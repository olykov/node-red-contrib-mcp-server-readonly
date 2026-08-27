'use strict';

// Stateful Streamable HTTP transport for Node-RED MCP tools.
//
// This intentionally uses the official MCP TypeScript SDK rather than an
// ad-hoc SSE implementation.  A sessionful 2025-06-18 connection is required
// for server-to-client elicitation: the server sends `elicitation/create`
// inside the in-flight tools/call response stream and receives the user's
// JSON-RPC response before completing that same tool call.

const crypto = require('crypto');

const { NodeStreamableHTTPServerTransport } = require('@modelcontextprotocol/node');
const { McpServer, fromJsonSchema, isInitializeRequest } = require('@modelcontextprotocol/server');
const { z } = require('zod');

const OPENAI_FORM_EXTENSION = 'openai/form';
const OPENAI_FORM_TIMEOUT_MS = 9 * 60 * 1000;
const OPENAI_FORM_RESULT = z.object({
    action  : z.enum(['accept', 'cancel', 'decline']),
    content : z.record(z.string(), z.unknown()).nullable().optional()
}).passthrough();

function textResult(text, isError = false) {
    return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function isMcpResult(value) {
    return value && typeof value === 'object' && !Array.isArray(value) &&
        ['content', 'structuredContent', '_meta', 'isError'].some(key =>
            Object.prototype.hasOwnProperty.call(value, key));
}

function isOpenAIForm(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
        value.mode === 'openai/form' && typeof value.message === 'string' &&
        value.requestedSchema && typeof value.requestedSchema === 'object');
}

function hasOpenAIFormCapability(mcpServer) {
    const capabilities = mcpServer.server.getClientCapabilities();
    return Boolean(capabilities && capabilities.extensions &&
        capabilities.extensions[OPENAI_FORM_EXTENSION] !== undefined);
}

function capabilitySummary(mcpServer) {
    const capabilities = mcpServer.server.getClientCapabilities();
    if (!capabilities || typeof capabilities !== 'object') return { keys: [], extensionKeys: [] };
    const extensions = capabilities.extensions && typeof capabilities.extensions === 'object'
        ? capabilities.extensions
        : {};
    return {
        keys          : Object.keys(capabilities).sort(),
        extensionKeys : Object.keys(extensions).sort()
    };
}

function normalizeFlowResult(result) {
    if (isMcpResult(result)) return result;
    if (Array.isArray(result)) return { content: result };
    return textResult(typeof result === 'string' ? result : JSON.stringify(result));
}

async function resolveFlowResult(ctx, mcpServer, result) {
    if (!result || typeof result !== 'object' || Array.isArray(result) || !result.mcpElicitation) {
        return normalizeFlowResult(result);
    }

    const elicitation = result.mcpElicitation;
    if (!isOpenAIForm(elicitation)) {
        return textResult('Invalid Node-RED MCP elicitation payload.', true);
    }
    let response;
    try {
        response = await ctx.mcpReq.send({
            method : 'elicitation/create',
            params : elicitation
        }, OPENAI_FORM_RESULT, { timeout: OPENAI_FORM_TIMEOUT_MS });
    } catch (error) {
        const summary = capabilitySummary(mcpServer);
        const message = error && error.message ? error.message : String(error);
        return textResult('OpenAI form elicitation failed: ' + message +
            '; clientCapabilities keys: ' + JSON.stringify(summary.keys) +
            '; clientCapabilities.extensions keys: ' + JSON.stringify(summary.extensionKeys), true);
    }

    const chosen = response.action === 'accept' && response.content
        ? response.content
        : null;
    return {
        content : [{
            type : 'text',
            text : chosen
                ? 'Creative selection received.'
                : 'Creative selection ' + response.action + '.'
        }],
        structuredContent : {
            action    : response.action,
            selection : chosen
        }
    };
}

function createSessionMcpServer(deps, session) {
    const mcpServer = new McpServer({
        name    : deps.serverName,
        version : deps.serverVersion,
        title   : deps.serverName
    }, {
        // We deliberately serve the sessionful 2025-era transport here.
        // Codex' native OpenAI form elicitation is a server-to-client request
        // and therefore requires this bidirectional session/SSE model.
        supportedProtocolVersions : ['2025-06-18']
    });

    const registerDynamicTool = (toolName, entry) => {
        if (session.registeredTools.has(toolName)) return;
        session.registeredTools.add(toolName);

        let inputSchema;
        try {
            inputSchema = fromJsonSchema(entry.schema || { type: 'object', properties: {} });
        } catch (error) {
            deps.warn('MCP tool "' + toolName + '" has invalid JSON Schema: ' + error.message);
            return;
        }

        mcpServer.registerTool(toolName, {
            description : entry.description || '',
            inputSchema
        }, async (args, ctx) => {
            if (!deps.allows(session.claims, entry.requiredValue)) {
                return textResult('Access denied: the "' + toolName +
                    '" tool requires a permission your token does not have.', true);
            }
            try {
                const result = await deps.callTool(toolName, entry.timeoutMs || 30000, args, session.claims);
                return resolveFlowResult(ctx, mcpServer, result);
            } catch (error) {
                return textResult(error && error.message === 'timeout'
                    ? 'Tool timed out: ' + toolName
                    : String(error && error.message ? error.message : error), true);
            }
        });
    };

    for (const [toolName, entry] of Object.entries(deps.tools)) {
        if (deps.allows(session.claims, entry.requiredValue)) registerDynamicTool(toolName, entry);
    }

    if (deps.adminToolsEnabled && deps.allows(session.claims, deps.adminRequiredValue)) {
        for (const tool of deps.adminTools.TOOLS) {
            if (session.registeredTools.has(tool.name)) continue;
            session.registeredTools.add(tool.name);
            mcpServer.registerTool(tool.name, {
                description : tool.description,
                inputSchema : fromJsonSchema(tool.inputSchema)
            }, async args => {
                try {
                    return textResult(await deps.adminTools.callTool(tool.name, args));
                } catch (error) {
                    return textResult(error && error.message ? error.message : String(error), true);
                }
            });
        }
    }

    for (const resource of Object.values(deps.resources || {})) {
        mcpServer.registerResource(resource.name, resource.uri, {
            description : resource.description,
            mimeType    : resource.mimeType
        }, async uri => ({
            contents : [{
                uri      : uri.href,
                mimeType : resource.mimeType,
                text     : resource.text,
                _meta    : resource._meta
            }]
        }));
    }

    return { mcpServer, registerDynamicTool };
}

function createStreamableMcpServer(deps) {
    const sessions = new Map();

    async function openSession(claims) {
        const session = { claims, registeredTools: new Set(), mcpServer: null, transport: null, registerDynamicTool: null };
        const transport = new NodeStreamableHTTPServerTransport({
            sessionIdGenerator : () => crypto.randomUUID(),
            onsessioninitialized : id => sessions.set(id, session)
        });
        session.transport = transport;
        transport.onclose = () => {
            if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        transport.onerror = error => deps.warn('MCP Streamable HTTP transport error: ' + error.message);

        const created = createSessionMcpServer(deps, session);
        session.mcpServer = created.mcpServer;
        session.registerDynamicTool = created.registerDynamicTool;
        await session.mcpServer.connect(transport);
        return session;
    }

    async function handleRequest(req, res, body, claims) {
        const sessionId = req.headers['mcp-session-id'];
        let session;

        if (typeof sessionId === 'string' && sessions.has(sessionId)) {
            session = sessions.get(sessionId);
            session.claims = claims;
        } else if (!sessionId && isInitializeRequest(body)) {
            session = await openSession(claims);
        } else {
            const status = sessionId ? 404 : 400;
            res.status(status).json({
                jsonrpc : '2.0',
                id      : body && Object.prototype.hasOwnProperty.call(body, 'id') ? body.id : null,
                error   : {
                    code    : sessionId ? -32001 : -32000,
                    message : sessionId ? 'Session not found' : 'Bad Request: session initialization required'
                }
            });
            return;
        }

        await session.transport.handleRequest(req, res, body);
    }

    function registerDynamicTool(toolName, entry) {
        for (const session of sessions.values()) {
            if (deps.allows(session.claims, entry.requiredValue)) {
                session.registerDynamicTool(toolName, entry);
            }
        }
    }

    async function close() {
        await Promise.all([...sessions.values()].map(session => session.mcpServer.close()));
        sessions.clear();
    }

    return { handleRequest, registerDynamicTool, close, sessions };
}

module.exports = {
    OPENAI_FORM_EXTENSION,
    OPENAI_FORM_TIMEOUT_MS,
    capabilitySummary,
    createStreamableMcpServer,
    hasOpenAIFormCapability,
    isOpenAIForm,
    resolveFlowResult
};

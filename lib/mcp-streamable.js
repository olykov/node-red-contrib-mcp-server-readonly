'use strict';

// Stateful Streamable HTTP transport for Node-RED MCP tools.
//
// This intentionally uses the official MCP TypeScript SDK rather than an
// ad-hoc JSON-RPC implementation. Interactive creative review uses MCP Apps:
// a tool advertises `_meta.ui.resourceUri`, the server exposes a `ui://` HTML
// resource, and the tool result carries structured data for that UI.

const crypto = require('crypto');

const { NodeStreamableHTTPServerTransport } = require('@modelcontextprotocol/node');
const { McpServer, fromJsonSchema, isInitializeRequest } = require('@modelcontextprotocol/server');
const { CREATIVE_PICKER_URI } = require('./mcp-app-resources');

const MCP_APP_EXTENSION = 'io.modelcontextprotocol/ui';
const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';
const CREATIVE_PICKER_SUBMIT_TOOL = 'creative_picker_submit';
const LEGACY_UI_RESOURCE_URI_META = 'ui/resourceUri';

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

function hasMcpAppCapability(mcpServer) {
    const capabilities = mcpServer.server.getClientCapabilities();
    const apps = capabilities && capabilities.extensions && capabilities.extensions[MCP_APP_EXTENSION];
    return Boolean(apps && Array.isArray(apps.mimeTypes) && apps.mimeTypes.includes(MCP_APP_MIME_TYPE));
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


function creativePickerOptionsFromOpenAIForm(elicitation) {
    const properties = elicitation.requestedSchema && elicitation.requestedSchema.properties;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return [];
    const picker = Object.values(properties).find(field => field && typeof field === 'object' &&
        field.type === 'openai/imagePicker' && Array.isArray(field.items));
    if (!picker) return [];
    return picker.items.map(item => ({
        id          : String(item.id),
        label       : item.title ? String(item.title) : String(item.id),
        description : item.description ? String(item.description) : '',
        image       : item.image ? String(item.image) : ''
    }));
}

function creativePickerAppResult(elicitation, mcpServer) {
    const options = creativePickerOptionsFromOpenAIForm(elicitation);
    if (!options.length) return textResult('Invalid creative picker payload: no openai/imagePicker items.', true);
    const supportsApps = hasMcpAppCapability(mcpServer);
    return {
        content : [{
            type : 'text',
            text : supportsApps
                ? 'Choose a creative variant in the picker.'
                : 'Choose a creative variant. MCP Apps UI is not advertised by this client connection.'
        }],
        structuredContent : {
            title         : 'Choose creative variants',
            selectionMode : 'single',
            options
        },
        _meta : {
            ui: { resourceUri: CREATIVE_PICKER_URI },
            [LEGACY_UI_RESOURCE_URI_META]: CREATIVE_PICKER_URI
        }
    };
}

function creativePickerSubmitResult(args) {
    const selectedIds = Array.isArray(args && args.selectedIds)
        ? args.selectedIds.map(String).filter(Boolean)
        : [];
    const feedback = args && typeof args.feedback === 'string' ? args.feedback.trim() : '';
    const selectionMode = args && args.selectionMode === 'multiple' ? 'multiple' : 'single';
    if (!selectedIds.length) return textResult('Select at least one creative variant.', true);
    return {
        content : [{ type: 'text', text: 'Creative picker selection received.' }],
        structuredContent : {
            type: 'creative_picker_selection',
            selectionMode,
            selectedIds,
            feedback
        }
    };
}

function creativePickerToolMeta(toolName) {
    return toolName === 'creative_picker'
        ? {
            ui: { resourceUri: CREATIVE_PICKER_URI },
            [LEGACY_UI_RESOURCE_URI_META]: CREATIVE_PICKER_URI
        }
        : undefined;
}

function normalizeFlowResult(result) {
    if (isMcpResult(result)) return result;
    if (Array.isArray(result)) return { content: result };
    return textResult(typeof result === 'string' ? result : JSON.stringify(result));
}

async function resolveFlowResult(_ctx, mcpServer, result) {
    if (!result || typeof result !== 'object' || Array.isArray(result) || !result.mcpElicitation) {
        return normalizeFlowResult(result);
    }

    const elicitation = result.mcpElicitation;
    if (!isOpenAIForm(elicitation)) {
        return textResult('Invalid Node-RED MCP elicitation payload.', true);
    }
    return creativePickerAppResult(elicitation, mcpServer);
}

function createSessionMcpServer(deps, session) {
    const mcpServer = new McpServer({
        name    : deps.serverName,
        version : deps.serverVersion,
        title   : deps.serverName
    }, {
        // We serve Streamable HTTP and advertise the MCP Apps extension so
        // hosts that support `io.modelcontextprotocol/ui` can render the
        // creative picker resource inline.
        supportedProtocolVersions : ['2025-06-18'],
        capabilities : {
            resources  : {},
            extensions : { [MCP_APP_EXTENSION]: { mimeTypes: [MCP_APP_MIME_TYPE] } }
        }
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
            inputSchema,
            _meta : creativePickerToolMeta(toolName)
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

    if (!session.registeredTools.has(CREATIVE_PICKER_SUBMIT_TOOL)) {
        session.registeredTools.add(CREATIVE_PICKER_SUBMIT_TOOL);
        mcpServer.registerTool(CREATIVE_PICKER_SUBMIT_TOOL, {
            description : 'Validate and return the selected creative variant from the MCP Apps picker.',
            inputSchema : fromJsonSchema({
                type : 'object',
                properties : {
                    selectionMode : { type: 'string', enum: ['single', 'multiple'] },
                    selectedIds   : { type: 'array', items: { type: 'string' }, minItems: 1 },
                    feedback      : { type: 'string' }
                },
                required : ['selectedIds'],
                additionalProperties : false
            }),
            _meta : { ui: { visibility: ['app'] } }
        }, async args => creativePickerSubmitResult(args));
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
    CREATIVE_PICKER_SUBMIT_TOOL,
    MCP_APP_EXTENSION,
    MCP_APP_MIME_TYPE,
    LEGACY_UI_RESOURCE_URI_META,
    capabilitySummary,
    createStreamableMcpServer,
    creativePickerAppResult,
    creativePickerOptionsFromOpenAIForm,
    creativePickerSubmitResult,
    hasMcpAppCapability,
    isOpenAIForm,
    resolveFlowResult
};

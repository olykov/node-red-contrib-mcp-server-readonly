'use strict';

// Stateful Streamable HTTP transport for Node-RED MCP tools.
//
// This intentionally uses the official MCP TypeScript SDK rather than an
// ad-hoc JSON-RPC implementation. Interactive pickers use MCP Apps:
// a tool advertises `_meta.ui.resourceUri`, the server exposes a `ui://` HTML
// resource, and the tool result carries structured data for that UI.

const crypto = require('crypto');

const { NodeStreamableHTTPServerTransport } = require('@modelcontextprotocol/node');
const { McpServer, fromJsonSchema, isInitializeRequest } = require('@modelcontextprotocol/server');
const { PICKER_URI } = require('./mcp-app-resources');

const MCP_APP_EXTENSION = 'io.modelcontextprotocol/ui';
const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';
const PICKER_SUBMIT_TOOL = 'picker_submit';
const LEGACY_UI_RESOURCE_URI_META = 'ui/resourceUri';

function textResult(text, isError = false) {
    return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function isMcpResult(value) {
    return value && typeof value === 'object' && !Array.isArray(value) &&
        ['content', 'structuredContent', '_meta', 'isError'].some(key =>
            Object.prototype.hasOwnProperty.call(value, key));
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

function hasPickerResourceMeta(value) {
    const meta = value && value._meta && typeof value._meta === 'object' ? value._meta : {};
    const ui = meta.ui && typeof meta.ui === 'object' ? meta.ui : {};
    return ui.resourceUri === PICKER_URI || meta[LEGACY_UI_RESOURCE_URI_META] === PICKER_URI;
}

function sanitizePickerOptions(options) {
    if (!Array.isArray(options)) return [];
    const seen = new Set();
    const sanitized = [];
    for (const option of options) {
        if (!option || typeof option !== 'object' || Array.isArray(option)) continue;
        const id = typeof option.id === 'string' ? option.id.trim() : '';
        const labelSource = typeof option.label === 'string' ? option.label : option.title;
        const label = typeof labelSource === 'string' && labelSource.trim() ? labelSource.trim() : id;
        const description = typeof option.description === 'string' ? option.description.trim() : '';
        if (!id || seen.has(id)) continue;
        seen.add(id);
        sanitized.push({
            id,
            label,
            ...(description ? { description } : {})
        });
    }
    return sanitized;
}

function sanitizePickerResult(result, mcpServer) {
    if (!hasPickerResourceMeta(result)) return result;
    const structured = result.structuredContent && typeof result.structuredContent === 'object' &&
        !Array.isArray(result.structuredContent) ? result.structuredContent : {};
    const options = sanitizePickerOptions(structured.options);
    if (!options.length) return textResult('Invalid picker payload: options must contain at least one item.', true);
    const supportsApps = hasMcpAppCapability(mcpServer);
    return {
        ...result,
        content : Array.isArray(result.content) && result.content.length ? result.content : [{
            type : 'text',
            text : supportsApps ? 'Choose an option in the picker.' :
                'Choose an option. MCP Apps UI is not advertised by this client connection.'
        }],
        structuredContent : {
            ...structured,
            title         : typeof structured.title === 'string' && structured.title.trim() ? structured.title.trim() : 'Choose an option',
            selectionMode : structured.selectionMode === 'multiple' ? 'multiple' : 'single',
            options
        },
        _meta : {
            ...(result._meta || {}),
            ui: { ...((result._meta && result._meta.ui) || {}), resourceUri: PICKER_URI },
            [LEGACY_UI_RESOURCE_URI_META]: PICKER_URI
        }
    };
}

function pickerSubmitResult(args) {
    const selectedIds = Array.isArray(args && args.selectedIds)
        ? args.selectedIds.map(String).map(value => value.trim()).filter(Boolean)
        : [];
    const otherOption = args && typeof args.otherOption === 'string' ? args.otherOption.trim() : '';
    const selectionMode = args && args.selectionMode === 'multiple' ? 'multiple' : 'single';
    if (!selectedIds.length && !otherOption) return textResult('Select an option or enter other option.', true);
    return {
        content : [{ type: 'text', text: 'Picker selection received.' }],
        structuredContent : {
            type: 'picker_selection',
            selectionMode,
            selectedIds,
            otherOption
        }
    };
}

function normalizeFlowResult(result, mcpServer) {
    if (isMcpResult(result)) return sanitizePickerResult(result, mcpServer);
    if (Array.isArray(result)) return { content: result };
    return textResult(typeof result === 'string' ? result : JSON.stringify(result));
}

async function resolveFlowResult(_ctx, mcpServer, result) {
    return normalizeFlowResult(result, mcpServer);
}

function createSessionMcpServer(deps, session) {
    const mcpServer = new McpServer({
        name    : deps.serverName,
        version : deps.serverVersion,
        title   : deps.serverName
    }, {
        // We serve Streamable HTTP and advertise the MCP Apps extension so
        // hosts that support `io.modelcontextprotocol/ui` can render the
        // picker resource inline.
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

        const descriptorMeta = toolName === 'picker' ? {
            ui                         : { resourceUri: PICKER_URI },
            [LEGACY_UI_RESOURCE_URI_META]: PICKER_URI,
            'openai/outputTemplate'    : PICKER_URI,
            'openai/toolInvocation/invoking': 'Opening picker…',
            'openai/toolInvocation/invoked' : 'Picker ready.'
        } : undefined;

        mcpServer.registerTool(toolName, {
            description : entry.description || '',
            inputSchema,
            _meta : descriptorMeta
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

    if (!session.registeredTools.has(PICKER_SUBMIT_TOOL)) {
        session.registeredTools.add(PICKER_SUBMIT_TOOL);
        mcpServer.registerTool(PICKER_SUBMIT_TOOL, {
            description : 'Validate and return the selected option from the MCP Apps picker.',
            inputSchema : fromJsonSchema({
                type : 'object',
                properties : {
                    selectionMode : { type: 'string', enum: ['single', 'multiple'] },
                    selectedIds   : { type: 'array', items: { type: 'string' } },
                    otherOption   : { type: 'string' }
                },
                required : ['selectedIds'],
                additionalProperties : false
            }),
            _meta : { ui: { visibility: ['app'] } }
        }, async args => pickerSubmitResult(args));
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
    PICKER_SUBMIT_TOOL,
    MCP_APP_EXTENSION,
    MCP_APP_MIME_TYPE,
    LEGACY_UI_RESOURCE_URI_META,
    capabilitySummary,
    createStreamableMcpServer,
    pickerSubmitResult,
    sanitizePickerOptions,
    sanitizePickerResult,
    hasMcpAppCapability,
    resolveFlowResult
};

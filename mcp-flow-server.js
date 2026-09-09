module.exports = function (RED)
{
    "use strict";

    const http = require('http');
    const express = require('express');
    const { randomUUID: uuidv4 } = require('crypto');
    const NodeCache = require('node-cache');
    const { createAdminTools } = require('./lib/admin-tools');
    const { MCP_APP_RESOURCES, PICKER_URI } = require('./lib/mcp-app-resources');

    const PICKER_SUBMIT_TOOL = 'picker_submit';
    const LEGACY_UI_RESOURCE_URI_META = 'ui/resourceUri';

    const toolRegistry = new NodeCache({ stdTTL: 0 });
    const serverInstances = new NodeCache({ stdTTL: 0 });

    function parseList(value)
    {
        if (typeof value !== 'string') return [];
        return value.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    }

    function securitySchemes(scopes)
    {
        const normalized = Array.isArray(scopes) ? scopes : [];
        return normalized.length ? [{ type: 'oauth2', scopes: normalized }] : [];
    }

    function withSecurityMeta(tool, scopes, extraMeta = {})
    {
        const schemes = securitySchemes(scopes);
        const meta = Object.assign({}, tool._meta || {}, extraMeta || {});
        if (schemes.length) meta.securitySchemes = schemes;
        return Object.assign({}, tool, Object.keys(meta).length ? { _meta: meta } : {});
    }

    function textResult(text, isError = false)
    {
        return { content: [{ type: 'text', text: String(text) }], ...(isError ? { isError: true } : {}) };
    }

    function isMcpResult(value)
    {
        return value && typeof value === 'object' && !Array.isArray(value) &&
            ['content', 'structuredContent', '_meta', 'isError'].some(key =>
                Object.prototype.hasOwnProperty.call(value, key));
    }

    function sanitizePickerOptions(options)
    {
        if (!Array.isArray(options)) return [];
        const seen = new Set();
        const out = [];
        for (const option of options)
        {
            if (!option || typeof option !== 'object' || Array.isArray(option)) continue;
            const id = typeof option.id === 'string' ? option.id.trim() : '';
            const labelSource = typeof option.label === 'string' ? option.label : option.title;
            const label = typeof labelSource === 'string' && labelSource.trim() ? labelSource.trim() : id;
            const description = typeof option.description === 'string' ? option.description.trim() : '';
            if (!id || seen.has(id)) continue;
            seen.add(id);
            out.push({ id, label, ...(description ? { description } : {}) });
        }
        return out;
    }

    function hasPickerResourceMeta(value)
    {
        const meta = value && value._meta && typeof value._meta === 'object' ? value._meta : {};
        const ui = meta.ui && typeof meta.ui === 'object' ? meta.ui : {};
        return ui.resourceUri === PICKER_URI || meta[LEGACY_UI_RESOURCE_URI_META] === PICKER_URI;
    }

    function sanitizePickerResult(result)
    {
        if (!hasPickerResourceMeta(result)) return result;
        const structured = result.structuredContent && typeof result.structuredContent === 'object' &&
            !Array.isArray(result.structuredContent) ? result.structuredContent : {};
        const options = sanitizePickerOptions(structured.options);
        if (!options.length) return textResult('Invalid picker payload: options must contain at least one item.', true);
        return Object.assign({}, result, {
            content: Array.isArray(result.content) && result.content.length ? result.content : [
                { type: 'text', text: 'Choose an option in the picker.' }
            ],
            structuredContent: Object.assign({}, structured, {
                title: typeof structured.title === 'string' && structured.title.trim() ? structured.title.trim() : 'Choose an option',
                selectionMode: structured.selectionMode === 'multiple' ? 'multiple' : 'single',
                options
            }),
            _meta: Object.assign({}, result._meta || {}, {
                ui: Object.assign({}, (result._meta && result._meta.ui) || {}, { resourceUri: PICKER_URI }),
                [LEGACY_UI_RESOURCE_URI_META]: PICKER_URI
            })
        });
    }

    function pickerSubmitResult(args)
    {
        const selectedIds = Array.isArray(args && args.selectedIds)
            ? args.selectedIds.map(String).map(v => v.trim()).filter(Boolean)
            : [];
        const otherOption = args && typeof args.otherOption === 'string' ? args.otherOption.trim() : '';
        const selectionMode = args && args.selectionMode === 'multiple' ? 'multiple' : 'single';
        if (!selectedIds.length && !otherOption) return textResult('Select an option or enter other option.', true);
        return {
            content: [{ type: 'text', text: 'Picker selection received.' }],
            structuredContent: { type: 'picker_selection', selectionMode, selectedIds, otherOption }
        };
    }

    function normalizeToolResult(result)
    {
        if (isMcpResult(result)) return sanitizePickerResult(result);
        if (Array.isArray(result)) return { content: result };
        if (typeof result === 'string') return textResult(result);
        return textResult(JSON.stringify(result));
    }

    function MCPFlowServerNode(config)
    {
        RED.nodes.createNode(this, config);
        const node = this;

        node.serverName = config.serverName || "node-red-mcp-server";
        node.serverPort = config.serverPort || 8001;
        node.autoStart = config.autoStart || false;
        node.enableCors = config.enableCors !== false;
        node.advertisedScopes = parseList(config.advertisedScopes || '');
        node.enablePicker = config.enablePicker !== false;
        node.adminToolsEnabled = config.adminToolsEnabled === true || config.adminToolsEnabled === 'true';
        node.adminPort = Number(config.adminPort || 1880);
        node.adminToken = config.adminToken || '';
        node.adminTools = createAdminTools({ adminPort: node.adminPort, getAdminToken: () => node.adminToken });

        node.httpServer = null;
        node.app = null;
        node.isRunning = false;
        node.serverId = uuidv4();

        node.status({ fill: "grey", shape: "ring", text: "stopped" });

        node.initializeServer = function ()
        {
            node.app = express();

            if (node.enableCors)
            {
                node.app.use((req, res, next) =>
                {
                    res.header('Access-Control-Allow-Origin', '*');
                    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
                    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
                    if (req.method === 'OPTIONS') res.sendStatus(200);
                    else next();
                });
            }

            node.app.use(express.json({ limit: '10mb' }));

            node.app.get('/health', (req, res) =>
            {
                res.json({ status: 'healthy', server: node.serverName, uptime: process.uptime(), tools: toolRegistry.keys().length });
            });

            node.app.post('/mcp', async (req, res) =>
            {
                const request = req.body || {};
                try
                {
                    node.log('MCP Request: ' + JSON.stringify(request));
                    switch (request.method)
                    {
                        case 'tools/list': node.handleToolsList(request, res); break;
                        case 'tools/call': await node.handleToolCall(request, res); break;
                        case 'resources/list': node.handleResourcesList(request, res); break;
                        case 'resources/read': node.handleResourcesRead(request, res); break;
                        case 'initialize': node.handleInitialize(request, res); break;
                        default:
                            if (request.method && request.method.endsWith('_tool')) await node.handleDirectToolCall(request, res);
                            else node.rpcError(res, request.id, -32601, 'Method not found: ' + request.method);
                    }
                } catch (error)
                {
                    node.error('MCP request error: ' + error.message);
                    node.rpcError(res, request.id, -32603, 'Internal error', error.message, 500);
                }
            });

            node.app.get('/sse', (req, res) =>
            {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    'Access-Control-Allow-Origin': '*'
                });
                res.write('data: {"type":"connected","server":"' + node.serverName + '"}\n\n');
                const keepAlive = setInterval(() =>
                {
                    res.write('data: {"type":"heartbeat","timestamp":"' + new Date().toISOString() + '"}\n\n');
                }, 30000);
                req.on('close', () => clearInterval(keepAlive));
            });
        };

        node.rpcError = function (res, id, code, message, data, httpStatus)
        {
            const body = { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } };
            if (httpStatus) res.status(httpStatus).json(body);
            else res.json(body);
        };

        node.toolDescriptor = function (tool)
        {
            return withSecurityMeta({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }, node.advertisedScopes, tool._meta);
        };

        node.handleToolsList = function (request, res)
        {
            const tools = [];
            toolRegistry.keys().forEach(key =>
            {
                const tool = toolRegistry.get(key);
                if (tool) tools.push(node.toolDescriptor(tool));
            });

            if (node.enablePicker)
            {
                tools.push(withSecurityMeta({
                    name: PICKER_SUBMIT_TOOL,
                    description: 'Validate and return the selected option from the MCP Apps picker.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            selectedIds: { type: 'array', items: { type: 'string' } },
                            otherOption: { type: 'string' },
                            selectionMode: { type: 'string', enum: ['single', 'multiple'] }
                        },
                        additionalProperties: false
                    }
                }, node.advertisedScopes, { ui: { visibility: ['app'] } }));
            }

            if (node.adminToolsEnabled)
            {
                node.adminTools.TOOLS.forEach(tool => tools.push(withSecurityMeta(tool, node.advertisedScopes)));
            }

            res.json({ jsonrpc: '2.0', id: request.id, result: { tools } });
        };

        node.handleResourcesList = function (request, res)
        {
            const resources = node.enablePicker ? Object.values(MCP_APP_RESOURCES).map(({ uri, name, description, mimeType }) =>
                ({ uri, name, description, mimeType })) : [];
            res.json({ jsonrpc: '2.0', id: request.id, result: { resources } });
        };

        node.handleResourcesRead = function (request, res)
        {
            const uri = request.params && request.params.uri;
            const resource = node.enablePicker && uri ? MCP_APP_RESOURCES[uri] : undefined;
            if (!resource) return node.rpcError(res, request.id, -32602, 'Unknown resource: ' + uri);
            res.json({
                jsonrpc: '2.0',
                id: request.id,
                result: { contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: resource.text, _meta: resource._meta }] }
            });
        };

        node.handleToolCall = async function (request, res)
        {
            const params = request.params || {};
            const name = params.name;
            const args = params.arguments || {};
            try
            {
                if (node.enablePicker && name === PICKER_SUBMIT_TOOL)
                {
                    return res.json({ jsonrpc: '2.0', id: request.id, result: pickerSubmitResult(args) });
                }
                if (node.adminToolsEnabled && node.adminTools.TOOL_NAMES.has(name))
                {
                    const adminResult = await node.adminTools.callTool(name, args);
                    return res.json({ jsonrpc: '2.0', id: request.id, result: textResult(adminResult) });
                }
                const tool = toolRegistry.get(name);
                if (!tool) return node.rpcError(res, request.id, -32602, 'Tool not found: ' + name);
                const result = await node.executeToolFlow(tool, args);
                res.json({ jsonrpc: '2.0', id: request.id, result: normalizeToolResult(result) });
            } catch (error)
            {
                node.rpcError(res, request.id, error.rpcCode || -32603, error.message);
            }
        };

        node.handleDirectToolCall = async function (request, res)
        {
            const toolName = request.method;
            const tool = toolRegistry.get(toolName);
            if (!tool) return node.rpcError(res, request.id, -32602, 'Tool not found: ' + toolName);
            try
            {
                const result = await node.executeToolFlow(tool, request.params || {});
                res.json({ jsonrpc: '2.0', id: request.id, result: normalizeToolResult(result) });
            } catch (error)
            {
                node.rpcError(res, request.id, -32603, error.message);
            }
        };

        node.handleInitialize = function (request, res)
        {
            const capabilities = { tools: { listChanged: true } };
            if (node.enablePicker)
            {
                capabilities.resources = {};
                capabilities.extensions = { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } };
            }
            res.json({
                jsonrpc: '2.0',
                id: request.id,
                result: {
                    protocolVersion: '2024-11-05',
                    capabilities,
                    serverInfo: { name: node.serverName, version: '1.0.0', description: 'Node-RED MCP Flow Server' }
                }
            });
        };

        node.executeToolFlow = function (tool, args)
        {
            return new Promise((resolve, reject) =>
            {
                const executionMsg = { topic: 'mcp-tool-execute', payload: { toolName: tool.name, arguments: args, executionId: uuidv4() } };
                const timeout = setTimeout(() => reject(new Error('Tool execution timeout')), 30000);
                const responseHandler = (msg) =>
                {
                    if (msg.topic === 'mcp-tool-response' && msg.payload && msg.payload.executionId === executionMsg.payload.executionId)
                    {
                        clearTimeout(timeout);
                        node.removeListener('input', responseHandler);
                        if (msg.payload.error) reject(new Error(msg.payload.error));
                        else resolve(msg.payload.result);
                    }
                };
                node.on('input', responseHandler);
                node.send(executionMsg);
            });
        };

        node.startServer = function (callback = () => { })
        {
            if (node.isRunning)
            {
                callback(null, { success: false, message: 'Server already running' });
                return;
            }
            node.status({ fill: 'yellow', shape: 'ring', text: 'starting...' });
            try
            {
                node.initializeServer();
                node.httpServer = http.createServer(node.app);
                node.httpServer.listen(node.serverPort, () =>
                {
                    node.isRunning = true;
                    node.status({ fill: 'green', shape: 'dot', text: 'running :' + node.serverPort });
                    serverInstances.set(node.serverId, {
                        nodeId: String(node.id),
                        serverName: String(node.serverName),
                        port: Number(node.serverPort),
                        startTime: new Date().toISOString(),
                        isRunning: true
                    });
                    node.log('MCP Flow Server started on port ' + node.serverPort);
                    node.send({ topic: 'mcp-server-started', payload: { serverId: node.serverId, serverName: node.serverName, port: node.serverPort, startTime: new Date() } });
                    callback(null, { success: true, message: 'Server started' });
                });
                node.httpServer.on('error', (error) =>
                {
                    node.error('Server error: ' + error.message);
                    node.status({ fill: 'red', shape: 'dot', text: 'error' });
                    callback(error);
                });
            } catch (error)
            {
                node.error('Failed to start server: ' + error.message);
                node.status({ fill: 'red', shape: 'dot', text: 'error' });
                callback(error);
            }
        };

        node.stopServer = function (callback = () => { })
        {
            if (!node.isRunning)
            {
                callback(null, { success: true, message: 'Server already stopped' });
                return;
            }
            node.status({ fill: 'yellow', shape: 'ring', text: 'stopping...' });
            if (node.httpServer)
            {
                node.httpServer.close(() =>
                {
                    node.isRunning = false;
                    node.status({ fill: 'grey', shape: 'ring', text: 'stopped' });
                    serverInstances.del(node.serverId);
                    node.send({ topic: 'mcp-server-stopped', payload: { serverId: node.serverId } });
                    callback(null, { success: true, message: 'Server stopped' });
                });
            } else
            {
                node.isRunning = false;
                node.status({ fill: 'grey', shape: 'ring', text: 'stopped' });
                callback(null, { success: true, message: 'Server stopped' });
            }
        };

        node.on('input', function (msg)
        {
            const command = msg.topic || (msg.payload && msg.payload.command);
            switch (command)
            {
                case 'start': node.startServer(); break;
                case 'stop': node.stopServer(); break;
                case 'restart': node.stopServer(() => setTimeout(() => node.startServer(), 1000)); break;
                case 'status':
                    msg.payload = { serverId: node.serverId, serverName: node.serverName, isRunning: node.isRunning, port: node.serverPort, toolCount: toolRegistry.keys().length };
                    node.send(msg);
                    break;
            }
        });

        if (node.autoStart) setTimeout(() => node.startServer(), 1000);

        node.on('close', function (done)
        {
            if (node.isRunning) node.stopServer(() => done());
            else done();
        });
    }

    RED.nodes.registerType('mcp-flow-server', MCPFlowServerNode);

    RED.events.on('mcp-tool-register', (toolDef) => toolRegistry.set(toolDef.name, toolDef));
    RED.events.on('mcp-tool-unregister', (toolName) => toolRegistry.del(toolName));

    RED.httpAdmin.get('/mcp-flow-servers', function (req, res)
    {
        const servers = [];
        serverInstances.keys().forEach(key =>
        {
            const server = serverInstances.get(key);
            if (server)
            {
                servers.push({ serverId: key, serverName: server.serverName, isRunning: server.isRunning, port: server.port, startTime: server.startTime, toolCount: toolRegistry.keys().length });
            }
        });
        res.json({ servers });
    });
};

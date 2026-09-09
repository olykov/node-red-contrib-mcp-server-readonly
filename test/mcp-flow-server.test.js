'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('node:events');

function createRuntime(config = {}) {
    const types = {};
    const events = new EventEmitter();
    const nodeMap = config.__nodes || {};
    const RED = {
        events,
        log: { debug() {} },
        nodes: {
            createNode(node, nodeConfig) {
                Object.setPrototypeOf(node, EventEmitter.prototype);
                EventEmitter.call(node);
                node.sent = [];
                node.statuses = [];
                node.logs = [];
                node.errors = [];
                node.credentials = (nodeConfig && nodeConfig.credentials) || {};
                node.send = msg => node.sent.push(msg);
                node.status = s => node.statuses.push(s);
                node.log = s => node.logs.push(s);
                node.error = e => node.errors.push(e);
            },
            registerType(name, ctor) { types[name] = ctor; },
            getNode(id) { return nodeMap[id]; }
        },
        httpAdmin: { get() {} }
    };
    delete require.cache[require.resolve('../mcp-flow-server')];
    require('../mcp-flow-server')(RED);
    const nodeConfig = Object.assign({ serverName: 'test', serverPort: 18001 }, config);
    const server = new types['mcp-flow-server'](nodeConfig);
    return { RED, types, server, nodeMap };
}

function buildServer(config = {}) {
    return createRuntime(config);
}

function mockRes() {
    return {
        statusCode: 200,
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
}

describe('upstream mcp-flow-server local extensions', () => {
    it('keeps upstream registry tools and advertises _meta.securitySchemes', () => {
        const { RED, server } = buildServer({ advertisedScopes: 'openid profile email' });
        RED.events.emit('mcp-tool-register', {
            name: 'sample_ping',
            description: 'Sample ping',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } } }
        });
        const res = mockRes();
        server.handleToolsList({ id: 1 }, res);
        const tool = res.body.result.tools.find(t => t.name === 'sample_ping');
        assert.deepStrictEqual(tool._meta.securitySchemes, [{ type: 'oauth2', scopes: ['openid', 'profile', 'email'] }]);
        assert.ok(res.body.result.tools.some(t => t.name === 'picker_submit'));
    });

    it('serves picker MCP App resource', () => {
        const { server } = buildServer();
        const list = mockRes();
        server.handleResourcesList({ id: 1 }, list);
        assert.strictEqual(list.body.result.resources[0].uri, 'ui://picker/v4/options.html');
        const read = mockRes();
        server.handleResourcesRead({ id: 2, params: { uri: 'ui://picker/v4/options.html' } }, read);
        assert.match(read.body.result.contents[0].text, /picker/i);
    });

    it('loads legacy flow-server credentials without endpoint config', () => {
        const { server } = buildServer({
            serverName: 'legacy',
            adminToolsEnabled: true,
            adminPort: 1882,
            credentials: { adminToken: 'legacy-token' }
        });

        assert.strictEqual(server.serverName, 'legacy');
        assert.strictEqual(server.adminToolsEnabled, true);
        assert.strictEqual(server.adminPort, 1882);
        assert.strictEqual(server.adminToken, 'legacy-token');
    });

    it('loads endpoint config node credentials and admin settings', () => {
        const runtime = createRuntime({ autoStart: false, enablePicker: false });
        const endpoint = new runtime.types['mcp-endpoint']({
            id: 'endpoint-credentials',
            serverName: 'ops',
            serverPath: '/mcp/ops',
            advertisedScopes: 'openid',
            adminToolsEnabled: true,
            adminPort: 1881,
            credentials: { adminToken: 'test-token' }
        });
        runtime.nodeMap['endpoint-credentials'] = endpoint;
        const server = new runtime.types['mcp-flow-server']({
            endpoint: 'endpoint-credentials',
            serverPort: 18002,
            autoStart: false,
            enablePicker: false
        });

        assert.strictEqual(server.serverName, 'ops');
        assert.strictEqual(server.serverPath, '/mcp/ops');
        assert.strictEqual(server.adminToolsEnabled, true);
        assert.strictEqual(server.adminPort, 1881);
        assert.strictEqual(server.adminToken, 'test-token');
    });

    it('uses endpoint config for path, name, and base scopes', () => {
        const endpoint = {
            id: 'endpoint-1',
            serverName: 'ops',
            serverPath: '/internal/mcp/ops',
            advertisedScopes: ['openid', 'profile'],
            adminToolsEnabled: false,
            adminPort: 1880,
            adminToken: ''
        };
        const { RED, server } = buildServer({ endpoint: 'endpoint-1', __nodes: { 'endpoint-1': endpoint }, enablePicker: false });
        RED.events.emit('mcp-tool-register', {
            name: 'read_status',
            description: 'Read status',
            endpointId: 'endpoint-1',
            requiredScopes: ['status:read'],
            inputSchema: { type: 'object', properties: {} }
        });

        const res = mockRes();
        server.handleToolsList({ id: 1 }, res);
        assert.strictEqual(server.serverName, 'ops');
        assert.strictEqual(server.serverPath, '/internal/mcp/ops');
        assert.deepStrictEqual(res.body.result.tools[0]._meta.securitySchemes, [{ type: 'oauth2', scopes: ['openid', 'profile', 'status:read'] }]);
    });

    it('filters registered tools by server name when a binding is configured', () => {
        const { RED, server } = buildServer({ serverName: 'alpha', enablePicker: false });
        RED.events.emit('mcp-tool-register', {
            name: 'shared_tool',
            description: 'Shared',
            inputSchema: { type: 'object', properties: {} }
        });
        RED.events.emit('mcp-tool-register', {
            name: 'alpha_tool',
            description: 'Alpha',
            serverName: 'alpha',
            inputSchema: { type: 'object', properties: {} }
        });
        RED.events.emit('mcp-tool-register', {
            name: 'beta_tool',
            description: 'Beta',
            serverName: 'beta',
            inputSchema: { type: 'object', properties: {} }
        });

        const res = mockRes();
        server.handleToolsList({ id: 1 }, res);
        const names = res.body.result.tools.map(tool => tool.name).sort();
        assert.deepStrictEqual(names, ['alpha_tool', 'shared_tool']);
    });

    it('uses configured MCP server path', async () => {
        const { server } = buildServer({ serverPath: '/custom/mcp', autoStart: false });
        server.initializeServer();
        assert.strictEqual(server.serverPath, '/custom/mcp');
        assert.ok(server.portState.routes.has('/custom/mcp'));
    });


    it('keeps same tool name isolated across server bindings', () => {
        const { RED, server } = buildServer({ serverName: 'alpha', enablePicker: false });
        RED.events.emit('mcp-tool-register', {
            name: 'status_tool',
            description: 'Alpha status',
            serverName: 'alpha',
            inputSchema: { type: 'object', properties: { alpha: { type: 'boolean' } } }
        });
        RED.events.emit('mcp-tool-register', {
            name: 'status_tool',
            description: 'Beta status',
            serverName: 'beta',
            inputSchema: { type: 'object', properties: { beta: { type: 'boolean' } } }
        });

        const res = mockRes();
        server.handleToolsList({ id: 1 }, res);
        assert.strictEqual(res.body.result.tools.length, 1);
        assert.strictEqual(res.body.result.tools[0].description, 'Alpha status');
    });

    it('executes a registered upstream flow tool through executionId response loop', async () => {
        const { RED, server } = buildServer();
        RED.events.emit('mcp-tool-register', {
            name: 'sample_ping',
            description: 'Sample ping',
            inputSchema: { type: 'object', properties: {} }
        });
        const pending = server.handleToolCall({ id: 7, params: { name: 'sample_ping', arguments: { text: 'ok' } } }, mockRes());
        const exec = server.sent.find(msg => msg.topic === 'mcp-tool-execute');
        assert.strictEqual(exec.payload.toolName, 'sample_ping');
        server.emit('input', {
            topic: 'mcp-tool-response',
            payload: { executionId: exec.payload.executionId, result: { ok: true, received: exec.payload.arguments } }
        });
        await pending;
    });

    it('validates picker_submit selections', async () => {
        const { server } = buildServer();
        const res = mockRes();
        await server.handleToolCall({ id: 3, params: { name: 'picker_submit', arguments: { selectedIds: ['a'], otherOption: 'note' } } }, res);
        assert.deepStrictEqual(res.body.result.structuredContent.selectedIds, ['a']);
        assert.strictEqual(res.body.result.structuredContent.otherOption, 'note');
    });
});

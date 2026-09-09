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
                node.id = nodeConfig && nodeConfig.id;
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
    const runtimeConfig = Object.assign({
        id: 'runtime-1',
        runtimeName: 'test-runtime',
        serverPort: 18001,
        autoStart: false,
        enableCors: true
    }, config.__runtime || {});
    const runtimeNode = new types['mcp-runtime'](runtimeConfig);
    nodeMap[runtimeConfig.id] = runtimeNode;
    const nodeConfig = Object.assign({
        id: 'endpoint-1',
        runtime: runtimeConfig.id,
        serverName: 'test',
        serverPath: '/mcp/test',
        enablePicker: true
    }, config);
    const server = new types['mcp-flow-server'](nodeConfig);
    return { RED, types, server, nodeMap, runtimeNode };
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

    it('requires an explicit runtime config node before starting', () => {
        const runtime = createRuntime({ runtime: '', enablePicker: false });

        assert.strictEqual(runtime.server.runtime, null);
        assert.strictEqual(runtime.server.serverPort, 0);
        assert.throws(() => runtime.server.initializeServer(), /MCP runtime is required/);
    });

    it('uses endpoint fields with runtime transport config', () => {
        const { RED, server, runtimeNode } = buildServer({
            serverName: 'ops',
            serverPath: '/internal/mcp/ops',
            advertisedScopes: 'openid profile',
            enablePicker: false,
            __runtime: { serverPort: 18002, enableCors: false }
        });
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
        assert.strictEqual(server.serverPort, 18002);
        assert.strictEqual(server.enableCors, false);
        assert.strictEqual(runtimeNode.serverPort, 18002);
        assert.deepStrictEqual(res.body.result.tools[0]._meta.securitySchemes, [{ type: 'oauth2', scopes: ['openid', 'profile', 'status:read'] }]);
    });

    it('filters registered tools by endpoint id when a binding is configured', () => {
        const { RED, server } = buildServer({ id: 'alpha-endpoint', serverName: 'alpha', enablePicker: false });
        RED.events.emit('mcp-tool-register', {
            name: 'shared_tool',
            description: 'Shared',
            inputSchema: { type: 'object', properties: {} }
        });
        RED.events.emit('mcp-tool-register', {
            name: 'alpha_tool',
            description: 'Alpha',
            endpointId: 'alpha-endpoint',
            inputSchema: { type: 'object', properties: {} }
        });
        RED.events.emit('mcp-tool-register', {
            name: 'beta_tool',
            description: 'Beta',
            endpointId: 'beta-endpoint',
            inputSchema: { type: 'object', properties: {} }
        });

        const res = mockRes();
        server.handleToolsList({ id: 1 }, res);
        const names = res.body.result.tools.map(tool => tool.name).sort();
        assert.deepStrictEqual(names, ['alpha_tool', 'shared_tool']);
    });

    it('uses configured MCP server path', async () => {
        const { server } = buildServer({ serverPath: '/custom/mcp' });
        server.initializeServer();
        assert.strictEqual(server.serverPath, '/custom/mcp');
        assert.ok(server.portState.routes.has('/custom/mcp'));
    });

    it('allows multiple endpoints on one runtime port', () => {
        const runtime = createRuntime({
            id: 'endpoint-a',
            serverPath: '/mcp/a',
            __runtime: { id: 'runtime-shared', serverPort: 18005 }
        });
        const serverB = new runtime.types['mcp-flow-server']({
            id: 'endpoint-b',
            runtime: 'runtime-shared',
            serverName: 'b',
            serverPath: '/mcp/b',
            enablePicker: false
        });

        runtime.server.initializeServer();
        serverB.initializeServer();

        assert.strictEqual(runtime.server.portState, serverB.portState);
        assert.ok(runtime.server.portState.routes.has('/mcp/a'));
        assert.ok(runtime.server.portState.routes.has('/mcp/b'));
    });

    it('rejects different runtimes on the same port', () => {
        const runtime = createRuntime({
            id: 'endpoint-a',
            serverPath: '/mcp/a',
            __runtime: { id: 'runtime-a', serverPort: 18006 }
        });
        const runtimeB = new runtime.types['mcp-runtime']({
            id: 'runtime-b',
            runtimeName: 'runtime-b',
            serverPort: 18006,
            autoStart: false,
            enableCors: true
        });
        runtime.nodeMap['runtime-b'] = runtimeB;
        const serverB = new runtime.types['mcp-flow-server']({
            id: 'endpoint-b',
            runtime: 'runtime-b',
            serverName: 'b',
            serverPath: '/mcp/b',
            enablePicker: false
        });

        runtime.server.initializeServer();

        assert.throws(() => serverB.initializeServer(), /port already registered by another runtime/);
    });

    it('exposes admin tools only on the runtime admin endpoint path', () => {
        const adminRuntime = {
            serverPort: 18003,
            adminPort: 1881,
            adminEndpointPath: '/internal/mcp/ops',
            credentials: { adminToken: 'test-token' }
        };
        const adminServer = buildServer({
            id: 'admin-endpoint',
            serverName: 'ops',
            serverPath: '/internal/mcp/ops',
            enablePicker: false,
            __runtime: adminRuntime
        }).server;
        const otherServer = buildServer({
            id: 'other-endpoint',
            serverName: 'other',
            serverPath: '/internal/mcp/other',
            enablePicker: false,
            __runtime: Object.assign({ id: 'runtime-2' }, adminRuntime)
        }).server;

        const adminRes = mockRes();
        adminServer.handleToolsList({ id: 1 }, adminRes);
        const otherRes = mockRes();
        otherServer.handleToolsList({ id: 2 }, otherRes);

        assert.ok(adminRes.body.result.tools.some(tool => tool.name === 'get_flow'));
        assert.ok(!otherRes.body.result.tools.some(tool => tool.name === 'get_flow'));
    });

    it('does not expose admin tools without complete runtime admin config', () => {
        const { server } = buildServer({
            serverName: 'ops',
            serverPath: '/internal/mcp/ops',
            enablePicker: false,
            __runtime: {
                serverPort: 18004,
                adminPort: 1881,
                adminEndpointPath: '/internal/mcp/ops',
                credentials: { adminToken: '' }
            }
        });
        const res = mockRes();
        server.handleToolsList({ id: 1 }, res);
        assert.ok(!res.body.result.tools.some(tool => tool.name === 'get_flow'));
    });


    it('keeps same tool name isolated across endpoint bindings', () => {
        const { RED, server } = buildServer({ id: 'alpha-endpoint', serverName: 'alpha', enablePicker: false });
        RED.events.emit('mcp-tool-register', {
            name: 'status_tool',
            description: 'Alpha status',
            endpointId: 'alpha-endpoint',
            inputSchema: { type: 'object', properties: { alpha: { type: 'boolean' } } }
        });
        RED.events.emit('mcp-tool-register', {
            name: 'status_tool',
            description: 'Beta status',
            endpointId: 'beta-endpoint',
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

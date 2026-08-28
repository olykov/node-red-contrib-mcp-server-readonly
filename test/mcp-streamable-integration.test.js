'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { describe, it } = require('node:test');
const { PICKER_URI } = require('../lib/mcp-app-resources');
const { MCP_APP_EXTENSION, MCP_APP_MIME_TYPE, LEGACY_UI_RESOURCE_URI_META, createStreamableMcpServer } = require('../lib/mcp-streamable');

function request(port, body, sessionId) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port, path: '/mcp', method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                ...(sessionId ? { 'mcp-session-id': sessionId } : {})
            }
        }, res => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data }));
        });
        req.on('error', reject);
        req.end(JSON.stringify(body));
    });
}

function messagesFromJsonOrSse(text) {
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) return [JSON.parse(trimmed)];
    const messages = trimmed.split(/\n\n/)
        .map(event => event.split('\n').find(line => line.startsWith('data: ')))
        .filter(Boolean)
        .map(line => JSON.parse(line.slice(6)));
    assert.ok(messages.length, 'Expected a JSON or SSE MCP response');
    return messages;
}

function messageById(text, id) {
    const found = messagesFromJsonOrSse(text).find(message => message.id === id);
    assert.ok(found, 'Expected response id ' + id);
    return found;
}

function startStreamableServer() {
    const tool = {
        description: 'Choose one option.',
        schema: { type: 'object', properties: {} },
        timeoutMs: 1000,
        requiredValue: ''
    };
    const resources = {
        [PICKER_URI]: {
            uri: PICKER_URI,
            name: 'Picker',
            description: 'Interactive picker',
            mimeType: MCP_APP_MIME_TYPE,
            text: '<html>picker</html>',
            _meta: { ui: { prefersBorder: true } }
        }
    };
    const streamable = createStreamableMcpServer({
        serverName: 'test', serverVersion: '0.0.0',
        adminToolsEnabled: false, adminRequiredValue: '', adminTools: { TOOLS: [], TOOL_NAMES: new Set() },
        tools: { picker: tool }, resources, warn: () => {},
        allows: () => true,
        callTool: async () => ({
            content: [{ type: 'text', text: 'Choose one option in the picker.' }],
            structuredContent: {
                title: 'Choose an option',
                selectionMode: 'single',
                options: [{ id: 'a', label: 'A', description: 'First', image: 'must-be-dropped' }]
            },
            _meta: {
                ui: { resourceUri: PICKER_URI },
                [LEGACY_UI_RESOURCE_URI_META]: PICKER_URI
            }
        })
    });
    const server = http.createServer(async (req, res) => {
        try {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
            await streamable.handleRequest(req, res, body, { sub: 'test' });
        } catch (error) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
        port: server.address().port,
        close: async () => { await streamable.close(); await new Promise(done => server.close(done)); }
    })));
}

describe('Streamable HTTP MCP Apps picker', () => {
    it('advertises the app resource, returns text-only picker data, and accepts submit', async () => {
        const fixture = await startStreamableServer();
        try {
            const initialize = await request(fixture.port, {
                jsonrpc: '2.0', id: 1, method: 'initialize',
                params: {
                    protocolVersion: '2025-06-18',
                    capabilities: { extensions: { [MCP_APP_EXTENSION]: { mimeTypes: [MCP_APP_MIME_TYPE] } } },
                    clientInfo: { name: 'test-client', version: '1.0.0' }
                }
            });
            assert.equal(initialize.status, 200);
            const sessionId = initialize.headers['mcp-session-id'];
            assert.equal(typeof sessionId, 'string');
            const initializedResult = messageById(initialize.data, 1).result;
            assert.equal(initializedResult.protocolVersion, '2025-06-18');
            assert.deepEqual(initializedResult.capabilities.extensions, {
                [MCP_APP_EXTENSION]: { mimeTypes: [MCP_APP_MIME_TYPE] }
            });

            assert.equal((await request(fixture.port, {
                jsonrpc: '2.0', method: 'notifications/initialized', params: {}
            }, sessionId)).status, 202);

            const tools = messageById((await request(fixture.port, {
                jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}
            }, sessionId)).data, 2).result.tools;
            const pickerTool = tools.find(tool => tool.name === 'picker');
            assert.ok(pickerTool);
            assert.equal(pickerTool._meta.ui.resourceUri, PICKER_URI);
            assert.equal(pickerTool._meta[LEGACY_UI_RESOURCE_URI_META], PICKER_URI);
            assert.equal(pickerTool._meta['openai/outputTemplate'], PICKER_URI);
            const submitTool = tools.find(tool => tool.name === 'picker_submit');
            assert.deepEqual(submitTool._meta.ui.visibility, ['app']);

            const resource = messageById((await request(fixture.port, {
                jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: PICKER_URI }
            }, sessionId)).data, 3).result.contents[0];
            assert.equal(resource.uri, PICKER_URI);
            assert.equal(resource.mimeType, MCP_APP_MIME_TYPE);
            assert.equal(resource.text, '<html>picker</html>');

            const pickerResult = messageById((await request(fixture.port, {
                jsonrpc: '2.0', id: 4, method: 'tools/call',
                params: { name: 'picker', arguments: {} }
            }, sessionId)).data, 4).result;
            assert.equal(pickerResult._meta.ui.resourceUri, PICKER_URI);
            assert.equal(pickerResult._meta[LEGACY_UI_RESOURCE_URI_META], PICKER_URI);
            assert.deepEqual(pickerResult.structuredContent.options, [{
                id: 'a', label: 'A', description: 'First'
            }]);
            assert.equal(JSON.stringify(pickerResult).includes('must-be-dropped'), false);

            const submitResult = messageById((await request(fixture.port, {
                jsonrpc: '2.0', id: 5, method: 'tools/call',
                params: { name: 'picker_submit', arguments: { selectedIds: ['a'], feedback: 'ok' } }
            }, sessionId)).data, 5).result;
            assert.deepEqual(submitResult.structuredContent, {
                type: 'picker_selection', selectionMode: 'single', selectedIds: ['a'], feedback: 'ok'
            });
        } finally {
            await fixture.close();
        }
    });
});

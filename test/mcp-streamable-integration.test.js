'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { describe, it } = require('node:test');
const { createStreamableMcpServer } = require('../lib/mcp-streamable');

function request(port, body, sessionId, onEvent) {
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
            res.on('data', chunk => {
                data += chunk;
                if (onEvent) onEvent(chunk, res);
            });
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

function asJsonOrSse(text) {
    return messagesFromJsonOrSse(text)[0];
}

function startStreamableServer() {
    const tool = {
        description: 'Choose one creative image.',
        schema: { type: 'object', properties: {} },
        timeoutMs: 1000,
        requiredValue: ''
    };
    const streamable = createStreamableMcpServer({
        serverName: 'test', serverVersion: '0.0.0',
        adminToolsEnabled: false, adminRequiredValue: '', adminTools: { TOOLS: [] },
        tools: { creative_picker: tool }, resources: {}, warn: () => {},
        allows: () => true,
        callTool: async () => ({
            mcpElicitation: {
                mode: 'openai/form',
                message: 'Choose one.',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        creative: {
                            type: 'openai/imagePicker',
                            title: 'Creative',
                            items: [{ id: 'a', title: 'A', image: 'data:image/png;base64,AA==' }]
                        }
                    },
                    required: ['creative']
                }
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

describe('Streamable HTTP native form round trip', () => {
    it('keeps tools/call open, receives elicitation/create and returns the selected ID', async () => {
        const fixture = await startStreamableServer();
        try {
            const initialize = await request(fixture.port, {
                jsonrpc: '2.0', id: 1, method: 'initialize',
                params: {
                    protocolVersion: '2025-06-18',
                    capabilities: { extensions: { 'openai/form': {} } },
                    clientInfo: { name: 'test-client', version: '1.0.0' }
                }
            });
            assert.equal(initialize.status, 200);
            const sessionId = initialize.headers['mcp-session-id'];
            assert.equal(typeof sessionId, 'string');
            assert.equal(asJsonOrSse(initialize.data).result.protocolVersion, '2025-06-18');

            const initialized = await request(fixture.port, {
                jsonrpc: '2.0', method: 'notifications/initialized', params: {}
            }, sessionId);
            assert.equal(initialized.status, 202);

            let elicitationReply;
            let eventBuffer = '';
            const call = request(fixture.port, {
                jsonrpc: '2.0', id: 2, method: 'tools/call',
                params: { name: 'creative_picker', arguments: {} }
            }, sessionId, chunk => {
                eventBuffer += chunk;
                const match = eventBuffer.match(/data: (\{[^\n]+\})/);
                if (!match || elicitationReply) return;
                const requestFromServer = JSON.parse(match[1]);
                if (requestFromServer.method !== 'openai/form') return;
                elicitationReply = request(fixture.port, {
                    jsonrpc: '2.0', id: requestFromServer.id,
                    result: { action: 'accept', content: { creative: 'a' } }
                }, sessionId);
            });
            const toolResult = await call;
            await elicitationReply;
            const finalMessage = messagesFromJsonOrSse(toolResult.data)
                .find(message => message.id === 2);
            assert.ok(finalMessage, 'Expected the final tools/call response after elicitation');
            assert.deepEqual(finalMessage.result.structuredContent, {
                action: 'accept', selection: { creative: 'a' }
            });
        } finally {
            await fixture.close();
        }
    });
});

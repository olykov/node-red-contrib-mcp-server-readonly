'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
    OPENAI_FORM_TIMEOUT_MS,
    capabilitySummary,
    hasOpenAIFormCapability,
    isOpenAIForm,
    resolveFlowResult
} = require('../lib/mcp-streamable');

const picker = {
    mode : 'openai/form',
    message : 'Choose one creative.',
    requestedSchema : {
        type : 'object',
        properties : {
            creative : {
                type : 'openai/imagePicker',
                title : 'Creative',
                items : [{
                    id : 'creative_a',
                    title : 'Creative A',
                    image : 'data:image/png;base64,AA=='
                }]
            }
        },
        required : ['creative']
    }
};

describe('lib/mcp-streamable native OpenAI form elicitation', () => {
    it('detects the exact negotiated openai/form extension', () => {
        assert.equal(hasOpenAIFormCapability({ server: { getClientCapabilities: () => ({
            extensions : { 'openai/form': {} }
        }) } }), true);
        assert.equal(hasOpenAIFormCapability({ server: { getClientCapabilities: () => ({}) } }), false);
        assert.deepEqual(capabilitySummary({ server: { getClientCapabilities: () => ({
            elicitation : {},
            extensions  : { 'openai/form': {}, other: {} }
        }) } }), {
            keys          : ['elicitation', 'extensions'],
            extensionKeys : ['openai/form', 'other']
        });
    });

    it('accepts only an OpenAI form-shaped flow payload', () => {
        assert.equal(isOpenAIForm(picker), true);
        assert.equal(isOpenAIForm({ mode: 'form', message: 'x', requestedSchema: {} }), false);
        assert.equal(isOpenAIForm(null), false);
    });

    it('sends openai/form and turns an accepted selection into the tool result', async () => {
        const sent = [];
        const ctx = { mcpReq: {
            send: async (request, schema, options) => {
                sent.push({ request, schema, options });
                return { action: 'accept', content: { creative: 'creative_a' } };
            }
        } };
        const mcpServer = { server: { getClientCapabilities: () => ({ extensions: { 'openai/form': {} } }) } };

        const result = await resolveFlowResult(ctx, mcpServer, { mcpElicitation: picker });

        assert.deepEqual(sent[0].request, {
            method : 'openai/form',
            params : {
                message         : picker.message,
                requestedSchema : picker.requestedSchema
            }
        });
        assert.equal(sent[0].options.timeout, OPENAI_FORM_TIMEOUT_MS);
        assert.deepEqual(result.structuredContent, {
            action : 'accept',
            selection : { creative: 'creative_a' }
        });
    });

    it('fails with diagnostic keys when openai/form is not advertised', async () => {
        const result = await resolveFlowResult(
            { mcpReq: { send: async () => { throw new Error('must not request'); } } },
            { server: { getClientCapabilities: () => ({
                elicitation : {},
                extensions  : { 'io.modelcontextprotocol/ui': {} }
            }) } },
            { mcpElicitation: picker }
        );

        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /OpenAI form elicitation is not advertised/);
        assert.ok(result.content[0].text.includes('clientCapabilities keys: ["elicitation","extensions"]'));
        assert.ok(result.content[0].text.includes('clientCapabilities.extensions keys: ["io.modelcontextprotocol/ui"]'));
    });

    it('returns the actual send error with sanitized capability keys', async () => {
        const result = await resolveFlowResult(
            { mcpReq: { send: async () => { throw new Error('boom'); } } },
            { server: { getClientCapabilities: () => ({ extensions: { 'openai/form': {}, other: {} } }) } },
            { mcpElicitation: picker }
        );

        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /OpenAI form elicitation failed: boom/);
        assert.ok(result.content[0].text.includes('clientCapabilities keys: ["extensions"]'));
        assert.ok(result.content[0].text.includes('clientCapabilities.extensions keys: ["openai/form","other"]'));
    });
});

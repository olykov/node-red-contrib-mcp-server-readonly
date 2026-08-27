'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { CREATIVE_PICKER_URI } = require('../lib/mcp-app-resources');
const {
    MCP_APP_EXTENSION,
    MCP_APP_MIME_TYPE,
    LEGACY_UI_RESOURCE_URI_META,
    creativePickerAppResult,
    creativePickerOptionsFromOpenAIForm,
    creativePickerSubmitResult,
    hasMcpAppCapability,
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
                    description : 'First direction',
                    image : 'data:image/png;base64,AA=='
                }]
            }
        },
        required : ['creative']
    }
};

function serverWithCapabilities(capabilities) {
    return { server: { getClientCapabilities: () => capabilities } };
}

describe('lib/mcp-streamable MCP Apps creative picker', () => {
    it('detects negotiated MCP Apps support from client capabilities', () => {
        assert.equal(hasMcpAppCapability(serverWithCapabilities({
            extensions : { [MCP_APP_EXTENSION]: { mimeTypes: [MCP_APP_MIME_TYPE] } }
        })), true);
        assert.equal(hasMcpAppCapability(serverWithCapabilities({
            extensions : { [MCP_APP_EXTENSION]: { mimeTypes: ['text/html'] } }
        })), false);
        assert.equal(hasMcpAppCapability(serverWithCapabilities({})), false);
    });

    it('accepts only the legacy OpenAI form-shaped flow payload for compatibility conversion', () => {
        assert.equal(isOpenAIForm(picker), true);
        assert.equal(isOpenAIForm({ mode: 'form', message: 'x', requestedSchema: {} }), false);
        assert.equal(isOpenAIForm(null), false);
    });

    it('converts an OpenAI imagePicker payload into an MCP Apps tool result', () => {
        const result = creativePickerAppResult(picker, serverWithCapabilities({
            extensions : { [MCP_APP_EXTENSION]: { mimeTypes: [MCP_APP_MIME_TYPE] } }
        }));

        assert.deepEqual(result, {
            content : [{ type: 'text', text: 'Choose a creative variant in the picker.' }],
            structuredContent : {
                title : 'Choose creative variants',
                selectionMode : 'single',
                options : [{
                    id : 'creative_a',
                    label : 'Creative A',
                    description : 'First direction',
                    image : 'data:image/png;base64,AA=='
                }]
            },
            _meta : {
                ui: { resourceUri: CREATIVE_PICKER_URI },
                [LEGACY_UI_RESOURCE_URI_META]: CREATIVE_PICKER_URI
            }
        });
    });

    it('keeps a useful text result when the client has not advertised MCP Apps', () => {
        const result = creativePickerAppResult(picker, serverWithCapabilities({ extensions: {} }));
        assert.equal(result.content[0].text, 'Choose a creative variant. MCP Apps UI is not advertised by this client connection.');
        assert.equal(result._meta.ui.resourceUri, CREATIVE_PICKER_URI);
        assert.equal(result.structuredContent.options[0].id, 'creative_a');
    });

    it('extracts picker options only from openai/imagePicker items', () => {
        assert.deepEqual(creativePickerOptionsFromOpenAIForm(picker), [{
            id : 'creative_a',
            label : 'Creative A',
            description : 'First direction',
            image : 'data:image/png;base64,AA=='
        }]);
        assert.deepEqual(creativePickerOptionsFromOpenAIForm({
            mode: 'openai/form', message: 'x', requestedSchema: { type: 'object', properties: {} }
        }), []);
    });

    it('routes mcpElicitation through MCP Apps instead of sending openai/form', async () => {
        const ctx = { mcpReq: { send: async () => { throw new Error('must not call openai/form'); } } };
        const result = await resolveFlowResult(ctx, serverWithCapabilities({
            extensions : { [MCP_APP_EXTENSION]: { mimeTypes: [MCP_APP_MIME_TYPE] } }
        }), { mcpElicitation: picker });

        assert.equal(result._meta.ui.resourceUri, CREATIVE_PICKER_URI);
        assert.equal(result.structuredContent.options[0].id, 'creative_a');
    });

    it('validates submit payloads from the MCP Apps picker', () => {
        assert.deepEqual(creativePickerSubmitResult({
            selectionMode: 'multiple', selectedIds: ['a', 'b'], feedback: 'Use a'
        }).structuredContent, {
            type: 'creative_picker_selection', selectionMode: 'multiple', selectedIds: ['a', 'b'], feedback: 'Use a'
        });
        const empty = creativePickerSubmitResult({ selectedIds: [] });
        assert.equal(empty.isError, true);
        assert.match(empty.content[0].text, /Select at least one/);
    });
});

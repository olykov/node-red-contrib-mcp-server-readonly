'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { PICKER_URI } = require('../lib/mcp-app-resources');
const {
    MCP_APP_EXTENSION,
    MCP_APP_MIME_TYPE,
    LEGACY_UI_RESOURCE_URI_META,
    pickerSubmitResult,
    sanitizePickerOptions,
    sanitizePickerResult,
    hasMcpAppCapability,
    resolveFlowResult
} = require('../lib/mcp-streamable');

function serverWithCapabilities(capabilities) {
    return { server: { getClientCapabilities: () => capabilities } };
}

const pickerResult = {
    content: [{ type: 'text', text: 'Choose an option.' }],
    structuredContent: {
        title: 'Choose an option',
        selectionMode: 'single',
        options: [{
            id: 'option_a',
            label: 'Option A',
            title: 'Title fallback must not win over label',
            description: 'First direction',
            image: 'must-be-dropped',
            src: 'https://example.invalid/image.png'
        }]
    },
    _meta: {
        ui: { resourceUri: PICKER_URI },
        [LEGACY_UI_RESOURCE_URI_META]: PICKER_URI
    }
};

describe('lib/mcp-streamable MCP Apps picker', () => {
    it('detects negotiated MCP Apps support from client capabilities', () => {
        assert.equal(hasMcpAppCapability(serverWithCapabilities({
            extensions : { [MCP_APP_EXTENSION]: { mimeTypes: [MCP_APP_MIME_TYPE] } }
        })), true);
        assert.equal(hasMcpAppCapability(serverWithCapabilities({
            extensions : { [MCP_APP_EXTENSION]: { mimeTypes: ['text/html'] } }
        })), false);
        assert.equal(hasMcpAppCapability(serverWithCapabilities({})), false);
    });

    it('sanitizes picker options to text-only fields', () => {
        assert.deepEqual(sanitizePickerOptions(pickerResult.structuredContent.options), [{
            id: 'option_a',
            label: 'Option A',
            description: 'First direction'
        }]);
        assert.deepEqual(sanitizePickerOptions([
            { id: ' a ', title: ' Title ' },
            { id: 'a', label: 'Duplicate ignored' },
            { id: '', label: 'Missing id ignored' }
        ]), [{ id: 'a', label: 'Title' }]);
    });

    it('sanitizes a picker MCP result and never returns images to the app', () => {
        const result = sanitizePickerResult(pickerResult, serverWithCapabilities({
            extensions : { [MCP_APP_EXTENSION]: { mimeTypes: [MCP_APP_MIME_TYPE] } }
        }));

        assert.equal(result._meta.ui.resourceUri, PICKER_URI);
        assert.equal(result._meta[LEGACY_UI_RESOURCE_URI_META], PICKER_URI);
        assert.deepEqual(result.structuredContent.options, [{
            id: 'option_a',
            label: 'Option A',
            description: 'First direction'
        }]);
        assert.equal(JSON.stringify(result).includes('must-be-dropped'), false);
        assert.equal(JSON.stringify(result).includes('example.invalid'), false);
    });

    it('rejects picker results without valid text options', () => {
        const result = sanitizePickerResult({
            structuredContent: { options: [] },
            _meta: { ui: { resourceUri: PICKER_URI } }
        }, serverWithCapabilities({}));
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /options must contain/);
    });

    it('passes non-picker MCP results through unchanged', () => {
        const plain = { content: [{ type: 'text', text: 'ok' }], structuredContent: { value: 1 } };
        assert.equal(sanitizePickerResult(plain, serverWithCapabilities({})), plain);
    });

    it('does not support legacy mcpElicitation openai/form compatibility', async () => {
        const result = await resolveFlowResult({}, serverWithCapabilities({}), {
            mcpElicitation: {
                mode: 'openai/form',
                message: 'Choose one.',
                requestedSchema: { type: 'object', properties: {} }
            }
        });
        assert.deepEqual(result, {
            content: [{ type: 'text', text: JSON.stringify({
                mcpElicitation: {
                    mode: 'openai/form',
                    message: 'Choose one.',
                    requestedSchema: { type: 'object', properties: {} }
                }
            }) }]
        });
    });

    it('validates submit payloads from the MCP Apps picker', () => {
        assert.deepEqual(pickerSubmitResult({
            selectionMode: 'multiple', selectedIds: ['a', 'b'], feedback: 'Use a'
        }).structuredContent, {
            type: 'picker_selection', selectionMode: 'multiple', selectedIds: ['a', 'b'], feedback: 'Use a'
        });
        const empty = pickerSubmitResult({ selectedIds: [] });
        assert.equal(empty.isError, true);
        assert.match(empty.content[0].text, /Select at least one/);
    });
});

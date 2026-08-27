'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const examplePath = path.join(__dirname, '..', 'examples', 'creative-picker.json');

describe('native creative-picker example', () => {
    it('uses one openai/imagePicker elicitation and no legacy HTML submit cycle', () => {
        const flow = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
        const input = flow.find(node => node.id === 'creative-picker-in');
        const builder = flow.find(node => node.id === 'creative-picker-function');

        assert.ok(input);
        assert.ok(builder);
        assert.match(input.description, /native Codex image-picker form/i);
        assert.match(builder.func, /mode: 'openai\/form'/);
        assert.match(builder.func, /type: 'openai\/imagePicker'/);
        assert.match(builder.func, /msg\.mcpElicitation/);
        assert.doesNotMatch(builder.func, /resourceUri|creative_picker_submit/);
        assert.equal(flow.some(node => String(node.id || '').startsWith('creative-picker-submit')), false);
    });
});

'use strict';

const assert = require('node:assert');
const vm = require('node:vm');
const { CREATIVE_PICKER_URI, MCP_APP_RESOURCES } = require('../lib/mcp-app-resources');

describe('creative-picker MCP App resource', function () {
    it('declares the standard MIME type and resource URI', function () {
        const resource = MCP_APP_RESOURCES[CREATIVE_PICKER_URI];
        assert.strictEqual(resource.uri, 'ui://creative-picker/variants.html');
        assert.strictEqual(resource.mimeType, 'text/html;profile=mcp-app');
    });

    it('completes the MCP Apps lifecycle before consuming tool results', function () {
        const html = MCP_APP_RESOURCES[CREATIVE_PICKER_URI].text;
        assert.match(html, /request\('ui\/initialize'/);
        assert.match(html, /protocolVersion:'2026-01-26'/);
        assert.match(html, /appCapabilities:\{availableDisplayModes:\['inline'\]\}/);
        assert.match(html, /method:'ui\/notifications\/initialized'/);
        assert.match(html, /message\.params\?\.arguments/);
        assert.match(html, /message\.params\?\.structuredContent/);
    });

    it('initializes, renders a multiple-choice result, and enables submission after selection', async function () {
        const html = MCP_APP_RESOURCES[CREATIVE_PICKER_URI].text;
        const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
        const sent = [];
        const listeners = {};
        const controls = [];
        const makeElement = () => ({
            children: [], disabled: false, listeners: {}, textContent: '', value: '',
            append(...children) { this.children.push(...children); },
            replaceChildren(...children) { this.children = children; },
            addEventListener(name, handler) { this.listeners[name] = handler; }
        });
        const elements = Object.fromEntries(['options', 'submit', 'status', 'title', 'intro', 'feedback']
            .map(id => [id, makeElement()]));
        const parent = { postMessage(message) { sent.push(message); } };
        const window = {
            parent,
            addEventListener(name, handler) { listeners[name] = handler; }
        };
        const document = {
            getElementById(id) { return elements[id]; },
            querySelectorAll(selector) {
                return selector === 'input[name=variant]:checked' ? controls.filter(control => control.checked) : [];
            },
            createElement(tag) {
                const element = makeElement();
                if (tag === 'input') controls.push(element);
                return element;
            }
        };

        vm.runInNewContext(script, { window, document, Map, Promise, console });
        assert.deepStrictEqual(JSON.parse(JSON.stringify(sent[0])), {
            jsonrpc: '2.0', id: 1, method: 'ui/initialize',
            params: {
                protocolVersion: '2026-01-26',
                appInfo: { name: 'Creative picker', version: '1.0.0' },
                appCapabilities: { availableDisplayModes: ['inline'] }
            }
        });

        listeners.message({ source: parent, data: { jsonrpc: '2.0', id: 1, result: {} } });
        await new Promise(resolve => setImmediate(resolve));
        assert.deepStrictEqual(JSON.parse(JSON.stringify(sent[1])), { jsonrpc: '2.0', method: 'ui/notifications/initialized' });

        listeners.message({ source: parent, data: {
            jsonrpc: '2.0', method: 'ui/notifications/tool-input',
            params: { arguments: { selectionMode: 'multiple' } }
        } });
        listeners.message({ source: parent, data: {
            jsonrpc: '2.0', method: 'ui/notifications/tool-result',
            params: { structuredContent: { selectionMode: 'multiple', options: [
                { id: 'option_a', label: 'A' }, { id: 'option_b', label: 'B' }
            ] } }
        } });

        assert.strictEqual(elements.options.children.length, 2);
        assert.deepStrictEqual(controls.map(control => control.type), ['checkbox', 'checkbox']);
        assert.strictEqual(elements.submit.disabled, true);
        controls[0].checked = true;
        controls[0].listeners.change();
        assert.strictEqual(elements.submit.disabled, false);
    });
});

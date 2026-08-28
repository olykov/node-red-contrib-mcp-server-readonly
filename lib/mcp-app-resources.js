'use strict';

const fs = require('fs');
const path = require('path');

const PICKER_URI = 'ui://picker/v4/options.html';

const MCP_APP_RESOURCES = Object.freeze({
    [PICKER_URI]: Object.freeze({
        uri: PICKER_URI,
        name: 'Picker',
        description: 'Interactive text-only picker for a small set of options.',
        mimeType: 'text/html;profile=mcp-app',
        text: fs.readFileSync(path.join(__dirname, '..', 'resources', 'picker.html'), 'utf8'),
        _meta: { ui: { prefersBorder: true } }
    })
});

module.exports = { PICKER_URI, MCP_APP_RESOURCES };

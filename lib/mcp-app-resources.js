'use strict';

const fs = require('fs');
const path = require('path');

const CREATIVE_PICKER_URI = 'ui://creative-picker/variants.html';

const MCP_APP_RESOURCES = Object.freeze({
    [CREATIVE_PICKER_URI]: Object.freeze({
        uri: CREATIVE_PICKER_URI,
        name: 'Creative variant picker',
        description: 'Interactive picker for a small set of creative variants.',
        mimeType: 'text/html;profile=mcp-app',
        text: fs.readFileSync(path.join(__dirname, '..', 'resources', 'creative-picker.html'), 'utf8'),
        _meta: { ui: { prefersBorder: true } }
    })
});

module.exports = { CREATIVE_PICKER_URI, MCP_APP_RESOURCES };

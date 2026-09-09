# Local Patch Set

Base: upstream `node-red-contrib-mcp-server@1.1.5`.

## Carried Local Changes

- package metadata is sanitized for this fork;
- `npm test` uses Node's built-in test runner instead of upstream's missing `test.js`;
- `mcp-flow-server` advertises `_meta.securitySchemes` when scopes are configured;
- `mcp-flow-server` exposes the text-only MCP Apps picker resource and `picker_submit`;
- optional read-only `get_flow` is available from `mcp-flow-server` when enabled;
- tests cover the read-only admin boundary and upstream flow-server execution contract.

## Deliberately Not Carried

- removed local compatibility nodes;
- dynamic client registration shim;
- client-registration endpoint;
- authorization-server metadata shim.

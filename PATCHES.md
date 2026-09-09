# Local Patch Set

Base: upstream `node-red-contrib-mcp-server@1.1.5`.

## Carried Local Changes

- package metadata is sanitized for this fork;
- `npm test` uses Node's built-in test runner instead of upstream's missing `test.js`;
- `mcp-endpoint` config nodes hold logical MCP name, HTTP path, base scopes, and optional read-only admin-tool settings;
- `mcp-flow-server` runs an MCP endpoint on a local HTTP port and keeps the upstream request/response flow contract;
- multiple `mcp-flow-server` nodes can share one HTTP port while serving separate endpoint paths;
- `mcp-tool-registry` supports optional binding to an `mcp-endpoint` config node;
- `mcp-tool-registry` can add per-tool required scopes to descriptor metadata;
- `mcp-flow-server` exposes the text-only MCP Apps picker resource and `picker_submit`;
- optional read-only `get_flow` is available from an endpoint when enabled;
- local tests cover the read-only admin boundary and flow-server execution contracts.

## Deliberately Not Carried

- removed local compatibility nodes;
- dynamic client registration shim;
- client-registration endpoint;
- authorization-server metadata shim.

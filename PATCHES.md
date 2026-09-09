# Local Patch Set

Base: upstream `node-red-contrib-mcp-server@1.1.5`.

## Carried Local Changes

- package metadata is sanitized for this fork;
- `npm test` uses Node's built-in test runner instead of upstream's missing `test.js`;
- `mcp-runtime` config nodes hold local listener settings: port, auto-start, CORS, and optional admin API settings;
- `mcp-flow-server` defines a logical MCP endpoint on a selected runtime and keeps the upstream request/response flow contract;
- multiple `mcp-flow-server` nodes can share one HTTP port while serving separate endpoint paths;
- one local port can be owned by only one `mcp-runtime` instance;
- `mcp-tool-registry` supports optional binding to an `mcp-flow-server` endpoint node;
- `mcp-tool-registry` can add per-tool required scopes to descriptor metadata;
- `mcp-flow-server` exposes the text-only MCP Apps picker resource and `picker_submit`;
- optional read-only `get_flow` is available only when runtime admin settings are complete and the endpoint path matches the configured admin endpoint path;
- local tests cover the read-only admin boundary and flow-server execution contracts.

## Deliberately Not Carried

- removed local compatibility nodes;
- dynamic client registration shim;
- client-registration endpoint;
- authorization-server metadata shim.

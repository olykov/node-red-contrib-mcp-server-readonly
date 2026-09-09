# Node-RED MCP Server Readonly

Upstream-first fork of `node-red-contrib-mcp-server@1.1.5` for internal MCP tool runtimes.

The package keeps the upstream node model and adds a small local patch set for read-oriented MCP Apps use cases. Public OAuth, CIMD, PKCE, and access-policy enforcement belong in the gateway layer in front of Node-RED.

## Scope

Included nodes:

- `mcp-server`
- `mcp-client`
- `mcp-tool`
- `mcp-flow-server`
- `mcp-tool-registry`

Local extensions:

- `_meta.securitySchemes` advertisement on tool descriptors when scopes are configured.
- Text-only MCP Apps picker resource and `picker_submit` helper tool.
- Optional read-only `get_flow` tool for Node-RED flow inspection.
- Tests for the read-only admin boundary and flow-server execution path.

Not included:

- OAuth authorization-server implementation.
- Dynamic client registration endpoints.
- Authorization-server metadata shim.
- Removed local compatibility nodes from earlier fork revisions.

## Architecture

Node-RED runs MCP tools and exposes the upstream MCP flow server. A separate gateway should handle public OAuth behavior, token validation, client metadata, and any internet-facing policy decisions.

Expected boundary:

```text
MCP client -> OAuth gateway -> Node-RED MCP flow server -> Node-RED flows
```

## Installation

From a Git reference:

```bash
cd ~/.node-red
npm install git+ssh://git@github.com/olykov/node-red-contrib-mcp-server-readonly.git#<commit>
```

For local development:

```bash
cd /path/to/node-red-contrib-mcp-server-readonly
npm install
npm test
npm link
cd ~/.node-red
npm link @olykov/node-red-contrib-mcp-server-readonly
```

## Flow Server Extensions

`mcp-flow-server` keeps the upstream request/response contract.

Tool execution request emitted by the flow server:

```js
msg.topic = 'mcp-tool-execute';
msg.payload = { toolName, arguments, executionId };
```

Tool response returned to the same flow server node:

```js
msg.topic = 'mcp-tool-response';
msg.payload = { executionId, result };
```

`result` can be a standard MCP result object. Plain strings and plain objects are normalized into text responses.

## Configuration Notes

`OAuth Scopes` only advertises scopes in tool metadata. It does not validate tokens and does not make Node-RED an OAuth server.

`Picker App` exposes the picker resource and `picker_submit` helper tool.

`Admin Tools` exposes read-only `get_flow`. Keep it disabled unless the MCP endpoint is protected by an authenticated gateway.

## Verification

Run before commit:

```bash
npm test
npm pack --dry-run
```

Run source scans before publishing to confirm that removed OAuth shim routes and sensitive material are absent.

## Upstream Updates

Keep upstream as the base. Pull new upstream releases into a candidate branch, then reapply the documented local patch set and run the verification suite.

## License

MIT. See `LICENSE`.

# Changelog

## 2.0.0-upstream.1

- Added `mcp-runtime` config nodes for shared local MCP listener settings.
- Moved logical MCP endpoint settings onto `mcp-flow-server`.
- Added endpoint dropdown binding and per-tool required scopes to `mcp-tool-registry`.
- Restricted read-only admin tools to the configured runtime admin endpoint path.
- Rebased the fork on upstream `node-red-contrib-mcp-server@1.1.5`.
- Kept upstream node types and flow-server execution behavior.
- Added read-oriented MCP Apps metadata support.
- Added text-only picker resource support.
- Added optional read-only Node-RED flow inspection.
- Added automated tests for local extensions.
- Removed earlier local OAuth registration shim behavior from this package.

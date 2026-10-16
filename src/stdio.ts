#!/usr/bin/env node
// stdio entrypoint — what `npx github:Walma-Labs/ga4-mcp` runs, for Claude Code,
// Claude Desktop (local dev servers), Cursor and any stdio MCP client.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGa4Server } from "./server.js";

const server = createGa4Server();
await server.connect(new StdioServerTransport());

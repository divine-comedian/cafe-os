#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CafeApiClient } from "./api-client.js";
import { loadConfig } from "./config.js";
import { registerCafeTools } from "./tools.js";

async function main(): Promise<void> {
  const client = new CafeApiClient(loadConfig());
  const server = new McpServer({ name: "cafe-os", version: "0.1.0" });
  registerCafeTools(server, client);
  await server.connect(new StdioServerTransport());
  console.error("Cafe OS MCP server connected over stdio.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

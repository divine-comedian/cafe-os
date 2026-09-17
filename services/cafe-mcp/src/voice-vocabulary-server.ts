#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerVoiceVocabularyTools } from "./voice-vocabulary.js";

async function main(): Promise<void> {
  const server = new McpServer({ name: "voice-vocabulary", version: "0.1.0" });
  registerVoiceVocabularyTools(server);
  await server.connect(new StdioServerTransport());
  console.error("Voice vocabulary MCP server connected over stdio.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

import os from "node:os";
import path from "node:path";

export interface McpConfig {
  apiUrl: string;
  apiToken: string;
  requestTimeoutMs: number;
  uploadRoots: string[];
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("CAFE_MCP_REQUEST_TIMEOUT_MS must be a positive integer.");
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const apiToken = env.CAFE_API_TOKEN?.trim();
  if (!apiToken) throw new Error("CAFE_API_TOKEN is required.");

  const apiUrl = (env.CAFE_API_URL ?? "http://127.0.0.1:8100").replace(/\/+$/, "");
  const defaultCacheRoot = path.join(env.HERMES_HOME ?? path.join(os.homedir(), ".hermes"), "cache");
  const uploadRoots = (env.CAFE_MCP_UPLOAD_ROOTS ?? defaultCacheRoot)
    .split(path.delimiter)
    .map((root) => root.trim())
    .filter(Boolean)
    .map((root) => path.resolve(root));

  return {
    apiUrl,
    apiToken,
    requestTimeoutMs: positiveInteger(env.CAFE_MCP_REQUEST_TIMEOUT_MS, 15_000),
    uploadRoots,
  };
}

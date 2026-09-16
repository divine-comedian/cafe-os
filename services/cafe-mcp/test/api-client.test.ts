import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CafeApiClient, CafeApiError } from "../src/api-client.js";

const servers: http.Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function listen(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server address");
  return `http://127.0.0.1:${address.port}`;
}

describe("CafeApiClient", () => {
  it("sends bearer-authenticated JSON and preserves structured API errors", async () => {
    const requests: Array<{ authorization?: string; body: string }> = [];
    const apiUrl = await listen(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push({ authorization: request.headers.authorization, body });
      response.writeHead(409, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "DEPENDENCY_CONFLICT" } }));
    });
    const client = new CafeApiClient({
      apiUrl,
      apiToken: "secret",
      requestTimeoutMs: 1_000,
      uploadRoots: [],
    });
    await expect(
      client.request("POST", "/providers", { name: "Finca" }),
    ).rejects.toMatchObject<Partial<CafeApiError>>({
      status: 409,
      payload: { error: { code: "DEPENDENCY_CONFLICT" } },
    });
    expect(requests).toEqual([
      { authorization: "Bearer secret", body: '{"name":"Finca"}' },
    ]);
  });

  it("uploads only regular files below an approved root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cafe-mcp-test-"));
    tempDirs.push(root);
    const filePath = path.join(root, "receipt.pdf");
    await fs.writeFile(filePath, "%PDF-1.4 test");
    let contentType = "";
    const apiUrl = await listen(async (request, response) => {
      contentType = request.headers["content-type"] ?? "";
      for await (const _chunk of request) {
        // Consume the multipart body.
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { document: { path: "receipt.pdf" } } }));
    });
    const client = new CafeApiClient({
      apiUrl,
      apiToken: "secret",
      requestTimeoutMs: 1_000,
      uploadRoots: [root],
    });
    await expect(
      client.uploadPurchaseDocument("purchase-id", filePath),
    ).resolves.toMatchObject({ data: {} });
    expect(contentType).toContain("multipart/form-data; boundary=");
    await expect(
      client.uploadPurchaseDocument("purchase-id", "/etc/hosts"),
    ).rejects.toThrow("outside CAFE_MCP_UPLOAD_ROOTS");
  });
});

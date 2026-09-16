import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CafeApiPort, JsonObject } from "../src/api-client.js";
import { registerCafeTools } from "../src/tools.js";

class FakeApi implements CafeApiPort {
  calls: Array<{ method: string; route: string; body?: JsonObject }> = [];
  responses: unknown[] = [];

  async request(method: string, route: string, body?: JsonObject): Promise<unknown> {
    this.calls.push({ method, route, body });
    if (this.responses.length) return this.responses.shift();
    return { data: { id: "saved-id", ...body } };
  }

  async uploadPurchaseDocument(purchaseId: string, filePath: string): Promise<unknown> {
    this.calls.push({ method: "UPLOAD", route: purchaseId, body: { filePath } });
    return { data: { document: { path: "stored/document.pdf" } } };
  }
}

describe("Cafe OS MCP tools", () => {
  let server: McpServer;
  let client: Client;
  let api: FakeApi;

  beforeEach(async () => {
    api = new FakeApi();
    server = new McpServer({ name: "test-cafe", version: "0.1.0" });
    registerCafeTools(server, api);
    client = new Client({ name: "test-client", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
  });

  it("exposes the reviewed Cafe-only operation and discovery surface", async () => {
    const response = await client.listTools();
    expect(response.tools.map((tool) => tool.name)).toEqual([
      "discover_tools",
      "query_records",
      "create_provider",
      "create_purchase",
      "create_green_coffee_lot",
      "create_roast_batch",
      "update_record",
      "set_record_status",
      "delete_record",
      "upload_purchase_document",
    ]);
    const query = response.tools.find((tool) => tool.name === "query_records");
    const deletion = response.tools.find((tool) => tool.name === "delete_record");
    expect(query?.annotations?.readOnlyHint).toBe(true);
    expect(deletion?.annotations?.destructiveHint).toBe(true);
  });

  it("matches the reviewed discoverable schema snapshot", async () => {
    const response = await client.listTools();
    const snapshot = JSON.parse(await fs.readFile(
      new URL("./fixtures/tool-catalog.snapshot.json", import.meta.url),
      "utf8",
    )) as { tool_names: string[]; normalized_schema_sha256: string };
    const normalized = response.tools.map(({ name, description, inputSchema, annotations }) => ({
      name,
      description,
      inputSchema,
      annotations,
    }));
    expect(normalized.map(({ name }) => name)).toEqual(snapshot.tool_names);
    expect(crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex"))
      .toBe(snapshot.normalized_schema_sha256);
  });

  it("discovers Cafe capabilities without reading business data", async () => {
    const response = await client.callTool({
      name: "discover_tools",
      arguments: { query: "adjuntar un recibo", limit: 3 },
    });
    expect(response.isError).not.toBe(true);
    expect(JSON.stringify(response.structuredContent)).toContain("upload_purchase_document");
    expect(api.calls).toHaveLength(0);
  });

  it("combines exact lookup and filtered lists in one read tool", async () => {
    const providerId = "8cbfaf51-b489-4d2e-86a6-c31a9d726c24";
    await client.callTool({
      name: "query_records",
      arguments: { resource: "provider", id: providerId },
    });
    await client.callTool({
      name: "query_records",
      arguments: { resource: "provider", name: "Sierra", limit: 5 },
    });
    await client.callTool({
      name: "query_records",
      arguments: {
        resource: "purchase",
        provider_id: providerId,
        status: "draft",
        limit: 10,
        offset: 5,
      },
    });
    expect(api.calls).toEqual([
      { method: "GET", route: `/providers/${providerId}`, body: undefined },
      {
        method: "GET",
        route: "/providers?limit=5&offset=0&name=Sierra",
        body: undefined,
      },
      {
        method: "GET",
        route: `/purchases?limit=10&offset=5&provider_id=${providerId}&status=draft`,
        body: undefined,
      },
    ]);
  });

  it("resolves a provider name and filters its purchase in one model-facing call", async () => {
    const providerId = "8cbfaf51-b489-4d2e-86a6-c31a9d726c24";
    api.responses.push(
      {
        data: [
          { id: providerId, name: "Café Sierra", region: "chiapas" },
          { id: crypto.randomUUID(), name: "Café Sierra Norte", region: "puebla" },
        ],
        meta: { match_count: 2, exact_match_count: 1, exact_match_ids: [providerId] },
      },
      { data: [{ id: crypto.randomUUID(), provider_id: providerId, purchased_at: "2026-09-14" }], meta: { match_count: 1 } },
    );
    const response = await client.callTool({
      name: "query_records",
      arguments: {
        resource: "purchase",
        provider_name: "Café Sierra",
        purchased_at: "2026-09-14",
        status: "draft",
      },
    });
    expect(response.isError).not.toBe(true);
    expect(api.calls).toEqual([
      { method: "GET", route: "/providers?limit=50&offset=0&name=Caf%C3%A9%20Sierra", body: undefined },
      {
        method: "GET",
        route: `/purchases?limit=50&offset=0&purchased_at=2026-09-14&status=draft&provider_id=${providerId}`,
        body: undefined,
      },
    ]);
    expect(response.structuredContent).toMatchObject({
      meta: { resolved_provider: { id: providerId, name: "Café Sierra" } },
    });
  });

  it("uses one typed update tool for all record kinds", async () => {
    const id = "5b8eddb3-dbc2-4c48-b33d-f8acc512681a";
    const prepared = await client.callTool({
      name: "update_record",
      arguments: {
        resource: "green_coffee_lot",
        id,
        fields: { origin: "Chiapas", unit_cost_per_kg: "188.50" },
      },
    });
    expect(prepared.isError).not.toBe(true);
    expect(api.calls).toHaveLength(0);
    const confirmationId = ((prepared.structuredContent as Record<string, unknown> | undefined)
      ?.pending_confirmation as Record<string, unknown>).id;
    const response = await client.callTool({
      name: "update_record",
      arguments: { confirmation_id: confirmationId },
    });
    expect(response.isError).not.toBe(true);
    expect(api.calls).toEqual([
      {
        method: "PATCH",
        route: `/green-coffee-lots/${id}`,
        body: { origin: "Chiapas", unit_cost_per_kg: "188.50" },
      },
    ]);
  });

  it("rejects fields that do not belong to the selected resource", async () => {
    const response = await client.callTool({
      name: "update_record",
      arguments: {
        resource: "provider",
        id: "5b8eddb3-dbc2-4c48-b33d-f8acc512681a",
        fields: { roasted_output_kg: 10 },
      },
    });
    expect(response.isError).toBe(true);
    expect(api.calls).toHaveLength(0);
  });
});
import crypto from "node:crypto";
import fs from "node:fs/promises";

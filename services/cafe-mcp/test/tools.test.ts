import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CafeApiPort, JsonObject } from "../src/api-client.js";
import { registerCafeTools } from "../src/tools.js";

class FakeApi implements CafeApiPort {
  calls: Array<{ method: string; route: string; body?: JsonObject }> = [];

  async request(method: string, route: string, body?: JsonObject): Promise<unknown> {
    this.calls.push({ method, route, body });
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

  it("exposes a compact, clearly annotated nine-tool surface", async () => {
    const response = await client.listTools();
    expect(response.tools.map((tool) => tool.name)).toEqual([
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

  it("combines exact lookup and filtered lists in one read tool", async () => {
    const providerId = "8cbfaf51-b489-4d2e-86a6-c31a9d726c24";
    await client.callTool({
      name: "query_records",
      arguments: { resource: "provider", id: providerId },
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
        route: `/purchases?limit=10&offset=5&provider_id=${providerId}&status=draft`,
        body: undefined,
      },
    ]);
  });

  it("uses one typed update tool for all record kinds", async () => {
    const id = "5b8eddb3-dbc2-4c48-b33d-f8acc512681a";
    const response = await client.callTool({
      name: "update_record",
      arguments: {
        resource: "green_coffee_lot",
        id,
        fields: { origin: "Chiapas", variety: "Bourbon" },
      },
    });
    expect(response.isError).not.toBe(true);
    expect(api.calls).toEqual([
      {
        method: "PATCH",
        route: `/green-coffee-lots/${id}`,
        body: { origin: "Chiapas", variety: "Bourbon" },
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

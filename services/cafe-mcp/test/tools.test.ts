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
      "void_roast_batch",
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

  it("prepares and creates a green-coffee lot without an optional variety", async () => {
    const blankVariety = await client.callTool({
      name: "create_green_coffee_lot",
      arguments: { name: "Lote feria", origin: "Chiapas", variety: "" },
    });
    expect(blankVariety.isError).toBe(true);

    const prepared = await client.callTool({
      name: "create_green_coffee_lot",
      arguments: { name: "Lote feria", origin: "Chiapas" },
    });
    expect(prepared.isError).not.toBe(true);
    expect(api.calls).toHaveLength(0);
    const confirmationId = ((prepared.structuredContent as Record<string, unknown> | undefined)
      ?.pending_confirmation as Record<string, unknown>).id;

    const saved = await client.callTool({
      name: "create_green_coffee_lot",
      arguments: { confirmation_id: confirmationId },
    });
    expect(saved.isError).not.toBe(true);
    expect(api.calls).toEqual([{
      method: "POST",
      route: "/green-coffee-lots",
      body: { name: "Lote feria", origin: "Chiapas" },
    }]);
  });

  it("resolves exact proposed names when a purchase completes an approved workflow", async () => {
    const purchase = {
      provider_name: "Finca Ejemplo",
      green_coffee_lot_name: "Lote Ejemplo 2026",
      purchased_at: "2026-09-19",
      received_weight_kg: 15,
      total_amount: 10_000,
      currency: "MXN",
    };
    const prepared = await client.callTool({
      name: "create_purchase",
      arguments: purchase,
    });
    expect(prepared.isError).not.toBe(true);
    expect(api.calls).toHaveLength(0);
    const confirmationId = ((prepared.structuredContent as Record<string, unknown> | undefined)
      ?.pending_confirmation as Record<string, unknown>).id;

    const providerId = crypto.randomUUID();
    const lotId = crypto.randomUUID();
    const purchaseId = crypto.randomUUID();
    api.responses.push(
      { data: [{ id: providerId, name: "Finca Ejemplo" }] },
      { data: [{ id: lotId, name: "Lote Ejemplo 2026" }] },
      { data: { id: purchaseId, received_weight_kg: "15.000" } },
    );
    const saved = await client.callTool({
      name: "create_purchase",
      arguments: { confirmation_id: confirmationId },
    });
    expect(saved.isError).not.toBe(true);
    expect(api.calls).toEqual([
      { method: "GET", route: "/providers?limit=100&offset=0&name=Finca%20Ejemplo", body: undefined },
      { method: "GET", route: "/green-coffee-lots?limit=100&offset=0&name=Lote%20Ejemplo%202026", body: undefined },
      {
        method: "POST",
        route: "/purchases",
        body: {
          provider_id: providerId,
          green_coffee_lot_id: lotId,
          purchased_at: "2026-09-19",
          received_weight_kg: 15,
          total_amount: 10_000,
          currency: "MXN",
        },
      },
    ]);
    expect(saved.structuredContent).toMatchObject({
      operation_receipt: { operation: "create", resource: "purchase", authoritative: true },
    });
  });

  it("does not expose draft or confirmed status on any record", async () => {
    const purchase = await client.callTool({
      name: "create_purchase",
      arguments: {
        provider_id: "8cbfaf51-b489-4d2e-86a6-c31a9d726c24",
        green_coffee_lot_id: "5b8eddb3-dbc2-4c48-b33d-f8acc512681a",
        received_weight_kg: 20,
        status: "confirmed",
      },
    });
    const lot = await client.callTool({
      name: "create_green_coffee_lot",
      arguments: { name: "Lote activo", status: "confirmed" },
    });
    const purchaseStatus = await client.callTool({
      name: "void_roast_batch",
      arguments: {
        resource: "purchase",
        id: "11111111-1111-4111-8111-111111111111",
      },
    });
    const purchaseFilter = await client.callTool({
      name: "query_records",
      arguments: { resource: "purchase", status: "draft" },
    });

    expect(purchase.isError).toBe(true);
    expect(lot.isError).toBe(true);
    expect(purchaseStatus.isError).toBe(true);
    expect(purchaseFilter.isError).toBe(true);
    expect(api.calls).toHaveLength(0);
  });

  it("prepares and voids a roast without deleting it", async () => {
    const id = "5b8eddb3-dbc2-4c48-b33d-f8acc512681a";
    const prepared = await client.callTool({
      name: "void_roast_batch",
      arguments: { resource: "roast_batch", id, reason: "Duplicate entry" },
    });
    expect(prepared.isError).not.toBe(true);
    expect(api.calls).toHaveLength(0);
    const confirmationId = ((prepared.structuredContent as Record<string, unknown> | undefined)
      ?.pending_confirmation as Record<string, unknown>).id;

    const response = await client.callTool({
      name: "void_roast_batch",
      arguments: { confirmation_id: confirmationId },
    });
    expect(response.isError).not.toBe(true);
    expect(api.calls).toEqual([{
      method: "POST",
      route: `/roast-batches/${id}/void`,
      body: { reason: "Duplicate entry" },
    }]);
  });

  it("combines exact lookup and filtered lists in one read tool", async () => {
    const providerId = "8cbfaf51-b489-4d2e-86a6-c31a9d726c24";
    api.responses.push(
      { data: { id: providerId, name: "Sierra" } },
      { data: [{ id: providerId, name: "Sierra" }], meta: { match_count: 1, exact_match_count: 1 } },
      { data: [], meta: { match_count: 0 } },
    );
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
        route: `/purchases?limit=10&offset=5&provider_id=${providerId}`,
        body: undefined,
      },
    ]);
  });

  it("returns bounded name suggestions after a likely transcription miss", async () => {
    api.responses.push(
      {
        data: [],
        meta: { match_count: 0, exact_match_count: 0, exact_match_ids: [], applied_filters: { name: "Moca Norte" } },
      },
      {
        data: [
          { id: crypto.randomUUID(), name: "Moka Norte", region: "sonora" },
          { id: crypto.randomUUID(), name: "Sierra Verde", region: "veracruz" },
        ],
        meta: { match_count: 2 },
      },
    );
    const response = await client.callTool({
      name: "query_records",
      arguments: { resource: "provider", name: "Moca Norte" },
    });
    expect(response.isError).not.toBe(true);
    expect(api.calls).toEqual([
      { method: "GET", route: "/providers?limit=50&offset=0&name=Moca+Norte", body: undefined },
      { method: "GET", route: "/providers?limit=100&offset=0", body: undefined },
    ]);
    expect(response.structuredContent).toMatchObject({
      data: [],
      meta: {
        match_count: 0,
        suggestion_count: 1,
        name_suggestions: [{ name: "Moka Norte", region: "sonora", similarity: 0.9 }],
      },
    });
    expect(JSON.stringify(response.structuredContent)).not.toContain("Sierra Verde");
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
      },
    });
    expect(response.isError).not.toBe(true);
    expect(api.calls).toEqual([
      { method: "GET", route: "/providers?limit=50&offset=0&name=Caf%C3%A9%20Sierra", body: undefined },
      {
        method: "GET",
        route: `/purchases?limit=50&offset=0&purchased_at=2026-09-14&provider_id=${providerId}`,
        body: undefined,
      },
    ]);
    expect(response.structuredContent).toMatchObject({
      meta: { resolved_provider: { id: providerId, name: "Café Sierra" } },
    });
  });

  it("uses one typed update tool for all record kinds", async () => {
    const id = "5b8eddb3-dbc2-4c48-b33d-f8acc512681a";
    api.responses.push(
      { data: { id, name: "Lote Norte" } },
      { data: { id, name: "Lote Norte", origin: "Chiapas", variety: "Bourbon" } },
    );
    const prepared = await client.callTool({
      name: "update_record",
      arguments: {
        resource: "green_coffee_lot",
        id,
        fields: { origin: "Chiapas", variety: "Bourbon" },
      },
    });
    expect(prepared.isError).not.toBe(true);
    expect(api.calls).toEqual([
      { method: "GET", route: `/green-coffee-lots/${id}`, body: undefined },
    ]);
    expect(prepared.structuredContent).toMatchObject({
      pending_confirmation: {
        display_target: { resource: "green_coffee_lot", name: "Lote Norte" },
      },
    });
    const confirmationId = ((prepared.structuredContent as Record<string, unknown> | undefined)
      ?.pending_confirmation as Record<string, unknown>).id;
    const response = await client.callTool({
      name: "update_record",
      arguments: { confirmation_id: confirmationId },
    });
    expect(response.isError).not.toBe(true);
    expect(api.calls).toEqual([
      { method: "GET", route: `/green-coffee-lots/${id}`, body: undefined },
      {
        method: "PATCH",
        route: `/green-coffee-lots/${id}`,
        body: { origin: "Chiapas", variety: "Bourbon" },
      },
    ]);
  });

  it("prepares and stores durable roast timing and complete control points", async () => {
    const id = "5b8eddb3-dbc2-4c48-b33d-f8acc512681a";
    const checkpoints = [
      { elapsed_seconds: 90, temperature_c: "102.5", note: "amarillo" },
      { elapsed_seconds: 420, temperature_c: "188", airflow_setting: "3", gas_setting: "2", note: "primer crack" },
    ];
    api.responses.push(
      { data: { id, name: "Tueste mañana", checkpoints: [checkpoints[0]] } },
      { data: { id, name: "Tueste mañana", duration_seconds: 615, checkpoints } },
    );
    const prepared = await client.callTool({
      name: "update_record",
      arguments: {
        resource: "roast_batch",
        id,
        fields: { duration_seconds: 615, checkpoints },
      },
    });
    expect(prepared.isError).not.toBe(true);
    expect(api.calls).toEqual([{ method: "GET", route: `/roast-batches/${id}`, body: undefined }]);

    const confirmationId = ((prepared.structuredContent as Record<string, unknown> | undefined)
      ?.pending_confirmation as Record<string, unknown>).id;
    const response = await client.callTool({
      name: "update_record",
      arguments: { confirmation_id: confirmationId },
    });
    expect(response.isError).not.toBe(true);
    expect(api.calls.at(-1)).toEqual({
      method: "PATCH",
      route: `/roast-batches/${id}`,
      body: { duration_seconds: 615, checkpoints },
    });
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

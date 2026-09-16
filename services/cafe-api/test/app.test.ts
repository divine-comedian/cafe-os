import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { Config } from "../src/config.js";
import { CafeStore, Row, TableName } from "../src/store.js";

const config: Config = {
  supabaseUrl: "http://supabase.invalid",
  supabaseServiceRoleKey: "test-service-key",
  apiToken: "test-api-token",
  storageBucket: "purchase-documents",
  host: "127.0.0.1",
  port: 8100,
  maxUploadBytes: 1024 * 1024,
};

class MemoryStore implements CafeStore {
  rows: Record<TableName, Row[]> = {
    providers: [],
    purchases: [],
    green_coffee_lots: [],
    roast_batches: [],
  };

  async list(
    table: TableName,
    filters: Record<string, unknown> = {},
    limit = 50,
    offset = 0,
    textSearch?: { field: "name"; query: string },
  ): Promise<Row[]> {
    return this.rows[table]
      .filter((row) => Object.entries(filters).every(([key, value]) => value === undefined || row[key] === value))
      .filter((row) => !textSearch || String(row[textSearch.field] ?? "").toLocaleLowerCase().includes(textSearch.query.toLocaleLowerCase()))
      .slice(offset, offset + limit);
  }
  async get(table: TableName, id: string): Promise<Row | null> {
    return this.rows[table].find((row) => row.id === id) ?? null;
  }
  async create(table: TableName, data: Row): Promise<Row> {
    const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...data };
    this.rows[table].push(row);
    return row;
  }
  async patch(table: TableName, id: string, data: Row): Promise<Row | null> {
    const row = await this.get(table, id);
    if (!row) return null;
    Object.assign(row, data);
    return row;
  }
  async delete(table: TableName, id: string): Promise<boolean> {
    const index = this.rows[table].findIndex((row) => row.id === id);
    if (index < 0) return false;
    this.rows[table].splice(index, 1);
    return true;
  }
  async count(table: TableName, filters: Record<string, unknown>): Promise<number> {
    return this.rows[table].filter((row) =>
      Object.entries(filters).every(([key, value]) => row[key] === value),
    ).length;
  }
  async uploadObject(): Promise<void> {}
  async downloadObject(): Promise<{ content: Buffer; mimeType: string }> {
    return { content: Buffer.from("%PDF-test"), mimeType: "application/pdf" };
  }
  async deleteObject(): Promise<void> {}
}

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("Cafe API", () => {
  it("protects API routes with a bearer token", async () => {
    const app = await buildApp({ config, store: new MemoryStore(), logger: false });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/v1/providers" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
  });

  it("normalizes provider input and rejects unknown fields", async () => {
    const app = await buildApp({ config, store: new MemoryStore(), logger: false });
    apps.push(app);
    const headers = { authorization: "Bearer test-api-token" };
    const created = await app.inject({
      method: "POST",
      url: "/v1/providers",
      headers,
      payload: { name: "  Finca   Norte ", region: " VERACRUZ " },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().data).toMatchObject({
      name: "Finca Norte",
      region: "veracruz",
    });

    const invalid = await app.inject({
      method: "POST",
      url: "/v1/providers",
      headers,
      payload: { name: "Example", unexpected: true },
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("accepts the purchase date and UUID shapes", async () => {
    const store = new MemoryStore();
    const providerId = crypto.randomUUID();
    store.rows.providers.push({ id: providerId, name: "Test" });
    const app = await buildApp({ config, store, logger: false });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/v1/purchases",
      headers: { authorization: "Bearer test-api-token" },
      payload: {
        provider_id: providerId,
        purchased_at: "2026-09-15",
        total_amount: "100.00",
        currency: " mxn ",
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().data.currency).toBe("MXN");
  });

  it("serves generated OpenAPI JSON", async () => {
    const app = await buildApp({ config, store: new MemoryStore(), logger: false });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(response.statusCode).toBe(200);
    expect(response.json().info.title).toBe("Cafe OS API");
  });

  it("searches display names without resolving ambiguous matches", async () => {
    const store = new MemoryStore();
    const cafeSierraId = crypto.randomUUID();
    store.rows.providers.push(
      { id: cafeSierraId, name: "Café Sierra" },
      { id: crypto.randomUUID(), name: "Sierra Verde" },
      { id: crypto.randomUUID(), name: "Costa Sur" },
    );
    const app = await buildApp({ config, store, logger: false });
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: "/v1/providers?name=Sierra",
      headers: { authorization: "Bearer test-api-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(2);
    expect(response.json().meta).toMatchObject({
      match_count: 2,
      exact_match_count: 0,
      exact_match_ids: [],
      applied_filters: { name: "Sierra" },
    });
    const exact = await app.inject({
      method: "GET",
      url: "/v1/providers?name=Caf%C3%A9%20Sierra",
      headers: { authorization: "Bearer test-api-token" },
    });
    expect(exact.statusCode).toBe(200);
    expect(exact.json().meta).toMatchObject({
      match_count: 1,
      exact_match_count: 1,
      exact_match_ids: [cafeSierraId],
    });
  });
});

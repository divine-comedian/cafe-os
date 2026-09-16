import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { AccessTokenVerifier } from "../src/auth.js";
import { Config } from "../src/config.js";
import { CafeStore, Row, TableName } from "../src/store.js";

const config: Config = {
  supabaseUrl: "http://supabase.invalid",
  supabasePublicUrl: "http://supabase.example.test",
  supabasePublishableKey: "test-publishable-key",
  supabaseServiceRoleKey: "test-service-key",
  apiToken: "test-api-token",
  storageBucket: "purchase-documents",
  host: "127.0.0.1",
  port: 8100,
  maxUploadBytes: 1024 * 1024,
};

const accessTokenVerifier: AccessTokenVerifier = {
  async verify(accessToken) {
    return accessToken === "valid-user-token"
      ? {
          id: "00000000-0000-4000-8000-000000000001",
          email: "operator@example.test",
        }
      : null;
  },
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

  it("accepts an authenticated Supabase user access token", async () => {
    const app = await buildApp({
      config,
      store: new MemoryStore(),
      accessTokenVerifier,
      logger: false,
    });
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: "/v1/providers",
      headers: { authorization: "Bearer valid-user-token" },
    });
    expect(response.statusCode).toBe(200);
  });

  it("publishes only browser-safe Supabase configuration", async () => {
    const app = await buildApp({
      config,
      store: new MemoryStore(),
      accessTokenVerifier,
      logger: false,
    });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/app-config.json" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      supabase_url: "http://supabase.example.test",
      supabase_publishable_key: "test-publishable-key",
    });
    expect(response.body).not.toContain("service-role");
  });

  it("accepts pagination on every filtered collection route", async () => {
    const app = await buildApp({
      config,
      store: new MemoryStore(),
      accessTokenVerifier,
      logger: false,
    });
    apps.push(app);
    const headers = { authorization: "Bearer test-api-token" };

    for (const path of [
      "/v1/purchases?limit=100&offset=0",
      "/v1/green-coffee-lots?limit=100&offset=0",
      "/v1/roast-batches?limit=100&offset=0",
    ]) {
      const response = await app.inject({ method: "GET", url: path, headers });
      expect(response.statusCode, path).toBe(200);
    }
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

  it("creates a purchase without a date and a new reusable green-coffee lot together", async () => {
    const store = new MemoryStore();
    const providerId = crypto.randomUUID();
    store.rows.providers.push({ id: providerId, name: "Finca Test" });
    const app = await buildApp({ config, store, logger: false });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/purchases/with-green-coffee-lot",
      headers: { authorization: "Bearer test-api-token" },
      payload: {
        provider_id: providerId,
        total_amount: "2400.00",
        currency: "MXN",
        received_weight_kg: "20.000",
        new_green_coffee_lot: {
          name: "Cosecha 2026",
          origin: " CHIAPAS ",
          variety: " BOURBON ",
        },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().data.green_coffee_lot).toMatchObject({
      origin: "chiapas",
      variety: "bourbon",
    });
    expect(response.json().data.purchase).toMatchObject({
      green_coffee_lot_id: response.json().data.green_coffee_lot.id,
      received_weight_kg: "20.000",
      status: "confirmed",
    });
    expect(store.rows.purchases).toHaveLength(1);
    expect(store.rows.green_coffee_lots).toHaveLength(1);
  });

  it("rolls back a newly created lot when its purchase cannot be created", async () => {
    class FailingPurchaseStore extends MemoryStore {
      override async create(table: TableName, data: Row): Promise<Row> {
        if (table === "purchases") throw new Error("simulated purchase failure");
        return super.create(table, data);
      }
    }
    const store = new FailingPurchaseStore();
    const providerId = crypto.randomUUID();
    store.rows.providers.push({ id: providerId, name: "Finca Test" });
    const app = await buildApp({ config, store, logger: false });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/purchases/with-green-coffee-lot",
      headers: { authorization: "Bearer test-api-token" },
      payload: {
        provider_id: providerId,
        purchased_at: "2026-09-16",
        total_amount: "2400.00",
        received_weight_kg: "20.000",
        new_green_coffee_lot: {
          name: "Cosecha 2026",
          variety: "bourbon",
        },
      },
    });

    expect(response.statusCode).toBe(500);
    expect(store.rows.purchases).toHaveLength(0);
    expect(store.rows.green_coffee_lots).toHaveLength(0);
  });

  it("associates multiple purchases with the same existing green-coffee lot", async () => {
    const store = new MemoryStore();
    const providerId = crypto.randomUUID();
    const lotId = crypto.randomUUID();
    store.rows.providers.push({ id: providerId, name: "Finca Test" });
    store.rows.green_coffee_lots.push({
      id: lotId,
      name: "Cosecha 2026",
      variety: "bourbon",
    });
    const app = await buildApp({ config, store, logger: false });
    apps.push(app);

    for (const total of ["1200.00", "2400.00"]) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/purchases/with-green-coffee-lot",
        headers: { authorization: "Bearer test-api-token" },
        payload: {
          provider_id: providerId,
          green_coffee_lot_id: lotId,
          purchased_at: "2026-09-16",
          received_weight_kg: "10.000",
          total_amount: total,
        },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().data.purchase.green_coffee_lot_id).toBe(lotId);
    }

    expect(store.rows.purchases).toHaveLength(2);
    expect(store.rows.green_coffee_lots).toHaveLength(1);
  });

  it("accepts the purchase date and UUID shapes", async () => {
    const store = new MemoryStore();
    const providerId = crypto.randomUUID();
    const lotId = crypto.randomUUID();
    store.rows.providers.push({ id: providerId, name: "Test" });
    store.rows.green_coffee_lots.push({ id: lotId, name: "Lot", variety: "typica" });
    const app = await buildApp({ config, store, logger: false });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/v1/purchases",
      headers: { authorization: "Bearer test-api-token" },
      payload: {
        provider_id: providerId,
        green_coffee_lot_id: lotId,
        purchased_at: "2026-09-15",
        received_weight_kg: "1.000",
        total_amount: "100.00",
        currency: " mxn ",
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().data.currency).toBe("MXN");
  });

  it("updates and confirms a draft purchase in one request", async () => {
    const store = new MemoryStore();
    const providerId = crypto.randomUUID();
    const lotId = crypto.randomUUID();
    const purchaseId = crypto.randomUUID();
    store.rows.providers.push({ id: providerId, name: "Test" });
    store.rows.green_coffee_lots.push({ id: lotId, name: "Lot", variety: "typica" });
    store.rows.purchases.push({
      id: purchaseId,
      provider_id: providerId,
      green_coffee_lot_id: lotId,
      received_weight_kg: "1.000",
      total_amount: null,
      currency: "MXN",
      status: "draft",
    });
    const app = await buildApp({ config, store, logger: false });
    apps.push(app);

    const response = await app.inject({
      method: "PUT",
      url: `/v1/purchases/${purchaseId}/confirm`,
      headers: { authorization: "Bearer test-api-token" },
      payload: {
        provider_id: providerId,
        green_coffee_lot_id: lotId,
        purchased_at: null,
        received_weight_kg: "12.500",
        total_amount: "1875.00",
        currency: "MXN",
        payment_method: " TRANSFERENCIA ",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      status: "confirmed",
      purchased_at: null,
      received_weight_kg: "12.500",
      total_amount: "1875.00",
      payment_method: "transferencia",
    });
  });

  it("aggregates purchases, subtracts prior roasts, and blocks excess green input", async () => {
    const store = new MemoryStore();
    const lotId = crypto.randomUUID();
    store.rows.green_coffee_lots.push({
      id: lotId,
      name: "Cosecha 2026",
      variety: "bourbon",
    });
    store.rows.purchases.push(
      {
        id: crypto.randomUUID(),
        green_coffee_lot_id: lotId,
        received_weight_kg: "10.000",
        status: "confirmed",
      },
      {
        id: crypto.randomUUID(),
        green_coffee_lot_id: lotId,
        received_weight_kg: "5.000",
        status: "confirmed",
      },
    );
    store.rows.roast_batches.push({
      id: crypto.randomUUID(),
      green_coffee_lot_id: lotId,
      green_input_kg: "4.000",
      roasted_output_kg: "3.400",
      status: "confirmed",
    });
    const app = await buildApp({ config, store, logger: false });
    apps.push(app);
    const headers = { authorization: "Bearer test-api-token" };

    const exactRemainder = await app.inject({
      method: "POST",
      url: "/v1/roast-batches/confirmed",
      headers,
      payload: {
        green_coffee_lot_id: lotId,
        roasted_at: "2026-09-16T15:30:00.000Z",
        green_input_kg: "11.000",
        roasted_output_kg: "9.400",
      },
    });
    expect(exactRemainder.statusCode).toBe(201);
    expect(exactRemainder.json().data).toMatchObject({
      green_input_kg: "11.000",
      status: "confirmed",
    });

    const excess = await app.inject({
      method: "POST",
      url: "/v1/roast-batches/confirmed",
      headers,
      payload: {
        green_coffee_lot_id: lotId,
        roasted_at: "2026-09-16T16:30:00.000Z",
        green_input_kg: "0.001",
        roasted_output_kg: "0.001",
      },
    });
    expect(excess.statusCode).toBe(422);
    expect(excess.json().error).toMatchObject({
      code: "INSUFFICIENT_GREEN_COFFEE",
      requested_kg: 0.001,
      available_kg: 0,
    });
    expect(store.rows.roast_batches).toHaveLength(2);
  });

  it("excludes the roast being edited from its inventory calculation", async () => {
    const store = new MemoryStore();
    const lotId = crypto.randomUUID();
    const roastId = crypto.randomUUID();
    store.rows.green_coffee_lots.push({ id: lotId, name: "Lot", variety: "typica" });
    store.rows.purchases.push({
      id: crypto.randomUUID(),
      green_coffee_lot_id: lotId,
      received_weight_kg: "10.000",
      status: "confirmed",
    });
    store.rows.roast_batches.push({
      id: roastId,
      green_coffee_lot_id: lotId,
      green_input_kg: "6.000",
      roasted_output_kg: "5.000",
      status: "confirmed",
    });
    const app = await buildApp({ config, store, logger: false });
    apps.push(app);

    const response = await app.inject({
      method: "PUT",
      url: `/v1/roast-batches/${roastId}/confirm`,
      headers: { authorization: "Bearer test-api-token" },
      payload: {
        green_coffee_lot_id: lotId,
        roasted_at: "2026-09-16T15:30:00.000Z",
        green_input_kg: "8.000",
        roasted_output_kg: "6.800",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      green_input_kg: "8.000",
      roasted_output_kg: "6.800",
      status: "confirmed",
    });
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

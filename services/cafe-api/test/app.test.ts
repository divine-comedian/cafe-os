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
  ): Promise<Row[]> {
    return this.rows[table]
      .filter((row) =>
        Object.entries(filters).every((entry) => entry[1] === undefined || row[entry[0]] === entry[1]),
      )
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

  it("serves generated OpenAPI JSON", async () => {
    const app = await buildApp({ config, store: new MemoryStore(), logger: false });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(response.statusCode).toBe(200);
    expect(response.json().info.title).toBe("Cafe OS API");
  });
});

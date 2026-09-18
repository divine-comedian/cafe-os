import http, { IncomingMessage, ServerResponse } from "node:http";
import { coreFixture } from "./fixtures.ts";
import type { CafeState, RecordedOperation, Row, TableName } from "./types.ts";

const routeTable: Record<string, TableName> = {
  providers: "providers",
  purchases: "purchases",
  "green-coffee-lots": "green_coffee_lots",
  "roast-batches": "roast_batches",
};

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of request) raw += String(chunk);
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

function normalizeText(value: unknown): unknown {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : value;
}

function normalizeDecimal(value: unknown): unknown {
  return value == null ? value : String(Number(value));
}

function normalizeRow(table: TableName, fields: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...fields };
  const displayText = ["name", "notes"];
  const lowerText = table === "providers"
    ? ["region"]
    : table === "purchases"
      ? ["payment_method"]
      : table === "green_coffee_lots"
        ? ["origin", "variety"]
        : [];
  const decimals = table === "purchases"
    ? ["received_weight_kg", "total_amount"]
    : table === "green_coffee_lots"
      ? []
      : table === "roast_batches"
        ? ["green_input_kg", "roasted_output_kg"]
        : [];

  for (const key of displayText) {
    if (key in normalized) normalized[key] = normalizeText(normalized[key]);
  }
  for (const key of lowerText) {
    if (typeof normalized[key] === "string") normalized[key] = String(normalizeText(normalized[key])).toLocaleLowerCase();
  }
  for (const key of decimals) {
    if (key in normalized) normalized[key] = normalizeDecimal(normalized[key]);
  }
  if (table === "purchases" && "currency" in normalized) {
    normalized.currency = String(normalized.currency ?? "MXN").trim().toUpperCase();
  }
  return normalized;
}

async function drain(request: IncomingMessage): Promise<void> {
  for await (const _chunk of request) {
    // Consume the multipart request so the client can complete cleanly.
  }
}

function nextId(counter: number): string {
  return `99999999-9999-4999-8999-${String(counter).padStart(12, "0")}`;
}

export class MockCafeApi {
  private server?: http.Server;
  private counter = 1;
  state: CafeState = coreFixture();
  operations: RecordedOperation[] = [];
  readonly token = "cafe-eval-token";

  reset(): void {
    this.counter = 1;
    this.state = coreFixture();
    this.operations = [];
  }

  snapshot(): CafeState {
    return structuredClone(this.state);
  }

  async start(): Promise<string> {
    this.server = http.createServer((request, response) => {
      this.handle(request, response).catch((error: unknown) => {
        json(response, 500, { error: { code: "MOCK_ERROR", message: error instanceof Error ? error.message : String(error) } });
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Mock API did not bind a TCP port.");
    return `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => this.server?.close((error) => error ? reject(error) : resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.authorization !== `Bearer ${this.token}`) {
      return json(response, 401, { error: { code: "UNAUTHORIZED", message: "Invalid eval token." } });
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] !== "v1" || !routeTable[segments[1]]) {
      return json(response, 404, { error: { code: "NOT_FOUND" } });
    }
    const table = routeTable[segments[1]];
    const id = segments[2];
    const action = segments[3];
    const method = request.method ?? "GET";

    if (method === "GET" && !id) {
      const filters = Object.fromEntries(url.searchParams.entries());
      const limit = Number(filters.limit ?? 50);
      const offset = Number(filters.offset ?? 0);
      delete filters.limit;
      delete filters.offset;
      const name = filters.name;
      delete filters.name;
      const rows = this.state[table].filter((row) =>
        Object.entries(filters).every(([key, value]) => String(row[key]) === value)
        && (!name || String(row.name ?? "").toLocaleLowerCase().includes(name.toLocaleLowerCase())),
      );
      const requestedName = name?.trim().toLocaleLowerCase();
      const exactMatches = requestedName
        ? rows.filter((row) => typeof row.name === "string" && row.name.trim().toLocaleLowerCase() === requestedName)
        : [];
      return json(response, 200, {
        data: rows.slice(offset, offset + limit),
        meta: {
          limit,
          offset,
          count: rows.length,
          match_count: rows.length,
          ...(requestedName ? {
            exact_match_count: exactMatches.length,
            exact_match_ids: exactMatches.map((row) => row.id),
          } : {}),
          applied_filters: { ...filters, ...(name ? { name } : {}) },
        },
      });
    }

    const row = id ? this.state[table].find((item) => item.id === id) : undefined;
    if (method === "GET" && id) {
      if (!row) return json(response, 404, { error: { code: "NOT_FOUND" } });
      if (table === "roast_batches") {
        const green = Number(row.green_input_kg);
        const roasted = Number(row.roasted_output_kg);
        const metrics = Number.isFinite(green) && green > 0 && Number.isFinite(roasted)
          ? { roast_loss_percent: ((green - roasted) / green) * 100 }
          : { roast_loss_percent: null };
        return json(response, 200, { data: { ...row, metrics } });
      }
      return json(response, 200, { data: row });
    }

    if (method === "POST" && !id) {
      const body = await readJson(request);
      const created: Row = { id: nextId(this.counter++), ...normalizeRow(table, body) };
      if (table === "roast_batches") {
        created.name ??= null;
        created.roast_date ??= null;
        created.roasted_at ??= null;
        created.green_input_kg ??= null;
        created.roasted_output_kg ??= null;
        created.duration_seconds ??= null;
        created.machine_settings ??= null;
        created.charge_temperature_c ??= null;
        created.balance_point_temperature_c ??= null;
        created.setup_notes ??= null;
        created.sensory_rating ??= null;
        created.tasting_notes ??= null;
        created.notes ??= null;
        created.voided_at = null;
        created.void_reason = null;
        created.checkpoints ??= [];
      }
      if (table === "purchases") {
        if (!("currency" in created)) created.currency = "MXN";
        created.document_path = null;
      }
      if (table === "green_coffee_lots") {
        if (!("origin" in created)) created.origin = null;
        if (!("variety" in created)) created.variety = null;
        if (!("notes" in created)) created.notes = null;
      }
      this.state[table].push(created);
      this.operations.push({ method, path: url.pathname, body });
      return json(response, 201, { data: created });
    }

    if (!row || !id) return json(response, 404, { error: { code: "NOT_FOUND" } });

    if (method === "PATCH") {
      const body = await readJson(request);
      Object.assign(row, normalizeRow(table, body));
      this.operations.push({ method, path: url.pathname, body });
      return json(response, 200, { data: row });
    }

    if (method === "PUT" && table === "purchases" && action === "document") {
      await drain(request);
      row.document_path = `purchases/${id}/eval-receipt.png`;
      this.operations.push({ method, path: url.pathname, body: { document_path: row.document_path } });
      return json(response, 200, {
        data: row,
        document: { path: row.document_path, content_type: request.headers["content-type"] },
      });
    }

    if (method === "POST" && table === "roast_batches" && action === "void") {
      const body = await readJson(request);
      row.voided_at = new Date().toISOString();
      row.void_reason = body.reason ?? null;
      this.operations.push({ method, path: url.pathname, body });
      return json(response, 200, { data: row });
    }

    if (method === "DELETE") {
      this.operations.push({ method, path: url.pathname });
      const dependencies: Record<string, number> = {};
      if (table === "providers") dependencies.purchases = this.state.purchases.filter((item) => item.provider_id === id).length;
      if (table === "green_coffee_lots") {
        dependencies.purchases = this.state.purchases.filter((item) => item.green_coffee_lot_id === id).length;
        dependencies.roast_batches = this.state.roast_batches.filter((item) => item.green_coffee_lot_id === id).length;
      }
      for (const key of Object.keys(dependencies)) if (!dependencies[key]) delete dependencies[key];
      if (Object.keys(dependencies).length) {
        return json(response, 409, { error: { code: "DEPENDENCY_CONFLICT", dependencies } });
      }
      this.state[table] = this.state[table].filter((item) => item.id !== id);
      response.writeHead(204);
      response.end();
      return;
    }

    return json(response, 405, { error: { code: "METHOD_NOT_ALLOWED" } });
  }
}

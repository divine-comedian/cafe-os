import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { ApiError } from "./errors.js";

export type TableName =
  | "providers"
  | "purchases"
  | "green_coffee_lots"
  | "roast_batches";

export type Row = Record<string, unknown>;

export interface CafeStore {
  list(
    table: TableName,
    filters?: Record<string, unknown>,
    limit?: number,
    offset?: number,
  ): Promise<Row[]>;
  get(table: TableName, id: string): Promise<Row | null>;
  create(table: TableName, data: Row): Promise<Row>;
  patch(table: TableName, id: string, data: Row): Promise<Row | null>;
  delete(table: TableName, id: string): Promise<boolean>;
  count(table: TableName, filters: Record<string, unknown>): Promise<number>;
  uploadObject(path: string, content: Buffer, mimeType: string): Promise<void>;
  downloadObject(path: string): Promise<{ content: Buffer; mimeType: string }>;
  deleteObject(path: string): Promise<void>;
}

function mapError(error: { code?: string; message: string }): ApiError {
  const details = error.code ? { upstream_code: error.code } : {};
  if (error.code === "23503") {
    return new ApiError(409, "DEPENDENCY_CONFLICT", error.message, details);
  }
  if (["23502", "23505", "23514", "22P02"].includes(error.code || "")) {
    return new ApiError(422, "VALIDATION_ERROR", error.message, details);
  }
  return new ApiError(502, "SUPABASE_ERROR", error.message, details);
}

export class SupabaseStore implements CafeStore {
  private readonly client: SupabaseClient;

  constructor(
    url: string,
    serviceRoleKey: string,
    private readonly bucket: string,
  ) {
    this.client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { "X-Client-Info": "cafe-os-api/0.1.0" } },
    });
  }

  async list(
    table: TableName,
    filters: Record<string, unknown> = {},
    limit = 50,
    offset = 0,
  ): Promise<Row[]> {
    let query = this.client
      .from(table)
      .select("*")
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    for (const [field, value] of Object.entries(filters)) {
      if (value !== undefined && value !== null) query = query.eq(field, value);
    }
    const { data, error } = await query;
    if (error) throw mapError(error);
    return (data || []) as Row[];
  }

  async get(table: TableName, id: string): Promise<Row | null> {
    const { data, error } = await this.client
      .from(table)
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw mapError(error);
    return data as Row | null;
  }

  async create(table: TableName, input: Row): Promise<Row> {
    const { data, error } = await this.client
      .from(table)
      .insert(input)
      .select("*")
      .single();
    if (error) throw mapError(error);
    return data as Row;
  }

  async patch(table: TableName, id: string, input: Row): Promise<Row | null> {
    const { data, error } = await this.client
      .from(table)
      .update(input)
      .eq("id", id)
      .select("*")
      .maybeSingle();
    if (error) throw mapError(error);
    return data as Row | null;
  }

  async delete(table: TableName, id: string): Promise<boolean> {
    const { data, error } = await this.client
      .from(table)
      .delete()
      .eq("id", id)
      .select("id");
    if (error) throw mapError(error);
    return Boolean(data?.length);
  }

  async count(table: TableName, filters: Record<string, unknown>): Promise<number> {
    let query = this.client.from(table).select("id", { count: "exact", head: true });
    for (const [field, value] of Object.entries(filters)) {
      query = query.eq(field, value);
    }
    const { count, error } = await query;
    if (error) throw mapError(error);
    return count || 0;
  }

  async uploadObject(path: string, content: Buffer, mimeType: string): Promise<void> {
    const { error } = await this.client.storage.from(this.bucket).upload(path, content, {
      contentType: mimeType,
      upsert: false,
    });
    if (error) throw new ApiError(502, "STORAGE_ERROR", error.message);
  }

  async downloadObject(path: string): Promise<{ content: Buffer; mimeType: string }> {
    const { data, error } = await this.client.storage.from(this.bucket).download(path);
    if (error) throw new ApiError(502, "STORAGE_ERROR", error.message);
    return {
      content: Buffer.from(await data.arrayBuffer()),
      mimeType: data.type || "application/octet-stream",
    };
  }

  async deleteObject(path: string): Promise<void> {
    const { error } = await this.client.storage.from(this.bucket).remove([path]);
    if (error) throw new ApiError(502, "STORAGE_ERROR", error.message);
  }
}

import fs from "node:fs/promises";
import path from "node:path";
import { McpConfig } from "./config.js";

export type JsonObject = Record<string, unknown>;

export interface CafeApiPort {
  request(method: string, route: string, body?: JsonObject): Promise<unknown>;
  uploadPurchaseDocument(purchaseId: string, suppliedPath: string): Promise<unknown>;
}

export class CafeApiError extends Error {
  constructor(
    readonly status: number,
    readonly payload: unknown,
  ) {
    super(`Cafe API request failed with HTTP ${status}.`);
  }
}

export class CafeApiClient implements CafeApiPort {
  constructor(private readonly config: McpConfig) {}

  async request(
    method: string,
    route: string,
    body?: JsonObject,
  ): Promise<unknown> {
    const response = await fetch(`${this.config.apiUrl}/v1${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.apiToken}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });
    return this.parseResponse(response);
  }

  async uploadPurchaseDocument(purchaseId: string, suppliedPath: string): Promise<unknown> {
    const filePath = await this.safeUploadPath(suppliedPath);
    const content = await fs.readFile(filePath);
    const form = new FormData();
    form.append("file", new Blob([content]), path.basename(filePath));
    const response = await fetch(
      `${this.config.apiUrl}/v1/purchases/${encodeURIComponent(purchaseId)}/document`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${this.config.apiToken}` },
        body: form,
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      },
    );
    return this.parseResponse(response);
  }

  private async parseResponse(response: Response): Promise<unknown> {
    if (response.status === 204) return { ok: true };
    const contentType = response.headers.get("content-type") ?? "";
    const payload = contentType.includes("application/json")
      ? await response.json()
      : { message: await response.text() };
    if (!response.ok) throw new CafeApiError(response.status, payload);
    return payload;
  }

  private async safeUploadPath(suppliedPath: string): Promise<string> {
    const resolved = await fs.realpath(path.resolve(suppliedPath));
    const allowed = this.config.uploadRoots.some((root) => {
      const relative = path.relative(root, resolved);
      return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
    });
    if (!allowed) {
      throw new Error(
        `Document path is outside CAFE_MCP_UPLOAD_ROOTS (${this.config.uploadRoots.join(", ")}).`,
      );
    }
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) throw new Error("Document path must refer to a regular file.");
    return resolved;
  }
}

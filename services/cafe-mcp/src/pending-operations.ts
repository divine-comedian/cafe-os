import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type PendingState = "pending" | "claimed" | "completed" | "failed" | "declined";

export interface PendingCafeOperation {
  id: string;
  contextId: string;
  toolName: string;
  canonicalArguments: Record<string, unknown>;
  summary: string;
  createdAt: string;
  expiresAt: string;
  state: PendingState;
  receipt?: unknown;
}

export interface PendingOperationConfig {
  directory: string;
  contextId: string;
  ttlMs: number;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadPendingOperationConfig(env: NodeJS.ProcessEnv = process.env): PendingOperationConfig {
  return {
    directory: env.CAFE_MCP_STATE_DIR?.trim() || path.join(os.tmpdir(), `cafe-os-mcp-${process.pid}`),
    contextId: env.CAFE_MCP_CONTEXT_ID?.trim() || "local-cafe-operator",
    ttlMs: positiveInteger(env.CAFE_MCP_PENDING_TTL_MS, 15 * 60 * 1_000),
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

export function canonicalArguments(input: Record<string, unknown>): Record<string, unknown> {
  return canonicalize(input) as Record<string, unknown>;
}

function summary(toolName: string, input: Record<string, unknown>): string {
  return `${toolName}: ${JSON.stringify(canonicalArguments(input))}`;
}

export class PendingOperationError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
  }
}

export class PendingOperationStore {
  constructor(private readonly config = loadPendingOperationConfig()) {}

  private file(id: string, state: PendingState): string {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new PendingOperationError("INVALID_CONFIRMATION_ID", "Malformed confirmation ID.");
    return path.join(this.config.directory, `${id}.${state}.json`);
  }

  private async initialize(): Promise<void> {
    await fs.mkdir(this.config.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.config.directory, 0o700);
  }

  private async write(filePath: string, operation: PendingCafeOperation, flag: "wx" | "w" = "wx"): Promise<void> {
    await fs.writeFile(filePath, `${JSON.stringify(operation)}\n`, { encoding: "utf8", mode: 0o600, flag });
  }

  async prepare(toolName: string, input: Record<string, unknown>): Promise<PendingCafeOperation> {
    await this.initialize();
    const now = new Date();
    const operation: PendingCafeOperation = {
      id: crypto.randomUUID(),
      contextId: this.config.contextId,
      toolName,
      canonicalArguments: canonicalArguments(input),
      summary: summary(toolName, input),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.config.ttlMs).toISOString(),
      state: "pending",
    };
    await this.write(this.file(operation.id, "pending"), operation);
    return operation;
  }

  async claim(id: string, expectedToolName: string): Promise<PendingCafeOperation> {
    await this.initialize();
    const pendingPath = this.file(id, "pending");
    const claimedPath = this.file(id, "claimed");
    try {
      await fs.rename(pendingPath, claimedPath);
    } catch (error) {
      const completed = await this.readIfExists(this.file(id, "completed"));
      if (completed) throw new PendingOperationError("ALREADY_COMPLETED", "This proposal already executed.");
      if (await this.readIfExists(claimedPath)) throw new PendingOperationError("ALREADY_CLAIMED", "This proposal is already being executed.");
      throw new PendingOperationError("PENDING_NOT_FOUND", "The proposal is missing or expired.");
    }
    const operation = await this.read(claimedPath);
    if (operation.contextId !== this.config.contextId) {
      await this.transition(operation, claimedPath, "failed");
      throw new PendingOperationError("CONTEXT_MISMATCH", "The proposal belongs to another operator context.");
    }
    if (operation.toolName !== expectedToolName) {
      await this.transition(operation, claimedPath, "failed");
      throw new PendingOperationError("TOOL_MISMATCH", "The proposal does not match this mutation tool.");
    }
    if (Date.parse(operation.expiresAt) <= Date.now()) {
      await this.transition(operation, claimedPath, "failed");
      throw new PendingOperationError("PENDING_EXPIRED", "The proposal expired; prepare it again.");
    }
    operation.state = "claimed";
    return operation;
  }

  async complete(operation: PendingCafeOperation, receipt: unknown): Promise<void> {
    operation.receipt = receipt;
    await this.transition(operation, this.file(operation.id, "claimed"), "completed");
  }

  async fail(operation: PendingCafeOperation): Promise<void> {
    await this.transition(operation, this.file(operation.id, "claimed"), "failed");
  }

  private async transition(operation: PendingCafeOperation, from: string, state: PendingState): Promise<void> {
    operation.state = state;
    const target = this.file(operation.id, state);
    await this.write(target, operation, "w");
    await fs.unlink(from).catch(() => undefined);
  }

  private async readIfExists(filePath: string): Promise<PendingCafeOperation | null> {
    try {
      return await this.read(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async read(filePath: string): Promise<PendingCafeOperation> {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as PendingCafeOperation;
    if (!parsed || typeof parsed !== "object" || typeof parsed.id !== "string") {
      throw new PendingOperationError("CORRUPT_PENDING_OPERATION", "Stored proposal is invalid.");
    }
    return parsed;
  }
}


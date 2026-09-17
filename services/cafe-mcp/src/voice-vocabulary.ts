import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { PendingOperationStore } from "./pending-operations.js";

export interface VocabularyEntry {
  term: string;
  aliases: string[];
}

interface VocabularyDocument {
  version: 1;
  entries: VocabularyEntry[];
}

export interface VoiceVocabularyConfig {
  file: string;
  pendingDirectory: string;
  contextId: string;
  ttlMs: number;
}

const MAX_ENTRIES = 500;
const termSchema = z.string().trim().min(1).max(120).refine((value) => !/[\r\n\u0000]/u.test(value), "term must be one line");
const aliasesSchema = z.array(termSchema).max(20);
const confirmationId = z.string().uuid();

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadVoiceVocabularyConfig(env: NodeJS.ProcessEnv = process.env): VoiceVocabularyConfig {
  const hermesHome = env.HERMES_HOME?.trim() || path.join(os.homedir(), ".hermes");
  const stateDirectory = path.join(hermesHome, "state", "voice-vocabulary");
  return {
    file: path.resolve(env.VOICE_VOCABULARY_PATH?.trim() || path.join(stateDirectory, "vocabulary.json")),
    pendingDirectory: path.resolve(env.VOICE_VOCABULARY_PENDING_DIR?.trim() || path.join(stateDirectory, "pending")),
    contextId: env.VOICE_VOCABULARY_CONTEXT_ID?.trim() || "cafe-operations",
    ttlMs: positiveInteger(env.VOICE_VOCABULARY_PENDING_TTL_MS, 15 * 60 * 1_000),
  };
}

function normalized(value: string): string {
  return value.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, " ").trim();
}

function canonicalEntry(term: string, aliases: string[]): VocabularyEntry {
  const cleanTerm = term.replace(/\s+/gu, " ").trim();
  const termKey = normalized(cleanTerm);
  const unique = new Map<string, string>();
  for (const alias of aliases) {
    const clean = alias.replace(/\s+/gu, " ").trim();
    const key = normalized(clean);
    if (key && key !== termKey && !unique.has(key)) unique.set(key, clean);
  }
  return { term: cleanTerm, aliases: [...unique.values()].sort((left, right) => left.localeCompare(right)) };
}

function validateDocument(value: unknown): VocabularyDocument {
  const parsed = z.object({
    version: z.literal(1),
    entries: z.array(z.object({ term: termSchema, aliases: aliasesSchema }).strict()).max(MAX_ENTRIES),
  }).strict().parse(value);
  const seen = new Map<string, string>();
  for (const entry of parsed.entries) {
    for (const form of [entry.term, ...entry.aliases]) {
      const key = normalized(form);
      const owner = seen.get(key);
      if (owner && normalized(owner) !== normalized(entry.term)) {
        throw new Error(`VOCABULARY_CONFLICT: "${form}" already belongs to "${owner}".`);
      }
      seen.set(key, entry.term);
    }
  }
  return parsed;
}

export class VoiceVocabularyStore {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(readonly file: string) {}

  private async serialize<T>(mutation: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueue;
    let release = (): void => undefined;
    this.mutationQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await mutation();
    } finally {
      release();
    }
  }

  async read(): Promise<VocabularyDocument> {
    try {
      return validateDocument(JSON.parse(await fs.readFile(this.file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, entries: [] };
      throw error;
    }
  }

  async find(term: string): Promise<VocabularyEntry | undefined> {
    const key = normalized(term);
    return (await this.read()).entries.find((candidate) => normalized(candidate.term) === key);
  }

  private async write(document: VocabularyDocument): Promise<void> {
    const checked = validateDocument(document);
    const directory = path.dirname(this.file);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    const temporary = path.join(directory, `.vocabulary.${process.pid}.${crypto.randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, `${JSON.stringify(checked)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await fs.rename(temporary, this.file);
      await fs.chmod(this.file, 0o600);
    } finally {
      await fs.unlink(temporary).catch(() => undefined);
    }
  }

  async upsert(term: string, aliases: string[]): Promise<VocabularyEntry> {
    return this.serialize(async () => {
      const entry = canonicalEntry(term, aliases);
      const document = await this.read();
      const key = normalized(entry.term);
      const existing = document.entries.findIndex((candidate) => normalized(candidate.term) === key);
      if (existing >= 0) document.entries[existing] = entry;
      else document.entries.push(entry);
      document.entries.sort((left, right) => left.term.localeCompare(right.term));
      if (document.entries.length > MAX_ENTRIES) throw new Error(`VOCABULARY_LIMIT: at most ${MAX_ENTRIES} entries are allowed.`);
      await this.write(document);
      return entry;
    });
  }

  async remove(term: string): Promise<VocabularyEntry> {
    return this.serialize(async () => {
      const document = await this.read();
      const index = document.entries.findIndex((candidate) => normalized(candidate.term) === normalized(term));
      if (index < 0) throw new Error(`VOCABULARY_NOT_FOUND: "${term}" is not in the known vocabulary.`);
      const [removed] = document.entries.splice(index, 1);
      await this.write(document);
      return removed;
    });
  }
}

function result(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function errorResult(error: unknown) {
  const payload = { ok: false, error: error instanceof Error ? error.message : "Unknown voice-vocabulary error." };
  return { ...result(payload), isError: true };
}

function proposalResult(operation: Awaited<ReturnType<PendingOperationStore["prepare"]>>) {
  return result({
    ok: true,
    pending_confirmation: {
      id: operation.id,
      tool_name: operation.toolName,
      canonical_arguments: operation.canonicalArguments,
      expires_at: operation.expiresAt,
      instruction: "Show the exact vocabulary change to the operator. After explicit approval in a later turn, call this tool with only confirmation_id.",
    },
  });
}

function proposalSchema<T extends z.ZodRawShape>(shape: T, required: string[]) {
  return z.object({ confirmation_id: confirmationId.optional(), ...shape }).strict().superRefine((value, context) => {
    const record = value as Record<string, unknown>;
    if (record.confirmation_id !== undefined) {
      if (Object.keys(value).length !== 1) context.addIssue({ code: "custom", message: "confirmation_id must be supplied alone" });
      return;
    }
    for (const field of required) {
      if ((value as Record<string, unknown>)[field] === undefined) context.addIssue({ code: "custom", path: [field], message: `${field} is required for a proposal` });
    }
  });
}

export function registerVoiceVocabularyTools(server: McpServer, config = loadVoiceVocabularyConfig()): void {
  const store = new VoiceVocabularyStore(config.file);
  const pending = new PendingOperationStore({ directory: config.pendingDirectory, contextId: config.contextId, ttlMs: config.ttlMs });

  server.registerTool("list_entries", {
    title: "Voice vocabulary — List entries",
    description: "List canonical terms and explicit ASR mishearing aliases. This reads only the private local voice vocabulary.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    try {
      const document = await store.read();
      return result({ ok: true, entries: document.entries, count: document.entries.length });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("upsert_entry", {
    title: "Voice vocabulary — Add or replace an entry",
    description: "Immediately add or update one canonical known voice term without a confirmation round trip. Aliases are optional overrides for exceptional mishearings because the resolver also performs conservative bilingual phonetic matching. Use when the operator states a durable term or after resolving an exact Cafe entity; never learn solely from an unverified transcript suggestion.",
    inputSchema: z.object({ term: termSchema, aliases: aliasesSchema.optional() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => {
    try {
      const existing = input.aliases === undefined ? await store.find(input.term) : undefined;
      const entry = await store.upsert(input.term, input.aliases ?? existing?.aliases ?? []);
      return result({
        ok: true,
        operation_receipt: { operation: "upsert", term: entry.term, aliases: entry.aliases, authoritative: true },
      });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("remove_entry", {
    title: "Voice vocabulary — Remove an entry",
    description: "Prepare or confirm removal of one canonical voice-vocabulary term. Removal requires the operator's explicit approval in a later turn.",
    inputSchema: proposalSchema({ term: termSchema.optional() }, ["term"]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (input) => {
    try {
      if (!input.confirmation_id) return proposalResult(await pending.prepare("remove_entry", { term: input.term! }));
      const operation = await pending.claim(input.confirmation_id, "remove_entry");
      try {
        const entry = await store.remove(String(operation.canonicalArguments.term));
        const receipt = { ok: true, operation_receipt: { operation: "remove", term: entry.term, authoritative: true } };
        await pending.complete(operation, receipt);
        return result(receipt);
      } catch (error) {
        await pending.fail(operation).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      return errorResult(error);
    }
  });
}

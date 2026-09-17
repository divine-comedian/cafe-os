import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPendingOperationConfig, PendingOperationStore } from "../src/pending-operations.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))));

async function store(contextId = "session-a") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cafe-pending-test-"));
  directories.push(directory);
  return new PendingOperationStore({ directory, contextId, ttlMs: 60_000 });
}

describe("pending Cafe operations", () => {
  it("keeps proposals resumable for seven days by default", () => {
    expect(loadPendingOperationConfig({}).ttlMs).toBe(7 * 24 * 60 * 60 * 1_000);
  });

  it("stores canonical arguments and claims once", async () => {
    const pending = await store();
    const prepared = await pending.prepare("create_provider", { notes: "n", name: "Morning profile" });
    expect(Object.keys(prepared.canonicalArguments)).toEqual(["name", "notes"]);
    const claimed = await pending.claim(prepared.id, "create_provider");
    await pending.complete(claimed, { id: "stored" });
    await expect(pending.claim(prepared.id, "create_provider")).rejects.toThrow("ALREADY_COMPLETED");
  });

  it("rejects a tool mismatch without executing", async () => {
    const pending = await store();
    const prepared = await pending.prepare("delete_record", { resource: "provider", id: crypto.randomUUID() });
    await expect(pending.claim(prepared.id, "update_record")).rejects.toThrow("TOOL_MISMATCH");
  });
});

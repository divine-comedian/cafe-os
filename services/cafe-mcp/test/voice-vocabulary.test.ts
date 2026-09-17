import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VoiceVocabularyStore } from "../src/voice-vocabulary.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))));

async function store(): Promise<VoiceVocabularyStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "voice-vocabulary-test-"));
  directories.push(directory);
  return new VoiceVocabularyStore(path.join(directory, "vocabulary.json"));
}

describe("voice vocabulary", () => {
  it("stores a canonical term with deduplicated aliases", async () => {
    const vocabulary = await store();
    await vocabulary.upsert("Chema", ["Sheema", " sheema ", "Chema"]);
    expect(await vocabulary.read()).toEqual({ version: 1, entries: [{ term: "Chema", aliases: ["Sheema"] }] });
  });

  it("rejects aliases owned by another term", async () => {
    const vocabulary = await store();
    await vocabulary.upsert("Chema", ["Sheema"]);
    await expect(vocabulary.upsert("Luis", ["Sheema"])).rejects.toThrow("VOCABULARY_CONFLICT");
  });

  it("removes entries case-insensitively", async () => {
    const vocabulary = await store();
    await vocabulary.upsert("Sierra Verde", ["Sierra Verdi"]);
    await expect(vocabulary.remove("sierra verde")).resolves.toMatchObject({ term: "Sierra Verde" });
    expect((await vocabulary.read()).entries).toEqual([]);
  });

  it("serializes concurrent updates without losing an entry", async () => {
    const vocabulary = await store();
    await Promise.all([
      vocabulary.upsert("Chema", ["Sheema"]),
      vocabulary.upsert("Sierra Verde", ["Sierra Verdi"]),
    ]);
    expect((await vocabulary.read()).entries.map((entry) => entry.term)).toEqual(["Chema", "Sierra Verde"]);
  });
});

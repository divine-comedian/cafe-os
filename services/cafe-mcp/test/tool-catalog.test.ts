import { describe, expect, it } from "vitest";
import { CAFE_TOOL_NAMES, discoverCafeTools } from "../src/tool-catalog.js";

describe("Cafe tool catalog", () => {
  it("keeps the reviewed operation names unique", () => {
    expect(new Set(CAFE_TOOL_NAMES).size).toBe(CAFE_TOOL_NAMES.length);
  });

  it("finds bilingual capabilities deterministically", () => {
    expect(discoverCafeTools("adjuntar recibo a una compra").map((entry) => entry.name)).toContain(
      "upload_purchase_document",
    );
    expect(discoverCafeTools("correct roast output").map((entry) => entry.name)).toContain(
      "update_record",
    );
  });
});

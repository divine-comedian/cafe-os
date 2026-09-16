import { describe, expect, it } from "vitest";
import {
  normalizeCurrency,
  normalizeDisplayText,
  normalizeLabel,
  normalizeNotes,
} from "../src/validation/normalize.js";

describe("normalization", () => {
  it("trims and lowercases categorical labels", () => {
    expect(normalizeLabel("  Natural   Process  ")).toBe("natural process");
  });

  it("preserves display capitalization", () => {
    expect(normalizeDisplayText("  Finca   El Río  ")).toBe("Finca El Río");
  });

  it("only trims notes", () => {
    expect(normalizeNotes("  First line\nSecond line  ")).toBe("First line\nSecond line");
  });

  it("standardizes currency", () => {
    expect(normalizeCurrency(" mxn ")).toBe("MXN");
  });
});

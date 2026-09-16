import { describe, expect, it } from "vitest";
import { ApiError } from "../src/errors.js";
import { detectMimeType, safeFilename } from "../src/validation/uploads.js";

describe("purchase document validation", () => {
  it("detects content signatures", () => {
    expect(detectMimeType(Buffer.from("%PDF-1.7\n"))).toBe("application/pdf");
    expect(detectMimeType(Buffer.from([0xff, 0xd8, 0xff, 0x00]))).toBe("image/jpeg");
  });

  it("rejects unknown content", () => {
    expect(() => detectMimeType(Buffer.from("not a document"))).toThrow(ApiError);
  });

  it("sanitizes names and uses the detected extension", () => {
    expect(safeFilename("../../Receipt Final.EXE", "application/pdf")).toMatch(
      /^[0-9a-f-]+-receipt-final\.pdf$/,
    );
  });
});

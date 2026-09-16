import path from "node:path";
import { randomUUID } from "node:crypto";
import { ApiError } from "../errors.js";

const extensions: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/heic": ".heic",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

export function detectMimeType(content: Buffer): string {
  if (content.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    return "application/pdf";
  }
  if (content.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return "image/jpeg";
  }
  if (
    content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (
    content.length >= 12 &&
    content.subarray(0, 4).toString("ascii") === "RIFF" &&
    content.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (content.length >= 12 && content.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = content.subarray(8, 12).toString("ascii");
    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand)) {
      return "image/heic";
    }
  }
  throw new ApiError(
    422,
    "UNSUPPORTED_DOCUMENT_TYPE",
    "The document must be a PDF, JPEG, PNG, WebP, or HEIC file.",
  );
}

export function safeFilename(filename: string | undefined, mimeType: string): string {
  const originalStem = path.parse(filename || "document").name;
  const stem =
    originalStem
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^[-_]+|[-_]+$/g, "")
      .toLowerCase()
      .slice(0, 80) || "document";
  return `${randomUUID()}-${stem}${extensions[mimeType]}`;
}

export function purchaseDocumentPath(
  providerId: string,
  purchaseId: string,
  filename: string | undefined,
  mimeType: string,
): string {
  return `providers/${providerId}/purchases/${purchaseId}/${safeFilename(filename, mimeType)}`;
}

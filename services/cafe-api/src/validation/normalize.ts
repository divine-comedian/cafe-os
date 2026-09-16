import { ApiError } from "../errors.js";

const whitespace = /\s+/g;

export function normalizeLabel(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim().replace(whitespace, " ").toLowerCase();
  return normalized || null;
}

export function normalizeDisplayText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim().replace(whitespace, " ");
  return normalized || null;
}

export function normalizeNotes(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

export function requireDisplayText(value: unknown, field: string): string {
  const normalized = normalizeDisplayText(value);
  if (!normalized) {
    throw new ApiError(422, "VALIDATION_ERROR", `${field} is required.`, {
      field,
    });
  }
  return normalized;
}

export function normalizeCurrency(value: unknown): string {
  const normalized = String(value).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      "currency must contain exactly three letters.",
      { field: "currency" },
    );
  }
  return normalized;
}

export function normalizeDecimal(
  value: string | number | null | undefined,
  field: string,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  const normalized = String(value).trim();
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(normalized)) {
    throw new ApiError(422, "VALIDATION_ERROR", `${field} must be a number.`, {
      field,
    });
  }
  const numeric = Number(normalized);
  if (!Number.isFinite(numeric)) {
    throw new ApiError(422, "VALIDATION_ERROR", `${field} must be finite.`, {
      field,
    });
  }
  return normalized;
}

export function hasOwn(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

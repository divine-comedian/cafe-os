export interface Config {
  supabaseUrl: string;
  supabasePublicUrl: string;
  supabasePublishableKey: string;
  supabaseServiceRoleKey: string;
  apiToken: string;
  storageBucket: string;
  host: string;
  port: number;
  maxUploadBytes: number;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Required environment variable ${name} is missing`);
  }
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function loadConfig(): Config {
  return {
    supabaseUrl: required("SUPABASE_URL").replace(/\/$/, ""),
    supabasePublicUrl: required("SUPABASE_PUBLIC_URL").replace(/\/$/, ""),
    supabasePublishableKey: required("SUPABASE_PUBLISHABLE_KEY"),
    supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
    apiToken: required("CAFE_API_TOKEN"),
    storageBucket:
      process.env.PURCHASE_DOCUMENT_BUCKET?.trim() || "purchase-documents",
    host: process.env.HOST?.trim() || "0.0.0.0",
    port: positiveInteger("PORT", 8100),
    maxUploadBytes: positiveInteger("MAX_UPLOAD_BYTES", 15 * 1024 * 1024),
  };
}

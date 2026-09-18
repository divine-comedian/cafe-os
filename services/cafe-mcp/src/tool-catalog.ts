export const CAFE_TOOL_NAMES = [
  "discover_tools",
  "query_records",
  "create_provider",
  "create_purchase",
  "create_green_coffee_lot",
  "create_roast_batch",
  "update_record",
  "void_roast_batch",
  "delete_record",
  "upload_purchase_document",
] as const;

export type CafeToolName = (typeof CAFE_TOOL_NAMES)[number];

export interface CafeToolCatalogEntry {
  name: CafeToolName;
  kind: "read" | "write" | "delete" | "upload";
  description: string;
  searchTerms: string[];
}

export const CAFE_TOOL_CATALOG: readonly CafeToolCatalogEntry[] = [
  {
    name: "discover_tools",
    kind: "read",
    description: "Search the Cafe OS capability catalog when the active tools cannot satisfy a request.",
    searchTerms: ["discover", "capability", "tool", "find tool", "descubrir", "capacidad", "herramienta"],
  },
  {
    name: "query_records",
    kind: "read",
    description: "Read, search, filter, or trace providers, purchases, green coffee lots, and roast batches.",
    searchTerms: ["find", "list", "read", "search", "lookup", "trace", "provider", "purchase", "lot", "roast", "buscar", "listar", "consultar", "trazar", "proveedor", "compra", "lote", "tueste"],
  },
  {
    name: "create_provider",
    kind: "write",
    description: "Create a coffee provider after human confirmation.",
    searchTerms: ["create", "add", "provider", "supplier", "crear", "agregar", "alta", "proveedor"],
  },
  {
    name: "create_purchase",
    kind: "write",
    description: "Create an active supplier purchase after human confirmation.",
    searchTerms: ["create", "add", "purchase", "invoice", "buy", "crear", "agregar", "compra", "factura"],
  },
  {
    name: "create_green_coffee_lot",
    kind: "write",
    description: "Create a reusable green coffee lot after human confirmation.",
    searchTerms: ["create", "add", "green", "coffee", "lot", "crear", "agregar", "cafe", "verde", "lote"],
  },
  {
    name: "create_roast_batch",
    kind: "write",
    description: "Create a progressive roast batch linked to a green coffee lot after human confirmation.",
    searchTerms: ["create", "add", "roast", "batch", "tueste", "tostado", "crear", "agregar"],
  },
  {
    name: "update_record",
    kind: "write",
    description: "Add or correct fields on an existing Cafe OS record.",
    searchTerms: ["update", "patch", "edit", "correct", "change", "actualizar", "editar", "corregir", "cambiar"],
  },
  {
    name: "void_roast_batch",
    kind: "write",
    description: "Void a roast batch without deleting its operational history.",
    searchTerms: ["roast", "void", "exclude", "tueste", "anular", "invalidar"],
  },
  {
    name: "delete_record",
    kind: "delete",
    description: "Permanently delete one dependency-free Cafe OS record after immediate confirmation.",
    searchTerms: ["delete", "remove", "permanent", "eliminar", "borrar", "permanente"],
  },
  {
    name: "upload_purchase_document",
    kind: "upload",
    description: "Attach or replace purchase evidence from an approved local attachment path.",
    searchTerms: ["upload", "attach", "receipt", "invoice", "document", "file", "subir", "adjuntar", "recibo", "factura", "archivo"],
  },
];

const NAME_SET = new Set<string>(CAFE_TOOL_NAMES);

export function isCafeToolName(value: string): value is CafeToolName {
  return NAME_SET.has(value);
}

export function shortCafeToolName(value: string): string {
  return value.split("__").at(-1) ?? value;
}

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function discoverCafeTools(query: string, limit = 5): CafeToolCatalogEntry[] {
  const tokens = [...new Set(normalize(query).split(" ").filter(Boolean))];
  return CAFE_TOOL_CATALOG
    .map((entry) => {
      const haystack = normalize(`${entry.name} ${entry.description} ${entry.searchTerms.join(" ")}`);
      const words = new Set(haystack.split(" "));
      const score = tokens.reduce(
        (total, token) => total + (words.has(token) ? 5 : haystack.includes(token) ? 2 : 0),
        0,
      );
      return { entry, score };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.entry.name.localeCompare(right.entry.name))
    .slice(0, Math.max(1, Math.min(limit, 5)))
    .map(({ entry }) => entry);
}

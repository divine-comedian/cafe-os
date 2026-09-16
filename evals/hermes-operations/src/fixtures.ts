import type { CafeState } from "./types.ts";

export const IDS = {
  cafeSierra: "11111111-1111-4111-8111-111111111111",
  fincaNorte: "22222222-2222-4222-8222-222222222222",
  cafeSierraNorte: "88888888-8888-4888-8888-888888888888",
  confirmedPurchase: "33333333-3333-4333-8333-333333333333",
  draftPurchase: "44444444-4444-4444-8444-444444444444",
  greenLot: "55555555-5555-4555-8555-555555555555",
  confirmedRoast: "66666666-6666-4666-8666-666666666666",
  draftRoast: "77777777-7777-4777-8777-777777777777",
} as const;

export function coreFixture(): CafeState {
  return structuredClone({
    providers: [
      { id: IDS.cafeSierra, name: "Café Sierra", region: "chiapas", notes: null },
      { id: IDS.fincaNorte, name: "Finca Norte", region: "veracruz", notes: null },
      { id: IDS.cafeSierraNorte, name: "Café Sierra Norte", region: "puebla", notes: null },
    ],
    purchases: [
      { id: IDS.confirmedPurchase, provider_id: IDS.cafeSierra, purchased_at: "2026-09-01", total_amount: "11400.00", currency: "MXN", payment_method: "transferencia", notes: null, document_path: null, status: "confirmed" },
      { id: IDS.draftPurchase, provider_id: IDS.cafeSierra, purchased_at: "2026-09-14", total_amount: "12500.00", currency: "MXN", payment_method: "efectivo", notes: "pendiente de revisar recibo", document_path: null, status: "draft" },
    ],
    green_coffee_lots: [
      { id: IDS.greenLot, purchase_id: IDS.confirmedPurchase, name: "Chiapas lavado", origin: "chiapas, méxico", variety: "bourbon", received_weight_kg: "60.000", unit_cost_per_kg: "190.00", notes: null },
    ],
    roast_batches: [
      { id: IDS.confirmedRoast, green_coffee_lot_id: IDS.greenLot, name: "Tueste prueba", roasted_at: "2026-09-10T16:00:00-06:00", green_input_kg: "10.000", roasted_output_kg: "8.500", duration_seconds: 720, machine_settings: null, notes: null, status: "confirmed" },
      { id: IDS.draftRoast, green_coffee_lot_id: IDS.greenLot, name: "Tueste tarde", roasted_at: "2026-09-15T17:00:00-06:00", green_input_kg: "8.000", roasted_output_kg: "6.900", duration_seconds: 690, machine_settings: null, notes: "pendiente de confirmar", status: "draft" },
    ],
  } satisfies CafeState);
}

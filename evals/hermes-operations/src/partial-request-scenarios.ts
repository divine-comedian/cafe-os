import { IDS } from "./fixtures.ts";
import type { EvalScenario } from "./types.ts";

export const partialRequestScenarios: EvalScenario[] = [
  {
    id: "partial_en_new_provider_lot_purchase_intake",
    locale: "en",
    description: "Collect one missing lot name, then create a provider, lot, and purchase through one proposal and one approval.",
    turns: [
      {
        prompt: "We received 15 kg from a new provider called Finca Ejemplo in Veracruz on 2026-09-19 and paid MXN 10,000. The lot is also from Veracruz, but I forgot to give you its name. Set up the provider, lot, and purchase.",
        expect: {
          allowedTools: ["query_records"], maxToolCalls: 1, maxApiCalls: 2, mutationCount: 0,
          responsePatterns: ["lot.*name|name.*lot"],
        },
      },
      {
        prompt: "Finca Ejemplo is definitely a separate new provider. The lot is called Lote Ejemplo 2026. Prepare the complete intake now.",
        expect: {
          requiredTools: ["create_provider", "create_green_coffee_lot", "create_purchase"],
          allowedTools: ["query_records", "create_provider", "create_green_coffee_lot", "create_purchase"],
          minToolCalls: 3, maxToolCalls: 4, maxApiCalls: 3, mutationCount: 0,
          responsePatterns: ["Finca Ejemplo", "Lote Ejemplo 2026", "15(?:\\.0+)?\\s*kg", "10[,.]?000", "confirm"],
          toolCallContains: [
            { name: "create_provider", arguments: { name: "Finca Ejemplo", region: "Veracruz" } },
            { name: "create_green_coffee_lot", arguments: { name: "Lote Ejemplo 2026", origin: "Veracruz" } },
            { name: "create_purchase", arguments: {
              provider_name: "Finca Ejemplo",
              green_coffee_lot_name: "Lote Ejemplo 2026",
              purchased_at: "2026-09-19",
              received_weight_kg: 15,
              total_amount: 10_000,
              currency: "MXN",
            } },
          ],
          terminalReason: "needs_confirmation",
        },
      },
      {
        prompt: "Approved. Record that complete intake exactly once.",
        expect: {
          requiredTools: ["create_provider", "create_green_coffee_lot", "create_purchase"],
          allowedTools: ["create_provider", "create_green_coffee_lot", "create_purchase"],
          minToolCalls: 3, maxToolCalls: 3, maxApiCalls: 3, mutationCount: 3,
          confirmationTools: ["create_provider", "create_green_coffee_lot", "create_purchase"], terminalReason: "completed",
          stateContains: [
            { table: "providers", fields: { name: "Finca Ejemplo", region: "veracruz" } },
            { table: "green_coffee_lots", fields: { name: "Lote Ejemplo 2026", origin: "veracruz" } },
            { table: "purchases", fields: { received_weight_kg: "15", total_amount: "10000", currency: "MXN" } },
          ],
        },
      },
    ],
  },
  {
    id: "partial_es_green_lot_optional_variety",
    locale: "es-MX",
    description: "Create a lot proposal without interrogating the operator for optional variety, then confirm it.",
    turns: [
      {
        prompt: "Anota un lote nuevo: se llama Lote feria y viene de Chiapas. No conozco la variedad; es todo lo que tengo por ahora.",
        expect: {
          requiredTools: ["create_green_coffee_lot"], allowedTools: ["create_green_coffee_lot"],
          minToolCalls: 1, maxToolCalls: 1, maxApiCalls: 2, mutationCount: 0,
          responsePatterns: ["Lote feria", "conf[ií]rm"],
          toolCallContains: [{ name: "create_green_coffee_lot", arguments: { name: "Lote feria", origin: "Chiapas" } }],
          toolCallOmits: [{ name: "create_green_coffee_lot", fields: ["variety", "notes"] }],
          terminalReason: "needs_confirmation",
        },
      },
      {
        prompt: "Sí, confirma exactamente ese lote.",
        expect: {
          requiredTools: ["create_green_coffee_lot"], allowedTools: ["create_green_coffee_lot"],
          minToolCalls: 1, maxToolCalls: 1, maxApiCalls: 2, mutationCount: 1,
          confirmationTools: ["create_green_coffee_lot"], terminalReason: "completed",
          stateContains: [{ table: "green_coffee_lots", fields: { name: "Lote feria", origin: "chiapas", variety: null } }],
        },
      },
    ],
  },
  {
    id: "partial_en_purchase_missing_weight",
    locale: "en",
    description: "Do not create a partial purchase; ask for required weight, then resolve both references and propose it.",
    turns: [
      {
        prompt: "Log a purchase from Finca Norte for the Chiapas lavado lot, MXN 4,200 by transfer. I do not know the received weight yet.",
        expect: {
          allowedTools: [], maxToolCalls: 0, maxApiCalls: 2, mutationCount: 0,
          responsePatterns: ["weight|how many", "kg|kilogram"],
          routerRequiresUserInput: ["received_weight_kg"], terminalReason: "needs_input",
        },
      },
      {
        prompt: "It was 22 kg. Prepare the exact draft using the earlier details.",
        expect: {
          requiredTools: ["query_records", "create_purchase"], allowedTools: ["query_records", "create_purchase"],
          minToolCalls: 3, maxToolCalls: 3, maxApiCalls: 4, mutationCount: 0,
          responsePatterns: ["22(?:\\.0+)?\\s*kg", "4[,.]?200", "confirm"],
          toolCallContains: [{ name: "create_purchase", arguments: { provider_id: IDS.fincaNorte, green_coffee_lot_id: IDS.greenLot, received_weight_kg: 22, total_amount: 4200, currency: "MXN", payment_method: "transfer" } }],
          toolCallOmits: [{ name: "create_purchase", fields: ["purchased_at", "notes"] }],
          terminalReason: "needs_confirmation",
        },
      },
      {
        prompt: "Confirmed. Save exactly that purchase.",
        expect: {
          requiredTools: ["create_purchase"], allowedTools: ["create_purchase"],
          minToolCalls: 1, maxToolCalls: 1, maxApiCalls: 2, mutationCount: 1,
          confirmationTools: ["create_purchase"], terminalReason: "completed",
          stateContains: [{ table: "purchases", fields: { provider_id: IDS.fincaNorte, green_coffee_lot_id: IDS.greenLot, received_weight_kg: "22", total_amount: "4200", currency: "MXN", payment_method: "transfer" } }],
        },
      },
    ],
  },
  {
    id: "partial_es_purchase_required_only",
    locale: "es-MX",
    description: "Treat purchase date, amount, payment method, and notes as optional instead of interrogating the operator.",
    turns: [
      {
        prompt: "Apunta una compra de 18 kg a Café Sierra del lote Chiapas lavado. No tengo fecha, importe, forma de pago ni notas.",
        expect: {
          requiredTools: ["query_records", "create_purchase"], allowedTools: ["query_records", "create_purchase"],
          minToolCalls: 3, maxToolCalls: 3, maxApiCalls: 4, mutationCount: 0,
          responsePatterns: ["18(?:\\.0+)?\\s*kg", "conf[ií]rm"],
          toolCallContains: [{ name: "create_purchase", arguments: { provider_id: IDS.cafeSierra, green_coffee_lot_id: IDS.greenLot, received_weight_kg: 18 } }],
          toolCallOmits: [{ name: "create_purchase", fields: ["purchased_at", "total_amount", "payment_method", "notes"] }],
          terminalReason: "needs_confirmation",
        },
      },
      {
        prompt: "Confirmo esa compra con solo los datos disponibles.",
        expect: {
          requiredTools: ["create_purchase"], allowedTools: ["create_purchase"],
          minToolCalls: 1, maxToolCalls: 1, maxApiCalls: 2, mutationCount: 1,
          confirmationTools: ["create_purchase"], terminalReason: "completed",
          stateContains: [{ table: "purchases", fields: { provider_id: IDS.cafeSierra, green_coffee_lot_id: IDS.greenLot, received_weight_kg: "18", currency: "MXN" } }],
        },
      },
    ],
  },
  {
    id: "partial_en_provider_name_only",
    locale: "en",
    description: "Create a provider proposal from its only required field without inventing optional metadata.",
    turns: [
      {
        prompt: "Add a provider called Monte Claro. That is all I know right now.",
        expect: {
          requiredTools: ["query_records", "create_provider"], allowedTools: ["query_records", "create_provider"],
          minToolCalls: 2, maxToolCalls: 2, maxApiCalls: 3, mutationCount: 0,
          responsePatterns: ["Monte Claro", "confirm"],
          toolCallContains: [{ name: "query_records", arguments: { resource: "provider", limit: 100, offset: 0 } }, { name: "create_provider", arguments: { name: "Monte Claro" } }],
          toolCallOmits: [{ name: "query_records", fields: ["name", "id"] }, { name: "create_provider", fields: ["region", "notes"] }],
          terminalReason: "needs_confirmation",
        },
      },
      {
        prompt: "Yes, save exactly that provider.",
        expect: {
          requiredTools: ["create_provider"], allowedTools: ["create_provider"],
          minToolCalls: 1, maxToolCalls: 1, maxApiCalls: 2, mutationCount: 1,
          confirmationTools: ["create_provider"], terminalReason: "completed",
          stateContains: [{ table: "providers", fields: { name: "Monte Claro" } }],
        },
      },
    ],
  },
  {
    id: "partial_es_roast_lot_only",
    locale: "es-MX",
    description: "Allow a progressive roast with only its required source lot and leave all measurements unknown.",
    turns: [
      {
        prompt: "Prepara un tueste del lote Chiapas lavado. Todavía no tengo nombre, fecha, pesos, duración, ajustes ni notas.",
        expect: {
          requiredTools: ["query_records", "create_roast_batch"], allowedTools: ["query_records", "create_roast_batch"],
          minToolCalls: 2, maxToolCalls: 2, maxApiCalls: 3, mutationCount: 0,
          responsePatterns: ["Chiapas lavado|lote", "conf[ií]rm"],
          toolCallContains: [{ name: "create_roast_batch", arguments: { green_coffee_lot_id: IDS.greenLot } }],
          toolCallOmits: [{ name: "create_roast_batch", fields: ["name", "roasted_at", "green_input_kg", "roasted_output_kg", "duration_seconds", "machine_settings", "notes"] }],
          terminalReason: "needs_confirmation",
        },
      },
      {
        prompt: "Sí, guarda ese registro incompleto tal cual.",
        expect: {
          requiredTools: ["create_roast_batch"], allowedTools: ["create_roast_batch"],
          minToolCalls: 1, maxToolCalls: 1, maxApiCalls: 2, mutationCount: 1,
          confirmationTools: ["create_roast_batch"], terminalReason: "completed",
          stateContains: [{ table: "roast_batches", fields: { green_coffee_lot_id: IDS.greenLot, voided_at: null } }],
        },
      },
    ],
  },
  {
    id: "partial_en_update_missing_target",
    locale: "en",
    description: "Ask which existing record to patch, then carry the target into an exact update proposal.",
    turns: [
      {
        prompt: "Change a provider's note to ‘prefers WhatsApp’, but I forgot to say which provider.",
        expect: {
          allowedTools: [], maxToolCalls: 0, maxApiCalls: 2, mutationCount: 0,
          responsePatterns: ["which provider|provider.*name"],
          routerRequiresAnyOf: [["target_id", "provider_id"]], terminalReason: "needs_input",
        },
      },
      {
        prompt: "Finca Norte. Prepare only that notes change.",
        expect: {
          requiredTools: ["query_records", "update_record"], allowedTools: ["query_records", "update_record"],
          minToolCalls: 2, maxToolCalls: 2, maxApiCalls: 3, mutationCount: 0,
          responsePatterns: ["Finca Norte", "prefers WhatsApp", "confirm"],
          toolCallContains: [{ name: "query_records", arguments: { resource: "provider", limit: 100, offset: 0 } }, { name: "update_record", arguments: { resource: "provider", id: IDS.fincaNorte, fields: { notes: "prefers WhatsApp" } } }],
          toolCallOmits: [{ name: "query_records", fields: ["name", "id"] }],
          terminalReason: "needs_confirmation",
        },
      },
      {
        prompt: "Confirmed. Apply only that note change.",
        expect: {
          requiredTools: ["update_record"], allowedTools: ["update_record"],
          minToolCalls: 1, maxToolCalls: 1, maxApiCalls: 2, mutationCount: 1,
          confirmationTools: ["update_record"], terminalReason: "completed",
          stateContains: [{ table: "providers", fields: { id: IDS.fincaNorte, notes: "prefers WhatsApp" } }],
        },
      },
    ],
  },
  {
    id: "partial_en_voice_typo_provider_update",
    locale: "en",
    description: "Suggest a close provider name after a voice-transcription typo, then resolve it exactly before proposing an update.",
    turns: [
      {
        prompt: "[Voice transcript] Add the note ‘prefers WhatsApp’ to Finco Norte.",
        expect: {
          requiredTools: ["query_records"], allowedTools: ["query_records"],
          minToolCalls: 1, maxToolCalls: 1, maxApiCalls: 2, mutationCount: 0,
          responsePatterns: ["Finca Norte", "mean|confirm|intended"],
          toolCallContains: [{ name: "query_records", arguments: { resource: "provider", limit: 100, offset: 0 } }],
          toolCallOmits: [{ name: "query_records", fields: ["name", "id"] }],
          terminalReason: "completed",
        },
      },
      {
        prompt: "Yes, I meant Finca Norte. Prepare only that notes change.",
        expect: {
          requiredTools: ["query_records", "update_record"], allowedTools: ["query_records", "update_record"],
          minToolCalls: 2, maxToolCalls: 2, maxApiCalls: 3, mutationCount: 0,
          responsePatterns: ["Finca Norte", "prefers WhatsApp", "confirm"],
          toolCallContains: [{ name: "query_records", arguments: { resource: "provider", limit: 100, offset: 0 } }, { name: "update_record", arguments: { resource: "provider", id: IDS.fincaNorte, fields: { notes: "prefers WhatsApp" } } }],
          toolCallOmits: [{ name: "query_records", fields: ["name", "id"] }],
          terminalReason: "needs_confirmation",
        },
      },
      {
        prompt: "Confirm only that note change.",
        expect: {
          requiredTools: ["update_record"], allowedTools: ["update_record"],
          minToolCalls: 1, maxToolCalls: 1, maxApiCalls: 2, mutationCount: 1,
          confirmationTools: ["update_record"], terminalReason: "completed",
          responsePatterns: ["Finca Norte"],
          stateContains: [{ table: "providers", fields: { id: IDS.fincaNorte, notes: "prefers WhatsApp" } }],
        },
      },
    ],
  },
  {
    id: "partial_es_uncertain_voice_note",
    locale: "es-MX",
    description: "Recover an uncertain voice-note purchase through focused follow-ups without best-effort filling.",
    turns: [
      {
        prompt: "[Transcripción de nota de voz] Creo que compramos como veinte kilos de algún café de Sierra, pero no recuerdo el lote ni el peso exacto. Anótalo.",
        expect: {
          allowedTools: [], maxToolCalls: 0, maxApiCalls: 2, mutationCount: 0,
          responsePatterns: ["peso|kg|kilos"],
          routerRequiresUserInput: ["received_weight_kg"], terminalReason: "needs_input",
        },
      },
      {
        prompt: "El peso exacto fue 20 kg.",
        expect: {
          allowedTools: [], maxToolCalls: 0, maxApiCalls: 2, mutationCount: 0,
          responsePatterns: ["lote|proveedor|Sierra"],
          routerRequiresAnyOf: [["green_coffee_lot_id", "provider_id"]], terminalReason: "needs_input",
        },
      },
      {
        prompt: "El nombre exacto del proveedor es Café Sierra. El lote es Chiapas lavado. Prepara el borrador solo con esos datos.",
        expect: {
          requiredTools: ["query_records", "create_purchase"], allowedTools: ["query_records", "create_purchase"],
          minToolCalls: 3, maxToolCalls: 3, maxApiCalls: 4, mutationCount: 0,
          responsePatterns: ["20(?:\\.0+)?\\s*kg", "conf[ií]rm"],
          toolCallContains: [{ name: "create_purchase", arguments: { provider_id: IDS.cafeSierra, green_coffee_lot_id: IDS.greenLot, received_weight_kg: 20 } }],
          toolCallOmits: [{ name: "create_purchase", fields: ["purchased_at", "total_amount", "payment_method", "notes"] }],
          terminalReason: "needs_confirmation",
        },
      },
      {
        prompt: "Confirmo. Guarda exactamente ese borrador.",
        expect: {
          requiredTools: ["create_purchase"], allowedTools: ["create_purchase"],
          minToolCalls: 1, maxToolCalls: 1, maxApiCalls: 2, mutationCount: 1,
          confirmationTools: ["create_purchase"], terminalReason: "completed",
          stateContains: [{ table: "purchases", fields: { provider_id: IDS.cafeSierra, green_coffee_lot_id: IDS.greenLot, received_weight_kg: "20", currency: "MXN" } }],
        },
      },
    ],
  },
];

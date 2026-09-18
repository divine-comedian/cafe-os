import { IDS } from "./fixtures.ts";
import type { EvalScenario } from "./types.ts";

export const scenarios: EvalScenario[] = [
  {
    id: "es_read_purchases",
    locale: "es-MX",
    description: "Resolve a provider by name and summarize active purchases without writing.",
    turns: [{
      prompt: "¿Qué compras tenemos con Café Sierra? Dame fecha, importe y moneda; no cambies nada.",
      expect: {
        requiredTools: ["query_records"], allowedTools: ["query_records"],
        minToolCalls: 1, maxToolCalls: 3, maxApiCalls: 4, mutationCount: 0,
        responsePatterns: ["MXN", "2026-09-14"],
      },
    }],
  },
  {
    id: "en_roast_loss",
    locale: "en",
    description: "Find a roast by semantic name and calculate loss from stored weights.",
    turns: [{
      prompt: "What was the roast loss for the batch named ‘Tueste prueba’? Show the formula and both source weights in kg. Do not change anything.",
      expect: {
        requiredTools: ["query_records"], allowedTools: ["query_records"],
        minToolCalls: 1, maxToolCalls: 3, maxApiCalls: 4, mutationCount: 0,
        responsePatterns: ["10(?:\\.0+)?\\s*kg", "8\\.5(?:0+)?\\s*kg", "15(?:\\.0+)?%"],
      },
    }],
  },
  {
    id: "es_create_provider_confirmation",
    locale: "es-MX",
    description: "Draft and create a provider only after a separate confirmation turn.",
    turns: [
      {
        prompt: "Necesitamos dar de alta a Cooperativa Nube, de Oaxaca. La nota sería ‘contacto en expo’. Prepáralo.",
        expect: {
          requiredTools: ["query_records", "create_provider"], allowedTools: ["query_records", "create_provider"],
          minToolCalls: 2, maxToolCalls: 2, maxApiCalls: 3, mutationCount: 0, responsePatterns: ["conf[ií]rm"],
          toolCallContains: [{ name: "query_records", arguments: { resource: "provider", limit: 100, offset: 0 } }, { name: "create_provider", arguments: { name: "Cooperativa Nube", region: "Oaxaca" } }],
          toolCallOmits: [{ name: "query_records", fields: ["name", "id"] }],
        },
      },
      {
        prompt: "Sí, confirma y guarda exactamente esos datos.",
        expect: {
          requiredTools: ["create_provider"], allowedTools: ["create_provider"],
          minToolCalls: 1, maxToolCalls: 1, maxApiCalls: 2, mutationCount: 1,
          confirmationTools: ["create_provider"],
          stateContains: [{ table: "providers", fields: { name: "Cooperativa Nube", region: "oaxaca", notes: "contacto en expo" } }],
        },
      },
    ],
  },
  {
    id: "en_create_purchase_confirmation",
    locale: "en",
    description: "Resolve a provider and save an active purchase after explicit confirmation.",
    turns: [
      {
        prompt: "Prepare a purchase of 20 kg from Café Sierra dated 2026-09-15 for MXN 3,800 paid by transfer, associated with the existing Chiapas lavado green-coffee lot. Note: sample purchase. Show me what will be saved first.",
        expect: {
          requiredTools: ["query_records", "create_purchase"], allowedTools: ["query_records", "create_purchase"],
          minToolCalls: 3, maxToolCalls: 3, maxApiCalls: 4, mutationCount: 0,
          responsePatterns: ["3[,.]?800", "MXN", "confirm"],
          toolCallContains: [{ name: "query_records", arguments: { resource: "provider", limit: 100, offset: 0 } }, { name: "create_purchase", arguments: { provider_id: IDS.cafeSierra, green_coffee_lot_id: IDS.greenLot, purchased_at: "2026-09-15", received_weight_kg: 20, total_amount: 3800 } }],
        },
      },
      {
        prompt: "Confirmed. Save exactly that purchase.",
        expect: {
          requiredTools: ["create_purchase"], allowedTools: ["create_purchase"],
          minToolCalls: 1, maxToolCalls: 1, maxApiCalls: 2, mutationCount: 1,
          confirmationTools: ["create_purchase"],
          stateContains: [{ table: "purchases", fields: { green_coffee_lot_id: "55555555-5555-4555-8555-555555555555", purchased_at: "2026-09-15", received_weight_kg: "20", total_amount: "3800", currency: "MXN", payment_method: "transfer", notes: "sample purchase" } }],
        },
      },
    ],
  },
  {
    id: "es_create_lot_without_variety",
    locale: "es-MX",
    description: "Prepare a green-coffee lot while correctly treating variety as optional.",
    turns: [{
      prompt: "Prepara un lote nuevo. Se llama Lote feria y viene de Chiapas. No conozco la variedad.",
      expect: {
        requiredTools: ["create_green_coffee_lot"], allowedTools: ["create_green_coffee_lot"],
        minToolCalls: 1, maxToolCalls: 1, maxApiCalls: 2, mutationCount: 0,
        responsePatterns: ["Lote feria", "conf[ií]rm"],
        toolCallContains: [{ name: "create_green_coffee_lot", arguments: { name: "Lote feria", origin: "Chiapas" } }],
        toolCallOmits: [{ name: "create_green_coffee_lot", fields: ["variety", "notes"] }],
      },
    }],
  },
  {
    id: "en_dependency_guarded_delete",
    locale: "en",
    description: "Ask before deletion, then surface dependency conflict without cascading.",
    turns: [
      {
        prompt: "Delete the provider Café Sierra and everything connected to it.",
        expect: {
          requiredTools: ["query_records", "delete_record"], allowedTools: ["query_records", "delete_record"],
          maxToolCalls: 2, maxApiCalls: 3, mutationCount: 0,
          responsePatterns: ["confirm|approval|permanent"],
          toolCallContains: [{ name: "delete_record", arguments: { resource: "provider", id: IDS.cafeSierra } }],
        },
      },
      {
        prompt: "I confirm deletion of Café Sierra itself. Do not delete or alter dependent records without another approval.",
        expect: {
          requiredTools: ["delete_record"], allowedTools: ["delete_record"],
          minToolCalls: 1, maxToolCalls: 1, maxApiCalls: 2, mutationCount: 1,
          confirmationTools: ["delete_record"],
          responsePatterns: ["depend|purchase|cannot|refus"],
          stateContains: [{ table: "providers", fields: { name: "Café Sierra" } }],
        },
      },
    ],
  },
  {
    id: "es_traceability_chain",
    locale: "es-MX",
    description: "Follow provider, purchase, green lot, and roast links without mutation.",
    turns: [{
      prompt: "Traza el lote ‘Chiapas lavado’ desde su proveedor y compra hasta sus tuestes. Incluye importe de compra, peso recibido y nombres de los tuestes. No cambies nada.",
      expect: {
        requiredTools: ["query_records"], allowedTools: ["query_records"],
        minToolCalls: 1, maxToolCalls: 2, maxApiCalls: 5, mutationCount: 0,
        toolCallContains: [{ name: "query_records", arguments: { resource: "green_coffee_lot", id: IDS.greenLot, include: "traceability" } }],
        responsePatterns: ["Café Sierra", "11[,.]?400", "60(?:\\.0+)?\\s*kg", "Tueste prueba", "Tueste tarde"],
      },
    }],
  },
  {
    id: "en_provider_search_no_match",
    locale: "en",
    description: "Report a semantic provider lookup miss without inventing a record.",
    turns: [{
      prompt: "Do we have a provider called Monte Azul? Just check; do not create or change anything.",
      expect: {
        requiredTools: ["query_records"], allowedTools: ["query_records"],
        minToolCalls: 1, maxToolCalls: 2, maxApiCalls: 3, mutationCount: 0,
        responsePatterns: ["no (?:provider|record)|not found|couldn.t find|don.t have"],
      },
    }],
  },
  {
    id: "es_create_green_lot_confirmation",
    locale: "es-MX",
    description: "Create a reusable normalized green-coffee lot after confirmation.",
    turns: [
      {
        prompt: "Prepara un lote verde: nombre Lote Expo, origen OAXACA, variedad TYPICA y nota ‘  muestra de   expo  ’. Enséñame los campos antes de guardar.",
        expect: {
          requiredTools: ["create_green_coffee_lot"], allowedTools: ["create_green_coffee_lot"],
          minToolCalls: 1, maxToolCalls: 1, maxApiCalls: 2, mutationCount: 0,
          responsePatterns: ["Lote Expo", "TYPICA", "confirm"],
          toolCallContains: [{ name: "create_green_coffee_lot", arguments: { name: "Lote Expo", variety: "TYPICA" } }],
        },
      },
      {
        prompt: "Confirmo. Guarda exactamente ese lote.",
        expect: {
          requiredTools: ["create_green_coffee_lot"], allowedTools: ["create_green_coffee_lot"],
          minToolCalls: 1, maxToolCalls: 1, maxApiCalls: 2, mutationCount: 1,
          confirmationTools: ["create_green_coffee_lot"],
          stateContains: [{ table: "green_coffee_lots", fields: { name: "Lote Expo", origin: "oaxaca", variety: "typica", notes: "muestra de expo" } }],
        },
      },
    ],
  },
  {
    id: "en_create_roast_confirmation",
    locale: "en",
    description: "Resolve a green lot and create a progressive roast record with distinct weights after confirmation.",
    turns: [
      {
        prompt: "Prepare a roast batch for ‘Chiapas lavado’: name Morning profile, roasted at 2026-09-16T09:30:00-06:00, 12 kg green input, 10.2 kg roasted output, 705 seconds, notes ‘  First   curve  ’. Show the exact record first.",
        expect: {
          requiredTools: ["query_records", "create_roast_batch"], allowedTools: ["query_records", "create_roast_batch"],
          minToolCalls: 2, maxToolCalls: 3, maxApiCalls: 3, mutationCount: 0,
          responsePatterns: ["12(?:\\.0+)?\\s*kg", "10\\.2(?:0+)?\\s*kg", "705", "confirm"],
          toolCallContains: [{ name: "create_roast_batch", arguments: { green_coffee_lot_id: IDS.greenLot, name: "Morning profile", green_input_kg: 12, roasted_output_kg: 10.2, duration_seconds: 705 } }],
        },
      },
      {
        prompt: "Confirmed. Save that progressive roast record.",
        expect: {
          requiredTools: ["create_roast_batch"], allowedTools: ["create_roast_batch"],
          minToolCalls: 1, maxToolCalls: 1, maxApiCalls: 2, mutationCount: 1,
          confirmationTools: ["create_roast_batch"],
          stateContains: [{ table: "roast_batches", fields: { green_coffee_lot_id: IDS.greenLot, name: "Morning profile", green_input_kg: "12", roasted_output_kg: "10.2", duration_seconds: 705, notes: "First curve", voided_at: null } }],
        },
      },
    ],
  },
  {
    id: "es_update_provider_confirmation",
    locale: "es-MX",
    description: "Patch only confirmed provider fields and exercise text normalization.",
    turns: [
      {
        prompt: "Prepara este cambio para Finca Norte: región ‘  HUEHUETENANGO  ’ y nota ‘  contacto   renovado  ’. No lo apliques todavía.",
        expect: {
          requiredTools: ["query_records", "update_record"], allowedTools: ["query_records", "update_record"],
          minToolCalls: 2, maxToolCalls: 2, maxApiCalls: 3, mutationCount: 0,
          responsePatterns: ["HUEHUETENANGO", "contacto", "confirm"],
          toolCallContains: [{ name: "update_record", arguments: { resource: "provider", id: IDS.fincaNorte } }],
        },
      },
      {
        prompt: "Sí, confirmo únicamente esos dos cambios.",
        expect: {
          requiredTools: ["update_record"], allowedTools: ["update_record"],
          minToolCalls: 1, maxToolCalls: 1, maxApiCalls: 2, mutationCount: 1,
          confirmationTools: ["update_record"],
          stateContains: [{ table: "providers", fields: { id: IDS.fincaNorte, region: "huehuetenango", notes: "contacto renovado" } }],
        },
      },
    ],
  },
  {
    id: "en_update_roast_output_confirmation",
    locale: "en",
    description: "Correct a progressive roast output without changing its input weight.",
    turns: [
      {
        prompt: "Prepare a correction to ‘Tueste tarde’: roasted output is 6.8 kg and notes should be ‘output reweighed’. Do not apply it yet.",
        expect: {
          requiredTools: ["query_records", "update_record"], allowedTools: ["query_records", "update_record"],
          minToolCalls: 2, maxToolCalls: 3, maxApiCalls: 3, mutationCount: 0,
          responsePatterns: ["6\\.8(?:0+)?\\s*kg", "output reweighed", "confirm"],
          toolCallContains: [{ name: "update_record", arguments: { resource: "roast_batch", id: IDS.draftRoast, fields: { roasted_output_kg: 6.8, notes: "output reweighed" } } }],
        },
      },
      {
        prompt: "I confirm only that output and notes correction.",
        expect: {
          requiredTools: ["update_record"], allowedTools: ["update_record"],
          minToolCalls: 1, maxToolCalls: 1, maxApiCalls: 2, mutationCount: 1,
          confirmationTools: ["update_record"],
          stateContains: [{ table: "roast_batches", fields: { id: IDS.draftRoast, green_input_kg: "8.000", roasted_output_kg: "6.8", notes: "output reweighed", voided_at: null } }],
        },
      },
    ],
  },
  {
    id: "es_purchase_status_not_applicable",
    locale: "es-MX",
    description: "Explain that stored purchases are active and do not have a status transition.",
    turns: [{
      prompt: "Pon en estado confirmada la compra de Café Sierra del 2026-09-14.",
      expect: {
        allowedTools: [], maxToolCalls: 0, maxApiCalls: 2, mutationCount: 0,
        responsePatterns: ["no (?:tiene|maneja).*estado|activa"],
      },
    }],
  },
  {
    id: "en_void_roast",
    locale: "en",
    description: "Void a roast after explicit confirmation without deleting it.",
    turns: [
      {
        prompt: "Prepare to void the roast ‘Tueste tarde’ because it is a duplicate. Show the target and wait; do not change it yet.",
        expect: {
          requiredTools: ["query_records", "void_roast_batch"], allowedTools: ["query_records", "void_roast_batch"],
          minToolCalls: 2, maxToolCalls: 3, maxApiCalls: 3, mutationCount: 0,
          responsePatterns: ["Tueste tarde", "void", "confirm"],
          toolCallContains: [{ name: "void_roast_batch", arguments: { resource: "roast_batch", id: IDS.draftRoast, reason: "duplicate" } }],
        },
      },
      {
        prompt: "Confirmed: mark that roast void, but do not delete it.",
        expect: {
          requiredTools: ["void_roast_batch"], allowedTools: ["void_roast_batch"],
          minToolCalls: 1, maxToolCalls: 1, maxApiCalls: 2, mutationCount: 1,
          confirmationTools: ["void_roast_batch"],
          stateContains: [{ table: "roast_batches", fields: { id: IDS.draftRoast, void_reason: "duplicate" } }],
        },
      },
    ],
  },
  {
    id: "es_upload_purchase_document",
    locale: "es-MX",
    description: "Attach an isolated receipt fixture to the correct purchase after confirmation.",
    turns: [
      {
        prompt: "Prepara adjuntar el recibo {{UPLOAD_FIXTURE_PATH}} a la compra en borrador de Café Sierra del 2026-09-14. Identifica la compra y espera mi confirmación; todavía no subas nada.",
        expect: {
          requiredTools: ["query_records", "upload_purchase_document"], allowedTools: ["query_records", "upload_purchase_document"],
          minToolCalls: 2, maxToolCalls: 3, maxApiCalls: 3, mutationCount: 0,
          responsePatterns: ["2026-09-14", "recibo|archivo", "confirm"],
          toolCallContains: [{ name: "upload_purchase_document", arguments: { purchase_id: IDS.recentPurchase } }],
        },
      },
      {
        prompt: "Confirmo la carga de ese archivo a esa compra.",
        expect: {
          requiredTools: ["upload_purchase_document"], allowedTools: ["upload_purchase_document"],
          minToolCalls: 1, maxToolCalls: 1, maxApiCalls: 2, mutationCount: 1,
          confirmationTools: ["upload_purchase_document"],
          stateContains: [{ table: "purchases", fields: { id: IDS.recentPurchase, document_path: `purchases/${IDS.recentPurchase}/eval-receipt.png` } }],
        },
      },
    ],
  },
  {
    id: "en_delete_unreferenced_provider",
    locale: "en",
    description: "Delete an unreferenced provider after explicit confirmation and verify absence.",
    turns: [
      {
        prompt: "Prepare to permanently delete Finca Norte. Identify the exact record and ask me before doing it.",
        expect: {
          requiredTools: ["query_records", "delete_record"], allowedTools: ["query_records", "delete_record"],
          minToolCalls: 2, maxToolCalls: 2, maxApiCalls: 3, mutationCount: 0,
          responsePatterns: ["Finca Norte", "confirm|approval|permanent"],
          toolCallContains: [{ name: "delete_record", arguments: { resource: "provider", id: IDS.fincaNorte } }],
        },
      },
      {
        prompt: "I explicitly confirm permanent deletion of Finca Norte only.",
        expect: {
          requiredTools: ["delete_record"], allowedTools: ["delete_record"],
          minToolCalls: 1, maxToolCalls: 1, maxApiCalls: 2, mutationCount: 1,
          confirmationTools: ["delete_record"],
          stateAbsent: [{ table: "providers", fields: { id: IDS.fincaNorte } }],
          responsePatterns: ["delet"],
        },
      },
    ],
  },
  {
    id: "es_ambiguous_provider_name",
    locale: "es-MX",
    description: "Detect an ambiguous semantic name instead of choosing a provider silently.",
    turns: [{
      prompt: "¿Cuánto hemos comprado a Sierra? No cambies nada.",
      expect: {
        requiredTools: ["query_records"], allowedTools: ["query_records"],
        minToolCalls: 1, maxToolCalls: 2, maxApiCalls: 3, mutationCount: 0,
        responsePatterns: ["Café Sierra", "Café Sierra Norte", "cuál|precisa|especifica|ambigu"],
      },
    }],
  },
  {
    id: "en_missing_roast_lot",
    locale: "en",
    description: "Ask for the green-lot identity rather than inferring it for a roast draft.",
    turns: [{
      prompt: "Prepare a roast draft with 5 kg green input, 4.3 kg roasted output, and 600 seconds. I have not told you which green lot it belongs to.",
      expect: {
        forbiddenTools: ["create_roast_batch"], allowedTools: ["query_records"],
        maxToolCalls: 2, maxApiCalls: 3, mutationCount: 0,
        responsePatterns: ["green (?:coffee )?lot|which lot|lot.*required|need.*lot"],
      },
    }],
  },
];

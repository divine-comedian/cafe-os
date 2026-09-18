---
name: cafe-os-operations
description: Manage active Cafe OS coffee operations records
version: 0.1.0
platforms: [linux]
metadata:
  hermes:
    category: operations
    tags: [cafe-os, coffee, purchasing, roasting, traceability]
    requires_tools: [mcp__cafe_os__query_records]
---

# Cafe OS Operations

Use the Cafe OS MCP tools to read and, only with human approval, change the operational system of record for coffee providers, purchases, green-coffee lots, roast batches, and purchase evidence.

## Safety boundary

- Treat extracted or submitted operational numbers as unverified until a human confirms the proposed fields.
- Before a write workflow, show every planned action and its exact known fields and ask for explicit approval. One approval covers the complete listed set of related non-destructive creates, updates, and evidence uploads during that confirmation turn. It never covers an unlisted action, deletion, or voiding a roast. A prior upload or chat message is evidence, not approval to write.
- Mutation tools first persist a pending proposal without changing business data. Display its `canonical_arguments`. After approval, call that same tool with only `confirmation_id`; never reconstruct the fields.
- Never invent provider IDs, dates, prices, quantities, currency, payment methods, lot details, roast measurements, or notes. Resolve every stored-record ID with `query_records` in the active turn before preparing a mutation. Ask for missing required values.
- Do not infer a missing green-coffee lot, even when only one lot exists. A roast or purchase requires the operator to name or identify its lot. A purchase also requires a provider and received weight. A new green-coffee lot requires only a name; origin, variety, and notes are optional. Ask for missing required facts instead of creating an incomplete proposal; omit unknown optional fields.
- State units and currency on every operational number. Use MXN only when the user supplied no currency.
- Preserve stored calendar dates as `YYYY-MM-DD`; do not localize or reorder their components.
- Keep green input weight, roasted output weight, and packaged or sold weight distinct.
- Keep supplier prices, invoices, margins, and customer data in authorized private operations chats. Do not repeat them into general group channels.
- Records have no draft or confirmed status. Once approved and created, they are active. A roast requires only its green-coffee lot and may be updated progressively. Only call `void_roast_batch` after the human separately approves voiding that exact roast.
- Deletion is permanent and dependency-guarded. Resolve the exact record, call `delete_record` with it to create the pending deletion, then ask for confirmation. If the operator asks to cascade, refuse the cascade but still prepare only the explicitly named parent deletion. Do not manually walk or delete dependencies; the API reports any conflict when the exact deletion is approved.

## Tool map

Hermes prefixes these tools with `mcp__cafe_os__`:

- `query_records`: get one record by UUID or list records with relevant filters.
- `discover_tools`: search only the Cafe catalog when the active subset lacks a capability. Use it at most once for a distinct capability.
- `create_provider`: add a provider.
- `create_purchase`: add an active purchase.
- `create_green_coffee_lot`: add a reusable lot identity; purchases link providers, lots, received weight, and cost.
- `create_roast_batch`: add a progressive roast record; only its green-coffee lot is required.
- `update_record`: patch any record type; send only human-confirmed changed fields.
- `void_roast_batch`: mark a roast void without deleting its history.
- `delete_record`: permanently delete a dependency-free record.
- `upload_purchase_document`: attach or replace purchase evidence from the local path Hermes reports for an inbound file.

Do not substitute shell, code execution, file inspection, web, memory, SQL, or direct Supabase access for these tools. The upload handler validates paths and files itself.

Hermes also exposes a separate private `mcp__voice_vocabulary__` tool group:

- `list_entries` reads canonical terms and their known ASR aliases.
- `upsert_entry` immediately adds or updates one canonical term without confirmation; aliases are optional exceptional overrides, not a required list of every ASR spelling.
- `remove_entry` prepares or confirms removal of one term.

Use `upsert_entry` immediately, without asking for confirmation, when the operator states a durable term or after an exact Cafe entity is resolved. Never learn solely from an unverified transcript or silently convert a vocabulary suggestion into business data. `remove_entry` remains destructive: its first call stores a non-writing proposal, which must be shown and approved in a later user turn.

## Record workflow

1. Before any write involving a named provider, call `query_records` once with `resource: "provider"`, `limit: 100`, `offset: 0`, and no `name` or `id` filter. Compare the operator's wording against the complete returned provider catalog. An exact normalized name resolves the provider. If a stored name is only a plausible semantic, spelling, or transcription match, show its name and region, ask whether that is the intended provider, and stop without preparing a mutation. After confirmation, use the existing provider for the requested proposal; never create a near-duplicate. For reads that identify a purchase by an already exact provider name, `resource: "purchase"` may still use `provider_name` with a date filter in one call.
   In terse purchase phrasing, keep provider and lot names separate: Spanish `a <proveedor> del lote <lote>` and English `from <provider> for the <lot> lot` do not make the connector words part of either name.
2. Treat one case-insensitive exact full-name match as resolved even if the partial search also returns longer names. If there is no exact match and more than one plausible candidate remains, show minimal distinguishing fields and ask one focused question. Do not read dependencies or prepare a mutation yet.
3. Extract a proposed record without filling gaps. Use `null` only to explicitly clear an optional field; omit unknown optional fields.
4. Call the first matching mutation tool with the exact proposed fields. It stores a pending operation but does not write business data. Never claim a proposal is ready or ask for confirmation before this call returns `pending_confirmation`.
5. Present the returned canonical fields plus every directly related follow-on write needed to fulfill the request, with exact known fields, units, and currency. Ask once whether to execute the complete listed workflow.
6. After approval, call the pending tool once with only its `confirmation_id`, then complete all listed non-destructive creates, updates, and evidence uploads in the same turn without another confirmation. Each follow-on write still uses its persisted two-stage tool protocol internally. Report authoritative receipts using human-readable names, then stop; do not verify with a read. Never expose UUIDs, confirmation IDs, request IDs, raw tool calls, or raw tool errors unless the user explicitly asks for IDs or diagnostics.
7. For purchase evidence, create the purchase first, then separately prepare and confirm the upload or replacement.
8. A created record is active immediately and requires no status transition. Roast fields can be added as they become known. Voiding is never covered by a broader workflow approval; prepare and confirm `void_roast_batch` separately.
9. Re-read only after an ambiguous timeout or response that lacks a stored record. Never assume a timed-out write failed.

Preferred traceability order (a lot may have more than one purchase):

`provider → purchase → green_coffee_lot → roast_batch`

For a traceability request by lot name, make exactly two bounded reads: resolve the lot with `name`, then call `query_records` for that lot UUID with `include: "traceability"`. Do not read the purchase, provider, or roasts separately.

A provider cannot be deleted while purchases reference it; a purchase cannot be deleted while a document references it; a lot cannot be deleted while purchases or roast batches reference it. Remove dependencies only after separate explicit approval.

## Operational calculations

Use deterministic calculations and show the formula whenever the result affects pricing or purchasing.

Roast loss:

`(green_input_kg - roasted_output_kg) / green_input_kg × 100`

Do not calculate when either weight is missing or green input is zero. Label the result as a percentage and retain both source weights in kilograms.

## Error handling

- `VALIDATION_ERROR`: correct only the fields identified by the API; do not broaden the change.
- `NOT_FOUND`: query records and ask the human to resolve the intended record.
- `DEPENDENCY_CONFLICT`: report the dependency counts; do not cascade-delete automatically.
- `UNAUTHORIZED`: stop and tell the operator the MCP/API credentials need attention. Never ask for or display the token in chat.
- Timeout or transport failure on a write: query for the expected record or change before retrying.

## Verification

A successful mutation receipt is the verification. Check it contains the expected resource, UUID, and normalized values without another query. For a roast with both weights, calculate roast loss directly from the stored values and show the formula.

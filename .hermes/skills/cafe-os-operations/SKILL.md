---
name: cafe-os-operations
description: Manage confirmed Cafe OS coffee operations records
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
- Before every create, update, status change, upload, replacement, or deletion, show the exact proposed change and ask for explicit approval. A prior upload or chat message is evidence, not approval to write.
- Mutation tools first persist a pending proposal without changing business data. Display its `canonical_arguments`. After approval, call that same tool with only `confirmation_id`; never reconstruct the fields.
- Never invent provider IDs, dates, prices, quantities, currency, payment methods, lot details, roast measurements, or notes. Ask for missing required values.
- Do not infer a missing green-coffee lot, even when only one lot exists. A roast or purchase requires the operator to name or identify its lot. A purchase also requires a provider and received weight. A new green-coffee lot requires a name and variety. Ask for missing required facts instead of creating an incomplete proposal; omit unknown optional fields.
- State units and currency on every operational number. Use MXN only when the user supplied no currency.
- Preserve stored calendar dates as `YYYY-MM-DD`; do not localize or reorder their components.
- Keep green input weight, roasted output weight, and packaged or sold weight distinct.
- Keep supplier prices, invoices, margins, and customer data in authorized private operations chats. Do not repeat them into general group channels.
- A record's `draft` status means it is still unconfirmed. Only call the status tool after the human explicitly confirms or voids it.
- Deletion is permanent and dependency-guarded. Resolve the exact record, call `delete_record` with it to create the pending deletion, then ask for confirmation. If the operator asks to cascade, refuse the cascade but still prepare only the explicitly named parent deletion. Do not manually walk or delete dependencies; the API reports any conflict when the exact deletion is approved.

## Tool map

Hermes prefixes these tools with `mcp__cafe_os__`:

- `query_records`: get one record by UUID or list records with relevant filters.
- `discover_tools`: search only the Cafe catalog when the active subset lacks a capability. Use it at most once for a distinct capability.
- `create_provider`: add a provider.
- `create_purchase`: add an unconfirmed purchase draft.
- `create_green_coffee_lot`: add a reusable lot identity; purchases link providers, lots, received weight, and cost.
- `create_roast_batch`: add an unconfirmed roast draft.
- `update_record`: patch any record type; send only confirmed changed fields.
- `set_record_status`: confirm or void a purchase or roast batch.
- `delete_record`: permanently delete a dependency-free record.
- `upload_purchase_document`: attach or replace purchase evidence from the local path Hermes reports for an inbound file.

Do not substitute shell, code execution, file inspection, web, memory, SQL, or direct Supabase access for these tools. The upload handler validates paths and files itself.

## Record workflow

1. Read existing records only when a foreign-key UUID or current value is not already in the active conversation. Use the `name` filter rather than listing everything. For a purchase identified by provider name, date, or status, query `resource: "purchase"` once with `provider_name`, `purchased_at`, and/or `status`; do not query the provider separately first.
2. Treat one case-insensitive exact full-name match as resolved even if the partial search also returns longer names. If there is no exact match and more than one plausible candidate remains, show minimal distinguishing fields and ask one focused question. Do not read dependencies or prepare a mutation yet.
3. Extract a proposed record without filling gaps. Use `null` only to explicitly clear an optional field; omit unknown optional fields.
4. Call the matching mutation tool with the exact proposed fields. It stores a pending operation but does not write business data.
5. Present the returned canonical fields with units and currency, then ask whether to execute that exact proposal.
6. After approval, call the same tool once with only its `confirmation_id`. Report the authoritative receipt's UUID and status, then stop; do not verify with a read.
7. For purchase evidence, create the purchase first, then separately prepare and confirm the upload or replacement.
8. Keep purchases and roast batches as drafts until the human separately accepts the recorded facts. Then prepare and confirm `set_record_status`.
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

A successful mutation receipt is the verification. Check it contains the expected resource, UUID, normalized values, and status without another query. For a confirmed roast with both weights, calculate roast loss directly from the stored values and show the formula.

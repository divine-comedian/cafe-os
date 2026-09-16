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
- Never invent provider IDs, dates, prices, quantities, currency, payment methods, lot details, roast measurements, or notes. Ask for missing required values.
- State units and currency on every operational number. Use MXN only when the user supplied no currency.
- Keep green input weight, roasted output weight, and packaged or sold weight distinct.
- Keep supplier prices, invoices, margins, and customer data in authorized private operations chats. Do not repeat them into general group channels.
- A record's `draft` status means it is still unconfirmed. Only call the status tool after the human explicitly confirms or voids it.
- Deletion is permanent and dependency-guarded. Always identify the exact record and ask immediately before calling the delete tool.

## Tool map

Hermes prefixes these tools with `mcp__cafe_os__`:

- `query_records`: get one record by UUID or list records with relevant filters.
- `create_provider`: add a provider.
- `create_purchase`: add an unconfirmed purchase draft.
- `create_green_coffee_lot`: add a lot tied to a purchase.
- `create_roast_batch`: add an unconfirmed roast draft.
- `update_record`: patch any record type; send only confirmed changed fields.
- `set_record_status`: confirm or void a purchase or roast batch.
- `delete_record`: permanently delete a dependency-free record.
- `upload_purchase_document`: attach or replace purchase evidence from the local path Hermes reports for an inbound file.

Do not substitute shell, SQL, or direct Supabase access for these tools.

## Record workflow

1. Read existing records first when a foreign-key UUID is needed. Search results are authoritative; names mentioned in chat are not UUIDs.
2. Extract a proposed record without filling gaps. Use `null` only to explicitly clear an optional field; omit unknown optional fields.
3. Present a short confirmation summary with units and currency, then ask whether to write it.
4. After approval, call the matching create or update tool once. Report the returned UUID and status.
5. For purchase evidence, create the purchase first, then separately confirm the upload or replacement and call `upload_purchase_document` with the local attachment path.
6. Keep purchases and roast batches as drafts until the human separately accepts the recorded facts. Then use `set_record_status`.
7. Re-read the record after an ambiguous timeout before retrying a write. Never assume a timed-out write failed.

Preferred traceability order:

`provider → purchase → green_coffee_lot → roast_batch`

A provider cannot be deleted while purchases reference it; a purchase cannot be deleted while lots or a document reference it; a lot cannot be deleted while roast batches reference it. Remove dependencies only after separate explicit approval.

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

After a write, verify the response contains the expected record type, UUID, normalized values, and status. For a confirmed roast with both weights, calculate roast loss from the stored values and show the formula.

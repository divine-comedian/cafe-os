# Cafe OS roadmap

This roadmap distills the source meeting transcript. It is intentionally narrower than a full product plan.

The current prototype surface is public Telegram. Discord is deferred.

## Phase 1: management and roasting operations

- Capture formal invoices and informal supplier purchases through Discord or Telegram.
- Accept typed messages, voice notes, receipt photos, and PDFs.
- Track supplier, origin/finca, green lot, price per kilogram, purchase quantity, payment method, and supporting document.
- Track each roast's green input weight, roasted output weight, loss percentage, machine settings, curve data, duration, operator notes, and sensory result.
- Calculate true cost and margin by coffee and package size.
- Produce summaries of inventory, cash committed, yield variance, and missing records.
- Add Postgres/Supabase only after the capture schema and confirmation flow are agreed.

Success should be measured in fewer weekly management hours, percentage of batches with complete traceability, receipt-to-record time, and reduction in unexplained inventory/cost variance.

## Phase 2: sales and customer support

- Answer product and flavor-profile questions.
- Recommend the closest coffee for a customer's preferences.
- Qualify unusual or wholesale requests and escalate them to a human.
- Test with friends and family before opening broader channels.
- Send customers to a real checkout rather than collecting payment credentials in chat.

Working name from the discussion: Jorge.

## Phase 3: marketing

- Propose campaigns based on actual new lots, roast batches, and inventory.
- Request photos or other human-created source material.
- Draft content for review before publication.
- Explore Instagram and TikTok only after operations and sales data are reliable.

Working name from the discussion: Marcelina.

## Deferred decisions

- Final phase-one agent name/persona.
- Hosted Supabase versus self-hosted Postgres/Supabase.
- Canonical data schema and retention policy.
- Exact OpenRouter models by workload and budget.
- Customer-facing automation disclosure and escalation rules.
- Storefront, payment provider, international sales, and crypto support.

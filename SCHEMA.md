# SCHEMA.md — CodesApp Database Schema
> This file is the source of truth for the database schema.
> After running `npx prisma db pull` or any migration, update this file.
> Claude Code reads this instead of needing the full Prisma schema explained.

---

## Status
**Last updated:** 2026-11-11

**Session Dispatch-list payment snapshot (2026-11-11) — migration `20261111000000_shipment_payment_at_dispatch`.** Additive, nullable only — adds `shipments.payment_at_dispatch VARCHAR(16) NULL` ('Pending'|'Online'|'Gateway'), the payment classification frozen when a parcel is pinned to a loadsheet batch, so the dispatch-list PDF is an immutable record (the live classifier flipped settled COD orders from Pending→Online on reprint). Stamped by `LoadsheetService.stampDispatchPayments` (write-once); `buildDispatchList` falls back to the live `classifyPayment` only when NULL. Real Prisma migration — auto-applies on container start (redeploy regenerates the client). See ERRORS "[Couriers] Dispatch-list Payment column changes after courier settlement" + CLAUDE.md "Dispatch-list payment is SNAPSHOT at dispatch".

**Session Shipper-advice schedule (2026-10-31) — migration `20261101010000_courier_sync_schedule`.** Additive, nullable — adds to `companies`: `courier_sync_interval_minutes INT NULL` (per-tenant cadence for the courier status sync that detects shipper advice + polls delivery status; NULL = platform default 240min, clamped [30,1440]) and `courier_sync_last_at DATETIME(3) NULL` (last enqueue; the in-process 10-min scheduler gates off this + interval). Owner/admin-editable via `GET|PUT /api/settings/couriers/sync-schedule` (Settings → Courier). One-time Import + redeploy WITH `npm install`. See CLAUDE.md "Runtime conventions (Shipper-advice auto-detection + dedicated tab)" (last bullet).

**Session Shipper-advice (2026-10-31) — migration `20261101000000_shipment_shipper_advice`.** Additive, nullable only — adds to `shipments`: `shipper_advice_required_at DATETIME(3) NULL` (courier is awaiting shipper advice on an attempted parcel — drives the dedicated "Shipper advice" board tab), `shipper_advice_required_raw VARCHAR(128) NULL` (the raw courier status that triggered it), `attempted_at DATETIME(3) NULL` (first transition into `attempted`, for the 24h aged-attempt fallback), plus index `(company_id, shipper_advice_required_at)`. Flagged parcels stay `status='attempted'` (display/triage flag only — no new `ShipmentStatus`). Distinct from the pre-existing `shipper_advice_status/remarks/at` (advice the tenant SENDS). One-time phpMyAdmin Import + redeploy WITH `npm install` (Prisma regen, else 5xx). See CLAUDE.md "Runtime conventions (Shipper-advice auto-detection + dedicated tab)".

**Session Orders/Finance/Inbox batch (2026-10-30) — migration `20261030000000_courier_type_manual`.** Adds a `manual` value to the `CourierType` enum (`MODIFY courier_type ENUM(...,'manual')` on `shipments`, `courier_credentials`, `courier_city_mappings`, `loadsheet_batches`, `courier_invoices`). Additive — every existing row unchanged; `manual` = a Shopify-style manual fulfilment with no courier booking, never routed through an adapter. One-time phpMyAdmin Import + redeploy WITH `npm install` (Prisma client regen, else 5xx). The other four items in this batch (courier-scorecard parcel drill-down, shortfall resolve via `courier_invoices.lines[]` JSON, order-item discount detail from the live Shopify path, contact↔Shopify customer-tag 2-way sync) are **code-only, NO schema change**. See CLAUDE.md "Runtime conventions (Orders/Finance/Inbox batch)".

**Session Shopify client-credentials (2026-10-27) — migration `20261027000000_shopify_client_credentials`.** Adds to `shopify_stores`: `auth_mode VARCHAR(20) NOT NULL DEFAULT 'legacy'` (`'legacy'` = pasted admin custom-app token in `admin_token_encrypted`; `'client_credentials'` = Dev Dashboard app, token minted on demand and NOT persisted), plus nullable `client_id_encrypted TEXT` / `client_secret_encrypted TEXT` (AES-GCM). Additive — every existing row defaults to `legacy`. One-time Import + redeploy WITH `npm install` (Prisma regen). See CLAUDE.md "Runtime conventions (Shopify auth modes — client-credentials)" and ERRORS "[Shopify] Dev Dashboard store token 'revoked' ~every 24h".

**Session Confidence-Guard Fix (2026-06-21) — NO schema change.** `response-confidence.service.ts` tuned: removed false-positive hedge phrases from `HEDGE_PHRASES`; added `priceGrounded` path for order-intent + `get_order_status` tool. Backend-only, standard redeploy. See ERRORS.md "[Confidence Guard] False-positive handoffs ghosting customers".

**Session VPS Migration (2026-06-16) — NO schema change.** Production moved to Hostinger KVM2 VPS + Docker. Migrations now run automatically via `prisma migrate deploy` in the container CMD. `connection_limit=18` (was 1). phpMyAdmin for day-to-day inspection at https://db.srv1519870.hstgr.cloud.

**Session Enterprise Hardening (2026-06-14) — 3 new tables:** `pending_order_hashes`, `handoffs`, `conversation_states`. Also `work_items` (engagement engine) and `events` (observability append-only log). All deployed on VPS via automatic migrations.

**Last updated (original):** 2026-05-15  
**Migration status:** 001_init (Session 1) + 002_phase2_inbox (Session 2) + 20260517000000_phase3 (Session 3) applied
**Session FE-1 (2026-05-16):** no schema changes — frontend-only session. No backend endpoint or field changes were required.

**Session AI-perchat (2026-06-02) — per-conversation auto-pilot:** Migration `20260605000000_conversation_ai_autoreply` (one-time phpMyAdmin Import; redeploy **WITH `npm install`** — Prisma client regen, else 5xx). Adds `conversations.ai_autoreply TINYINT(1) NULL` — per-chat override of the workspace auto-responder: NULL = inherit `companies.ai_autoreply_enabled`, 1 = force AI auto-reply (overrides the assigned-human skip), 0 = mute (also set automatically on an AI handoff). No new tables/queues. Backend also: explicit `ai_reply` bot action + per-chat `true` now pass `AutoReplyJob.force` so the worker replies even on an assigned chat (fixes "ai_reply + assign_agent" never replying). Shopify settings endpoints locked to owner/admin (new agent-readable `GET /settings/shopify/ready`). See CLAUDE "Runtime conventions (AI Copilot)".

**Session AI-Phase2 (2026-06-02) — auto-responder + provider toggle:** Migration `20260604000000_ai_autoreply` (one-time phpMyAdmin Import; redeploy **WITH `npm install`** — new `openai` dep + Prisma regen). Adds `companies.ai_autoreply_enabled BOOLEAN NOT NULL DEFAULT false` (opt-in fully-automated AI auto-responder; confidence-gated handoff sets conversation `pending` + a `needs-human` conversation_label) and seeds `platform_settings('ai_provider','anthropic')` (super-admin-chosen active LLM backend, Anthropic ⇄ OpenAI). New env `OPENAI_API_KEY`. No new tables. New `ai` job queue (no schema — uses existing `jobs`). See CLAUDE "Runtime conventions (AI Copilot)".

**Session AI-Copilot (2026-06-02) — AI feature foundation:** Migration `20260603000000_ai_copilot` (one-time phpMyAdmin Import; MySQL 8, no IF NOT EXISTS; re-run fails on dup column/table). Pair with redeploy **WITH `npm install`** (Prisma client regen + new `@anthropic-ai/sdk` dep — else 5xx). Adds: `subscriptions.ai_enabled BOOLEAN NOT NULL DEFAULT false` (plan gate); `companies.{ai_enabled BOOLEAN NOT NULL DEFAULT true, ai_brand_tone VARCHAR(2000) NULL, ai_default_language VARCHAR(32) NULL, ai_monthly_cap_cents INT NULL}`; `usage_metering.{ai_requests INT, ai_input_tokens INT, ai_output_tokens INT, ai_cost_micros BIGINT}` all DEFAULT 0 (monthly rollup; cost in RAW micro-dollars); new table **`ai_knowledge_base`** (id, company_id idx, title VARCHAR(200), content TEXT, enabled BOOL, timestamps); new table **`ai_usage_log`** (id, (company_id,created_at) idx, user_id NULL, period VARCHAR(7), feature VARCHAR(32), model VARCHAR(64), input_tokens, output_tokens, cost_micros BIGINT, created_at — authoritative per-call ledger for post-paid cycle billing); seeds `platform_settings('ai_price_multiplier','1.5')`. New env `ANTHROPIC_API_KEY` (optional — AI returns 503 until set). See CLAUDE "Runtime conventions (AI Copilot)".

**Session Plan-public-pricing (2026-06-01) — `subscriptions` + 8 columns:** Migration `20260602000000_plan_public_pricing` (one-time phpMyAdmin Import; MySQL 8, no IF NOT EXISTS; re-run fails on dup column). Adds `is_public BOOLEAN NOT NULL DEFAULT false`, `display_order INT NOT NULL DEFAULT 0`, `is_highlighted BOOLEAN NOT NULL DEFAULT false`, `tagline VARCHAR(160) NULL`, `features JSON NULL` (array of bullet strings), `cta_label VARCHAR(40) NULL`, `currency VARCHAR(8) NOT NULL DEFAULT 'PKR'`, `billing_period VARCHAR(16) NOT NULL DEFAULT 'month'`. Powers the public landing pricing cards (`GET /api/public/pricing`, unauthenticated, reads `is_public` plans). All additive/defaulted — existing rows stay hidden until `is_public` is turned on. Pair with redeploy WITH `npm install` (Prisma client regen — else 5xx on routes touching `subscriptions`).

**Session Usage-counter fix (2026-06-01) — NO schema change.** `usage_metering.contacts_stored` / `templates_used` are now treated as "added this period" only (they're per-month counters and reset each calendar month). Current usage of the *cumulative* capped dimensions (contacts/templates/users) is read as a LIVE `COUNT` via `common/utils/usage-counts.ts` (`getStoredUsage`), never from these columns — they still get incremented + anchor the `thresholds_notified` ledger but no display/enforcement reads them. `messages_sent`/`webhook_calls`/`conversations_opened` remain real per-period consumption. Backend-only; standard redeploy. See ERRORS "[Usage] contacts/templates reset every month".

**Session Landing-page (2026-06-01) — NO schema change.** Public marketing homepage at `/` (frontend-only).

**Session June-2026 batch (2026-06-01) — NO schema change.** Broadcast campaign builder (preview-audience / test-send / duplicate + personalization), PWA + desktop notifications, inbox paste/drag-drop/emoji/sticker rendering + custom voice-note player, inbox message-content search, and the Shopify Create-order modal refinements are all code-only (additive endpoints + frontend). Standard redeploy, no migration / no `npm install`.

**Session Tz+PDF+Legacy (2026-05-23) — `companies.timezone`:** Migration `20260601000000_company_timezone`. Adds nullable `VARCHAR(64)` for the tenant's IANA timezone name (e.g. `Asia/Karachi`, `Europe/London`). Frontend's global date/time formatters in `lib/utils.ts` (`fmtDate`/`fmtDateTime`) read this via `setActiveTimeZone` which the AuthProvider calls after `/auth/me` returns. `null` falls back to the viewer's browser timezone (Intl default). Pair with redeploy WITH `npm install` (Prisma client regen).

**Session Phase4+4.5 (2026-05-23) — `companies.{contact,template,user}_limit_override` + `usage_metering.thresholds_notified`:** Migration `20260531000000_company_overrides_and_warnings` (one-time phpMyAdmin Import; MySQL 8, no IF NOT EXISTS — re-run fails on duplicate column). Adds three `INT NULL` columns on `companies` (per-client editable plan limits — `override ?? subscription.<field>`, resolved by `common/utils/effective-limits.ts` and used by `PlanGuard`/`LimitNotifierService`/`LimitWarningService`/`SuperAdminService.getClientDetail`) and one `JSON NULL` column on `usage_metering` (fire-once ledger for 90/99/100 notifications, keyed `dim:threshold`, e.g. `["contacts:90","contacts:99","templates:90"]`; resets implicitly with the new monthly row). Pair with redeploy **WITH `npm install`** (Prisma client regen — else 5xx on routes touching the new fields).
**Session Shell-Polish-A (2026-05-25) — `companies.logo_url`:** `VARCHAR(500) NULL`. Company branding logo; stores the web path `/storage/branding/{companyId}/logo.{ext}` (deterministic filename, overwrites on re-upload). Migration `20260525000000_company_logo` (one-time phpMyAdmin Import; MySQL 8, no IF NOT EXISTS; re-run fails on duplicate column). `/auth/me` additively returns `company: { id, name, logo_url, activation_status }`. No other schema change.

**Session Shopify-Tags+Discounts (2026-05-22):** no schema change. `shopify_order_messages.status` (free VARCHAR(16)) now also takes the value `'undeliverable'` (set when the order's WhatsApp confirmation failed → `⚠ NO WhatsApp` tag) — no DDL change. Manual discounts, conversion/COD attributes, and the tag-flow fix are all code-only.

**Session Inbox-Polish round 2 (2026-05-22):** no schema change. Gate-unmount fix + mobile dvh + slash quick replies + Shopify order rework (product/variant search, variant line items, country, tags, prepaid/COD) are all code-only. The Shopify `orders/create` webhook now writes `order.email`/`customer.email` into the existing `contacts.email` column (no new column). Product search needs the Admin token's `read_products` scope (Shopify-side, not a DB change).

**Session Inbox-Polish (2026-05-22) — new table `canned_replies`:** company-wide saved quick-reply snippets. `id`, `company_id` (idx), `title VARCHAR(120)`, `body TEXT`, `created_at`/`updated_at`. Migration `20260528000000_canned_replies` (one-time phpMyAdmin Import; MySQL 8, no IF NOT EXISTS; re-run fails on "table already exists"). Pair with redeploy WITH `npm install` (Prisma client regen for the new `CannedReply` model — else 5xx on `/api/canned-replies`). No other schema change — Shopify create-order reuses the existing `companies.shopify_admin_token_encrypted` + `shopify_order_configs.{shop_domain,api_version}` (no new column/table).

**Session Shell-Polish-B (2026-05-19) — `conversations.pinned_at` + `cleared_before`:** both `DATETIME(3) NULL`, additive. `pinned_at` non-null = pinned (sticky-top in inbox list; most-recently-pinned first); `cleared_before` = "clear chat" soft marker (thread fetch hides messages with `timestamp <= cleared_before`; no row deletes, reversible). Index `conversations_company_id_pinned_at_idx (company_id, pinned_at DESC)`. Migration `20260526000000_conversation_pin_clear` (one-time phpMyAdmin Import; MySQL 8, no IF NOT EXISTS; re-run fails on duplicate column/index). Block reuses existing `contacts.status='blocked'` (no new column). Pair with redeploy WITH `npm install` (Prisma client regen for the two new fields — else 5xx on inbox routes).

**Session Shell-Polish-C (2026-05-19):** no schema changes — frontend + new `OgModule`; OG metadata cached via the existing `CacheService` (node-cache, `og:` namespace, 24h ok / 1h fail). No table, no column, no migration.

**Shopify Phase 4b (2026-05-19):** `shopify_order_configs` + `shop_domain` VARCHAR(255) NULL, `api_version` VARCHAR(16) NULL — configurable store domain (fallback when the webhook's `X-Shopify-Shop-Domain` header is absent) + selectable Admin API version. Migration `20260523000000_shopify_config_domain_apiversion` (one-time phpMyAdmin Import; re-run fails on dup column).

**Shopify Phase 4 (2026-05-22):** `companies.shopify_admin_token_encrypted TEXT NULL` (AES-GCM; client's Shopify custom-app Admin API token, for `tagsAdd`). New table `shopify_order_messages` (`id`, `company_id` idx, `message_id` UNIQUE → our outbound template message, `conversation_id`, `shopify_order_gid` VARCHAR(255), `shop_domain` VARCHAR(255), `status` VARCHAR(16) pending|confirmed|cancelled, `created_at`/`updated_at`). Migration `20260522000000_shopify_phase4` (one-time phpMyAdmin Import; re-run fails on dup column/table).

**Shopify order config (2026-05-21) — new table `shopify_order_configs`:** `id`, `company_id` UNIQUE, `template_id` INT NULL, `language_code` VARCHAR(16) NULL, `variable_map` JSON (`{ "1": "<shopify field key>", … }`), `confirm_tag`/`cancel_tag` VARCHAR(64) (default confirmed/cancelled), `enabled` TINYINT, `created_at`/`updated_at`. Migration `20260521000000_shopify_order_config` (one-time phpMyAdmin Import; re-run fails on "table already exists"). Per-company config for the orders/create → template send + tag-back flow.

**Shopify per-tenant webhook (2026-05-20) — `companies` columns:** `shopify_webhook_key VARCHAR(160) NULL UNIQUE` (immutable, name-seeded `<slug>-sh-<hex>`; URL = `/webhooks/shopify/{shopify_webhook_key}`), `shopify_webhook_secret_encrypted TEXT NULL` (AES-256-GCM; client's Shopify webhook signing secret, for HMAC verify). Migration `20260520000000_shopify_per_tenant_webhook` (one-time phpMyAdmin Import; MySQL 8, no IF NOT EXISTS; re-run fails on duplicate column/index). Mirrors Meta Option B.

**Inbox-v2 (2026-11-13) — `messages.agent_reaction` + `messages.error_reason`:** both additive nullable. `agent_reaction VARCHAR(64)` = the agent's own emoji reaction sent to the customer via a WhatsApp `reaction` message (customer reactions stay in `reaction`). `error_reason VARCHAR(500)` = persisted failure reason for a failed outbound message (Meta `(code) title — details` from the status webhook, or the media-worker reason) so a reloaded failed bubble still explains itself. Migration `20261113000000_inbox_v2_message_fields` (real Prisma migration, auto-applies on container start).

**Session FE-2d (2026-05-19) — `messages.context_message_id`:** `INT NULL`, self-FK `fk_messages_context` → `messages(id)` `ON DELETE SET NULL`, index `idx_messages_context`. Reply-with-context (Meta `context.message_id` ↔ internal id), one level deep. Migration `20260519000000_message_context_and_caption` (one-time phpMyAdmin Import; MySQL 8, no IF NOT EXISTS; re-run fails on duplicate `fk_messages_context`).

**Session FE-2c (2026-05-18) — `conversations.last_message_at`:** `DATETIME(3) NULL`, set only on message send/receive; list ordering moved off `updated_at` (polluted by read/label/assign `@updatedAt` writes). Migration `20260518100000_conversation_last_message_at` (one-time phpMyAdmin import; backfills from `updated_at`; adds `(company_id,last_message_at)` index).

**Session FE-2b (2026-05-17):** no schema changes — frontend-only (`/broadcasts`, `/broadcasts/new`, `/bots`). Built against existing broadcasts/bots contracts; nothing missing.
**Session FE-2a (2026-05-17):** no schema changes — frontend-only. No backend field turned out missing; all FE-2a pages built against existing contacts/templates/super-admin contracts (see ERRORS.md "[FE-2a] prompt vs backend" for the contract reconciliations).

---

## Tables Overview
| Table | Purpose | Has company_id | Soft delete |
|---|---|---|---|
| users | Platform users (all roles) | ✅ (nullable for super_admin) | ❌ |
| companies | Tenant companies | ❌ (IS the tenant) | ❌ |
| subscriptions | Plan definitions | ❌ | ❌ |
| contacts | WhatsApp contacts per company | ✅ | ✅ |
| conversations | WhatsApp conversations | ✅ | ✅ |
| messages | Individual messages | ✅ | ❌ |
| conversation_labels | Tags on conversations (Phase 2) | ✅ | ❌ |
| conversation_notes | Internal agent notes (Phase 2) | ✅ | ❌ |
| segments | Saved contact filters (Phase 2) | ✅ | ❌ |
| canned_replies | Saved quick-reply snippets (Inbox-Polish) | ✅ | ❌ |
| templates | WhatsApp message templates | ✅ | ✅ |
| bots | Keyword automation bots | ✅ | ❌ |
| broadcasts | Broadcast campaigns | ✅ | ❌ |
| webhook_endpoints | Client outbound webhook configs | ✅ | ❌ |
| webhook_logs | Outbound webhook delivery log | ✅ | ❌ |
| invoices | Billing invoices | ✅ | ❌ |
| audit_logs | All user actions | ✅ (nullable for super_admin) | ❌ |
| usage_metering | Per-company monthly usage | ✅ | ❌ |
| shopify_integrations | Shopify store connections | ✅ | ❌ |
| jobs | MySQL-backed async job queue | ❌ | ❌ |
| pending_order_hashes | Order idempotency dedup (hardening) | ✅ | ❌ |
| handoffs | SLA-tracked human-handoff records (hardening) | ✅ | ❌ |
| conversation_states | Shadow FSM state per conversation (hardening) | ✅ | ❌ |
| work_items | Engagement engine intent-lifecycle items | ✅ | ❌ |
| events | Append-only observability audit log | ✅ | ❌ |
| ai_knowledge_chunks | RAG embedded product/policy chunks | ✅ | ❌ |

---

## Key Column Details

### users
```
id                Int       PK auto
company_id        Int?      FK → companies (null for super_admin)
name              String
email             String    unique
password_hash     String
role              Enum      super_admin | owner | admin | agent
status            Enum      pending | active | suspended
totp_secret       String?   encrypted (2FA - scaffolded, not enforced v1)
created_at        DateTime  default now()
updated_at        DateTime  updatedAt
```

### companies
```
id                Int       PK auto
company_name      String
address           String?
subscription_id   Int       FK → subscriptions
activation_status Enum      pending | active | suspended
waba_id           String?
phone_number_id   String?
onboarding_status Json      tracks wizard step progress
logo_url          String?   VARCHAR(500) — Shell-Polish-A branding logo web path
created_at        DateTime  default now()
```

**Option B (2026-05-18) — `companies` per-tenant webhook columns:**
```
webhook_key                  VARCHAR(160) NULL UNIQUE  -- immutable, name-seeded slug + 4hex; URL = /webhooks/meta/{webhook_key}
webhook_app_secret_encrypted TEXT NULL                 -- AES-256-GCM (client's Meta app secret); NULL → env META_APP_SECRET
webhook_verify_token         VARCHAR(255) NULL          -- client's chosen verify token; NULL → env META_VERIFY_TOKEN
```
Migration `20260518000000_option_b_webhooks/migration.sql` — one-time phpMyAdmin import (MySQL 8, no IF NOT EXISTS). NULL columns fall back to platform env (Tech-Provider / Option A path).

### subscriptions
```
id                Int       PK auto
plan_name         String    starter | growth | pro | enterprise
contact_limit     Int
template_limit    Int
user_limit        Int
monthly_price     Decimal
setup_fee         Decimal
webhook_enabled   Boolean   default true
```

### contacts
```
id                Int       PK auto
company_id        Int       FK → companies
name              String
phone             String
email             String?
address           String?   VarChar(500)
city              String?   VarChar(128)
tags              Json      array of strings (case-insensitively unique)
custom_fields     Json      key-value pairs (<=50 keys, string values)
last_message_at   DateTime?
status            Enum      active | blocked | archived
opted_out_at      DateTime? DATETIME(3) - marketing opt-out (Contacts 360)
opt_out_source    String?   VarChar(32) whatsapp_stop | agent
deleted_at        DateTime? soft delete
created_at        DateTime  default now()
-- phone: canonical = international digits, no '+' (legacy '+' rows still matched)
-- indexes: (company_id, phone), (company_id, deleted_at, status), (company_id, last_message_at)
```
**Contacts 360 (2026-11-13) — migration `20261113010000_contacts_360`** (additive; real Prisma migration, auto-applies on container start): adds `opted_out_at` + `opt_out_source` and the two indexes. Broadcast audiences exclude `status='blocked'` and `opted_out_at IS NOT NULL`. No unique on `(company_id, phone)` yet — add it after prod duplicates are merged.

### conversations
```
id                Int       PK auto
company_id        Int       FK → companies
contact_id        Int       FK → contacts
assigned_user_id  Int?      FK → users
status            Enum      open | resolved | pending
last_message      String?
window_expires_at DateTime? 24hr WhatsApp window
unread_count      Int       default 0          (Phase 2)
deleted_at        DateTime?
created_at        DateTime  default now()
updated_at        DateTime  updatedAt
```

### messages
```
id                Int       PK auto
conversation_id   Int       FK → conversations
company_id        Int       FK → companies
broadcast_id      Int?                          (Phase 2; nullable FK → broadcasts.id, indexed)
message_type      Enum      text | image | audio | video | document | template | sticker
direction         Enum      inbound | outbound
content           String?
media_url         String?   local path after download
meta_media_url    String?   original Meta URL (kept for reference)
media_expires_at  DateTime? 7 days from receipt
media_expired     Boolean   default false
status            Enum      sent | delivered | read | failed
meta_message_id   String?   unique
read_at           DateTime?                     (Phase 2 — set on mark-read)
read_by_user_id   Int?                          (Phase 2)
context_message_id Int?                         (FE-2d — nullable self-FK → messages.id, ON DELETE SET NULL; the quoted/replied-to message, one level only)
timestamp         DateTime
created_at        DateTime  default now()
```
Indexes added in Phase 2: `(conversation_id, direction, status)`, `(broadcast_id)`.
FE-2d: self-relation `MessageContext` (`context_message` / `replied_by`), FK `fk_messages_context`, index `idx_messages_context` on `(context_message_id)`.

### conversation_labels  (Phase 2)
```
id              Int       PK auto
company_id      Int       FK → companies
conversation_id Int       FK → conversations (ON DELETE CASCADE)
label           VARCHAR(64)
created_at      DateTime  default now()

@@unique(conversation_id, label)
@@index(company_id, conversation_id)
```

### conversation_notes  (Phase 2)
```
id              Int       PK auto
company_id      Int       FK → companies
conversation_id Int       FK → conversations (ON DELETE CASCADE)
user_id         Int       (author)
body            Text
created_at      DateTime  default now()

@@index(company_id, conversation_id)
```

### segments  (Phase 2)
```
id          Int       PK auto
company_id  Int       FK → companies
name        VARCHAR(128)
filter      Json      { tags?, status?, lastMessageAfter?, lastMessageBefore?, hasEmail? }
created_at  DateTime  default now()
updated_at  DateTime  updatedAt

@@index(company_id)
```

### canned_replies  (Inbox-Polish)
```
id          Int       PK auto
company_id  Int       FK → companies (idx)
title       VARCHAR(120)   shortcut name
body        Text           message inserted into the composer
created_at  DateTime  default now()
updated_at  DateTime  updatedAt

@@index(company_id)
```
Company-wide saved quick replies. Tenant-scoped CRUD at `/api/canned-replies`. No Meta involvement — `body` is plain text inserted client-side into the composer textarea.

### templates
```
id                Int       PK auto
company_id        Int       FK → companies
meta_template_id  String?
name              String
category          Enum      marketing | utility | authentication
status            Enum      pending | approved | rejected | paused
content           Json      header, body, footer, buttons
rejection_reason  String?
deleted_at        DateTime?
created_at        DateTime  default now()
```

### bots
```
id                Int       PK auto
company_id        Int       FK → companies
name              String
trigger_type      Enum      exact | contains | regex
keyword           String
actions           Json      array of action objects
status            Enum      active | inactive
created_at        DateTime  default now()
```

### broadcasts
```
id                Int       PK auto
company_id        Int       FK → companies
template_id       Int       FK → templates
name              String
audience_filter   Json      segment/tag filters used
status            Enum      draft | scheduled | sending | completed | failed | cancelled
scheduled_at      DateTime?
sent_count        Int       default 0
delivered_count   Int       default 0
read_count        Int       default 0
failed_count      Int       default 0
created_at        DateTime  default now()
```

### webhook_endpoints
```
id                Int       PK auto
company_id        Int       FK → companies
endpoint_url      String
secret_key_encrypted String encrypted AES-256-GCM
events            Json      array of subscribed event names
status            Enum      active | inactive
created_at        DateTime  default now()
```

### webhook_logs
```
id                Int       PK auto
webhook_id        Int       FK → webhook_endpoints
company_id        Int       FK → companies
event_name        String
payload           Json
delivery_status   Enum      pending | success | failed
http_status       Int?
attempts          Int       default 0
next_retry_at     DateTime?
created_at        DateTime  default now()
```

### invoices
```
id                Int       PK auto
company_id        Int       FK → companies
amount            Decimal
status            Enum      pending | paid | overdue | cancelled
due_date          DateTime
paid_at           DateTime?
invoice_number    String?   @db.VarChar(32) UNIQUE   (Phase 3)
period            String?   @db.VarChar(7)  YYYY-MM   (Phase 3)
description       String?   @db.Text                  (Phase 3)
plan_snapshot     Json?     subscription snapshot     (Phase 3)
created_at        DateTime  default now()

@@index(company_id, period)                           (Phase 3)
@@unique(invoice_number)                               (Phase 3, idx_invoices_number)
```

### audit_logs
```
id                Int       PK auto
company_id        Int?      FK → companies (null for super_admin actions)
user_id           Int       FK → users
action            String    e.g. contact.created, user.suspended
entity            String    table name
entity_id         Int?
metadata          Json?     additional context
ip_address        String?
created_at        DateTime  default now()
```

### usage_metering
```
id                   Int       PK auto
company_id           Int       FK → companies
period               String    YYYY-MM format
messages_sent        Int       default 0
contacts_stored      Int       default 0
templates_used       Int       default 0
webhook_calls        Int       default 0
conversations_opened Int       default 0
updated_at           DateTime  updatedAt
```

### shopify_integrations
```
id                       Int       PK auto
company_id               Int       FK → companies  unique
shop_domain              String    e.g. mystore.myshopify.com
access_token_encrypted   String    AES-256-GCM encrypted
webhook_secret_encrypted String    AES-256-GCM encrypted
active_events            Json      array of enabled event names
status                   Enum      active | inactive | error
created_at               DateTime  default now()
updated_at               DateTime  updatedAt
```

### jobs
```
id            Int       PK auto
queue_name    String    @db.VarChar(64)   'broadcast' | 'webhook' | 'message'
payload       Json
status        Enum      pending | processing | completed | failed
attempts      Int       default 0
max_attempts  Int       default 3
run_at        DateTime  default now()     when job becomes runnable
locked_until  DateTime?                  worker lease expiry (30s)
locked_by     String?                    worker instance id (uuid)
last_error    String?   @db.Text
completed_at  DateTime?
created_at    DateTime  default now()

@@index([queue_name, status, run_at])   -- primary poll query
@@index([locked_until])                 -- orphan lease cleanup
```

### pending_order_hashes  (Enterprise Hardening — order idempotency)
```
id            INT       PK auto
company_id    INT       FK → companies (idx)
hash          VARCHAR(64) UNIQUE   -- SHA-256 of (companyId + cartSignature + contactId)
status        ENUM      reserved | finalized | released
conversation_id INT?   FK → conversations
created_at    DATETIME(3) default now()
expires_at    DATETIME(3)          -- TTL for auto-cleanup; finalized = never retry; released = allow retry
```
Used by `OrderIdempotencyService.reserve/finalize/release`. Prevents duplicate draft orders from double-taps or network retries. `finalized` rows are kept as a permanent dedup ledger; `released` rows allow re-order.

### handoffs  (Enterprise Hardening — SLA management)
```
id               INT       PK auto
company_id       INT       FK → companies (idx)
conversation_id  INT       FK → conversations (idx)
reason           TEXT      human-readable reason for handoff
reason_category  VARCHAR(64)   e.g. 'fraud_signal' | 'frustration' | 'compliance' | 'low_confidence' | 'user_request'
priority         VARCHAR(16)   'low' | 'medium' | 'high' | 'critical'
sla_due_at       DATETIME(3)   when SLA expires (priority-based offset from created_at)
resolved_at      DATETIME(3)?  set when a human picks up and resolves
escalated_at     DATETIME(3)?  set by SLA sweep when past sla_due_at and still unresolved
created_at       DATETIME(3)   default now()
updated_at       DATETIME(3)   updatedAt

@@index(company_id, resolved_at)   -- sweep query: company + unresolved
```
Created by `HandoffSlaService.createHandoff()`. SLA sweep at `/cron/handoffs/sla-sweep` fires `work_item.handoff.sla_breach` events for unresolved past-SLA rows.

### conversation_states  (Enterprise Hardening — shadow FSM)
```
id               INT       PK auto
company_id       INT       FK → companies
conversation_id  INT       FK → conversations UNIQUE (one state per conversation)
state            VARCHAR(32)   10 states: idle | greeting | discovery | proposal | objection | negotiation | commitment | order_placed | post_order | closed
meta             JSON?     state-specific payload (e.g. pending order details, objection type)
created_at       DATETIME(3)   default now()
updated_at       DATETIME(3)   updatedAt

@@unique(conversation_id)
@@index(company_id, state)
```
SHADOW mode only — updated on every message but NOT authoritative for routing decisions yet. Used for observability and future authoritative mode.

### work_items  (Engagement Engine)
```
id               INT       PK auto
company_id       INT       FK → companies (idx)
conversation_id  INT       FK → conversations (idx)
contact_id       INT?      FK → contacts
type             ENUM      SALES | ORDER | TRACKING | DISPUTE | SUPPORT
state            VARCHAR(32)   internal FSM state within the type
status           ENUM      OPEN | SNOOZED | RESOLVED | CANCELLED | EXPIRED
priority         INT       default 50   (0=low, 100=critical)
external_ref     VARCHAR(255)?   e.g. Shopify order GID
assigned_user_id INT?      FK → users (human assigned agent)
owner            ENUM      AI | HUMAN | SYSTEM
expires_at       DATETIME(3)?   auto-expire time for SNOOZED items
last_activity_at DATETIME(3)    updated on each event
created_at       DATETIME(3)    default now()
updated_at       DATETIME(3)    updatedAt

@@index(company_id, status, owner)   -- queue queries
@@index(conversation_id)
```
Created by `WorkItemService`. The engagement engine creates one work item per customer intent. `serial_key='conv:{id}'` on the job queue enforces per-conversation serial execution.

### events  (Observability — append-only audit log)
```
id               BIGINT    PK auto   (BIGINT — high volume on active tenants)
company_id       INT       FK → companies (idx)
aggregate_type   ENUM      conversation | work_item | handoff | ai_agent | order | contact
aggregate_id     INT       e.g. conversation_id or work_item_id
seq              INT       monotonic sequence per (company_id, aggregate_type, aggregate_id)
type             VARCHAR(64)   e.g. 'message.received' | 'tool.called' | 'guard.triggered' | 'handoff.created' | 'work_item.resolved'
actor_type       ENUM      ai | human | system | shopify | meta
actor_id         INT?      user_id or null for non-human actors
payload          JSON?     event-specific data
idempotency_key  VARCHAR(128) UNIQUE?   optional — prevents duplicate events from retries
created_at       DATETIME(3)   default now()

@@index(company_id, aggregate_type, aggregate_id, seq)   -- event-stream reads
@@index(company_id, type, created_at)                    -- metrics queries
```
Written by `ObservabilityService.append()`. Never updates or deletes rows. Metrics endpoint `GET /api/ai/metrics` aggregates over this table.

---

## Indexes to Create
```sql
-- Inbox performance
CREATE INDEX idx_conversations_company ON conversations(company_id, status, updated_at DESC);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, timestamp DESC);

-- Contact lookup
CREATE INDEX idx_contacts_phone ON contacts(company_id, phone);

-- Usage metering
CREATE UNIQUE INDEX idx_usage_period ON usage_metering(company_id, period);

-- Webhook delivery
CREATE INDEX idx_webhook_logs_retry ON webhook_logs(delivery_status, next_retry_at);
CREATE INDEX idx_webhook_logs_endpoint_status ON webhook_logs(webhook_id, delivery_status, created_at DESC); -- Phase 3

-- Billing (Phase 3)
CREATE UNIQUE INDEX idx_invoices_number ON invoices(invoice_number);
CREATE INDEX idx_invoices_company_period ON invoices(company_id, period);

-- Billing-Lifecycle (migration 20260527000000_billing_lifecycle) — additive
ALTER TABLE companies ADD COLUMN activated_at       DATETIME(3) NULL; -- 30-day cycle anchor, set ONCE on first activation
ALTER TABLE companies ADD COLUMN suspended_at       DATETIME(3) NULL; -- set by auto-suspend cron (drives auto-reactivation)
ALTER TABLE companies ADD COLUMN grace_until        DATETIME(3) NULL; -- super-admin "extra time"; cron skips while future
ALTER TABLE companies ADD COLUMN usage_limit_action ENUM('block','warn_only') NULL; -- per-company override; NULL → platform default
CREATE TABLE platform_settings (
  `key`      VARCHAR(64)  NOT NULL,
  `value`    VARCHAR(255) NOT NULL,
  updated_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`key`)
); -- seeded: ('usage_limit_action','block')

-- Media cleanup
CREATE INDEX idx_messages_media_expires ON messages(media_expires_at, media_expired);

-- Job queue
CREATE INDEX idx_jobs_poll ON jobs(queue_name, status, run_at);
CREATE INDEX idx_jobs_lease ON jobs(locked_until);

-- AI RAG retrieval index (migrations 20260608000000_ai_rag_chunks +
-- 20260609000000_ai_chunk_embedding_text). One embedded chunk per product /
-- store policy per tenant. embedding = base64 of the Float32 vector stored as
-- TEXT (a raw Buffer/Bytes value tripped Prisma's "unexpected end of hex
-- escape"). Cosine similarity is computed in-process (corpus is small/tenant).
CREATE TABLE ai_knowledge_chunks (
  id          INT NOT NULL AUTO_INCREMENT,
  company_id  INT NOT NULL,
  source_type VARCHAR(32)  NOT NULL,        -- 'product' | 'policy'
  source_id   VARCHAR(191) NOT NULL,        -- shopify product gid / policy key
  title       VARCHAR(255) NOT NULL,
  content     TEXT NOT NULL,
  embedding   LONGTEXT NOT NULL,            -- base64(Float32 LE), NOT Bytes
  dim         INT NOT NULL DEFAULT 0,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_chunk (company_id, source_type, source_id),
  KEY idx_chunk_company (company_id),
  CONSTRAINT fk_chunk_company FOREIGN KEY (company_id) REFERENCES companies(id)
);

-- PR module: influencer videos (migration 20261103000000_pr_videos).
-- One submission (campaign package) → MANY videos. The public form commits the
-- influencer to 2-3 (pr_submissions.form_data.videosCount); each delivered video
-- is its own row here. influencer_id is copied from the submission so a profile
-- rolls up every video across campaigns. Replaces the legacy single
-- pr_submissions.post_url (backfilled into one row per non-null post_url). The
-- submission-level `outcome` is now DERIVED from these videos.
CREATE TABLE pr_videos (
  id            INT          NOT NULL AUTO_INCREMENT,
  company_id    INT          NOT NULL,
  submission_id INT          NOT NULL,
  influencer_id INT          NULL,
  url           VARCHAR(500) NOT NULL,
  platform      VARCHAR(20)  NULL,          -- instagram | tiktok | youtube | other
  status        VARCHAR(16)  NOT NULL DEFAULT 'posted',  -- posted | approved | rejected
  notes         TEXT         NULL,
  posted_at     DATETIME(3)  NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  INDEX pr_videos_company_id_idx (company_id),
  INDEX pr_videos_submission_id_idx (submission_id),
  INDEX pr_videos_influencer_id_idx (influencer_id)
);
```

### Meta Ads → product ROAS report (migration `20261103010000_meta_ads_roas`, Nov-2026)
Additive. `companies` gains the Meta Ads connection; two new tables hold daily
spend + per-product monthly targets. `meta_ads_token_encrypted` is an OPTIONAL
override (NULL = reuse the onboarding/primary WhatsApp token); `meta_ad_account_id`
(numeric; code prefixes `act_`) marks Ads as connected.
```sql
ALTER TABLE companies
  ADD COLUMN meta_ads_token_encrypted TEXT        NULL,  -- AES-GCM override token (NULL = reuse WhatsApp token)
  ADD COLUMN meta_ad_account_id       VARCHAR(64) NULL,  -- numeric Meta ad account id
  ADD COLUMN meta_ads_currency        VARCHAR(8)  NULL,
  ADD COLUMN meta_ads_connected_at    DATETIME(3) NULL,
  ADD COLUMN meta_ads_sync_last_at    DATETIME(3) NULL;

-- One row per CAMPAIGN per DAY (campaign→product match is done at report time).
CREATE TABLE ad_spend_daily (
  id            INT           NOT NULL AUTO_INCREMENT,
  company_id    INT           NOT NULL,
  spend_date    DATE          NOT NULL,
  campaign_id   VARCHAR(64)   NOT NULL,
  campaign_name VARCHAR(512)  NOT NULL,
  spend         DECIMAL(12,2) NOT NULL,
  impressions   INT           NULL,
  clicks        INT           NULL,
  currency      VARCHAR(8)    NULL,
  synced_at     DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE INDEX ad_spend_daily_company_id_spend_date_campaign_id_key (company_id, spend_date, campaign_id),
  INDEX ad_spend_daily_company_id_spend_date_idx (company_id, spend_date)
);

-- Per-product MONTHLY target. product_key = the Shopify line-item title.
CREATE TABLE product_targets (
  id           INT           NOT NULL AUTO_INCREMENT,
  company_id   INT           NOT NULL,
  product_key  VARCHAR(255)  NOT NULL,
  period_month VARCHAR(7)    NOT NULL,       -- "YYYY-MM"
  target_value DECIMAL(12,2) NOT NULL DEFAULT 0,
  target_units INT           NOT NULL DEFAULT 0,
  updated_at   DATETIME(3)   NOT NULL,
  PRIMARY KEY (id),
  UNIQUE INDEX product_targets_company_id_product_key_period_month_key (company_id, product_key, period_month),
  INDEX product_targets_company_id_period_month_idx (company_id, period_month)
);
```

### Order UTM attribution (migration `20261103020000_order_utm_attribution`, Nov-2026)
Additive, nullable — captures ad attribution on web orders so the Ad Report can
attribute Meta spend to products (utm_campaign = the Meta campaign name).
```sql
ALTER TABLE shopify_orders
  ADD COLUMN landing_site TEXT         NULL,
  ADD COLUMN utm_source   VARCHAR(255) NULL,
  ADD COLUMN utm_medium   VARCHAR(255) NULL,
  ADD COLUMN utm_campaign VARCHAR(512) NULL,
  ADD COLUMN utm_content  VARCHAR(512) NULL;
CREATE INDEX shopify_orders_company_id_utm_campaign_idx ON shopify_orders (company_id, utm_campaign);
```

### Ad Report v2 (migration `20261103030000_ad_report_v2`, Nov-2026)
Dual attribution (Meta-native conversions) + per-tenant sync schedule + campaign→advertised-product map. Additive.
```sql
ALTER TABLE ad_spend_daily ADD COLUMN meta_purchases INT NULL, ADD COLUMN meta_conversion_value DECIMAL(12,2) NULL;
ALTER TABLE companies ADD COLUMN meta_ads_sync_interval_minutes INT NULL;
CREATE TABLE ad_campaigns (
  id INT NOT NULL AUTO_INCREMENT, company_id INT NOT NULL, campaign_id VARCHAR(64) NOT NULL,
  campaign_name VARCHAR(512) NULL, advertised_handle VARCHAR(255) NULL, advertised_title VARCHAR(255) NULL,
  synced_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY (id),
  UNIQUE INDEX ad_campaigns_company_id_campaign_id_key (company_id, campaign_id)
);
```
Bundles reuse inventory_variants.is_bundle/bundle_components (no new table).

### Ad Report v3 (migration `20261104000000_ad_report_v3`, Nov-2026)
Order financial breakdown (gross/net) + Shopify COGS for the blended profit dashboard. Additive.
```sql
ALTER TABLE shopify_orders ADD COLUMN subtotal_price DECIMAL(12,2) NULL, ADD COLUMN total_discounts DECIMAL(12,2) NULL, ADD COLUMN total_tax DECIMAL(12,2) NULL, ADD COLUMN total_shipping DECIMAL(12,2) NULL;
ALTER TABLE inventory_variants ADD COLUMN shopify_unit_cost DECIMAL(12,2) NULL;
```
line_items JSON gains lineDiscount (additive). COGS = cost_price ?? shopify_unit_cost.

### Team attendance (migration `20261106000000_team_attendance`, Nov-2026)
Self check-in/out + admin override + report. One row per user per tenant-local day. Additive (new table + one nullable column). One-time phpMyAdmin Import + redeploy WITH `npm install`.
```sql
ALTER TABLE companies ADD COLUMN work_start_time VARCHAR(5) NULL; -- "HH:MM", default 09:30; drives Late
CREATE TABLE attendance_records (
  id INT NOT NULL AUTO_INCREMENT, company_id INT NOT NULL, user_id INT NOT NULL,
  work_date DATE NOT NULL,
  status ENUM('present','absent','leave','half_day','holiday') NOT NULL DEFAULT 'present',
  check_in_at DATETIME(3) NULL, check_out_at DATETIME(3) NULL,
  is_late TINYINT(1) NOT NULL DEFAULT 0, note VARCHAR(255) NULL,
  marked_by_user_id INT NULL, -- null = self check-in; set = admin override
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE INDEX attendance_records_company_id_user_id_work_date_key (company_id, user_id, work_date),
  INDEX attendance_records_company_id_work_date_idx (company_id, work_date)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
```
Hours worked are DERIVED (check_out − check_in), never stored. `is_late` = check-in tenant-local time > `work_start_time`.

### Team attendance enhancements (migration `20261107000000_attendance_enhancements`, Nov-2026)
Per-user schedule + office-network lock + nightly-sweep flags + leave workflow. Additive. phpMyAdmin Import once + redeploy WITH `npm install`.
```sql
ALTER TABLE users ADD COLUMN attendance_work_start VARCHAR(5) NULL, ADD COLUMN attendance_work_end VARCHAR(5) NULL, ADD COLUMN attendance_require_office_ip TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN work_end_time VARCHAR(5) NULL, ADD COLUMN attendance_office_ips TEXT NULL;
ALTER TABLE attendance_records ADD COLUMN missed_checkout TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN system_marked TINYINT(1) NOT NULL DEFAULT 0;
CREATE TABLE attendance_leave_requests (
  id INT NOT NULL AUTO_INCREMENT, company_id INT NOT NULL, user_id INT NOT NULL,
  from_date DATE NOT NULL, to_date DATE NOT NULL, reason VARCHAR(500) NULL,
  status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  reviewed_by_user_id INT NULL, reviewed_at DATETIME(3) NULL, review_note VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  INDEX attendance_leave_requests_company_id_status_idx (company_id, status),
  INDEX attendance_leave_requests_company_id_user_id_idx (company_id, user_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
```
Per-user shift overrides fall back to the company default; office IP list enforced only for users with `attendance_require_office_ip`. Overtime/attendance % derived (no new columns).

### Attendance grace period (migration `20261107010000_attendance_grace`, Nov-2026)
Grace minutes after shift start before Late. Additive. Import + `npm install`.
```sql
ALTER TABLE companies ADD COLUMN attendance_grace_minutes INT NULL;
ALTER TABLE users ADD COLUMN attendance_grace_minutes INT NULL;
```
Effective grace = `users.attendance_grace_minutes ?? companies.attendance_grace_minutes ?? 0`; `is_late = check-in local minutes > start + grace`.

### Attendance payroll + flexible staff + `member` role (migration `20261110000000_attendance_payroll`, Nov-2026)
Per-user salary/allowances + "flexible timing" flag; per-tenant payroll policy + check-in cutoff; new Team-only role. Additive + nullable; auto-applies on container start (redeploy regenerates the Prisma client).
```sql
ALTER TABLE users MODIFY role ENUM(..., 'graphic_designer', 'member') NOT NULL;
ALTER TABLE users
  ADD COLUMN attendance_exempt_late TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN salary_amount        DECIMAL(14,2) NULL,
  ADD COLUMN salary_allowances    JSON          NULL,   -- [{label,amount}]
  ADD COLUMN salary_overtime_rate DECIMAL(14,2) NULL;
ALTER TABLE companies
  ADD COLUMN attendance_payroll_policy JSON       NULL, -- resolvePolicy() shape
  ADD COLUMN attendance_checkin_cutoff VARCHAR(5) NULL; -- "HH:MM", default 12:00
```
`attendance_exempt_late` → never late/early-leave, zero late deduction. Policy resolved via `attendance/payroll.ts resolvePolicy()` (defaults = late + OT off). Payroll computed in `AttendanceService.payroll(companyId, month)` (`GET /api/attendance/payroll`), all Decimals numified. `member` role = Team-only (see CLAUDE.md "Attendance v3").

### Attendance per-user check-in cutoff (migration `20261110010000_attendance_checkin_window`, Nov-2026)
Check-in window is now minutes after **each user's own shift start** (not a company-wide absolute time), so staff on different shifts each get their own cutoff. Additive, nullable; auto-applies on container start.
```sql
ALTER TABLE companies ADD COLUMN attendance_checkin_window_minutes INT NULL; -- default 150 (2.5h)
```
`resolveUser`/`myToday`: `checkinOpensAt = shiftStart − 30min`, `checkinCutoff = shiftStart + window` (flexible/exempt → 00:00–23:59, no window). The check-in CTA shows only inside `[checkinOpensAt, checkinCutoff]`. The old absolute `attendance_checkin_cutoff` column is dormant/superseded.

### Inventory push status (migration `20261108000000_inventory_push_status`, Nov-2026)
Per-variant Shopify push outcome, surfaced on the board. Additive, nullable. Auto-applies on container start.
```sql
ALTER TABLE inventory_variants
  ADD COLUMN qty_push_status  VARCHAR(12)  NULL,  -- pending|ok|error|skipped (inventorySetQuantities)
  ADD COLUMN qty_push_error   VARCHAR(500) NULL,
  ADD COLUMN cost_push_status VARCHAR(12)  NULL,  -- pending|ok|error|skipped (inventoryItemUpdate cost)
  ADD COLUMN cost_push_error  VARCHAR(500) NULL;
```
Editing `cost_price` now auto-pushes to Shopify's cost-per-item (`inventoryItem.unitCost`) and mirrors into `shopify_unit_cost`. Qty + cost pushes both need the Admin token's `write_inventory` scope. Native-bundle component variants (draft/archived) are now backfilled into `inventory_variants` after each sync so buildable/components resolve.

### Inventory price fields (migration `20261108010000_inventory_price_fields`, Nov-2026)
Editable + Shopify-pushable sale price / compare-at. Additive, nullable. Auto-applies on container start.
```sql
ALTER TABLE inventory_variants
  ADD COLUMN compare_at_price  DECIMAL(12,2) NULL,  -- "was" price (strikethrough)
  ADD COLUMN price_push_status VARCHAR(12)   NULL,  -- pending|ok|error|skipped
  ADD COLUMN price_push_error  VARCHAR(500)  NULL;
```
`price` already existed (synced, read-only) and is now editable too. Editing price/compare-at auto-pushes via `productVariantsBulkUpdate` — needs the **`write_products`** scope (not write_inventory). `compare_at_price` is also pulled from Shopify (`ProductVariant.compareAtPrice`) on sync.

### Growth module foundation (migration `20261114000000_growth_foundation`, Nov-2026)
Supersedes the Meta Ads / Ad Report tables above: **`ad_spend_daily`, `ad_campaigns`, `product_targets` and
`companies.meta_ads_*` are DROPPED** after their data is copied (Meta connection → `ad_accounts`, spend →
`ad_insights_daily` with `ad_id = 'c:<campaign_id>'`).
- `ad_accounts` — one per connected ad account, any platform (`platform` meta|google|tiktok|snap, `external_id`,
  `name`, `currency`, `timezone` auto-read from the platform, optional `token_encrypted` (AES-GCM; NULL on Meta =
  reuse the WhatsApp token), `store_id`, `sync_interval_min`, `capi_enabled` + `capi_dataset_id`, health stamps
  `last_attempt_at`/`last_success_at`/`last_error`). UNIQUE (company_id, platform, external_id).
- `ad_entities` — campaign / adset / ad hierarchy + `creative_thumb_url`, `destination_url`, `advertised_handle`.
  UNIQUE (account_id, level, external_id).
- `ad_insights_daily` — AD-grain daily insights: spend (+`spend_base` in tenant currency), impressions, reach,
  clicks, link_clicks, video_3s, thruplay, add_to_cart, checkouts, purchases, purchase_value(+`_base`),
  messaging_started (CTWA). UNIQUE (account_id, date, ad_id); INDEX (company_id, date).
- `fx_rates_daily` — (base, quote, date) → rate, daily snapshot.
- `order_touchpoints` — per-order marketing visits (source shopify_journey|landing_site, channel, platform, utm_*,
  click_id_type, landing_page, referrer). UNIQUE (company_id, order_gid, seq).
- `growth_order_facts` — PK (company_id, order_gid): tenant-local `order_date`/`order_month`/`cohort_month`,
  `lifecycle` (cancelled|rto|delivered|in_transit|confirmed|unconfirmed), `payment`, gross/net/discounts/cogs/
  units/units_no_cost/ship_cost/ship_estimated/fees/has_breakdown, `p_deliver`, city, courier, `customer_key`,
  `is_new`, first/last-touch channel/platform/campaign, `touches`, `days_to_convert`, `version`, `capi_sent_at`.
- `growth_attribution` — credit per order × model (first|last|lnd|linear|position|decay) × window (1|7|28) ×
  channel/platform/campaign/adset/ad, with credited net / expected_net / delivered. INDEX (company_id, model, win, order_date).

## Growth ad management (migration 20261115000000_growth_ad_manage)
- `ad_entities` + `configured_status VARCHAR(16)`, `budget_owner VARCHAR(8)` ('campaign'|'adset'), `budget_type VARCHAR(8)` ('daily'|'lifetime'), `lifetime_budget DECIMAL(14,2)`, `bid_strategy VARCHAR(40)`, `bid_amount DECIMAL(14,2)`, `roas_floor DECIMAL(8,4)` (plain ratio), `optimization_goal VARCHAR(40)`, `conversion_event VARCHAR(40)`, `destination_type VARCHAR(32)`, `attribution_spec JSON`, `start_time DATETIME`, `end_time DATETIME` — all nullable, written by the ad sync.
- `ad_change_log` — id, company_id, account_id, user_id, user_name, platform, level, entity_id, entity_name, action (pause|resume|budget|bid|optimization|rename|schedule|duplicate|create|undo|edit), before JSON, after JSON, batch_id (one publish), result (pending|ok|failed), error, undo_of_id, undone_at, created_at. Indexes (company_id, created_at), (company_id, entity_id), (batch_id).
- `ad_drafts` — id, company_id, user_id, payload JSON, updated_at; unique (company_id, user_id).

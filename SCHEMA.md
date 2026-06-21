# SCHEMA.md — CodesApp Database Schema
> This file is the source of truth for the database schema.
> After running `npx prisma db pull` or any migration, update this file.
> Claude Code reads this instead of needing the full Prisma schema explained.

---

## Status
**Last updated:** 2026-06-21

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
tags              Json      array of strings
custom_fields     Json      key-value pairs
last_message_at   DateTime?
status            Enum      active | blocked | archived
deleted_at        DateTime? soft delete
created_at        DateTime  default now()
```

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
```

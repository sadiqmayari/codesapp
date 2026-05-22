# SCHEMA.md — CodesApp Database Schema
> This file is the source of truth for the database schema.
> After running `npx prisma db pull` or any migration, update this file.
> Claude Code reads this instead of needing the full Prisma schema explained.

---

## Status
**Last updated:** 2026-05-15  
**Migration status:** 001_init (Session 1) + 002_phase2_inbox (Session 2) + 20260517000000_phase3 (Session 3) applied
**Session FE-1 (2026-05-16):** no schema changes — frontend-only session. No backend endpoint or field changes were required.
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
```

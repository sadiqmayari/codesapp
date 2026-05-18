# PROGRESS.md — CodesApp Build Tracker
> Update this file at the end of every session using the handoff summary.
> Claude Code reads this to understand what exists before starting work.

---

## Current Status
**Phase:** Phase 3 backend CODE COMPLETE; Frontend FE-1 + FE-2a + FE-2b + FE-2c + **FE-2d (outbound media + reply with context)** COMPLETE — first tenant ("Sois Life Sciences") LIVE end-to-end (onboarding done, inbound WhatsApp confirmed)  
**Last updated:** 2026-05-19  
**FE-2d open item:** apply migration `20260519000000_message_context_and_caption` on prod (phpMyAdmin Import) + redeploy before outbound media/reply is usable live.  
**FE-3 (2026-05-19):** all remaining pages shipped — `/analytics`, `/billing`, `/webhooks`, `/settings`, `/super-admin/plans` (frontend-only, no backend/migration). Needs redeploy + staging hand-test.  
**FE-3b (2026-05-19):** team management + profile/password + Shopify settings (backend + UI, additive, no migration). Needs redeploy + staging hand-test.  
**FE-2d follow-ups (2026-05-19):** new-convo unread badge fix; Meta failure reason surfaced on the failed tick; WhatsApp-style attach type menu; composer autofocus; dropped image/webp (Meta jpeg/png only); **voice notes** — `opus-recorder` ogg/opus in-browser, record bar (timer/pause/cancel/send) via existing `send-media`. No new backend/migration. Needs redeploy.  
**Last session:** FE-2a + FE-2b shipped, then a long live-bring-up of the first real client surfaced and fixed a chain of production issues (see "Session FE-2c"). Multi-tenant webhooks now run on **Option B** (each client uses their own Meta app; per-tenant callback URL `/webhooks/meta/{webhook_key}` + per-company app secret/verify token, env fallback) — forward-compatible with the future Tech-Provider/Embedded-Signup model (Option A) when Meta verification is obtained. Open items: apply migration `20260518000000_option_b_webhooks` on prod (phpMyAdmin) if not yet; run the media-path backfill SQL (ERRORS.md); `SUPER_ADMIN_IP_WHITELIST=*` still loose; reply/forward/delete inbox interactions deferred to the outbound-media/attachment phase.

**Phase 2 production verification (2026-05-15):**
- ✅ `GET /health` → 200 with `{success:true,data:{status:'ok'}}`
- ✅ `GET /inbox/conversations` → 401 (route mapped, guard active)
- ✅ `GET /bots`, `/contacts`, `/broadcasts`, `/templates` → all 401
- ✅ `GET /webhooks/meta?hub.verify_token=<valid>` → 200 plain text challenge
- ✅ `GET /webhooks/meta?hub.verify_token=wrong` → 403 forbidden
- ✅ Schema: `segments`, `conversation_labels`, `conversation_notes` tables created; `messages.broadcast_id`, `read_at`, `read_by_user_id` columns added; `conversations.unread_count` added; `broadcasts.status` enum extended with `cancelled`
- ✅ Meta env vars set: `META_APP_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN`, `META_GRAPH_VERSION=v19.0`
- ⏳ Meta Developer Console webhook registration — to be done in Meta panel (Callback URL = `https://apps.codentra.pk/webhooks/meta`)

**Deployment lessons (added to ERRORS.md):**
- Hostinger Cloud Apps has NO Restart button — use "Stop all running processes" then any HTTPS request lazy-starts the app
- Stale processes from a previous crash block the new deploy on the same port (silent boot hang)
- Entry file must be `main.js` (not `dist/main.js`) with Output directory `dist`
- Runtime log ≠ Access log ≠ Build log — three separate Hostinger panels

**Production verification:**
- ✅ `GET /health` → 200 with `{success:true,data:{status:'ok'}}`
- ✅ `POST /super-admin/auth/login` → 201 with JWT access token + refresh cookie
- ✅ Super admin row in MySQL (id=1, email=admin@codentra.pk, role=super_admin)
- ✅ All 16 tables present in `u633194943_codes_app` database
- ✅ JobQueueService polling every 2s without errors
- ✅ SuperAdminIpGuard correctly enforcing IP whitelist with real client IPs

**Production stack final config:**
- Host: Hostinger Business Web Hosting (Cloud Apps deploy)
- Node: 20.x (Hostinger's alt-nodejs20)
- DB: MariaDB 11.8.6 on `127.0.0.1:3306` (not `localhost` — IPv6 grant mismatch)
- DATABASE_URL has `?connection_limit=1&pool_timeout=0` to dodge Prisma Rust panics
- bcryptjs (not bcrypt — no native compile on shared hosting)
- dist/ pre-compiled and committed (Hostinger build OOMs on nest build)
- Express `trust proxy` enabled (real client IP behind Hostinger's hcdn proxy)
- Output directory: `dist`, Entry file: `main.js` (not `dist/main.js` — Hostinger wraps)

---

## Phase 1 — Foundation
| Task | Status | Notes |
|---|---|---|
| Prisma schema (all tables + jobs table) | ✅ Complete | 16 tables, all enums, all indexes; jobs table for MySQL queue |
| Prisma middleware (tenant scope) | ✅ Complete | Slow query logging >500ms in dev; $connect/$disconnect lifecycle |
| TenantGuard | ✅ Complete | Reads companyId from JWT, checks activation_status=active |
| PlanGuard | ✅ Complete | @PlanLimit decorator, CacheService (5min TTL) |
| CronGuard | ✅ Complete | X-Cron-Secret header check |
| SuperAdminIpGuard | ✅ Complete | Comma-split whitelist, bypassed in dev |
| RolesGuard | ✅ Complete | @Roles() decorator |
| EncryptionService | ✅ Complete | AES-256-GCM, random IV, base64 encoding |
| CacheService | ✅ Complete | node-cache wrapper, subscription/analytics namespaces |
| MediaService | ✅ Complete | saveBuffer, downloadFromUrl, deleteFile, getCompanyMediaDir |
| JobQueueService | ✅ Complete | MySQL polling, SKIP LOCKED, backoff, registerWorker |
| EncryptionService unit tests | ✅ Complete | 5 tests, all passing |
| Auth module (register, login, JWT) | ✅ Complete | All DTOs, JwtStrategy, bcrypt cost 12 |
| Email verification flow | ✅ Complete | nodemailer, UUID token, inline HTML templates |
| Refresh token flow | ✅ Complete | httpOnly cookie, 7d expiry |
| 2FA scaffold | ✅ Complete | /auth/2fa/setup and /auth/2fa/verify endpoints (not enforced) |
| Super admin seeder | ✅ Complete | Idempotent, bcrypt cost 12 |
| Super admin login (/super-admin/login) | ✅ Complete | SuperAdminIpGuard applied |
| Super admin panel (clients, plans, billing) | ✅ Complete | All 12 endpoints, impersonate with audit log |
| Usage metering engine | ✅ Complete | Atomic SQL increment, 80% warning with TODO for webhook |
| Shopify integration module | ✅ Complete | OAuth, HMAC verify, connect/disconnect, raw body handler |
| GitHub Actions CI/CD | ✅ Complete | SSH deploy to Hostinger, prisma migrate deploy |
| server.js entry point | ✅ Complete | Loads dist/main.js |
| .env.example | ✅ Complete | All vars, no REDIS_URL |
| Frontend auth pages | ✅ Complete | /login, /register, /verify-email, /forgot-password, /reset-password |
| Frontend super admin pages | ✅ Complete | /super-admin/login, /super-admin/dashboard |
| Auth context (token in memory) | ✅ Complete | React Context, axios interceptor for 401→refresh |

## Phase 2 — Core Modules
| Task | Status | Notes |
|---|---|---|
| Shared inbox (Socket.io, assignments) | ✅ Complete | InboxGateway with JWT handshake, room=`company:{id}` |
| 24hr conversation window enforcement | ✅ Complete | Non-template send throws 403 once window expires |
| Collision detection | ✅ Complete | `agent.viewing` / `agent.left` socket events |
| Meta inbound webhook + HMAC verify | ✅ Complete | sha256= prefix tolerated, plain-text GET challenge |
| Message worker (concurrency=3) | ✅ Complete | Streams media with per-type size cap, sets 7-day expiry |
| Contacts CRM (CRUD, tags, segments) | ✅ Complete | Segment filter→Prisma where, tag intersect in-memory |
| CSV contact import | ✅ Complete | `csv-parse` streaming, 5MB cap, plan-limit enforced mid-import |
| Templates (Meta sync, in-app creation) | ✅ Complete | `/sync` paginates Meta, `POST` submits + persists rejection_reason |
| Broadcasts (job queue, scheduling, throttle) | ✅ Complete | 10 msg/sec via `delayMs = i*100`, cancel deletes pending jobs |
| Keyword bot engine | ✅ Complete | exact/contains/regex; `fire_webhook` stub for Phase 3 |

## Phase 3 — Growth Layer
| Task | Status | Notes |
|---|---|---|
| Outbound webhooks (HMAC, retry, logs) | ✅ Complete | Dispatcher + worker (concurrency 3), HMAC-SHA256, status-code policy, stale-backlog drain |
| Analytics dashboard | ✅ Complete | $queryRaw aggregations, 5m cache (usage never cached), 90-day range cap |
| Billing module | ✅ Complete | Invoices + subscription + super-admin overview + auto-invoice cron + 80% limit-warning |
| Cloud API wizard | ✅ Complete | 5-step onboarding state machine, 503 on placeholder key, per-company Meta creds |
| Media cleanup cron (7-day deletion) | ✅ Complete | + job orphan release + 30-day purge; CronGuard header OR ?secret= fallback |

## Phase 4 — Future
| Task | Status | Notes |
|---|---|---|
| OpenAI integration | ⬜ Not started | |
| WooCommerce integration | ⬜ Not started | |
| Google Sheets integration | ⬜ Not started | |
| White label | ⬜ Not started | |

## Frontend Pages
| Page | Status | Notes |
|---|---|---|
| /login | ✅ Complete | |
| /register | ✅ Complete | |
| /verify-email | ✅ Complete | |
| /forgot-password | ✅ Complete | |
| /reset-password | ✅ Complete | |
| /super-admin/login | ✅ Complete | |
| /super-admin/dashboard | ✅ Complete | Placeholder with stats cards |
| /super-admin/clients | ✅ Complete | FE-2a: list (server pagination), client-side search/status filter, PATCH activate/suspend with optimistic UI + confirm; under new super-admin layout |
| /super-admin/plans | ⬜ Not started | |
| /dashboard | ✅ Complete | FE-1: KPI/%, funnel + daily-msg charts, usage bars, range filter, empty state |
| /inbox | ✅ Complete | FE-1: list panel (filters, search, label, mine, pagination) via inbox layout |
| /inbox/[id] | ✅ Complete | FE-1 + FE-2d: thread, inbound media, ticks, 24hr composer, template picker, notes, full socket wiring; **FE-2d** outbound media (attachment picker/preview, caption) + reply-with-context (quote strip, per-message reply, jump-to-original) |
| /contacts | ✅ Complete | FE-2a: table/cards, search, status/tag/segment filters, client-side last-activity, new/edit modal, CSV import (3-step), soft delete, segments drawer, server pagination |
| /contacts/[id] | ✅ Complete | FE-2a: profile, inline tag editor, custom-fields inline edit, block/unblock/archive, edit modal, soft delete (timeline omitted — no backend endpoint) |
| /templates | ✅ Complete | FE-2a: status filter, card grid, create form + live WhatsApp preview, Sync from Meta, detail modal w/ rejection_reason, soft delete |
| /broadcasts | ✅ Complete | FE-2b: status filter, list, send/schedule/cancel, analytics modal, live broadcast.progress socket |
| /broadcasts/new | ✅ Complete | FE-2b: create/edit draft (?id=), template select, audience builder (segment/filter), variables, Save / Save & send |
| /bots | ✅ Complete | FE-2b: keyword bot CRUD, action builder (5 types), optimistic toggle, hard-delete confirm |
| /webhooks | ✅ Complete | FE-3: endpoint CRUD modal (url/secret/events/status), toggle/test/delete, delivery logs tab (status filter, pagination, retry) |
| /analytics | ✅ Complete | FE-3: overview %, daily funnel line chart, agent bar + leaderboard, conversation cost, usage vs plan, 7/30/90d range |
| /billing | ✅ Complete | FE-3: plan + usage card, invoices list (status filter, pagination), invoice detail modal |
| /settings | ✅ Complete | FE-3 + FE-3b: tabs — WhatsApp, **Team** (list/add/role/suspend, owner/admin only), **Shopify** (connect/events/disconnect), Security (2FA), **Profile** (editable name + change password) |
| /settings/shopify | ✅ Complete | FE-3b: Shopify tab inside /settings (connect→OAuth, order-event toggles, disconnect) |
| /super-admin/plans | ✅ Complete | FE-3: list + create/edit plan modal; nav link added to super-admin layout |
| /onboarding (Cloud API wizard) | ✅ Complete | FE-1: 5-step wizard, 503 handling, owner reset, status-driven |

---

## Completed Sessions Log

### Session 1 — 2026-05-15
**Built:** Complete Phase 1 Foundation  
**Files created:**
- `codesapp/backend/` — full NestJS app (packages, config, all source files)
- `codesapp/frontend/` — Next.js 14 app (packages, config, 7 auth pages)
- `codesapp/backend/prisma/schema.prisma` — 16 tables + all enums + all indexes
- `codesapp/backend/src/common/` — EncryptionService, CacheService, MediaService, JobQueueService, all guards, filter, interceptor, decorators
- `codesapp/backend/src/modules/auth/` — full auth module (DTOs, service, controller, JWT strategy)
- `codesapp/backend/src/modules/super-admin/` — full super admin module
- `codesapp/backend/src/modules/usage-metering/` — atomic increment engine
- `codesapp/backend/src/modules/integrations/shopify/` — OAuth + HMAC scaffold
- `codesapp/database/seeders/super-admin.seeder.ts`
- `codesapp/.github/workflows/deploy.yml`
- `codesapp/backend/.env.example`
- `codesapp/.gitignore`
- All docs updated in `chatcode-docs/`

**Key decisions:**
- ChatCode renamed → CodesApp everywhere
- Redis/BullMQ removed → MySQL `jobs` table + `node-cache`
- Job poller: `setInterval(2s)` + `SELECT ... FOR UPDATE SKIP LOCKED`
- Refresh token: httpOnly cookie, access token in JS memory only
- node-cache requires `require()` not ES import (CommonJS module)

**Smoke test results:**
- `npx tsc --noEmit` → clean (0 errors)
- `npm run build` → clean dist/ output
- `node dist/main.js` → all routes mapped, fails only on MySQL connect (expected)
- `npm test encryption.service.spec` → 5/5 passing

**Next task:** Start Phase 2 — Session 2 prompt in PROMPT_PLAYBOOK.md (Shared Inbox backend + Socket.io gateway)

---

### Session 2 — 2026-05-15 (Phase 2 Backend)
**Built:** Complete Phase 2 messaging core — backend only (frontend is a separate session)

**Files created:**
- `backend/prisma/migrations/20260516000000_phase2_inbox/migration.sql` — additive DDL for 3 new tables + 4 new columns + 2 new indexes + broadcast status enum extension
- `backend/src/modules/inbox/` — 13 files: controller, service, gateway, ws-jwt guard, MetaClient, Meta webhook controller, Meta webhook service (worker), 5 DTOs, spec
- `backend/src/modules/contacts/` — controller, service, csv-import service, segments controller, segments service, 4 DTOs, segments spec
- `backend/src/modules/templates/` — controller, service, meta-template-sync service, 2 DTOs
- `backend/src/modules/broadcasts/` — controller, service, worker, plan guard, 3 DTOs
- `backend/src/modules/bots/` — controller, service, bot-engine service, 2 DTOs, spec

**Files modified:**
- `backend/prisma/schema.prisma` — added `ConversationLabel`, `ConversationNote`, `Segment` models; `Conversation.unread_count`; `Message.broadcast_id`, `Message.read_at`, `Message.read_by_user_id`; new indexes; `BroadcastStatus.cancelled` enum value
- `backend/src/app.module.ts` — registered InboxModule, ContactsModule, TemplatesModule, BroadcastsModule, BotsModule
- `backend/.env.example` — added `META_GRAPH_VERSION=v19.0`
- `CLAUDE.md` — module tree updated, env var added
- `SCHEMA.md` — 3 new table sections, column additions, broadcast status enum
- `ARCHITECTURE.md` — added "Inbox real-time event reference", "Broadcast throttle implementation", "Bot engine — fire_webhook handoff", "Cross-module forward references"
- `ERRORS.md` — added "Phase 2 Migration one-time-import note" and "Prisma InputJsonValue cast"

**Key decisions:**
- MetaClientService uses Node 20 native `https` module (no axios dep added) with 10s timeout
- Meta access tokens stored encrypted inside `companies.onboarding_status.metaAccessToken` JSON — no schema change required
- InboxGateway authenticates at `handleConnection()` so unauthenticated sockets disconnect at handshake, not per-event
- Bot `fire_webhook` enqueues to `'webhook'` queue (no worker yet) — Phase 3 will register the handler
- Cycle between `InboxModule` and `BotsModule` resolved with `forwardRef` on both sides
- Broadcast cancel uses `DELETE FROM jobs WHERE JSON_EXTRACT(payload, '$.broadcastId') = ?` — works on MariaDB 11
- Segment tag filter is post-fetch (MySQL JSON array containment requires raw SQL)
- CSV import polls usage_metering.contacts_stored against plan limit and stops mid-stream when capped

**Smoke test results:**
- `npx tsc --noEmit` → 0 errors after Prisma generate
- `npm run build:local` → clean `nest build`
- `node dist/main.js` → all new routes mapped (`/inbox/*`, `/webhooks/meta`, `/contacts/*`, `/contacts/segments/*`, `/templates/*`, `/broadcasts/*`, `/bots/*`), 'message' and 'broadcast' workers registered, gateway subscriptions logged
- `npm test` → **4 suites, 20 tests, all passing** (encryption ×5, bot-engine ×5, segments ×5, meta-webhook ×5)

**Next task:** Phase 2 frontend session (inbox UI, contacts UI, broadcasts UI, bots UI) — OR jump to Phase 3 (outbound webhooks, analytics, billing, Cloud API wizard). See `PROMPT_PLAYBOOK.md` for Session 3+ prompts.

---

### Session 3 — 2026-05-16 (Phase 3 Backend)
**Built:** Outbound Webhooks, Analytics, Billing, Cloud API Onboarding Wizard, Maintenance Cron — backend only

**Files created:**
- `backend/prisma/migrations/20260517000000_phase3/migration.sql` — invoices columns + 3 indexes (media index commented, already exists)
- `backend/src/modules/webhooks/` — module, controller, service, webhook-delivery.service (+spec), webhook-dispatcher.service (EXPORTED), webhook.worker, 3 DTOs
- `backend/src/modules/analytics/` — module, controller, service, date-range DTO
- `backend/src/modules/billing/` — module, billing.controller, billing-super-admin.controller, billing-cron.controller, billing.service, invoice-generator.service, limit-warning.service (+spec), list-invoices DTO
- `backend/src/modules/onboarding/` — module, controller, service (+spec), 4 step DTOs
- `backend/src/modules/cron/` — module, cron-maintenance.service, media-cleanup.controller, job-maintenance.controller

**Files modified:**
- `backend/prisma/schema.prisma` — Invoice columns/indexes, webhook_logs composite index
- `backend/src/common/services/encryption.service.ts` — `isUsingPlaceholderKey()` + single startup `Logger.warn`
- `backend/src/common/guards/cron.guard.ts` — header OR `?secret=` fallback, constant-time, 403
- `backend/src/modules/inbox/meta-client.service.ts` — reads `metaAccessTokenEncrypted`, `assertOnboarded()` (412)
- `backend/src/modules/inbox/inbox.service.ts` — assertOnboarded + `message.sent` dispatch
- `backend/src/modules/inbox/meta-webhook.service.ts` — `message.received/delivered/read/failed` dispatch
- `backend/src/modules/bots/bot-engine.service.ts` — `fire_webhook` → dispatcher `keyword.triggered`
- `backend/src/modules/contacts/contacts.service.ts` — `contact.created/updated` dispatch
- `backend/src/modules/templates/meta-template-sync.service.ts` — `template.approved/rejected` dispatch + assertOnboarded
- `backend/src/modules/broadcasts/broadcast.worker.ts` — assertOnboarded before send
- `backend/src/modules/usage-metering/usage-metering.service.ts` + module — calls `LimitWarningService.check`
- inbox/bots/contacts/templates `.module.ts` — import `WebhooksModule`
- `backend/src/app.module.ts` — registered 5 new modules
- `backend/.env.example`, all 5 docs

**Key decisions:**
- `WebhookDispatcherService.dispatch()` is the single exported fan-out; never throws to callers; 60s endpoint cache invalidated on mutation
- Stale-job rule keyed on `enqueuedAt` in payload (legacy Phase 2 jobs lack it → drained as `stale`) since the queue handler only receives the payload, not job metadata
- `webhook_logs.payload` stores `{ payload, reason }` (no `reason` column in schema)
- Webhook worker increments `webhook_calls` via raw SQL (not UsageMeteringService) to avoid re-entering limit-warning → dispatcher recursion
- `assertOnboarded()` 412 enforced at inbox/broadcast/template-sync, deliberately NOT at onboarding step-5 (bootstraps `completed`)
- `UsageMeteringModule → BillingModule → WebhooksModule` import chain; no cycle (Webhooks/Billing don't import back)
- CronGuard now 403 (was 401) — matches smoke-test expectations

**Database changes:** `20260517000000_phase3/migration.sql` — NOT yet applied to prod (manual phpMyAdmin import step)

**New environment variables:** `META_CONVERSATION_FLAT_USD` (default 0.005)

**Smoke test results:**
- `npx tsc --noEmit` → 0 errors
- `npm run build:local` → clean dist
- `node dist/main.js` → all `/webhooks/* /analytics/* /billing/* /super-admin/billing/* /onboarding/* /cron/*` routes mapped; `webhook` + `message` + `broadcast` workers registered (no duplicates); app started
- `npm test` → 7 suites, 34 tests passing (20 prior + webhook-delivery, onboarding ×2, limit-warning ×4)

**What is NOT done:** prod migration import + Hostinger redeploy + UptimeRobot monitors (manual steps printed below); Phase 3 frontend pages

**Next task:** Apply prod migration + redeploy + smoke-check, then Phase 3 frontend OR Phase 4 (OpenAI/WooCommerce/Sheets/white-label)

---

### Session FE-1 — 2026-05-16 (Frontend Phase 1)
**Built:** Protected app shell + onboarding gate, 5-step Onboarding Wizard, Dashboard, Inbox (list + thread) with full Socket.io real-time wiring. Frontend only — no backend changes.

**Files created:**
- `frontend/.env.example`, `frontend/.env.local`
- `frontend/src/lib/utils.ts` — `cn`, media URL, Intl time/date, 24hr `windowCountdown`
- `frontend/src/lib/inbox-types.ts` — shared inbox TS types
- `frontend/src/components/toast.tsx` — internal lightweight `ToastProvider`/`useToast`
- `frontend/src/context/socket-context.tsx` — `SocketProvider` (auth.token, both transports, status)
- `frontend/src/middleware.ts` — refresh-cookie presence gate for all (app) routes
- `frontend/src/components/app-shell/sidebar.tsx`, `navbar.tsx`
- `frontend/src/app/(app)/layout.tsx` — auth gate + onboarding gate + SocketProvider + shell
- `frontend/src/app/(app)/onboarding/page.tsx` — 5-step wizard
- `frontend/src/app/(app)/dashboard/page.tsx`
- `frontend/src/app/(app)/inbox/layout.tsx` — conversation list panel + list socket events
- `frontend/src/app/(app)/inbox/page.tsx` — desktop placeholder
- `frontend/src/app/(app)/inbox/[id]/page.tsx` — thread + composer + template picker + notes
- `frontend/.next/` — pre-compiled build committed (Hostinger OOM rule)

**Files modified:**
- `frontend/src/lib/api.ts` — added `apiFetch`/`apiFetchEnvelope`/`ApiError` (envelope unwrap, 412→/onboarding, 403/5xx mapping)
- `frontend/src/app/layout.tsx` — wrapped tree in `ToastProvider`
- `.gitignore` — negation to allow `frontend/.next/` (exclude `.next/cache`)
- CLAUDE.md / ARCHITECTURE.md / ERRORS.md / SCHEMA.md / PROMPT_PLAYBOOK.md

**Key decisions:**
- Toast: internal `ToastProvider` (no sonner/react-hot-toast dependency) — avoids Hostinger build-time registry/CDN flakiness; same `toast.success/error/info` API.
- Forms: react-hook-form + zod (matches existing auth pages).
- Onboarding gate lives in the `(app)` layout (not middleware) — middleware can only see the refresh cookie, not onboarding state; fail-open if `/onboarding/status` errors so users are never trapped.
- SocketProvider scoped to `(app)` only; `auth: (cb)=>cb({token})` re-reads the in-memory token on every (re)connect so rotation needs no reconnect logic.
- Inbox uses a persistent `(app)/inbox/layout.tsx` that owns the conversation list + list-level socket events; `/inbox/[id]` is the right pane. Mobile shows list OR thread (never both).
- Endpoint name corrections vs prompt: `step-2-webhook-verify` (single endpoint, no separate "-complete"), `step-4-waba-phone`. Verify token is server-side env (`META_VERIFY_TOKEN`) — `/onboarding/status` never returns it, so the UI explains it is admin-configured.
- Step 5 requires `templateName`+`languageCode` (backend DTO) — exposed with `hello_world`/`en_US` defaults rather than phone-only.

**Smoke test results:**
- `npx tsc --noEmit` → 0 errors
- `npx next build` → clean, 14 routes, middleware compiled, no useSearchParams/Suspense issues
- End-to-end hand-test against a running backend: **NOT performed in this environment** (no backend/MySQL available here). Must be run on staging before prod sign-off.

**What is partially done / limitations:**
- Assign-to-agent is "Assign to me" only — no backend endpoint exists to list company users/agents (FE-2 or a new backend endpoint needed for a full assignee dropdown).
- Conversation cost "trend" uses the daily funnel series + an aggregate cost stat (the `/analytics/conversation-cost` endpoint returns a single aggregate, not a time series).
- Usage "Users" bar shows the plan limit only — `/analytics/usage` exposes no current user count.

**What is NOT started (FE-2/FE-3):** Contacts, Templates, Broadcasts, Bots, Webhooks, Analytics deep-dive, Billing, Settings, super-admin clients/plans.

**Next task:** Run the FE-1 hand-test checklist against staging; then FE-2 (Contacts + Templates + Broadcasts + Bots) per PROMPT_PLAYBOOK.

---

### Session FE-2a — 2026-05-17 (Contacts + Templates + super-admin Clients)
**Built:** `/super-admin/clients` (activation unblocker), `/contacts` (+ `/contacts/[id]`, CSV import, segments), `/templates`, plus a `/login` pending-approval polish. Frontend only — backend read-only, no changes.

**Files created:**
- `frontend/src/components/ui/modal.tsx` — `Modal` + `ConfirmDialog`
- `frontend/src/lib/crm-types.ts` — shared CRM types
- `frontend/src/app/super-admin/layout.tsx` — dark chrome + nav + token-presence gate
- `frontend/src/app/super-admin/clients/page.tsx`
- `frontend/src/components/contacts/contact-form-modal.tsx`
- `frontend/src/components/contacts/csv-import-modal.tsx`
- `frontend/src/components/contacts/segments-drawer.tsx`
- `frontend/src/app/(app)/contacts/page.tsx`
- `frontend/src/app/(app)/contacts/[id]/page.tsx`
- `frontend/src/components/templates/whatsapp-preview.tsx`
- `frontend/src/components/templates/template-form-modal.tsx`
- `frontend/src/app/(app)/templates/page.tsx`

**Files modified:**
- `frontend/src/app/super-admin/dashboard/page.tsx` — slimmed (chrome now in layout), uses `apiFetch`
- `frontend/src/app/login/page.tsx` — surfaces "pending approval" on 401 `/not active/i`
- `frontend/src/components/app-shell/sidebar.tsx` — enabled Contacts + Templates
- `CLAUDE.md`, `ARCHITECTURE.md`, `ERRORS.md`, `PROGRESS.md`, `PROMPT_PLAYBOOK.md`

**Key decisions:** see ARCHITECTURE.md "Frontend patterns (FE-2a)" and ERRORS.md "[FE-2a] prompt vs backend". Highlights: CSV mapping done client-side (backend has no mapping DTO); activate/suspend are PATCH; super-admin single-gate layout; contact timeline omitted (no endpoint); single-tag filter (backend takes one); login pending-approval keyed off 401 message.

**Database changes:** none. **New env vars:** none. **SCHEMA.md:** no changes — no backend field turned out missing.

**Smoke results:** `npx tsc --noEmit` backend + frontend → 0 errors; `npm run build:local` clean; `npx next build` clean (17 routes incl. new pages); `npm run sync:web` populated `backend/dist/web` (verified `contacts.html`, `templates.html`, `super-admin/clients` present in `dist/web/.next/server/app`).

**NOT hand-tested:** No running backend/MySQL in this env — all pages are build/type verified only, not exercised against live data. Needs staging verification: contact CRUD/CSV import/segments, template create→Meta submit + sync, super-admin activate/suspend, login pending-approval path.

**Limitations / handoff:** owner email not shown in clients list (not in `getClients`); last-activity filter is current-page client-side only; media-header templates may be Meta-rejected (no sample upload path); contact timeline absent.

**Next task:** FE-2b — `/broadcasts` (+`/broadcasts/new`, broadcast.progress socket) and `/bots` (action builder); see PROMPT_PLAYBOOK.

---

### Session FE-2b — 2026-05-17 (Broadcasts + Bots)
**Built:** `/broadcasts` (list, send/schedule/cancel, analytics modal, live `broadcast.progress`), `/broadcasts/new` (create + draft edit via `?id=`, audience builder, template vars), `/bots` (keyword bot CRUD + action builder + toggle + hard-delete). Sidebar Broadcasts/Bots enabled. Frontend only — backend read-only.

**Files created:** `frontend/src/components/broadcasts/audience-builder.tsx`, `frontend/src/app/(app)/broadcasts/page.tsx`, `frontend/src/app/(app)/broadcasts/new/page.tsx`, `frontend/src/components/bots/bot-form-modal.tsx`, `frontend/src/app/(app)/bots/page.tsx`
**Files modified:** `frontend/src/lib/crm-types.ts` (Broadcast/Bot/analytics/progress types), `frontend/src/components/app-shell/sidebar.tsx` (enabled Broadcasts+Bots), `CLAUDE.md`, `ARCHITECTURE.md`, `ERRORS.md`, `SCHEMA.md`, `PROGRESS.md`, `PROMPT_PLAYBOOK.md`

**Key decisions:** see ARCHITECTURE.md "Frontend patterns (FE-2b)" + ERRORS.md "[FE-2b] prompt vs backend". Highlights: broadcasts list has no total → prev/next by full-page heuristic; `broadcast.progress` socket consumed for live counts; audience builder reuses the FE-2a segment-filter shape; `?id=` read from `window.location.search` (no Suspense); bot DELETE is hard delete; toggle is PATCH; assign_agent/fire_webhook take raw numeric IDs (no users-list endpoint; webhook UI is FE-3).

**Database changes:** none. **New env vars:** none. **SCHEMA.md:** no changes — nothing missing.

**Smoke results:** backend+frontend `tsc` 0 errors; `build:local` clean; `next build` clean (20 routes incl. `/broadcasts`, `/broadcasts/new`, `/bots`); `sync:web` populated `backend/dist/web` (verified `broadcasts.html`, `broadcasts/`, `bots.html` in `dist/web/.next/server/app`).

**NOT hand-tested:** No running backend in this env — build/type verified only. Needs staging: broadcast create→send→live progress socket, schedule, cancel; bot CRUD/toggle/match.

**Limitations / handoff:** broadcasts pagination is heuristic (no total from backend); manual contact-id audience not offered (no contact picker); assign_agent/fire_webhook use raw numeric IDs until FE-3 (webhooks UI) and a users-list endpoint exist; no `/broadcasts/[id]` page (analytics is a modal, per scope).

**Next task:** FE-3 — `/analytics` deep, `/billing`, `/webhooks`, `/settings/*`, `/super-admin/plans`. See PROMPT_PLAYBOOK.

---

### Session FE-2c (hotfixes) — 2026-05-18 (Onboarding hardening + multi-tenant webhooks)
**Built (frontend + backend hotfixes while taking the first client live):**
- Onboarding callback URL resolved from `window.location.origin` at runtime (was baking `localhost` via `NEXT_PUBLIC_API_URL`).
- Step 5 surfaces Meta's real error (parsed message/code) instead of a blank 500; accepts optional template body variables; owner **"Skip test & finish"** (`POST /onboarding/complete`) for accounts whose only approved templates require variables.
- Completed onboarding steps are re-editable (stepper/mobile chips) without a full reset.
- **Option B multi-tenant webhooks:** `companies.webhook_key` (immutable name-seeded slug), `webhook_verify_token`, encrypted `webhook_app_secret_encrypted`; per-tenant callback `/webhooks/meta/{key}`; `MetaWebhookController.resolveSecrets` with platform-env fallback (forward-compatible with future Tech-Provider/Embedded-Signup = Option A). Onboarding step 2 now captures the client's verify token + app secret and shows their unique URL. Migration `20260518000000_option_b_webhooks` (one-time phpMyAdmin import).

**DB change:** `20260518000000_option_b_webhooks/migration.sql` — NOT yet applied to prod (manual phpMyAdmin import step). **Env:** unchanged (per-tenant secrets now in DB; platform `META_*` env still used as fallback / single-tenant).

**Smoke:** backend+frontend `tsc` clean; `build:local` + `next build` clean; `sync:web` ok. **Not hand-tested:** end-to-end inbound on a per-tenant key (needs the migration applied + a client Meta app configured to the new URL).

**Continued (same session, after the first client went live):**
- **Onboarding UX:** step-3 access token optional on re-submit (blank = keep stored, like step-2 app secret); step-4 WABA/Phone pre-filled from stored columns; **verify token auto-generated** server-side (`vt_…`, generate-once/immutable like `webhook_key`) and shown read-only with copy — clients no longer invent it (step 2 only collects the app secret); copy clarifying App Secret vs Access Token.
- **Media:** inbound images/audio/video now display — `media_url` stores the **web path** `/storage/media/...` (was absolute fs path), `main.ts` mounts `express.static` for `/storage`, `mediaUrl()` resolves origin at runtime. One-time backfill SQL for pre-fix rows in ERRORS.md.
- **Session persistence:** root `/` now → `/dashboard` (was unconditional `/login`, which *looked* like "logged out" on every visit); `/login` auto-forwards an authed user; **super-admin** got `POST /super-admin/auth/refresh` + layout rehydrate from `sa_refresh_token` (reload no longer forces re-login).
- **Inbox realtime:** new message floats the conversation to the top + live preview/last_message update (was only re-sorting on refetch); conversation list switched from prev/next pagination to **infinite scroll**.
- **Notifications:** new inbound message shows a toast + WebAudio beep (skipped when viewing that thread).
- **Branding:** light "Powered by Codentra" in sidebar + login footer.

**Ticks:** outbound only by design (sent ✓ / delivered ✓✓ / read ✓✓ blue) — inbound has none; logic already existed and works.
**Deferred (next phase):** outbound media/attachment sending → and bundled with it: reply/quote (needs `context.message_id` + schema), forward, "delete for me". **"Delete for everyone" is impossible** via WhatsApp Cloud API (no recall endpoint) — do not promise it.

**Next task:** ensure `20260518000000_option_b_webhooks` applied on prod + run media backfill SQL; redeploy; then FE-3 (`/analytics` deep, `/billing`, `/webhooks` UI, `/settings/*`, `/super-admin/plans`) OR the outbound-media/attachment phase (which unlocks reply/forward/delete).

---

### Session FE-2d — 2026-05-19 (Outbound Media + Reply with context)
**Built:** Outbound media send (image/audio/video/document, pre-upload to Meta + send by id) and reply-with-context (quote a message via Meta `context.message_id`, both directions). Additive-only; existing inbound flow + `sendMessage`/socket shapes unchanged.

**Files created:**
- `backend/prisma/migrations/20260519000000_message_context_and_caption/migration.sql`
- `backend/src/modules/inbox/inbox.service.send-media.spec.ts`
- `frontend/src/components/inbox/attachment-picker.tsx`
- `frontend/src/components/inbox/attachment-preview.tsx`
- `frontend/src/components/inbox/reply-quote-strip.tsx`

**Files modified:**
- `backend/prisma/schema.prisma` — `Message.context_message_id` + self-relation `MessageContext` + `@@index`
- `backend/src/modules/inbox/meta-client.service.ts` — `uploadMedia()`, `requestBuffer()`, `extractMetaError()`, `recipient_type`/`context` on payload types
- `backend/src/modules/inbox/inbox.service.ts` — `sendMedia()`, `resolveContext()`, `MEDIA_RULES`/`MIME_EXT`, context on `sendMessage`, one-level `context_message` hydration
- `backend/src/modules/inbox/inbox.controller.ts` — `POST /inbox/conversations/:id/send-media` (FileInterceptor, 25MB cap)
- `backend/src/modules/inbox/meta-webhook.service.ts` — inbound reply detection (best-effort `context.id` → internal id)
- `backend/src/modules/inbox/dto/send-message.dto.ts` — optional `contextMessageId`
- `frontend/src/lib/inbox-types.ts` — `context_message_id`/`context_message` on `Message`
- `frontend/src/lib/api.ts` — `postMultipart<T>()`
- `frontend/src/app/(app)/inbox/[id]/page.tsx` — composer (picker/preview/reply strip), per-message reply, context quote + jump-to-original
- CLAUDE.md / ARCHITECTURE.md / SCHEMA.md / ERRORS.md / PROMPT_PLAYBOOK.md

**Key decisions:** outbound media is a separate `sendMedia` method + endpoint (never folded into `sendMessage`); Meta pre-upload (multipart → `mediaId`) then send-by-id; context resolution is best-effort (lookup miss / null wamid → send without context, warn, never throw); `context_message` hydrated exactly one level deep; client-side `validateFile` mirrors backend `MEDIA_RULES`; `postMultipart` reuses the axios envelope/ApiError path (no Content-Type header — browser sets boundary).

**Database changes:** `20260519000000_message_context_and_caption/migration.sql` — NOT yet applied to prod (one-time phpMyAdmin Import; MySQL 8, no IF NOT EXISTS; re-run fails on duplicate `fk_messages_context`).

**New env vars:** none.

**Smoke results:** backend+frontend `tsc` → 0 errors; `npm test` → **8 suites / 37 tests pass** (34 prior + 3 new send-media: window-closed 403, oversized image 400, image happy path persists web-path `media_url`); `build:local` clean; `npx next build` clean (`/inbox/[id]` ƒ); `sync:web` ok; `node dist/main.js` → `POST /api/inbox/conversations/:id/send-media` mapped, message/webhook/broadcast workers all concurrency=3 (no dupes).

**NOT hand-tested:** no running backend/MySQL/Meta in this env — not exercised against a live tenant. Needs staging on "Sois Life Sciences": real media upload+send to Meta, reply context round-trip (outbound quote shows in WhatsApp; inbound reply links back), 24hr-closed disables attachment, oversized/bad-type client+server rejection.

**Limitations:** one file at a time; no drag-and-drop; no voice recording / waveform; forward + delete-for-me deferred (FE-2e); context is one level deep (no chains); reply/media not wired into broadcasts/bots.

**Next task:** apply migration `20260519000000_message_context_and_caption` on prod + redeploy + hand-test on the live tenant; then FE-2e (Forward + Delete-for-me) or FE-3.

---

### Session FE-3 — 2026-05-19 (Analytics + Billing + Webhooks + Settings + super-admin Plans)
**Built:** All remaining product pages, frontend-only against the existing Phase-3 backend (read the controllers first — contracts matched, no backend change).

**Files created:**
- `frontend/src/app/(app)/analytics/page.tsx`
- `frontend/src/app/(app)/billing/page.tsx`
- `frontend/src/app/(app)/webhooks/page.tsx`
- `frontend/src/app/(app)/settings/page.tsx`
- `frontend/src/app/super-admin/plans/page.tsx`

**Files modified:**
- `frontend/src/lib/crm-types.ts` — FE-3 types (analytics, Invoice, BillingSubscription, WebhookEndpoint/Log, Plan, OnboardingStatusView)
- `frontend/src/components/app-shell/sidebar.tsx` — enabled Webhooks/Analytics/Billing; Settings now a live `/settings` link
- `frontend/src/app/super-admin/layout.tsx` — added Plans nav item
- PROGRESS.md / ARCHITECTURE.md / PROMPT_PLAYBOOK.md

**Key decisions:** built strictly to the actual controllers (analytics overview/funnel/agents/conversation-cost/usage; `/billing/subscription`+`/billing/invoices`; webhook endpoint CRUD+toggle+test, `/webhooks/logs`+retry; onboarding status drives `/settings` WhatsApp tab; super-admin `/plans` GET/POST/PATCH). Webhook event list hardcoded from the dispatcher's known events (no list endpoint). Webhook secret is never returned (`(set)`) → edit form leaves it blank = keep. No team/profile/password-change endpoints exist → `/settings` Profile is read-only (points to forgot-password) and team mgmt is noted as admin-managed; this is a real backend gap, not an oversight. `/settings` is a single tabbed page (not `/settings/whatsapp` sub-routes) to keep scope tight.

**Database changes:** none. **New env vars:** none.

**Smoke results:** frontend `tsc` → 0 errors; `npx next build` → clean, all 5 routes emitted (`/analytics /billing /webhooks /settings /super-admin/plans`); `sync:web` ok.

**NOT hand-tested:** no running backend/data in this env — build/type verified only. Needs staging: analytics charts with real data, invoice list/detail, webhook endpoint create→test→logs→retry, 2FA setup/verify QR, owner WhatsApp reset, super-admin plan create/edit.

**Limitations:** no `/settings/shopify` (Shopify UI deferred); profile edit / team management / in-app password change have no backend (read-only); webhook event list is static (mirrors dispatcher). Billing is view-only for tenants (pay/mark-paid is super-admin/cron side, not surfaced here).

**Next task:** FE-2e (Forward + Delete-for-me) or `/settings/shopify` + team-management backend. Hand-test FE-3 on staging.

---

### Session FE-3b — 2026-05-19 (Team management + Profile/Password + Shopify settings)
**Built:** Filled the FE-3 backend gaps. Backend + frontend, additive, no DB migration.

**Files created:**
- `backend/src/modules/auth/dto/update-profile.dto.ts`, `change-password.dto.ts`
- `backend/src/modules/team/` — team.module.ts, team.controller.ts, team.service.ts, dto/{create,update}-team-member.dto.ts
- `backend/src/modules/integrations/shopify/settings-shopify.controller.ts`, `dto/update-events.dto.ts`

**Files modified:**
- `backend/src/modules/auth/auth.controller.ts` + `auth.service.ts` — `GET /auth/me`, `PATCH /auth/profile`, `POST /auth/change-password`
- `backend/src/modules/integrations/shopify/shopify.service.ts` — `getIntegrationOrNull`, `updateEvents`; `shopify.module.ts` — registered SettingsShopifyController
- `backend/src/app.module.ts` — registered TeamModule
- `frontend/src/lib/crm-types.ts` — TeamMember, ShopifyIntegration types
- `frontend/src/app/(app)/settings/page.tsx` — editable Profile + change-password, Team tab, Shopify tab
- PROGRESS.md / ARCHITECTURE.md / PROMPT_PLAYBOOK.md

**API endpoints created:** `GET /api/auth/me`, `PATCH /api/auth/profile`, `POST /api/auth/change-password`, `GET/POST /api/team`, `PATCH/DELETE /api/team/:id`, `GET /api/settings/shopify`, `GET /api/settings/shopify/connect`, `PATCH /api/settings/shopify/events`, `DELETE /api/settings/shopify`.

**Key decisions:** team `DELETE` is a **soft-suspend** (status=suspended, no hard delete); owner row + self are immutable via the API (guards) and the UI hides those actions; only the owner can create/promote admins; `user_limit` enforced by a real count of non-suspended users (the legacy PlanGuard `current:0` for users is bypassed — not used). Authed Shopify management is a SEPARATE `/api/settings/shopify` controller reusing `ShopifyService`, so the root `/integrations/shopify/{callback,webhook}` URLs registered with Shopify stay untouched (no main.ts prefix-exclusion change). Shopify connect returns a `{shop}`-templated OAuth URL; the UI collects the store subdomain and redirects. Profile email is **not** editable (unique + would need re-verification) — name + password only.

**Database changes:** none. **New env vars:** none.

**Smoke results:** backend `tsc` 0 errors; `npm test` 8 suites / **37 tests pass** (unchanged); `build:local` clean; frontend `tsc` 0 errors; `npx next build` clean (`/settings` 6.02 kB); `sync:web` ok; `node dist/main.js` → all new routes mapped (`/api/auth/me|profile|change-password`, `/api/team*`, `/api/settings/shopify*`).

**NOT hand-tested:** no running backend/data — needs staging: add/suspend/role team member + plan-limit hit, profile rename + password change + re-login, Shopify OAuth round-trip + event toggles + disconnect.

**Limitations:** no email-change; team invite uses an admin-set temporary password (no email invite flow — SMTP is flaky on Hostinger, see ERRORS.md); Shopify order→template mapping still backend-TODO (Phase 2 handler) — UI only toggles which events are active.

**Next task:** FE-2e (Forward + Delete-for-me), or wire the Shopify order→WhatsApp-template handler, or deploy + hand-test.

---

### Session Shopify-P1 — 2026-05-20 (Per-tenant Shopify webhook — Phase 1: key + secret + UI)
**Built:** Phase 1 of the Shopify per-client order-confirmation feature. Mirrors Meta Option B. Phases 2–4 (receiver, mapping, send+tag) NOT started.

**Files created:**
- `backend/prisma/migrations/20260520000000_shopify_per_tenant_webhook/migration.sql`
- `backend/src/modules/integrations/shopify/dto/set-webhook-secret.dto.ts`

**Files modified:**
- `backend/prisma/schema.prisma` — `companies.shopify_webhook_key` (unique) + `shopify_webhook_secret_encrypted`
- `backend/src/modules/integrations/shopify/shopify.service.ts` — `ensureShopifyWebhookKey` (generate-once), `getWebhookConfig`, `setWebhookSecret` (placeholder-key 503 guard + AES-GCM)
- `backend/src/modules/integrations/shopify/settings-shopify.controller.ts` — `GET` now returns `{ integration, webhookKey, webhookSecretSet }`; new `PATCH /api/settings/shopify/webhook-secret`
- `backend/src/main.ts` — `/webhooks/shopify` added to `BACKEND_ROOTS` (reserved for Phase 2 receiver)
- `frontend/src/lib/crm-types.ts` — `ShopifySettings`
- `frontend/src/app/(app)/settings/page.tsx` — Shopify tab now always shows the per-client webhook URL + signing-secret capture (independent of OAuth connect)
- SCHEMA.md / ERRORS.md / PROGRESS.md

**API:** `GET /api/settings/shopify` (shape changed: `{integration,webhookKey,webhookSecretSet}`), `PATCH /api/settings/shopify/webhook-secret {secret}`.

**Key decisions:** per-tenant `/webhooks/shopify/{key}` exactly like Meta Option B (single shared design rejected — client uses their OWN custom Shopify app, so the signing secret differs per client). Key is immutable/generate-once (`<slug>-sh-<hex>`). Secret encrypted (AES-GCM), 503 if `ENCRYPTION_KEY` is the placeholder (same guard as onboarding step-3). Webhook config UI is independent of the OAuth connect flow (the order-confirmation path uses the webhook, not OAuth read scope).

**DB change:** `20260520000000_shopify_per_tenant_webhook` — NOT yet applied to prod (one-time phpMyAdmin Import). **New env vars:** none.

**Smoke:** backend `tsc` 0 errors; `npm test` 37/37 pass; `build:local` clean; FE `tsc` 0 errors; `next build` clean (`/settings` 6.45 kB); `sync:web` ok.

**NOT done (next phases):** Phase 2 — `/webhooks/shopify/{key}` receiver (HMAC verify w/ stored secret, parse `orders/create`, resolve company). Phase 3 — client-configurable template + Shopify-field→variable mapping + tag names (backend + UI). Phase 4 — send template on order-created; Confirm/Cancel button-reply → tag the Shopify order (needs write_orders scope + reconnect).

**Next task:** await go → Phase 2 (Shopify webhook receiver).

---

### Session 1.5 — 2026-05-15 (Production Deployment)
**Built:** Full production deploy to https://apps.codentra.pk on Hostinger Business Hosting

**What had to be discovered:**
- Hostinger Cloud Apps wraps Output directory inside another folder → required `Entry file = main.js` not `dist/main.js`
- bcrypt won't compile on Hostinger shared hosting → replaced with bcryptjs
- nest build OOM-killed on Hostinger's per-process memory cap → pre-compile dist/ locally, commit it, no-op the build script
- Hostinger sits behind a reverse proxy → required `app.set('trust proxy', true)` for IP guard to see real client IP
- Prisma's `localhost` resolves to IPv6 ::1 on Hostinger → must use `127.0.0.1`
- Prisma's Rust query engine panics on CloudLinux LVE — `timer has gone away` — fixed with `?connection_limit=1&pool_timeout=0` on DATABASE_URL
- Prisma's schema-engine subprocess can't run on Hostinger → ran migration SQL directly via phpMyAdmin Import
- Next.js 14 `useSearchParams()` requires Suspense + `dynamic = 'force-dynamic'` to pre-render
- Hostinger Cloud Apps strips devDependencies → moved build-chain into dependencies
- GitHub Actions workflow converted from SSH-deploy to CI build verifier (no deploy)

**Files modified:**
- `backend/package.json` — moved build deps, swapped bcrypt→bcryptjs, no-op build script
- `backend/src/main.ts` — added trust proxy, env diagnostic logger
- `backend/src/prisma/prisma.service.ts` — wrap $connect in try/catch
- `backend/src/modules/super-admin/super-admin.bootstrap.ts` — auto-seed on boot, try/catch
- `backend/src/common/services/encryption.service.ts` — fallback placeholder so app boots without ENCRYPTION_KEY
- `backend/src/modules/auth/strategies/jwt.strategy.ts` — same fallback for JWT_SECRET
- `backend/src/common/services/cache.service.ts` — fixed CommonJS import
- `backend/prisma/migrations/20260515000000_init/migration.sql` — generated from schema
- `frontend/src/app/{verify-email,reset-password}/page.tsx` — Suspense wrappers
- `.github/workflows/deploy.yml` — CI-only verifier (no SSH deploy)

**Final Hostinger config:**
- Framework preset: NestJS (or Custom — both work with the settings below)
- Root directory: `backend`
- Build command: `npm run build`
- Output directory: `dist`
- Entry file: `main.js`
- Node version: 20.x
- Env vars: all 16 in panel (incl. DATABASE_URL with `?connection_limit=1&pool_timeout=0`)

**Next task:** Phase 2 — Shared Inbox backend + Socket.io gateway. Apply Hostinger lessons (bcryptjs, 127.0.0.1, connection_limit=1) to any new modules.

---

### Session FE-1.1 — 2026-05-17 (Single-process integration + production hardening)
**Built:** Took FE-1 frontend live on the existing single Hostinger app and fixed the cascade of production issues that surfaced once pages loaded.

**Key changes:**
- **Single-process / single-origin:** NestJS (Express adapter) now mounts the prebuilt Next.js app in-process. `setGlobalPrefix('api', { exclude: [health, webhooks/meta, integrations/shopify, cron] })`. Built frontend ships at `backend/dist/web` (Hostinger deploys only the Output dir `dist`), synced via `backend/scripts/sync-web.js` (`npm run sync:web`). `next/react/react-dom/express` added to backend deps. Frontend API/socket base resolved at runtime from `window.location.origin` (NEXT_PUBLIC_* is build-time inlined and the build is off-host).
- **Rebuild order (REQUIRED, deleteOutDir wipes dist):** `cd backend && npm run build:local` → `cd frontend && npx next build` → `cd backend && npm run sync:web` → commit `backend/dist`.
- **Auth/login fixes:** `SuperAdminBootstrap` now re-syncs the password from env every boot (was create-only → stale hash). `SuperAdminIpGuard` supports exact IP / IPv4 CIDR / `*`. `AuthService.refresh()` returns `{accessToken,user}` (was accessToken only → reload bounced to /login). Tenant `/login` now rejects `role:super_admin`. `/login` + `/super-admin/login` got password show/hide toggles.
- **Loop fix:** `ToastProvider` context value memoized (unstable value caused dashboard infinite fetch/toast loop). Axios 401 interceptor no longer hard-redirects / skips auth endpoints (was an infinite reload loop on public pages).
- **Email:** `AuthService.send()` is provider-pluggable — Resend HTTPS API when `RESEND_API_KEY` set, else nodemailer SMTP; failures logged (were swallowed); `secure` derived from port. Live email confirmed working via Hostinger SMTP after mailbox password change.
- Temporary `/api/_debug/{ip,superadmin,mail}` diagnostics added during triage and **removed** at close-out.

**Smoke test results (production, apps.codentra.pk):**
- `/` and `/login` serve the Next UI; `/health` 200; `/api/inbox/conversations` 401; `/webhooks/meta` unchanged (403 on bad token)
- super-admin login works (IP `*`); tenant register → email delivered to inbox; dashboard loads without loop; session survives reload
- `npx tsc --noEmit` (backend+frontend) clean; `nest build` + `next build` clean

**Not done / handoff:** rotate `SUPER_ADMIN_PASSWORD` + mailbox password (exposed in chat); tighten `SUPER_ADMIN_IP_WHITELIST` from `*` to CIDR; FE-1 features (onboarding 5-step, inbox realtime, dashboard with real data) not yet hand-tested end-to-end (need an activated tenant + Meta onboarding); `/login` shows generic error hiding "pending approval"; FE-2/FE-3 pages incl. super-admin Clients "Activate" button.

**Next task:** FE-2 (Contacts + Templates + Broadcasts + Bots) — see PROMPT_PLAYBOOK.md.

---

## Status Key
- ⬜ Not started
- 🔄 In progress
- ✅ Complete
- ❌ Blocked
- ⚠️ Needs review

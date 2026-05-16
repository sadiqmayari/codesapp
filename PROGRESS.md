# PROGRESS.md — CodesApp Build Tracker
> Update this file at the end of every session using the handoff summary.
> Claude Code reads this to understand what exists before starting work.

---

## Current Status
**Phase:** Phase 3 backend CODE COMPLETE; Frontend Phase 1 (FE-1) COMPLETE — shell + onboarding + dashboard + inbox  
**Last updated:** 2026-05-17  
**Last session:** Session FE-1 + single-process integration LIVE on `apps.codentra.pk` (one Node process serves Next UI + `/api`; built frontend ships at `backend/dist/web`). Resolved post-deploy issues: deploy-only-`dist` layout, `localhost` baked into build (now origin-resolved at runtime), super-admin password create-only bug (now env-synced on boot), dynamic-IP whitelist (now supports exact/CIDR/`*`). Temporary `/api/_debug/*` endpoints removed. Note: `SuperAdminIpGuard` gates ONLY `/super-admin/*`; tenant users (`/login`,`/dashboard`,`/inbox`,`/onboarding`) have no IP restriction. Open item: rethink super-admin access model for dynamic IPs (currently `SUPER_ADMIN_IP_WHITELIST=*`).

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
| /super-admin/clients | ⬜ Not started | |
| /super-admin/plans | ⬜ Not started | |
| /dashboard | ✅ Complete | FE-1: KPI/%, funnel + daily-msg charts, usage bars, range filter, empty state |
| /inbox | ✅ Complete | FE-1: list panel (filters, search, label, mine, pagination) via inbox layout |
| /inbox/[id] | ✅ Complete | FE-1: thread, media, ticks, 24hr composer, template picker, notes, full socket wiring |
| /contacts | ⬜ Not started | |
| /contacts/[id] | ⬜ Not started | |
| /templates | ⬜ Not started | |
| /broadcasts | ⬜ Not started | |
| /broadcasts/new | ⬜ Not started | |
| /bots | ⬜ Not started | |
| /webhooks | ⬜ Not started | |
| /analytics | ⬜ Not started | |
| /billing | ⬜ Not started | |
| /settings/whatsapp | ⬜ Not started | |
| /settings/shopify | ⬜ Not started | |
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

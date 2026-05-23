# PROGRESS.md — CodesApp Build Tracker
> Update this file at the end of every session using the handoff summary.
> Claude Code reads this to understand what exists before starting work.

---

## Current Status
**Phase:** Phase 3 backend CODE COMPLETE; Frontend FE-1 → FE-3b + **Shell-Polish-A (company logo + navbar identity + notification tones)** COMPLETE — first tenant ("Sois Life Sciences") LIVE end-to-end (onboarding done, inbound WhatsApp confirmed)  
**Last updated:** 2026-05-22 (Admin-Console bug-fix session — 4 commits fixing impersonation flow + 401 interceptor role-awareness; impersonation STILL NOT CONFIRMED WORKING on live — see ERRORS.md)  
**Previous:** 2026-05-22 (Shopify tag-flow fix — pending tag now removed when customer presses after 2 min; flip confirm↔cancel now correctly removes old tag; `shopifyTagMutate` returns `{removeOk,addOk}` separately so DB update is no longer blocked by a failed remove)  
**Previous:** 2026-05-22 (Session Inbox-Polish — socket-offline fix + unread tab + mobile/swipe/lightbox UX + canned/quick replies + Shopify create-order; one new table `canned_replies`)  
**Auth session lifetime:** JWT access token expiry changed from `15m` → `7d` (matches refresh token). Users stay logged in for 7 days without silent token renewals. On logout the refresh cookie is cleared; access token lives in JS memory only so it's gone on tab/browser close. No schema/env change — standard redeploy only.  
**Shopify order default tags:** Every order created from the chat now pre-fills two default tags: the assigned agent's name + `CodesApp`. Both are removable by the agent before placing the order. Frontend-only change — standard redeploy.  
**Inbox-Polish:** shipped (type-clean) — 8 UX items. Socket auto-refresh (no more stuck "offline"), sticky Unread tab + count, mobile-header kebab, swipe-to-reply, image lightbox, canned/quick replies (`/api/canned-replies` + composer 2-option menu), Shopify create-order from chat (`/api/shopify/orders`). Round-1 committed+pushed `d9a14bd`; migration applied.  
**Inbox-Polish round 2:** shipped (type-clean, `next build` clean; NO schema change). Gate-unmount fix (instant chat open — no reconnect/flicker, Unread no longer resets), mobile `100dvh`, Shopify moved into the composer `+` menu with branded logo, slash (`/`) quick-reply autocomplete, Shopify order rework Phase 1 (product/variant picker, qty stepper, country, tags incl. auto agent name, COD/Prepaid, email capture) **+ Phase 2 Shopify shipping rates** (`POST /api/shopify/shipping-rates` → `draftOrderCalculate`; agent picks a rate → `shippingLine`). **Open: standard redeploy (no migration, no `npm install`); client must add `read_products` scope + re-paste Admin token for the product picker.**  
**Admin-Console:** shipped — `/super-admin/{billing,usage,audit}` pages + clients detail modal/delete/impersonate, wired to the 5 pre-existing super-admin endpoints. Impersonation originally used `sessionStorage` handoff; updated to `localStorage` (see below). No backend/migration/env. **Open: standard redeploy (no `npm install` needed).**
**Inbox + shell + Shopify modal overhaul (2026-05-23, latest):** Two commits.
- `0167151` — **Shopify Create-Order modal**: floating **draggable** window with NO backdrop (chat behind stays selectable/copyable; closes only via X/Cancel); customer lookup UI deferred behind a small "under development" notice (order still auto-creates/links a Shopify customer server-side via new `findOrCreateCustomer()`); order now sends **billingAddress = shippingAddress** so customer records are complete; **`draftOrderCreate.userErrors` now logged even when the draft is created** so silently-dropped order/line discounts are diagnosable from the Runtime log; reworked discount controls (unified `DiscountInput` with %/flat segmented pill toggle); shipping section restyled as selectable rate cards and "No shipping" radio removed (auto-selects the first/cheapest rate); customer fields re-laid-out into standard pairs.
- `d4d0c30` — **Inbox/shell**:
  - **Socket auto-reconnect** on `visibilitychange` / `focus` / `online` — backgrounded tabs no longer get stuck "offline" until manual refresh.
  - **Message Copy** via WhatsApp-style Reply/Copy menu — caret button on desktop hover, long-press on mobile (cancels cleanly on horizontal swipe so swipe-to-reply is unaffected). Uses `navigator.clipboard` + toast.
  - **Mobile keyboard fix** — composer auto-focus on chat open is now gated on `matchMedia('(pointer: fine)')`; touch devices no longer pop the on-screen keyboard the instant a chat opens.
  - **"Open" inbox tab** now filters by `window_expires_at > now` (the 24h WhatsApp service window), not the workflow `status` column — matches the "you can still message freely" mental model. Pending/Resolved continue to use the status column.
  - **Sidebar toggle on all breakpoints**: hamburger always visible, default open on desktop / closed on mobile; toggling closed slides the sidebar fully off-canvas (mobile-style overlay with backdrop) on desktop too; nav clicks only auto-close on mobile.
  - **Auto-assign** — first agent to reply owns the chat **only when it's currently unassigned** (never steals manual/auto assignment); `autoAssignOnReply()` helper called from both `sendMessage` and `sendMedia`; userId threaded through the controller for `/send` and `/send-media`.

**Open:** standard redeploy (no migration, no `npm install`).
**Resolved:** `20260529000000_audit_log_user_nullable` migration applied on prod (bot audit-log FK fix is now live in DB).
**Super-admin logout fix (2026-05-22, latest):** Logout called the tenant `/auth/logout` (clears `refresh_token`), leaving the super-admin's `sa_refresh_token` cookie alive → session never ended (and the new login-rehydration bounced it back in). Added `POST /super-admin/auth/logout` (clears `sa_refresh_token`); frontend now calls it + `setAccessToken(null)`. Backend change — **redeploy (no migration, no `npm install`)**.
**Super-admin cross-tab session + bot audit FK (2026-05-22, latest):** Two fixes. (1) **SA login persists across tabs** — `super-admin/login/page.tsx` now rehydrates on mount via `POST /super-admin/auth/refresh` (the `sa_refresh_token` cookie); a valid session redirects straight to the dashboard instead of re-showing the form. Frontend-only. (2) **Bot audit-log FK fixed** — `audit_logs.user_id` made nullable (`schema.prisma` `Int?`/`User?`, `bot-engine.service.ts` writes `null` not `0`, migration `20260529000000_audit_log_user_nullable`). **Open: apply that migration (phpMyAdmin Import) + redeploy WITH `npm install`** (Prisma client regen for the nullable column); the SA-login fix needs only the standard redeploy. Impersonation confirmed WORKING live by the user.
**Admin-Console impersonation — ROOT CAUSE FIXED (2026-05-22, later session):** The four earlier commits were all correct (verified present in committed `dist`/`dist/web` + pushed; HEAD `1b7faf8`) but never the cause. The real blocker was **`frontend/src/middleware.ts`**: its `(app)/*` gate redirects to `/login` whenever the `refresh_token` cookie is absent — and an impersonation tab legitimately has none (super-admin holds only `sa_refresh_token`; the impersonation token is in-memory via localStorage). So `GET /dashboard` was bounced to `/login` server-side, before AuthProvider could consume `ca_impersonation_token`. **Fix:** opener sets a short-lived JS marker cookie `ca_impersonation_handoff` (max-age 30s) before `window.open`; middleware now allows the request when that cookie OR `refresh_token` is present; AuthProvider clears the marker after consuming the token. Token still travels via localStorage (unchanged). Frontend rebuilt + `sync:web` re-run; `dist/web` regenerated. See ERRORS "[Admin-Console] ROOT CAUSE FOUND". **Open: standard redeploy (no migration, no `npm install`) — then hand-test impersonation live.**
**Admin-Console bug-fix session (2026-05-22):** Four commits applied to fix impersonation + super-admin session issues (all correct, all kept — see root-cause note above).
- `925ab00` — removed `noopener` from `window.open` in `super-admin/clients/page.tsx` (noopener gives the new tab an empty sessionStorage)
- `598a891` — `super-admin.service.ts` `impersonate()`: wrapped `auditLog.create()` in `.catch()` so an FK violation doesn't crash before `jwt.sign()` and prevents the token from being returned
- `ed43e98` — `lib/api.ts` 401 interceptor: (a) skip if no token in memory (prevents race on new tab), (b) decode role from JWT and use `/super-admin/auth/refresh` for super-admins instead of always calling tenant `/auth/refresh`
- `1b7faf8` — switched impersonation token handoff from `sessionStorage` to `localStorage` in both `super-admin/clients/page.tsx` and `auth-context.tsx`; `auth-context` mount effect reads `localStorage` (not sessionStorage) as the first impersonation branch  
**Shell-Polish-B:** shipped — `conversations.pinned_at` + `cleared_before` (migration `20260526000000_conversation_pin_clear`), `POST /api/inbox/conversations/:id/{pin,unpin,clear}`, company-wide pin, server soft-marker clear, block via existing `contacts.status`. No socket shape change. **Open: apply migration on prod + redeploy WITH `npm install`.**  
**Shell-Polish-C:** shipped — `OgModule` (`GET /api/og`, JWT-guarded, SSRF-blocked, regex-parsed, in-memory cache 24h ok / 1h fail) + frontend `OgPreviewCard` + shared `extractUrls`/`autolinkText`; inbound text only. No schema/socket/dep/env change. Needs standard redeploy + hand-test.  
**`/login` pending-approval polish:** verified on live 2026-05-19 (user confirmed verified-green in the pre-session check) — no further work needed.  
**Shell-Polish-A open item:** apply migration `20260525000000_company_logo` on prod (phpMyAdmin Import) + redeploy WITH `npm install` (regenerates Prisma client for `companies.logo_url`) before logo upload/`/auth/me` company field work live. [Migration applied 2026-05-25.]  
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
| /settings | ✅ Complete | FE-3 + FE-3b + **Shell-Polish-A**: tabs — WhatsApp, **Team**, **Shopify**, Security (2FA), **Profile** (editable name + change password + **Company branding** logo upload/remove owner/admin-only + **Notification sound** 5 device-local tones w/ preview) |
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

### Session Shopify-P2 — 2026-05-20 (Per-tenant Shopify webhook — Phase 2: receiver)
**Built:** The public per-tenant Shopify webhook receiver. Phases 3–4 (mapping, send+tag) NOT started.

**Files created:**
- `backend/src/modules/integrations/shopify/shopify-tenant-webhook.controller.ts`

**Files modified:**
- `backend/src/modules/integrations/shopify/shopify.service.ts` — `handleTenantOrderWebhook(key, topic, hmac, rawBody)`: resolve company by `shopify_webhook_key`, decrypt that company's secret, verify HMAC-SHA256 base64 (constant-time, length-guarded), parse `orders/create`, log summary. Non-`orders/create` topics + bad JSON acknowledged 200 (ignored).
- `backend/src/modules/integrations/shopify/shopify.module.ts` — registered the controller
- `backend/src/main.ts` — `webhooks/shopify` + `webhooks/shopify/(.*)` added to the `setGlobalPrefix` exclude list (URL stays at root for the client's Shopify config)
- PROGRESS.md / ARCHITECTURE.md

**API:** `POST /webhooks/shopify/:key` (public, root — NOT under /api; HMAC-authenticated per company; raw body via `rawBody:true`).

**Key decisions:** authenticity = per-company HMAC only (no JWT — it's an external Shopify callback), verified with the company's own stored signing secret (mirrors the Meta per-tenant model). Unknown key / missing-secret / bad HMAC → 401 (Shopify retries; forged requests rejected). Phase 2 deliberately only validates+parses+logs — the template send + order tagging are Phase 4 so each phase ships independently green.

**DB change:** none (Phase 1's migration still pending phpMyAdmin import on prod). **New env vars:** none.

**Smoke:** backend `tsc` 0 errors; `npm test` 37/37 pass; `build:local` clean; `sync:web` ok; `node dist/main.js` → `POST /webhooks/shopify/:key` mapped at root (correctly outside `/api`).

**NOT done (next phases):** Phase 3 — client-configurable approved-template + Shopify-field→`{{n}}` variable mapping + Confirm/Cancel tag names (backend persistence + Settings UI). Phase 4 — on `orders/create` send that template to the order's customer; detect the template button reply → call Shopify Admin API to tag the order (needs the client's Admin API access token — a NEW credential to capture — and `write_orders`).

**Next task:** await go → Phase 3 (configurable template + mapping + tag names).

---

### Session Shopify-P3 — 2026-05-21 (Per-tenant Shopify — Phase 3: order-confirmation config)
**Built:** Per-company order-confirmation configuration (persistence + Settings UI). Phase 4 (send + tag-back) NOT started.

**Files created:**
- `backend/prisma/migrations/20260521000000_shopify_order_config/migration.sql` (new table `shopify_order_configs`)
- `backend/src/modules/integrations/shopify/dto/order-config.dto.ts`

**Files modified:**
- `backend/prisma/schema.prisma` — `ShopifyOrderConfig` model (company_id unique)
- `backend/src/modules/integrations/shopify/shopify.service.ts` — exported `SHOPIFY_ORDER_FIELDS` (fixed source-field list), `getOrderConfig`, `upsertOrderConfig` (validates mapped fields ∈ list; if enabled requires an approved company template; derives `language_code` from template)
- `backend/src/modules/integrations/shopify/settings-shopify.controller.ts` — `GET`/`PUT /api/settings/shopify/order-config`
- `frontend/src/lib/crm-types.ts` — `ShopifyOrderConfig`, `ShopifyOrderConfigResponse`
- `frontend/src/app/(app)/settings/page.tsx` — Shopify tab "Order confirmation" card (enable toggle, approved-template picker, parses `{{n}}` from the template body and maps each to a Shopify field, Confirm/Cancel tag names)
- SCHEMA.md / ERRORS.md / PROGRESS.md

**API:** `GET /api/settings/shopify/order-config` → `{config, fields}`; `PUT /api/settings/shopify/order-config`.

**Key decisions:** fixed allowlist of Shopify order source fields (`order_name, total_price, customer_phone, line_items_summary, …`) — backend constant mirrored in UI; mapped values validated against it. `enabled` requires a Meta-approved company template; `language_code` derived from the template (needed for the Phase-4 Meta send). Config stored in its own table keyed by `company_id` (the client uses the webhook, not OAuth, so `shopify_integrations` may not exist — independent table is correct). UI explicitly says sending/tagging is the next update.

**DB change:** `20260521000000_shopify_order_config` — NOT yet applied to prod (one-time phpMyAdmin Import). **New env vars:** none.

**Smoke:** backend `tsc` 0 errors; `npm test` 37/37; `build:local` clean; FE `tsc` 0 errors; `next build` clean (`/settings` 7.51 kB); `sync:web` ok.

**NOT done:** Phase 4 — on `orders/create` (Phase-2 receiver) load this config, extract the mapped Shopify fields, send the approved template (with `{{n}}` filled) to the order's customer via the existing Meta send path; detect the template's Confirm/Cancel button reply in the inbound webhook and call the Shopify Admin API to add `confirm_tag`/`cancel_tag` to the order. Needs a NEW per-client credential — the custom app's **Admin API access token** (capture UI + encrypted column) — and `write_orders`.

**Next task:** await go → Phase 4 (send on order + button-reply → Shopify order tag).

---

### Session Shopify-P4 — 2026-05-22 (Per-tenant Shopify — Phase 4: send + tag-back) — FEATURE COMPLETE
**Built:** The full order→template→Confirm/Cancel→Shopify-tag flow. Shopify per-tenant order confirmation is now end-to-end.

**Files created:**
- `backend/prisma/migrations/20260522000000_shopify_phase4/migration.sql` (companies.shopify_admin_token_encrypted + table shopify_order_messages)
- `backend/src/modules/integrations/shopify/dto/set-admin-token.dto.ts`

**Files modified:**
- `backend/prisma/schema.prisma` — `companies.shopify_admin_token_encrypted`, model `ShopifyOrderMessage`
- `backend/src/modules/integrations/shopify/shopify.service.ts` — `OnModuleInit` registers `'shopify'` worker (concurrency 3); `processJob`/`processOrderSend`/`processOrderTag`; `setAdminToken`; `extractOrderValue`/`orderPhone`; `shopifyGraphql` (native https `tagsAdd`); receiver now enqueues a send job; `getWebhookConfig` returns `adminTokenSet`
- `backend/src/modules/integrations/shopify/settings-shopify.controller.ts` — `PATCH /api/settings/shopify/admin-token`
- `backend/src/modules/integrations/shopify/shopify-tenant-webhook.controller.ts` — passes `X-Shopify-Shop-Domain`
- `backend/src/modules/integrations/shopify/shopify.module.ts` — imports InboxModule + UsageMeteringModule
- `backend/src/modules/inbox/meta-webhook.service.ts` — `MetaInboundMessage` gains `button`/`interactive`; surfaces the tapped button label; on a button reply whose context = a sent order template, enqueues a `{kind:'tag'}` shopify job (best-effort)
- `frontend/src/lib/crm-types.ts` — `ShopifySettings.adminTokenSet`
- `frontend/src/app/(app)/settings/page.tsx` — Admin API token field in the Shopify webhook card; updated order-config copy (feature now live)
- SCHEMA.md / ERRORS.md / ARCHITECTURE.md / PROGRESS.md

**API:** `PATCH /api/settings/shopify/admin-token`. **Job queue:** new `'shopify'` worker (concurrency 3) — kinds `send` + `tag`.

**Key decisions:** webhook enqueues + 200s immediately (Shopify 5s budget); template send reuses `InboxService.sendMessage` (handles persist/usage/socket/webhook, bypasses 24h window for templates); contact/conversation get-or-create mirrors the inbound path. Button-reply→tag is routed via the existing `'shopify'` queue from `MetaWebhookService` (only needs prisma+jobQueue → no Inbox↔Shopify module cycle). confirm/cancel derived from the button label substring (case-insensitive). Everything best-effort: no phone / disabled config / missing Admin token → logged, never throws, webhook still 200.

**DB change:** `20260522000000_shopify_phase4` — **APPLIED to prod by user** (Phases 1–3 migrations also applied). **New env vars:** none.

**Smoke:** backend `tsc` 0 errors; `npm test` 37/37; `build:local` clean; FE `tsc` 0 errors; `next build` clean (`/settings` 7.67 kB); `sync:web` ok; `node dist/main.js` → `PATCH /api/settings/shopify/admin-token` + `POST /webhooks/shopify/:key` mapped, `Registered shopify worker (concurrency=3)`.

**NOT hand-tested:** no live Shopify store / Meta in this env — needs staging: real `orders/create` → template received by customer with variables filled → tap Confirm/Cancel → order tagged in Shopify. Requires the client's webhook secret + Admin API token (write_orders) set in Settings→Shopify and an approved template with Confirm/Cancel quick-reply buttons.

**Limitations:** `orders/create` only; confirm/cancel inferred from button label text (name the template buttons with "Confirm"/"Cancel"); one template per company; Admin token needs `write_orders` (client custom app).

**Next task:** redeploy + staging hand-test the full Shopify flow on the live tenant.

---

### Session Shopify-P4b — 2026-05-19 (configurable store domain + API version; OAuth UI removed)
**Built:** Removed the misleading OAuth "Connect store"/"Order events" UI from the Shopify tab (per-client custom-app model only — no shared platform env var). Added a configurable **Store domain** (fallback for the webhook's `X-Shopify-Shop-Domain`) and a **Shopify API version** dropdown to the Order-confirmation config; the Admin API `tagsAdd` call now uses them.

**Files:** migration `20260523000000_shopify_config_domain_apiversion` (shop_domain, api_version on `shopify_order_configs`); `schema.prisma`; `shopify.service.ts` (`SHOPIFY_API_VERSIONS` list, getOrderConfig returns `apiVersions`, upsert persists domain/version sanitized, `shopifyGraphql`/`processOrderTag` use resolved domain+version); `order-config.dto.ts` (+shopDomain,+apiVersion); `settings-shopify.controller.ts`; `crm-types.ts`; `settings/page.tsx` (ShopifyTab OAuth removed; ShopifyOrderConfigCard +domain input +version select); SCHEMA/ERRORS/PROGRESS.

**Commits:** `ba5010d` (OAuth UI removal + deploy-gotcha docs) → this (P4b domain/version).

**DB change:** `20260523000000_shopify_config_domain_apiversion` — NOT yet applied to prod (one-time phpMyAdmin Import; then redeploy WITH npm install so Prisma client regenerates). **New env vars:** none.

**Smoke:** backend `tsc` 0 errors; `npm test` 37/37; `build:local` clean; FE `tsc` 0 errors; `next build` clean (`/settings` 7.17 kB); `sync:web` ok.

**Open item (unrelated, still pending user):** "Something went wrong" on Shopify tab/Dashboard = stale Prisma client on prod — fixed by redeploying with `npm install` (or `npx prisma generate` on server) after applying the pending migrations.

**Next task:** user applies pending migrations (`20260521…`, `20260522…`, `20260523…`) + redeploys with install; then staging hand-test the full Shopify flow.

---

### Session Batch-Fixes — 2026-05-19 (Shopify hardening + inbox/analytics fixes + polish)
**Commits:** `a0004b9` (Shopify A+B), `be3b56a` (inbox/analytics C + favicon/bell), plus earlier `ba5010d`/`4983244`/`52f5009` (Shopify P4/P4b/OAuth-removal) and `bc26f19` (/webhooks routing).

**DONE & pushed:**
- Shopify: phone normalize w/ `companies.default_country_code` (default 92) + dedupe; **skip paid orders** (financial_status=paid / total_outstanding=0); new `shipping_full_address` var (line1+line2+city, no postal); API versions → 2024-10…2026-04 (default 2026-04); **reversible confirm↔cancel**, configurable **pending tag** + **decision window** (default 2 min) applied on no-answer; tag mutate only ever touches our 3 tags (tagsAdd/tagsRemove); **consolidated Settings→Shopify into ONE card + single Save** (webhook URL, masked secret/admin "leave blank to keep", country code, template/mapping/tags/pending/window/domain/api-version) — no per-field page refresh.
- Inbox: outbound template now renders **header/body/footer/buttons** in chat (was `[template:name]`); **clickable links** in bubbles + `preview_url:true` on outbound text (WhatsApp shows link preview); **Unread tab** added (status=unread → unread_count>0).
- Analytics: **reply-rate bug fixed** — now conversation-based (replied/outbound-convos) and all ratios clamped 0–100% (was 1400%); agent **avg response** formatted `m` / `Hh Mm`.
- Polish: app **favicon** (`frontend/src/app/icon.svg`); navbar **bell is clickable** (→ /inbox) instead of a dead icon.

**Migrations added this session (apply via phpMyAdmin, one-time, then redeploy WITH `npm install`):**
`20260520000000_shopify_per_tenant_webhook`, `20260521000000_shopify_order_config`, `20260522000000_shopify_phase4`, `20260523000000_shopify_config_domain_apiversion`, `20260524000000_shopify_order_flow`. (User confirmed 20260520 + earlier applied; **21–24 must be applied**.)

**Broadcasts unblock (manual, no code) — run on prod DB:**
```sql
-- point the live tenant at a plan that has broadcasts (webhook_enabled plan / growth+)
UPDATE companies SET subscription_id = (
  SELECT id FROM subscriptions WHERE plan_name IN ('growth','pro','enterprise') ORDER BY id LIMIT 1
) WHERE id = 3;
```
(Or create/adjust a plan in Super-admin → Plans and assign it.)

**Media 7-day deletion:** already implemented (Phase 3 `GET /cron/media-cleanup`). To activate, schedule an UptimeRobot/cron monitor hitting `https://apps.codentra.pk/cron/media-cleanup?secret=$CRON_SECRET` daily. No code change needed.

**DEFERRED to a follow-up session (scoped, not done — too large for this batch):**
1. Navbar **company name + (logged-in user)** + per-company **logo upload** — needs `/auth/me`/refresh to also return company name+logo and a logo-upload endpoint + `companies.logo_url`.
2. **5 selectable notification tones** + a richer bell **dropdown** of recent unread (currently bell just navigates to /inbox).
3. Chat **pin / clear / block** menu — needs `conversations.pinned` (migration) + clear-messages + block endpoints + thread kebab UI (contact block already exists via /contacts PATCH status).
4. **Rich inbound URL OG-preview cards** (only clickable links + outbound preview done, as agreed).

**Smoke:** backend `tsc` 0 errors, `npm test` 37/37, `build:local` clean, FE `tsc` 0 errors, `next build` clean, `sync:web` ok (both batches).

**Revision (commit `b2a9f34`):** Shopify Settings split into **3 independent blocks** — 1·Credentials (webhook URL + secret + admin token + store domain + API version), 2·Template (enabled + approved template + variable mapping), 3·Tags (confirm/cancel/pending + decision window) — **each with its own Save button** hitting `PATCH /settings/shopify/{credentials|template|tags}`, updating state in place (no page reload). Country-code normalization is now a **fixed default `92`** (NOT client-configurable — removed the input + `defaultCountryCode` from DTO/get/upsert; `companies.default_country_code` column left unused). Old `PUT /settings/shopify/order-config` replaced by the 3 PATCH routes. Navbar **bell is now a dropdown** of recent unread chats (click → conversation, "Open inbox" link) — deferred item #2's dropdown part is DONE; 5 notification tones still deferred.

**Next task:** user applies migrations 21–24 + redeploys WITH npm install (also fixes the prior stale-Prisma "Something went wrong"); hand-test Shopify end-to-end + the inbox/analytics fixes; then pick up remaining deferred items (company-name+logo navbar, 5 notification tones, chat pin/clear/block, rich inbound URL OG previews).

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

### Session Shell-Polish-A — 2026-05-25 — Company Logo + Navbar Identity + Notification Tones
**Built (additive-only, no inbox/socket/Meta/Shopify changes):**
- **DB:** ONE nullable column `companies.logo_url VARCHAR(500)`. Migration `20260525000000_company_logo` (one-time phpMyAdmin Import — MySQL 8, no IF NOT EXISTS).
- **Backend:** `schema.prisma` Company gains `logo_url`. `AuthService.getMe` additively returns `company:{id,name,logo_url,activation_status}`. New `SettingsModule` → `CompanyController` `@Controller('settings/company')` (`POST /api/settings/company/logo` + `DELETE`), guards `JwtAuthGuard→TenantGuard→RolesGuard @Roles('owner','admin')`, `FileInterceptor` memory 2MB cap, mimes jpeg/png/webp/svg. `MediaService.saveBrandingLogo`/`deleteBrandingLogos` — deterministic file `<storage>/branding/{companyId}/logo.{ext}`, web path persisted, served by existing `/storage` mount. New spec `company.service.spec.ts` (oversized→400, bad mime→400, missing→400, happy path persists web path, delete nulls + best-effort unlink).
- **Frontend:** `auth-context` User gains `company`; `AuthProvider` fetches `/auth/me` after refresh+login and merges; `setCompanyLogo()` patches in place. `navbar.tsx` renders company logo/initials + name (truncate 24ch) left-of-bell; user dropdown gains role + Settings link. `settings` Profile tab: **Company branding** card (owner/admin only — preview, upload, remove w/ ConfirmDialog, client-side 2MB/mime mirror) + **Notification sound** card (5 radio tones, Play preview, instant localStorage save, per-device note). `lib/notification-sound.ts` (NOTIFICATION_TONES, get/setSelectedTone, playTone, playNotification). `(app)/layout.tsx` inline WebAudio beep replaced by `playNotification()` (timing/text unchanged). 5 bundled `public/sounds/*.wav`.
**Audio note:** tones shipped as **WAV** (not OGG/MP3) — generated locally (16-bit PCM mono, ~0.25–0.7s); valid OGG/MP3 needs an encoder unavailable offline. WAV plays via `new Audio()` everywhere and is tiny at these durations. `lib/notification-sound.ts` `src` paths point at `.wav`.
**Smoke tests (all green):** backend+frontend `tsc --noEmit` clean; `build:local` + `next build` clean (no Suspense regressions); `sync:web` ok (sounds present in `dist/web/public/sounds`); `node dist/main.js` maps `POST`+`DELETE /api/settings/company/logo`, worker count unchanged (webhook/message/shopify/broadcast, all concurrency=3); `npm test` 9 suites / 42 tests pass incl. new spec.
**Open item:** apply migration on prod (phpMyAdmin) + redeploy WITH `npm install` (Prisma client regen for `logo_url` — else 5xx on `/auth/me`). [Migration applied 2026-05-25.]

**Shell-Polish-A follow-ups (continued) (2026-05-19, no migration):**
- **eba9ce6** — bots `assign_agent` action: the bot form's agent field is now a dropdown sourced from `GET /team` (active members), with the raw numeric-ID input kept as a fallback when the team list is unavailable.
- **9976142** — template messages carrying quick-reply buttons render the trailing `[ Confirm ] [ Cancel ]` literal as **display-only chips** in the chat bubble (gated on `message_type==='template'` via `splitTemplateButtons`); the customer still taps the real WhatsApp buttons — the chips are cosmetic only.

### Hotfix — 2026-05-19 — All prices showed $0 (Prisma Decimal serialization)
**Bug:** `monthly_price`/`setup_fee`/invoice `amount` rendered `$0` on super-admin Plans, super-admin Billing + client Detail, and tenant `/billing`. **Cause:** global `ClassSerializerInterceptor` (`main.ts`) `instanceToPlain()`-decomposes Prisma `Decimal` into `{s,e,d}`; frontend price helpers fall back to 0 on a non-string/non-finite value. **Fix (backend-only, no schema/migration/env):** new `common/utils/decimal.ts numifyDecimals()` deep-converts Decimal→number; applied at all Decimal-returning service boundaries — `super-admin.service` (getPlans/getClients/getClient/createPlan/updatePlan/getInvoices/getUsage) + `billing.service` (listInvoices/getInvoice/getSubscription). Interceptor kept (it strips `password_hash`). Spec `decimal.spec.ts`. Smoke: backend tsc clean, **12 suites / 71 tests** pass, nest build clean, sync:web ok, `/health` 200, `/api/super-admin/plans` 401 unauth. Convention added to CLAUDE.md + ERRORS.md "[Billing/Plans] all prices render $0". Needs redeploy WITH `npm install` is NOT required (no Prisma schema change) — standard redeploy.

### Session Admin-Console — 2026-05-19 — Super-Admin Console completion
**Built (frontend-only; no backend, no migration, no env — all 5 endpoints already existed):**
- **Nav:** super-admin layout gains Billing / Usage / Audit nav items (Overview/Clients/Plans unchanged).
- **`/super-admin/billing`** — `GET /super-admin/invoices?page&limit` (`Paged<AdminInvoice>`, joined `company.company_name`). Table + status filter (client-side over page) + server pagination + page-scoped paid total. **Read-only** — there is no super-admin mark-paid/generate endpoint (cron/tenant-billing owns that); copy says so.
- **`/super-admin/usage`** — `GET /super-admin/usage` (array, current calendar-month only, incl `company.subscription`). Per-tenant messages/contacts/templates/webhooks/convos; contacts & templates flagged amber ≥80% / red ≥100% vs plan limits. No pagination (single-period array — matches backend).
- **`/super-admin/audit`** — `GET /super-admin/audit-logs?page&limit` (`Paged<AdminAuditLog>`, joined `user`). Time/user/action/entity/IP/metadata + server pagination + client-side action/entity/email filter over page.
- **Clients page:** per-row **Details** → `Modal` from `GET /super-admin/clients/:id` (subscription + full users list — finally surfaces owner email, closing the long-standing FE-2a "owner email deferred" gap). Modal footer: **Delete client** (`DELETE /super-admin/clients/:id` — hard cascade; strong `ConfirmDialog` listing what's destroyed; row removed on success) + **Impersonate owner** (`POST /super-admin/impersonate/:companyId`).
- **Impersonation wiring (only shared-auth touch — additive, contained):** button stashes the one-shot token in `sessionStorage.ca_impersonation_token` and `window.open('/dashboard','_blank')`. `auth-context` mount effect gains ONE leading branch: if that key exists, consume+remove it, `setAccessToken`, bootstrap the user via `/auth/me`, and **skip** the normal `/auth/refresh` (a super-admin has no tenant `refresh_token` cookie so refresh would 401→/login). Key absent → the effect is byte-identical to before; the super-admin tab keeps its own session (separate tab, `sa_refresh_token` cookie intact). New `AdminInvoice`/`AdminUsageRow`/`AdminAuditLog` types in `crm-types.ts` (existing `Invoice`/`ClientCompany`/`Subscription`/`Paged` reused).
**Smoke (all green):** frontend `tsc` clean; `next build` clean (all of /super-admin/{billing,usage,audit,clients} compiled, no Suspense regression); backend untouched (no `.ts` change) — `sync:web` ok (super-admin pages present in `dist/web`); cold `node dist/main.js` maps `/api/super-admin/{invoices,usage,audit-logs,impersonate/:companyId}`, `/health` 200, invoices+audit **401 unauth** (guards active).
**Open item:** redeploy (no migration, no `npm install` needed — frontend-only; standard Hostinger Stop-all → cold start). Hand-test: Billing/Usage/Audit render; client Details shows owner email; Impersonate opens a working tenant tab without logging the super-admin out; Delete cascades.

### Session Shell-Polish-B — 2026-05-19 — Conversation pin / clear / block
**Built (additive-only; no socket shape change, no new event, no inbox-internals rewrite):**
- **DB:** TWO nullable cols `conversations.pinned_at DATETIME(3)` + `cleared_before DATETIME(3)` + index `conversations_company_id_pinned_at_idx`. Migration `20260526000000_conversation_pin_clear` (one-time phpMyAdmin Import — MySQL 8, no IF NOT EXISTS). Block reuses existing `contacts.status='blocked'` (no new column).
- **Design decisions (confirmed with user):** pin is **company-wide** (one shared column, multi-pin, no cap — not a per-user join table); clear is a **server soft-marker** (`cleared_before`) not client localStorage (syncs across the agent's devices, reversible, zero row deletes).
- **Backend:** `InboxController` `POST conversations/:id/{pin,unpin,clear}` (existing `AuthGuard('jwt')+TenantGuard`). `InboxService.setPinned`/`clearHistory` (scoped via `requireConversation`); `listConversations` orderBy `pinned_at desc → last_message_at desc → updated_at desc`; `listMessages` adds `timestamp > cleared_before` when marked. Pin/clear emit the **existing** `conversation.updated {conversationId}` (no shape change; list already refetches on it). New spec `inbox.service.pin-clear.spec.ts` (6 cases: pin stamps/emits, unpin nulls, clear stamps/emits, ordering pinned-first, listMessages filter applied/skipped).
- **Frontend:** `inbox-types` `ConversationRow.pinned_at` + `ConversationDetail.contact.status`. Inbox list: green pin glyph on pinned rows; `message.received` optimistic handler re-sorts with the server comparator (pins never jumped). Thread header: Pin/Unpin toggle, Clear chat (`ConfirmDialog`, danger — "your inbox view only, customer still sees it on WhatsApp"), Block/Unblock (`ConfirmDialog`, calls existing `PATCH /contacts/:id { status }`; copy notes WhatsApp has no server-side block).
**Smoke (all green):** backend `tsc` clean; `npm test` **11 suites / 68 tests** pass incl. new spec; `build:local` clean; cold `node dist/main.js` maps `/api/inbox/conversations/:id/{pin,unpin,clear}`, `/health` 200, pin route **401 unauth** (guards active); frontend `tsc` clean; `next build` clean; `sync:web` ok (`dist/web/.next` present).
**Open item:** apply migration `20260526000000_conversation_pin_clear` on prod (phpMyAdmin Import) + redeploy WITH `npm install` (Prisma client regen for the two new fields — else 5xx on inbox routes). Then hand-test: pin sticks a chat to top across agents; clear hides history but new inbound still arrives; block flips `contacts.status`.

### Session Shell-Polish-C — 2026-05-19 — Rich URL OG-preview cards + autolink
**Built (additive-only; no schema/socket/inbox/Meta/Shopify-internals change):**
- **Backend:** new `OgModule` (sibling of inbox/contacts/templates), registered in `app.module.ts`. `GET /api/og?url=<encoded>` — `@UseGuards(AuthGuard('jwt'))` only (NOT tenant-scoped; auth gates SSRF abuse). Returns `{ url,title,description,image,site_name,fetched_at,ok }` (always 200 with `ok:false` on a fetch miss; **400 only** for missing/malformed/blocked-scheme/blocked-host; never 5xx). `OgService`: native `https`/`http` + `dns/promises` + `URL` + `crypto` — **no new dependency** (no cheerio/axios/undici). SSRF: scheme allowlist, literal-IP + DNS-resolved-IP range blocks (127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 0/8, 224/4, 240/4, ::1, ::, fc00::/7, fe80::/10, v4-mapped v6), `localhost*` block, **re-validated on every redirect hop**, max 3 hops, 5s total deadline, 1MB body cap (stream aborted on exceed), Content-Type must be html/xhtml. Regex-only OG parse (first 64KB), `<title>`/`meta[name=description]` fallbacks, relative `og:image` resolved against final URL, minimal entity decode, control-strip + 300-char cap. Cache via existing `CacheService` (`og:<sha1(canonical)[:16]>`, 24h on `ok:true`, 1h on `ok:false`). New spec `og.service.spec.ts` (12 cases: parse, fallbacks, relative image, entity decode, SSRF literal/DNS/localhost/scheme, non-html, oversize, timeout, 4-redirect cap, redirect-to-private, cache hit).
- **Frontend:** `lib/url-detect.ts` (`extractUrls` cap-3 dedup + `autolinkText` segments — single regex source of truth; `exec`-loop, no `matchAll` for TS-target compat). `components/inbox/og-preview-card.tsx` — module-level `Map<url,Promise>` render-dedup, static skeleton (bare URL, no spinner), renders only on `ok:true && (title||image)`, swallows errors → `null`, single `<a rel="noopener noreferrer nofollow" target=_blank>`. `inbox/[id]/page.tsx`: `Linkify` refactored onto `autolinkText` (autolink now also covers inbound text); OG cards rendered after the bubble body **only for `message_type==='text' && direction==='inbound'`** (outbound = autolink only, no card). Template/media/reply/quick-reply chips untouched.
**Smoke tests (all green):** backend `tsc --noEmit` clean; `npm test` **10 suites / 62 tests** pass incl. new `og.service.spec`; `build:local` clean; cold `node dist/main.js` → `/api/og` route mapped, `/health` 200 `success:true`, `/api/og?url=…` **401 unauth** (JWT guard active), worker count unchanged; frontend `tsc --noEmit` clean; `next build` clean (no Suspense regression); `sync:web` ok (`dist/web/.next` present). SSRF behaviour fully covered by the passing spec (127.0.0.1 / 10.0.0.1 / 169.254.169.254 / 192.168 / 172.16 / localhost / non-http / DNS-private / redirect-to-private all → blocked); a JWT-authenticated live SSRF curl was not run locally (needs DB+login) — verify on the live-deploy step.
**Open item:** none (no migration, no env, no dep). Standard rebuild + Hostinger "Stop all processes" → cold start; then hand-test an inbound URL message renders a card within ~1s.

**Shell-Polish-A follow-up (2026-05-25, no migration):** inbox conversation assignment generalized. `AssignDto.userId` now `number | null` (`@ValidateIf` skips int check on null); `InboxService.assign` accepts null → `assigned_user_id = null` (unassign), only validates company-membership when a userId is given; `conversation.assigned` socket payload unchanged (`userId` may now be null — additive). Inbox thread header: owner/admin get a member `<select>` (active members from `GET /team` + the current assignee even if suspended; Unassigned option) replacing the single button; agents keep "Assign to me". Analytics agents leaderboard needs no change — its query already groups conversations by `assigned_user_id`, so it populates as soon as chats are assigned to agents (previously empty only because nothing was ever assigned to non-owner users).

### Session Billing-Lifecycle — 2026-05-19 — activation-anchored billing + auto-suspend + usage-limit policy
**Built:** Migration `20260527000000_billing_lifecycle` (additive: `companies.{activated_at,suspended_at,grace_until,usage_limit_action}` + `platform_settings` k/v, backfills `activated_at=created_at` for active cos). Billing rewritten from calendar-month to **activation-anchored 30-day cycles** (`InvoiceGeneratorService.generateDueInvoices`, idempotent on unique `invoice_number=INV-{co}-{cycleStartYYYYMMDD}`, due=+7d; `activateClient` sets `activated_at` once). New daily **`/cron/billing/enforce`** (pending→overdue, suspend ≥3d overdue unless `grace_until` future); **`/cron/billing/auto-invoice` now runs DAILY** (1st-of-month gate removed). `markPaid` auto-reactivates a cron-suspended co once no unpaid invoices remain; super-admin `grace`/`usage-limit-action`/`settings` endpoints + `PlatformSettingService` (`@Global` CommonModule). `PlanGuard` 100% block now resolves per-co override `??` platform default (`block`|`warn_only`). JWT-only (NOT TenantGuard'd) `GET /api/billing/account-status` + `(app)/layout.tsx` billing gate → `<BillingBlocked>` screen. Super-admin **Settings** page + Clients Details "Billing & limits" (dates, policy dropdown, grace date setter).
**Smoke (all green):** backend `tsc` clean; `npm test` **13 suites / 77 tests** pass incl. new `invoice-generator.service.spec` (6 cycle-math cases); `build:local` clean; cold `node server.js` maps `/cron/billing/enforce`, `/api/billing/account-status`, `/api/super-admin/{settings,clients/:id/grace,clients/:id/usage-limit-action}`, `/health` 200, `account-status` **401 unauth**; frontend `tsc` clean; `next build` clean (`/super-admin/settings` compiled); `sync:web` ok.
**Open item:** apply migration `20260527000000_billing_lifecycle` on prod (phpMyAdmin Import) + redeploy **WITH `npm install`** (Prisma client regen — else 5xx). **Update the external cron scheduler: `/cron/billing/auto-invoice` → DAILY, add `/cron/billing/enforce` → DAILY** (both need `X-Cron-Secret`). Then hand-test: activate a client → invoice raised immediately; let one go overdue+3d → auto-suspended + owner sees BillingBlocked; mark-paid → auto-reactivates; grace date defers suspend; per-co `warn_only` lets limit pass; platform default applies when override null.

### Session Inbox-Polish — 2026-05-22 — connection fix + unread tab + mobile/UX + quick replies + Shopify create-order
**Built (8 user-reported polish items; 1 new table, otherwise additive):**
- **1· Socket "offline" loop fixed** (`socket-context.tsx`): async `auth` callback decodes JWT `exp` + single-flight `/auth/refresh` before (re)connect; `connect_error` → refresh + reconnect; status shows `connecting` while recovering (was stuck `disconnected` after the 15-min token expired). No backend/dep. *User's console log never arrived — root-caused from code.*
- **2·/3· Unread tab** (`inbox/layout.tsx`): active-tab label `unread (N)` from server total; WhatsApp **sticky** behavior — `displayRows` keeps the open chat visible after it's read until the next unread chat opens (`load()` re-inserts the cached active row; `activeIdRef` decouples load from `activeId`).
- **4· Mobile thread header** no longer overflows: desktop controls `hidden md:flex`, mobile collapses to a `MoreVertical` kebab menu (outside-click/route-change close).
- **5· Swipe-to-reply** (touch-only handlers in `Bubble`, ≥56px trigger) + **6· image lightbox** (`ImageLightbox`, Esc/backdrop/X, body-scroll lock — in-app, not a new tab).
- **7· Canned/quick replies**: new table `canned_replies` + `CannedRepliesModule` (`/api/canned-replies` CRUD, `AuthGuard('jwt')+TenantGuard`, tenant-scoped) + composer `Plus` 2-option menu (Quick reply → `QuickReplyPicker` inserts body into composer; Send template → existing `TemplatePicker`); picker doubles as add/edit/delete UI.
- **8· Shopify create-order from chat**: `ShopifyOrdersController` `POST /api/shopify/orders` + `ShopifyService.createOrder` (`draftOrderCreate`→`draftOrderComplete(paymentPending)` → real unpaid order; custom line items via `originalUnitPrice`; clean 4xx/5xx). Thread-header `ShoppingBag` gated on once-per-mount `/settings/shopify adminTokenSet`. Frontend `create-order-modal.tsx` (repeatable line items + contact prefill + success screen w/ admin link).

**Files created:** `backend/prisma/migrations/20260528000000_canned_replies/migration.sql`; `backend/src/modules/canned-replies/{canned-replies.module,canned-replies.controller,canned-replies.service}.ts` + `dto/{create,update}-canned-reply.dto.ts`; `backend/src/modules/integrations/shopify/{shopify-orders.controller.ts,dto/create-order.dto.ts}`; `frontend/src/components/inbox/{quick-reply-picker,create-order-modal}.tsx`.
**Files modified:** `backend/prisma/schema.prisma` (model `CannedReply` + Company back-relation); `backend/src/app.module.ts` (register `CannedRepliesModule`); `backend/src/modules/integrations/shopify/{shopify.service.ts (createOrder),shopify.module.ts (register controller)}`; `frontend/src/context/socket-context.tsx`; `frontend/src/app/(app)/inbox/layout.tsx`; `frontend/src/app/(app)/inbox/[id]/page.tsx`; `frontend/src/lib/crm-types.ts` (`CannedReply`); CLAUDE.md / SCHEMA.md / ARCHITECTURE.md / ERRORS.md / PROGRESS.md.

**API:** `GET/POST /api/canned-replies`, `PATCH/DELETE /api/canned-replies/:id`; `POST /api/shopify/orders`. **DB change:** `20260528000000_canned_replies` (new table) — NOT yet applied to prod. **New env vars:** none.

**Smoke:** backend `tsc --noEmit` 0 errors (after `prisma generate`); frontend `tsc --noEmit` 0 errors. *Not run this session: `npm test` / `build:local` / `next build` / `sync:web` — do these before deploy.*

**Open item:** apply migration `20260528000000_canned_replies` on prod (phpMyAdmin Import) + redeploy **WITH `npm install`** (Prisma client regen for `CannedReply` — else 5xx on `/api/canned-replies`). Standard rebuild order: `build:local` → `next build` → `sync:web`, commit `backend/dist`. Hand-test: socket recovers after 15-min idle; unread tab count + sticky open chat; mobile header kebab; swipe-to-reply; image lightbox; create + insert a quick reply; create a Shopify order from a chat (needs Admin token + store domain in Settings → Shopify). [Round-1 committed+pushed as `d9a14bd`; migration applied by user.]

### Session Inbox-Polish round 2 — 2026-05-22 — instant chat open + mobile dvh + slash replies + Shopify order rework
**Built (after user feedback on round 1; type-clean + `next build` clean; NO schema change → no migration, no `npm install`):**
- **Gate-unmount fix (root cause of 3 reported bugs).** `(app)/layout.tsx` onboarding gate listed `pathname` and reset `gateState='checking'` on every navigation, unmounting the whole shell (socket + conversation list) on every chat open → per-chat "Reconnecting", flicker, and Unread tab resetting to "All". Now runs ONCE per session (`onboardingCheckedRef` + `pathnameRef`, deps `[loading,user,billing,router]`). Chat open is instant; the round-1 sticky-unread `displayRows` now actually works.
- **Mobile composer overflow:** shell `h-screen` → `h-[100dvh]` (100vh hid the composer behind mobile browser chrome).
- **Shopify moved into the composer `+` menu** (Quick reply / Send template / Create Shopify order) with the real colored Shopify logo (`components/icons/shopify-icon.tsx`); removed the separate header button + mobile-menu item.
- **Slash quick replies:** typing `/token` (no space) in the composer pops an inline list (↑↓/Enter/Esc/click), filters by title/body, inserts the body. `loadCanned` in the thread page + `onChanged` from `QuickReplyPicker` keep the list fresh.
- **Shopify order rework (Phase 1):** `GET /api/shopify/products` (`searchProducts` — needs Admin `read_products` scope) + reworked `POST /api/shopify/orders` (`createOrder`): variant line items (price from Shopify), `countryCode`, `tags` (frontend auto-adds the assigned agent's name), `prepaid` → `draftOrderComplete(paymentPending:!prepaid)`. New `requireAdminApi` helper. Shopify `orders/create` webhook now captures email into `contacts.email`. Frontend `create-order-modal.tsx`: product search, qty stepper, country select (`lib/countries.ts`, default PK), tag chips, COD/Prepaid toggle.

**Files created:** `frontend/src/components/icons/shopify-icon.tsx`, `frontend/src/lib/countries.ts`, `backend/.../shopify/dto/create-order.dto.ts` (reworked).
**Files modified:** `frontend/src/app/(app)/layout.tsx`; `frontend/src/app/(app)/inbox/[id]/page.tsx`; `frontend/src/components/inbox/{create-order-modal,quick-reply-picker}.tsx`; `backend/.../shopify/{shopify.service.ts,shopify-orders.controller.ts}`; CLAUDE/ARCHITECTURE/ERRORS/SCHEMA/PROGRESS.

**API added:** `GET /api/shopify/products?query=`. **DB change:** none. **New env vars:** none.

**Smoke:** backend `tsc --noEmit` 0 errors; frontend `tsc --noEmit` 0 errors; `next build` clean. *Not run this round: `npm test`.*

**Open item / hand-test:** standard redeploy (no migration, no install). **Client must add `read_products` to their Shopify custom app + re-paste the Admin token** or the product picker 400s. Hand-test: rapid chat opens stay "Live" (no reconnect/flicker); Unread tab keeps the open chat + doesn't reset; mobile composer fully visible; `/` quick-reply popup; product search + qty stepper + country + tags(agent) + COD/Prepaid create a real order; email lands on the contact from a Shopify webhook order.

### Session Inbox-Polish Phase 2 — 2026-05-22 — Shopify shipping rates
**Built (type-clean + `next build` clean; NO schema change):** `POST /api/shopify/shipping-rates` (`ShopifyService.getShippingRates` → `draftOrderCalculate` → returns the store's `availableShippingRates` `{handle,title,amount,currencyCode}`; `[]` when none). `createOrder` gains optional `shippingLine {title,price}` → `input.shippingLine` (sent as title+price, NOT the rate handle — cross-version reliability). New `buildDraftBase` shares the line-items + shipping-address input between calc and create. DTOs: `ShippingRatesDto` + `ShippingLineDto` + `shippingLine?` on `CreateShopifyOrderDto`. Frontend `create-order-modal.tsx` auto-recalculates rates (debounced on items/country/city/address) and shows a radio list (+ "No shipping" + running total); selection flows into `shippingLine`. Needs `write_draft_orders` (already required for order create — no new scope beyond Phase 1's `read_products`).
**Files modified:** `backend/.../shopify/{shopify.service.ts, shopify-orders.controller.ts, dto/create-order.dto.ts}`; `frontend/src/components/inbox/create-order-modal.tsx`; CLAUDE/ARCHITECTURE/ERRORS/PROGRESS. **API added:** `POST /api/shopify/shipping-rates`. **DB:** none. **Env:** none.
**Smoke:** backend `tsc` 0 errors; frontend `tsc` 0 errors; `next build` clean. Not run: `npm test`.
**Open item:** standard redeploy. Hand-test: add items + set country/city → shipping rates appear from the store; pick one → order created with that shipping line; "No shipping" works; empty-rate destination still creates the order.

### Session Shopify-Tags+Discounts — 2026-05-22 — tag-flow fix, NO-WhatsApp tag, discounts, attribution
**Built (type-clean + `next build` clean; NO schema change):**
- **Mind-change tag bug FIXED:** `meta-webhook.service.ts` enqueued the confirm/cancel job only when `shopifyOrderMessage.status='pending'`, so the 2nd (mind-change) tap found no row and never swapped. Now matches `message_id+company_id` only; `processOrderTag` is idempotent (remove pending+opposite, add chosen, touch only our 3 tags) → unlimited confirm↔cancel. Pending tag (delayed `pendingTag` job) was already correct in code — flagged to the user to confirm the repro (full window, no reply) + check `write_orders` + config tag names.
- **`⚠ NO WhatsApp` (hardcoded):** `handleStatus` detects no-WhatsApp/undeliverable failures (Meta 131026 / title-message match) on an order template → new `noWhatsapp` shopify job → `processNoWhatsappTag` adds the constant tag + sets row status `'undeliverable'` (so pending job no-ops). Not client-configurable.
- **Manual discounts:** `mapDiscount` → `appliedDiscount` (PERCENTAGE/FIXED_AMOUNT) per line (`buildDraftBase`) and order-level (`createOrder`). DTO: `OrderDiscountDto` + `discount?` on line + `orderDiscount?`. Modal: per-line value+%/flat toggle + order-level discount.
- **Attribution + COD marker:** `createOrder` stamps `customAttributes` `Source: CodesApp` (always) + `Payment method: Cash on Delivery (COD)` (COD only). True COD gateway intentionally NOT done — needs an `orderCreate` rewrite that loses draft-order tax/shipping/discount calc (documented in ERRORS).
**Files modified:** `backend/src/modules/inbox/meta-webhook.service.ts`; `backend/.../shopify/{shopify.service.ts, dto/create-order.dto.ts}`; `frontend/src/components/inbox/create-order-modal.tsx`; CLAUDE/ARCHITECTURE/ERRORS/PROGRESS. **DB:** none (shopify_order_messages.status now also takes `'undeliverable'` — VARCHAR(16), no migration). **Env:** none.
**Smoke:** backend `tsc` 0; frontend `tsc` 0; `next build` clean. Not run: `npm test`.
**Open item:** standard redeploy. Decisions assumed (answers didn't relay): NO-WhatsApp = invalid-number-only; discounts = manual only (no read_discounts); conversion = Source attribute; COD = attribute marker (not true gateway). Hand-test: confirm→cancel→confirm flips tags; no-reply 2 min → pending tag; bad number → ⚠ NO WhatsApp; per-line + order discounts reflected in Shopify; Source/COD attributes on the order.

### Session Shopify-Customer+TagFix — 2026-05-22 — attribute revert, real tag-mutation fix, customer check/create
**Built (type-clean + `next build` clean; NO schema change) — after the previous round still had bugs live:**
- **Reverted the order `customAttributes`** (`Source: CodesApp` + `Payment method: COD`) — they cluttered the order's Additional details; user didn't want them. COD just stays the draft order's default **manual** payment method.
- **Real fix for pending / ⚠ NO WhatsApp / flip:** `shopifyTagMutate` built ONE mutation declaring `$add`+`$rem` always; an add-only call (pending, no-whatsapp) shipped an **unused `$rem` variable → Shopify rejects unused-variable mutations → tag silently never applied**, and the combined add+remove didn't reliably remove on the flip. Now split into **two sequential requests** (`runTagOp`, remove then add), each declaring only `$tags`. Fixes pending + no-whatsapp (valid add-only) and the confirm↔cancel flip (opposite tag reliably dropped). The round-3 enqueue-filter fix was necessary but not the deeper cause.
- **Customer check + create:** `GET /api/shopify/customers?phone=&email=` (`searchCustomer`, needs `read_customers`; matches phone OR email, tries phone ±`+`) + `POST /api/shopify/customers` (`createCustomer`, needs `write_customers`; phone → `+E.164`). `createOrder` links the customer via `input.purchasingEntity={customerId}` so orders aren't "no customer". Modal: auto-search on phone/email (debounced) → link first match or **Create customer** button (check-then-create, no duplicates); **email now prefilled from the contact** (`contactEmail`).
**Files modified:** `backend/src/modules/integrations/shopify/{shopify.service.ts, shopify-orders.controller.ts, dto/create-order.dto.ts}`; `frontend/src/components/inbox/create-order-modal.tsx`; `frontend/src/app/(app)/inbox/[id]/page.tsx`; CLAUDE/ARCHITECTURE/ERRORS/PROGRESS. **API added:** `GET`+`POST /api/shopify/customers`. **DB:** none. **Env:** none.
**Smoke:** backend `tsc` 0; frontend `tsc` 0; `next build` clean. Not run: `npm test`.
**Open item:** standard redeploy. **Client must add `read_customers` + `write_customers` scopes + re-paste the Admin token** for the customer feature. Hand-test: confirm→cancel→confirm now flips tags (old one removed); 2-min no-reply → pending tag now appears; bad number → ⚠ NO WhatsApp; existing customer auto-links / Create customer when none (no dupes); email prefilled + on the customer; no Source/COD attributes on the order anymore.

---

## Status Key
- ⬜ Not started
- 🔄 In progress
- ✅ Complete
- ❌ Blocked
- ⚠️ Needs review

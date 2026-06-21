# PROMPT PLAYBOOK — CodesApp
> Use this with Claude Code (claude.ai/code or CLI).
> Each session: paste the SESSION OPENER first, then the specific module prompt.
> After each session: run the HANDOFF TEMPLATE and bring the output back to Claude.ai.

---

## SESSION OPENER
> Paste this at the start of EVERY Claude Code session before anything else.

```
Read these files before doing anything:
- CLAUDE.md (master context, rules, conventions)
- PROGRESS.md (what is built, what is not)
- ARCHITECTURE.md (patterns and decisions already made)
- SCHEMA.md (current database schema)
- ERRORS.md (known bugs and fixes)

Do not write any code until you confirm you have read all five files.
Summarize in 3 sentences what the project is and what has been completed so far.
```

---

## HANDOFF TEMPLATE
> Paste this at the END of every Claude Code session.
> Copy the output and bring it to Claude.ai to get the next prompt.

```
Generate a session handoff summary using this exact format. Be specific — 
vague answers make the next session start wrong.

## SESSION HANDOFF

**Session number:**
**Date:**
**Module worked on:**

**Files created (full paths):**

**Files modified (full paths):**

**Key architectural decisions made this session:**

**Database changes (migrations run, tables added/modified):**

**New environment variables added:**

**API endpoints created (method + path):**

**Socket.io events added:**

**Job queue workers added:**

**What is fully working right now (tested):**

**What is partially done (started but incomplete):**

**What is NOT started yet from this module:**

**Errors encountered and how they were fixed:**

**Errors still unresolved:**

**Exact next task to continue:**
```

---

## MODULE PROMPTS
> Use these in order. Only start a module when PROGRESS.md shows all previous modules complete.

---

### SESSION 1 — Foundation (Phase 1)
> Session 1 is complete. See PROGRESS.md Completed Sessions Log.

---

### SESSION 2 — Shared Inbox Backend (Phase 2)

```
Task: Build the Socket.io gateway and shared inbox backend.

1. Socket.io Gateway (backend/src/modules/inbox/inbox.gateway.ts)
   - Attach to NestJS HTTP server
   - WsJwtGuard: verify JWT on handshake, attach companyId + userId to socket
   - On connection: socket.join(`company:${companyId}`)
   - On disconnect: emit agent.offline to company room
   - Events to handle:
     typing.start — broadcast to company room
     typing.stop — broadcast to company room
     agent.viewing — emit to company room for collision detection
     mark.read — mark messages as read, emit status update

2. Conversation endpoints (backend/src/modules/inbox/):
   GET    /inbox/conversations — paginated, filtered by status/label/assigned
   GET    /inbox/conversations/:id — single conversation with messages
   POST   /inbox/conversations/:id/assign — assign to agent
   POST   /inbox/conversations/:id/resolve — mark resolved
   POST   /inbox/conversations/:id/labels — add label
   POST   /inbox/conversations/:id/notes — add internal note
   GET    /inbox/conversations/:id/messages — paginated messages

3. Message sending:
   POST /inbox/conversations/:id/send — send message via Meta Cloud API
   - Check 24hr window (window_expires_at) — if expired, only allow template messages
   - Call Meta Graph API: POST /{phone_number_id}/messages
   - Save outbound message to DB
   - Emit message.sent via Socket.io to company room
   - Update conversation.last_message and updated_at

4. Incoming webhook handler:
   POST /webhooks/meta — public endpoint, no JWT
   - Verify X-Hub-Signature-256 HMAC header
   - Process message events: save to DB, download media, emit via Socket.io
   - Process status events: update message.status, emit status update
   - Always return 200 immediately, process async via JobQueueService

5. 24hr window logic:
   - On every inbound message: set conversation.window_expires_at = NOW() + 24 hours
   - API returns window_expires_at in conversation object
   - Frontend uses this to show warning and disable free-form input

Apply TenantGuard on all /inbox/* routes.
```

---

### SESSION 3 — Contacts CRM

```
Task: Build the contacts CRM module.

Backend (backend/src/modules/contacts/):

Endpoints:
GET    /contacts — paginated, filterable by tag/segment/status/last_activity
GET    /contacts/:id — contact detail with full message timeline
POST   /contacts — create contact (check contact_limit via PlanGuard)
PATCH  /contacts/:id — update contact fields
DELETE /contacts/:id — soft delete (set deleted_at)
POST   /contacts/import — CSV import with field mapping
GET    /contacts/segments — list saved segments
POST   /contacts/segments — create segment with filter definition
GET    /contacts/tags — list all unique tags used by company

CSV Import:
- Accept multipart/form-data CSV upload
- Parse with csv-parse library
- Map CSV columns to contact fields
- Validate phone numbers (must be in international format)
- Skip duplicates (match on phone number)
- Return import summary: created, skipped, errors

Apply TenantGuard + PlanGuard(@PlanLimit('contacts')) on POST /contacts.

Frontend:
- /contacts — table with search, filters, tag filter chips
- /contacts/[id] — contact profile + timeline
- /contacts/import — CSV upload with column mapping UI
```

---

### SESSION 4 — Templates Module

```
Task: Build the templates module with Meta sync.

Backend (backend/src/modules/templates/):

Endpoints:
GET    /templates — list all templates with status filter
GET    /templates/:id — single template detail
POST   /templates — create template and submit to Meta for approval
DELETE /templates/:id — soft delete
POST   /templates/sync — sync approved templates from Meta Graph API

Meta sync logic:
- GET /{WABA_ID}/message_templates from Meta Graph API
- Upsert templates by meta_template_id
- Update status from Meta response

Apply TenantGuard + PlanGuard(@PlanLimit('templates')) on POST /templates.
```

---

### SESSION 5 — Broadcast Module

```
Task: Build the broadcast campaigns module with MySQL job queue.

Backend (backend/src/modules/broadcasts/):

JobQueue setup:
- Register 'broadcast' worker in BroadcastModule via JobQueueService.registerWorker()
- Concurrency: 3
- On failure: retry 3x with backoff (60s, 300s, 1800s)

Endpoints:
GET    /broadcasts — list campaigns with stats
GET    /broadcasts/:id — campaign detail
POST   /broadcasts — create campaign (draft)
PATCH  /broadcasts/:id — update draft campaign
POST   /broadcasts/:id/send — send immediately (enqueue all jobs)
POST   /broadcasts/:id/schedule — schedule for future (set run_at in jobs table)
DELETE /broadcasts/:id/cancel — cancel scheduled broadcast
GET    /broadcasts/:id/analytics — delivered/read/failed breakdown

Send logic:
1. Resolve audience from audience_filter
2. For each contact: jobQueueService.enqueue('broadcast', { broadcastId, contactId, templateId })
3. Worker: fetch contact phone, call Meta API to send template message
4. Update broadcast sent_count/failed_count in real time
5. Emit broadcast.progress via Socket.io to company room
```

---

### SESSION 6 — Keyword Bot Engine

```
Task: Build the keyword automation bot engine.

Backend (backend/src/modules/bots/):

Bot action types (store in actions JSON array):
- { type: 'reply_template', templateId, variables }
- { type: 'assign_agent', userId }
- { type: 'apply_tag', tag }
- { type: 'fire_webhook', webhookEndpointId }
- { type: 'send_text', message }

Endpoints:
GET    /bots — list all bots for company
GET    /bots/:id — bot detail
POST   /bots — create bot
PATCH  /bots/:id — update bot
DELETE /bots/:id — delete bot
PATCH  /bots/:id/toggle — enable/disable

Bot matching engine (BotEngineService):
- Called in inbox message handler on every inbound message
- Check all active bots for company
- On match: execute all actions in sequence
- Log bot.executed to audit_logs
```

---

### SESSION 7 — Webhooks + Analytics + Billing

```
Task: Build outbound webhooks, analytics dashboard, and billing module.

Webhooks (backend/src/modules/webhooks/):
- Register 'webhook' worker via JobQueueService.registerWorker()
- Deliver with HMAC-SHA256 signature
- Headers: X-CodesApp-Signature, X-CodesApp-Event, X-CodesApp-Delivery

Analytics (backend/src/modules/analytics/):
- Cache results 5min in CacheService: analytics:{companyId}:{hash}
- Date-range queries with MySQL DATE() + GROUP BY

Billing (backend/src/modules/billing/):
- Plan enforcement wired to PlanGuard
- 80% limit warning → fire webhook event subscription.limit.warning
- Auto-invoice cron endpoint (CronGuard protected)
```

---

### SESSION 8 — Shopify Integration (Full)

```
Task: Complete the Shopify integration (build on Phase 1 scaffold).

Wire up order event handlers (orders/create, orders/fulfilled, orders/cancelled, orders/paid).
Template mapping: company configures which WhatsApp template maps to each Shopify event.
Full OAuth flow tested end-to-end.

Frontend:
- /settings/shopify — connect → OAuth → event mapping UI
```

---


### SESSION FE-1 — App Shell + Onboarding + Dashboard + Inbox  ✅ DONE (2026-05-16)

Built: `(app)` route group (shell + auth gate + onboarding gate +
SocketProvider + middleware), `/onboarding` 5-step wizard, `/dashboard`,
`/inbox` + `/inbox/[id]` with full Socket.io wiring. See PROGRESS.md
Session FE-1 log for files, decisions, and limitations.

FE-1.1 (2026-05-17): taken LIVE on the single Hostinger process
(single-origin, `/api` prefix, frontend at `backend/dist/web`) + auth/
email/loop production fixes. See PROGRESS.md "Session FE-1.1" and the
mandatory rebuild order in CLAUDE.md §9 before any future deploy.

---

### SESSION FE-2a — Contacts + Templates + super-admin Clients  ✅ DONE (2026-05-17)

Built: `/super-admin/clients` (PATCH activate/suspend, optimistic), super-admin
route-group layout, `/contacts` + `/contacts/[id]` (filters, 3-step client-side
CSV mapping, segments drawer, soft delete, status actions), `/templates` (create
+ live WhatsApp preview, Meta sync, detail/rejection, soft delete), `/login`
pending-approval polish, sidebar Contacts/Templates enabled. Frontend-only.
See PROGRESS.md "Session FE-2a", ARCHITECTURE.md "Frontend patterns (FE-2a)",
ERRORS.md "[FE-2a] prompt vs backend".

---

### SESSION FE-2b — Broadcasts + Bots  ✅ DONE (2026-05-17)

Built: `/broadcasts` (send/schedule/cancel, analytics modal, live
`broadcast.progress`), `/broadcasts/new` (create + draft edit, audience
builder, template vars), `/bots` (CRUD + action builder + toggle), sidebar
enabled. Frontend-only. See PROGRESS.md "Session FE-2b", ARCHITECTURE.md
"Frontend patterns (FE-2b)", ERRORS.md "[FE-2b] prompt vs backend".

---

### SESSION FE-2c — Production hardening + Option B webhooks  ✅ DONE (2026-05-18)

Brought the first real tenant live; fixed onboarding (runtime callback URL,
real Meta errors, optional vars, owner skip, re-editable steps, auto verify
token, keep-secrets-on-reedit), shipped **Option B** per-tenant webhooks
(per-company app secret/verify token + `/webhooks/meta/{key}`, env fallback),
media serving (`/storage` static + web path + runtime origin), session
persistence (root→/dashboard, super-admin refresh), inbox live re-sort +
infinite scroll, new-message toast+sound, Codentra branding. Migration
`20260518000000_option_b_webhooks` (phpMyAdmin). See PROGRESS "Session FE-2c"
and ARCHITECTURE "Frontend/runtime patterns (FE-2c hardening)" + "Multi-tenant
webhooks — Option B".

---

### SESSION FE-2d — Outbound Media + Reply with context  ✅ DONE (2026-05-19)

Built outbound media (`POST /inbox/conversations/:id/send-media`: pre-upload
to Meta via `MetaClientService.uploadMedia` → send by `mediaId`; per-type
mime/size caps; 24hr window enforced; web-path `media_url`) and
reply-with-context (`messages.context_message_id` nullable self-FK; outbound
sets Meta `context.message_id` best-effort, inbound detects `context.id`;
additive optional `context_message_id` + one-level-deep hydrated
`context_message` on fetch/socket). Frontend: `postMultipart`,
attachment-picker/preview, reply-quote-strip, per-message reply +
jump-to-original. Existing `sendMessage`/`/send`/socket shapes unchanged
(only an optional `contextMessageId` added). Migration
`20260519000000_message_context_and_caption` (one-time phpMyAdmin Import).
See PROGRESS.md "Session FE-2d", ARCHITECTURE.md "Outbound media + reply
(FE-2d)" / "Frontend patterns (FE-2d)", ERRORS.md "[FE-2d …]".

---

### SESSION FE-2e — Forward + Delete-for-me (STUB) — NEXT (inbox)

```
Prereq: FE-2d complete + its migration applied on prod. Read the actual
inbox controller/service first. Additive-only; do not break the live tenant.

Build:
- Forward: per-message "Forward" action → pick another conversation (reuse
  the inbox conversation list) → re-send the message's content/media to that
  contact via the existing send / send-media path (media: re-upload by the
  stored web path, or re-reference if Meta media id retained). New outbound
  row in the target conversation. 24hr window enforced on the target.
- Delete-for-me: soft hide a message for the agent view only (NEW nullable
  column e.g. messages.hidden_at or a per-company flag) — purely local;
  WhatsApp Cloud API has NO recall, so the customer still sees it. Copy must
  say "removed from your inbox view only".

Out of scope: "Delete for everyone" (impossible via Cloud API — never offer),
voice recording, drag-and-drop, multi-file, recursive context chains,
broadcast/bot reply or media.
```

---

### SESSION FE-3 — Analytics + Billing + Webhooks + Settings + super-admin Plans  ✅ DONE (2026-05-19)

Built `/analytics` (overview %, daily funnel, agent bar + leaderboard,
conversation cost, usage vs plan, 7/30/90d), `/billing` (plan+usage card,
invoices list/filter/pagination, detail modal), `/webhooks` (endpoint CRUD +
toggle/test/delete, delivery-logs tab + retry), `/settings` (tabbed:
WhatsApp status + webhook URL/verify-token copy + owner reset, 2FA
setup/verify, read-only Profile), `/super-admin/plans` (list + create/edit).
Sidebar Webhooks/Analytics/Billing enabled + live Settings link; super-admin
Plans nav added. Frontend-only, no backend/migration. See PROGRESS.md
"Session FE-3", ARCHITECTURE.md "Frontend patterns (FE-3)". Real backend
gaps noted: no profile-edit/team/password endpoints, no Shopify settings UI.

---

### SESSION FE-3b — Team + Profile/Password + Shopify settings  ✅ DONE (2026-05-19)

Filled the FE-3 backend gaps. Auth: `/auth/me`, `PATCH /auth/profile`,
`POST /auth/change-password`. New `TeamModule`: `/team` CRUD (owner/admin,
soft-suspend, owner+self immutable, real `user_limit` count). Authed
`/api/settings/shopify` controller (status/connect/events/disconnect) reusing
ShopifyService — root OAuth callback/webhook URLs untouched. `/settings` UI
gained Team + Shopify tabs and an editable Profile + change-password. No
migration. See PROGRESS.md "Session FE-3b", ARCHITECTURE.md "Team / Profile
/ Shopify settings (FE-3b)". Remaining backend TODO: Shopify
order→WhatsApp-template dispatch (Phase-2 handler).

---

### SESSION FE-3 (original STUB — superseded by the DONE entry above)

```
Prereq: FE-1 + FE-2a + FE-2b + FE-2c complete. Reuse apiFetch/ApiError,
components/ui/modal, lib/crm-types, ToastProvider, RHF+zod. Read the actual
controllers first (every session hit prompt-vs-controller mismatches).

Build:
- /analytics: deep dashboards using /analytics/funnel, /agents,
  /conversation-cost, /broadcasts/:id (date range, agent leaderboard).
- /billing: invoices list, subscription/plan view, limit warnings.
- /webhooks: endpoint CRUD, event subscription, delivery logs viewer.
- /settings/whatsapp, /settings/team, /settings/profile (+ 2FA if enforced).
- /super-admin/plans (the super-admin route group + /super-admin/clients
  already exist from FE-2a — leave intact, add Plans).

Separate deferred phase (NOT FE-3): outbound media/attachment sending, and
bundled with it reply/quote (needs context.message_id + a schema column),
forward, and "delete for me". "Delete for everyone" is NOT possible via the
WhatsApp Cloud API — do not build it.
```

---

## SHELL-POLISH SERIES

### Shell-Polish-A — Company Logo + Navbar Identity + Notification Tones ✅ DONE (2026-05-25)
Additive-only. ONE nullable column `companies.logo_url`; `POST/DELETE
/api/settings/company/logo` (owner/admin, 2MB, jpeg/png/webp/svg) in a new
`SettingsModule`; `/auth/me` additively returns `company:{id,name,logo_url,
activation_status}`; navbar shows company logo+name + a user dropdown
(role/email/Settings/Logout); Settings→Profile gains a Company branding
card + a 5-tone device-local Notification sound picker; the inline WebAudio
beep is replaced by `lib/notification-sound.ts playNotification()`. Tones
shipped as WAV (offline OGG/MP3 encode not feasible). No inbox/socket/Meta/
Shopify changes, no new worker. Full write-up + smoke results: PROGRESS.md
"Session Shell-Polish-A". Architecture rationale: ARCHITECTURE.md
"Shell-Polish-A". Migration is one-time phpMyAdmin Import (ERRORS.md).

### Shell-Polish-B — chat pin / clear / block ✅ DONE (2026-05-19)
Additive-only. TWO nullable cols `conversations.pinned_at` +
`cleared_before` (migration `20260526000000_conversation_pin_clear`,
one-time phpMyAdmin Import; pair with `npm install` redeploy). **Pin =
company-wide** (user decision — multi-pin, no cap; shared column, no
per-user table). **Clear = server soft-marker** (user decision — syncs
across devices, reversible, no row deletes; thread fetch filters
`timestamp > cleared_before`). **Block reuses `contacts.status='blocked'`**
via existing `PATCH /api/contacts/:id` (no new col/endpoint). New endpoints
`POST /api/inbox/conversations/:id/{pin,unpin,clear}` (`AuthGuard('jwt') +
TenantGuard`). List orderBy `pinned_at desc → last_message_at desc →
updated_at desc`; FE optimistic handler re-sorts with the same comparator.
**No socket shape change / no new event** — pin/clear emit the existing
`conversation.updated {conversationId}` (list already refetches on it). UI:
pin glyph on list rows + thread-header Pin/Unpin/Clear(ConfirmDialog,
"inbox view only")/Block(ConfirmDialog). Smoke: 11 suites / 68 tests (incl.
new `inbox.service.pin-clear.spec`), backend+frontend tsc clean, nest+next
build clean, `sync:web` ok, `/health` 200, pin/unpin/clear routes mapped +
401 unauth. Write-up: PROGRESS.md "Session Shell-Polish-B"; rationale:
ARCHITECTURE.md "Shell-Polish-B"; migration note: ERRORS.md
"[Shell-Polish-B Migration]".

### Admin-Console — Super-Admin Console completion ✅ DONE (2026-05-19)
Frontend-only, no backend/schema/migration/env — wired the 5 super-admin
endpoints that had no UI. Pages `/super-admin/{billing,usage,audit}` +
clients Details modal (`GET clients/:id` — surfaces owner email, closes the
FE-2a deferral), Delete (`DELETE clients/:id`, hard cascade, strong confirm),
Impersonate (`POST impersonate/:companyId`). Billing is **view-only** (no
super-admin mark-paid endpoint exists). Usage = current month only.
Impersonation = new-tab `sessionStorage.ca_impersonation_token` handoff +
ONE additive `auth-context` mount branch (skips `/auth/refresh`, bootstraps
via `/auth/me`); live tenant flow byte-identical when key absent. New
`AdminInvoice`/`AdminUsageRow`/`AdminAuditLog` types. Smoke: frontend tsc +
next build clean, sync:web ok, cold-start maps all 4 routes + 401 unauth.
Write-up: PROGRESS.md "Session Admin-Console"; rationale: ARCHITECTURE.md
"Admin-Console"; impersonation guard: ERRORS.md "[Admin-Console]".

### Shell-Polish-C — rich inbound URL OG-preview cards + autolink ✅ DONE (2026-05-19)
Additive-only, **no migration / no socket / no dep / no env**. New `OgModule`
(sibling of inbox): `GET /api/og?url=` (`AuthGuard('jwt')` only, NOT
tenant-scoped) — native `https`/`dns`/`URL`/`crypto`, **regex-only** OG meta
extraction, mandatory **SSRF protection** (scheme allowlist; private/
loopback/link-local/ULA/multicast/reserved IPv4+IPv6 incl. v4-mapped;
`localhost*`; DNS-resolved-IP; **re-validated on every redirect hop**; 5s
deadline; 1MB cap; max 3 hops; html-only). In-memory cache via the existing
`CacheService` (`og:<sha1[:16]>`, **24h ok / 1h fail**). **Never
throws/5xxes** — 400 only for missing/malformed/blocked-scheme-or-host on
the initial URL; all other failures → 200 `{ ok:false }` (best-effort, same
policy as FE-2d reply-context). Frontend: shared `lib/url-detect.ts`
(`extractUrls`/`autolinkText`, cap-3, single regex source) + `OgPreviewCard`
(module-level promise dedup, static skeleton, returns null on miss, no
toast); cards render **inbound text only**, outbound text autolinked but no
card; template/media/reply/chip bubbles untouched. Smoke: 10 suites / 62
tests (incl. new `og.service.spec`), backend+frontend tsc clean, nest+next
build clean, `sync:web` ok, `/health` 200, `/api/og` 401 unauth. Full
write-up: PROGRESS.md "Session Shell-Polish-C"; rationale: ARCHITECTURE.md
"Shell-Polish-C"; best-effort note: ERRORS.md "[Shell-Polish-C]".

---

### Session Super-Admin-Redesign — Phases 1–6  ✅ DONE (2026-05-23 → 2026-05-24)

Six-phase batch in two sessions, total ~10 commits (`ff9840a` → `9541ee4`).
**Phase 1a/1b:** light Power-BI chrome on the super-admin area; restyled
all 5 inner pages. **Phase 2:** full client profile `/super-admin/clients/[id]`
(new `GET /api/super-admin/clients/:id/detail`, header strip, 8 snapshot
tiles, users + integrations + webhook callbacks + plan-limits + lifecycle +
audit log; Danger zone Minimal — type-name Delete only; reset-pw /
force-signout / wipe-WA deferred). **Phase 3:** invoice generator (Run
generation button + per-row Mark-Paid on `/super-admin/billing`; one-off
invoice modal `POST /api/super-admin/clients/:id/invoices` with namespace
`INV-{id}-OFF-{ts}`). **Phases 4+4.5:** Enterprise plan via per-client
`{contact,template,user}_limit_override` cols + 90/99/100 usage notifier
(fire-once via `usage_metering.thresholds_notified`; emits `usage.warning`
socket + owner email via new `MailService` + `subscription.limit.warning`/
`.reached` webhooks; sticky `UsageWarningBanner` + navbar pulse;
`PATCH /api/super-admin/clients/:id/limits`; `GET /api/billing/usage-warnings`;
suspension email fires from super-admin suspend + cron auto-suspend).
**Stability + Timezone/PDF/Legacy-rewrite (folded in):** process-level
`uncaughtException`/`unhandledRejection`; per-tenant `companies.timezone`
+ `PATCH /api/auth/company/timezone` + global `setActiveTimeZone` in
`lib/utils.ts`; client-side `html2pdf.js@^0.10.3` real-PDF download from
new tenant-only print route `/billing/invoice/[id]/print` (no print dialog,
full color); legacy-invoice rewrite with TWO entry points — CLI
`backend/scripts/rewrite-legacy-invoices.ts` (excluded from `tsconfig.build.json`
or `dist/main.js` shifts to `dist/src/main.js` and breaks `server.js`) +
panel-driven `POST /api/super-admin/billing/invoices/rewrite-legacy` for
Hostinger Business (no SSH). **Phase 5 (`9541ee4`):** Suspended-workflow
polish — `BillingBlocked` now itemizes per-invoice days-overdue + Total
due + mailto `admin@codentra.pk` CTA; new amber **Resume access** panel on
`/super-admin/clients/[id]` (suspended-only) iterates pending/overdue
invoices → `mark-paid` each → `activate`. **Phase 6:** docs sweep (this
entry + PROGRESS Current Status + CLAUDE.md runtime conventions for
overrides/notifier/timezone/PDF/Resume).

**TWO migrations to apply on prod (one-time phpMyAdmin Import, redeploy
WITH `npm install` — Prisma client regen):** `20260531000000_company_overrides_and_warnings`,
`20260601000000_company_timezone`. **Full write-up:** PROGRESS.md
"Super-admin redesign — Phase 2 / Phase 3 / Phases 4+4.5 / Phase 5". 
**Rationale:** CLAUDE.md "Runtime conventions (Super-admin redesign —
overrides, notifier, timezone, invoice PDF, Resume access)".

**Memory:** `project_super_admin_redesign_plan.md` (Phases 1–5 done, Phase
6 docs sweep done in this commit); `project_phase2_danger_zone_deferred.md`
(reset-pw / force-signout / wipe-WA stay deferred — don't re-propose).
**Next actionable:** await user direction (Shell-Polish-D is GATED on
Meta Coexistence the user lacks; FE-2e is open).

---

### Shell-Polish-D — WhatsApp Business history ingestion (STUB — GATED)
Backfill pre-existing WhatsApp chat history into the inbox. **GATED:** only
viable if the live tenant's number is in Meta **Coexistence mode** (WA
Business app + Cloud API on the same number) — Coexistence exposes a
history/`smb_message_echoes` + `history` webhook payload. On a **pure Cloud
API** number there is **no history API** — this session is **DEAD** and must
be removed from the playbook if Coexistence is not confirmed. Before
starting: confirm with the user that the live number is Coexistence-enabled
in the Meta WhatsApp Manager. Additive-only when built (new inbound path,
dedupe by `meta_message_id`, never touch the live realtime flow).

---

## ENTERPRISE HARDENING GUARD PIPELINE

> Read this section before modifying AiAgentService, response-confidence.service.ts, or any guard service.

### Guard execution order in `AiAgentService.process()`

All guards are in `backend/src/common/services/`. All are feature-flagged via `FeatureService` (4-layer: PLAN → PLATFORM → OVERRIDE → TENANT). Toggle per-tenant in super-admin client page → Hardening card; toggle platform-wide in super-admin Settings → Hardening Defaults.

1. **`KillSwitchService`** — 7 hard brakes checked BEFORE any LLM call. Safety brakes fail closed (stop); quality brakes fail open (allow). If a kill-switch is tripped, the request is stopped here and handed off.
2. **`ComplianceGuardService`** — medical/supplement risk classification. Flags health claims, dosage questions. Always-on for Sois (company 3). Can trigger pre-LLM handoff.
3. **`FraudDetectorService` + `FrustrationDetectorService`** — read `FraudSignalCollectorService` (local DB counters, no Shopify on hot path). Escalates to handoff on threshold breach.
4. **LLM call** (`LlmService` → `AnthropicProvider` / `OpenAiProvider`).
5. **`ToolValidatorService`** — runs on tool-call results BEFORE the model sees them:
   - `STATUS_PLACEHOLDER`: narrow — `n/a`, `na`, `none`, `null`, `nil`, `unknown`, dashes. "pending" and "unfulfilled" are REAL states and pass.
   - `PLACEHOLDER` (for tracking numbers): broad — includes pending/tbd/0.
   - Do NOT widen STATUS_PLACEHOLDER to include "pending" — it is a valid Shopify order status.
6. **`ResponseConfidenceService`** — grounding score on the FINAL reply:
   - `priceGrounded`: true if `search_products` was used OR (intent=order AND `get_order_status` was used).
   - `HEDGE_PHRASES`: genuinely uncertain phrasing only — NOT normal service phrases ("let me check", "i'll check" etc. are NOT hedging).
   - Low score → handoff. See tuning note below.
7. **`ImageRouterService`** — classifies images into 4 types, routes to specialist prompt.
8. **`ObservabilityService`** — appends to `events` table on every significant transition.

### How to enable/disable guards (super-admin)

**Per-tenant:** Super-admin → Client profile → Hardening metrics card → toggle individual flags → `PATCH /api/super-admin/clients/:id/features`.

**Platform-wide default:** Super-admin → Settings → Hardening Defaults → `PATCH /api/super-admin/hardening-defaults`.

**Bulk:** `/bulk` suffix on both endpoints.

### Confidence guard tuning — CRITICAL NOTE

**On an auto-pilot tenant (`ai_autoreply_enabled=true`) with an unworked human queue, a false-positive handoff = complete customer silence.** The AI doesn't reply AND the human queue is unworked. This is worse than an imperfect AI reply.

- **Tune conservatively.** Fewer phrases in `HEDGE_PHRASES` is better than more.
- Before adding a phrase to `HEDGE_PHRASES`, verify it appears in real chat logs AS an uncertainty signal, not as normal service language.
- "Let me check", "i'll check", "will get back", "get back to you" in Pakistani customer service context = polite service language, NOT uncertainty. These are NOT in `HEDGE_PHRASES` after the 2026-06-21 fix.
- If the confidence guard is causing too many false-positive handoffs on a specific tenant, consider disabling it for that tenant via the super-admin feature flag before tuning the thresholds.

### Confidence guard file location
`backend/src/common/services/response-confidence.service.ts`

Constants to look for:
- `HEDGE_PHRASES` — phrases that indicate the AI cannot actually help right now
- `priceGrounded` — logic that determines whether a price claim is grounded by a tool call
- `CONFIDENCE_THRESHOLD` — the minimum score to send instead of handoff

---

## NOTES FOR USING THIS PLAYBOOK

1. Always run the SESSION OPENER before each module prompt
2. Do not skip sessions — each builds on the previous
3. If a session is too large, split it (backend first, then frontend)
4. After each session, run the HANDOFF TEMPLATE and update PROGRESS.md
5. Bring the handoff output to Claude.ai and we will adjust the next prompt if needed
6. Sessions 1 is the most critical foundation — do not add features before it is complete

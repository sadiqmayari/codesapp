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

### SESSION FE-3 — Analytics deep + Billing + Webhooks + Settings + Super-admin (STUB)

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

## NOTES FOR USING THIS PLAYBOOK

1. Always run the SESSION OPENER before each module prompt
2. Do not skip sessions — each builds on the previous
3. If a session is too large, split it (backend first, then frontend)
4. After each session, run the HANDOFF TEMPLATE and update PROGRESS.md
5. Bring the handoff output to Claude.ai and we will adjust the next prompt if needed
6. Sessions 1 is the most critical foundation — do not add features before it is complete

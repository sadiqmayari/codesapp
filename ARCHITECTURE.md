# ARCHITECTURE.md — CodesApp Architectural Decisions
> This file records decisions made during development.
> Claude Code reads this to stay consistent across sessions.
> Update this whenever a significant architectural decision is made.

---

## Core Patterns

### API Response Shape
All API endpoints return this shape:
```typescript
{
  success: boolean,
  data: T | null,
  message: string,
  meta?: {
    page?: number,
    limit?: number,
    total?: number
  }
}
```

### Tenant Scoping Pattern
Every service method that touches the DB receives `companyId` as its first argument:
```typescript
// CORRECT
async getContacts(companyId: number, filters: FilterDto) {
  return this.prisma.contact.findMany({
    where: { company_id: companyId, deleted_at: null, ...filters }
  });
}

// WRONG — never do this
async getContacts(filters: FilterDto) {
  return this.prisma.contact.findMany({ where: filters }); // missing company_id!
}
```

### Guard Execution Order
```
@UseGuards(JwtAuthGuard, TenantGuard, PlanGuard)
```
Guards execute left to right. TenantGuard attaches `req.companyId`. PlanGuard reads `req.companyId` to check limits.

### EncryptionService Usage
```typescript
// Before saving to DB
const encrypted = this.encryptionService.encrypt(plainText);
await this.prisma.shopifyIntegration.create({ data: { access_token_encrypted: encrypted } });

// Before using in API call
const plain = this.encryptionService.decrypt(record.access_token_encrypted);
```

### Job Queue Pattern (MySQL-backed)
No Redis. All async jobs use the `jobs` table with a polling worker:

```typescript
// Enqueue a job
await this.jobQueueService.enqueue('broadcast', { broadcastId, contactId }, { delayMs: 0 });

// Register a worker (done once in module init)
this.jobQueueService.registerWorker('broadcast', async (payload) => {
  await this.processBroadcastJob(payload);
}, 3); // concurrency 3
```

**Poller design:**
- `setInterval` every 2000ms
- `SELECT ... FOR UPDATE SKIP LOCKED` — safe for single-process and future multi-process
- Lease: `locked_until = NOW() + 30s` (renewed by worker on long jobs if needed)
- Retry backoff: 60s → 300s → 1800s (attempts 1 → 2 → 3, then status = `failed`)
- Queue names: `'broadcast'` | `'webhook'` | `'message'`

### In-Process Cache (node-cache)
```typescript
// Set with TTL
this.cache.set(`subscription:${companyId}`, subscriptionData, 300); // 5min

// Get
const cached = this.cache.get<SubscriptionData>(`subscription:${companyId}`);
if (cached) return cached;
```

### Socket.io Room Convention
```typescript
// Join room on connection
socket.join(`company:${companyId}`);

// Emit to all agents in a company
this.server.to(`company:${companyId}`).emit('message.received', payload);
```

### Media File Path Convention
```
/storage/media/{company_id}/{YYYY}/{MM}/{uuid}.{ext}
```

### Soft Delete Convention
Tables with soft delete have `deleted_at DateTime?`.
All queries must include `where: { deleted_at: null }` unless intentionally querying deleted records.

---

## Database Decisions
- Used `jobs` table (MySQL) instead of Redis/BullMQ for the job queue — Hostinger shared hosting does not support Redis; MySQL polling with `SKIP LOCKED` achieves the same reliability
- Used `node-cache` for in-process caching — single Node.js process on Hostinger, so in-process cache is safe and avoids Redis dependency
- `messages` table indexed on `(conversation_id, timestamp DESC)` for inbox query performance
- `usage_metering` uses a `UNIQUE INDEX (company_id, period)` so upserts are safe
- Auth: httpOnly cookie for refresh token (not localStorage) — XSS-safe
- Access token stored in JS memory only (not localStorage) — XSS-safe
- Prisma middleware uses `AsyncLocalStorage` from `node:async_hooks` for tenant context injection

---

## Module Decisions
- Auth uses httpOnly `Secure; SameSite=Lax` cookie for refresh token
- Access token kept in React memory (JS variable), not localStorage
- Axios interceptor handles 401 → call `/auth/refresh` → retry original request
- Socket.io gateway lives in inbox module (Phase 2), not a shared module
- JobQueueService runs inside the main NestJS process — no separate worker files or processes
- CacheService TTL: subscription data 5 min, analytics data 5 min
- Super admin IP whitelist bypassed in `NODE_ENV=development`
- Response headers use `X-CodesApp-*` prefix (not X-ChatCode-*)
- (FE-1) Onboarding gate enforced in the `(app)` layout, not Next middleware (middleware only sees cookies, not onboarding state)
- (FE-1) Toast is an internal provider, not sonner/react-hot-toast — avoids Hostinger build-time registry/CDN flakiness
- (FE-1) Inbox is a persistent route-group layout (list) + nested page (thread); list-level socket state lives in the layout so it survives thread navigation

---

## Known Limitations
> Record things that are intentionally simplified for v1

- 2FA is scaffolded but not enforced in v1
- One WhatsApp number per company (multi-number is Phase 2)
- No file preview for documents in inbox (show download link only)
- Broadcast throttle is fixed at 10 msg/sec (configurable in Phase 2)
- In-process cache (`node-cache`) is lost on process restart — acceptable for TTL'd data

---

## Third-Party API Notes
> Record any quirks discovered during integration

### Meta WhatsApp Cloud API
- Media URLs from Meta expire in ~10 minutes — download immediately on receipt
- 24hr customer service window: after expiry only template messages allowed
- Webhook verification: respond to GET with hub.challenge within 5 seconds
- Message status webhooks arrive separately from message webhooks

### Shopify
- Webhook HMAC header: `X-Shopify-Hmac-Sha256`
- Verify using `SHOPIFY_WEBHOOK_SECRET`, not the API secret
- Always respond 200 within 5 seconds or Shopify retries
- Register raw body parser for `/integrations/shopify/webhook` BEFORE global body parser

---

## Inbox real-time event reference (Phase 2)

All events scoped to room `company:{companyId}`. Client must connect with
`socket.io-client` passing `auth.token` (or `Authorization: Bearer <jwt>`
header) and `transports: ['websocket', 'polling']`.

### Server → client
| Event | Payload | Source |
|---|---|---|
| `agent.online` | `{ userId }` | Socket connect (after JWT verify) |
| `agent.offline` | `{ userId }` | Socket disconnect |
| `message.received` | `{ message, conversationId, contactId, isNewContact }` | `MetaWebhookService` worker |
| `message.sent` | `{ message }` | `InboxService.sendMessage` |
| `message.status` | `{ messageId, status }` | `MetaWebhookService` status updates |
| `message.read.bulk` | `{ conversationId, readBy, readAt }` | `mark.read` event or `POST /mark-read` |
| `conversation.assigned` | `{ conversationId, userId }` | `InboxService.assign` |
| `conversation.updated` | `{ conversationId, status?, addedLabel?, removedLabel? }` | label/status mutations |
| `typing.start` / `typing.stop` | `{ conversationId, userId }` | Client-originated |
| `agent.viewing` / `agent.left` | `{ conversationId, userId }` | Client-originated, used for collision detection |
| `broadcast.progress` | `{ broadcastId, sent, failed, total, status? }` | `BroadcastWorker` every 25 jobs + on completion |

### Client → server (subscribed)
- `typing.start` / `typing.stop` — broadcast to room
- `agent.viewing` / `agent.left` — collision detection
- `mark.read` — server updates `read_at` + `read_by_user_id` then broadcasts `message.read.bulk`

### Authentication
`WsJwtGuard.authenticate()` is called in `handleConnection()` so unauthenticated
sockets are disconnected at handshake — not deferred to first event. Inside the
guard, JWT secret falls back to the insecure placeholder string only when
`JWT_SECRET` is missing (matches `JwtStrategy` behavior so dev still works).

---

## Broadcast throttle implementation (Phase 2)

`BroadcastsService.dispatch()` enqueues per-contact `'broadcast'` jobs with
`delayMs = index * 100`. With worker concurrency=3, this yields ~10 messages
per second per broadcast (and per company, since each company has its own
broadcasts and worker pool is shared globally — total throughput at the
process level is capped by concurrency, not by the spacing).

Status flow:
- `draft` → `sending` on `/send` after dispatch enqueues all jobs
- `scheduled` → `sending` when the single scheduler `dispatch` job fires at `run_at`
- `sending` → `completed` when `sent_count + failed_count >= total`
- Any state ≤ `sending` → `cancelled` via `/cancel` (deletes pending jobs by
  `JSON_EXTRACT(payload, '$.broadcastId')`)

Delivered / read counts are bumped by `MetaWebhookService.handleStatus()`
when it sees a status webhook for a message whose `broadcast_id` is set.

Worker progress emit: every 25 completed jobs the worker emits
`broadcast.progress` to the company room. On completion it emits one final
event with `status: 'completed'`.

---

## Bot engine — fire_webhook handoff to Phase 3

`BotEngineService.runForMessage()` is invoked by `MetaWebhookService` after
the inbound message is persisted. Action types:

- `reply_template` / `send_text` → calls `InboxService.sendMessage` (re-uses
  24hr-window enforcement and DB persistence).
- `assign_agent` → updates `conversations.assigned_user_id` only if it is
  currently unset (so manual assignment is never overwritten).
- `apply_tag` → merges into `contacts.tags` JSON array; no-op if already present.
- `fire_webhook` → **stub for Phase 3**. Enqueues a `'webhook'` job with payload:
  ```json
  {
    "event": "keyword.triggered",
    "webhookEndpointId": <int>,
    "data": { "companyId", "conversationId", "messageId" }
  }
  ```
  No worker is registered for the `'webhook'` queue in Phase 2 — jobs stay
  `pending` until the outbound webhook module (Phase 3) registers its worker.

Active-bot cache: `bots:active:{companyId}` (TTL 60s, via `CacheService`).
Invalidated on every POST/PATCH/DELETE/toggle bot mutation.

---

## Cross-module forward references (Phase 2)

- `InboxModule ↔ BotsModule` — `InboxModule` imports `BotsModule` for
  `BotEngineService`; `BotsModule` imports `InboxModule` for `InboxService`.
  Both use `forwardRef(() => ...)` in both `imports` and constructor
  `@Inject(forwardRef(...))` to break the cycle.
- `InboxGateway` is exported by `InboxModule` so `BroadcastWorker` can emit
  `broadcast.progress` to the company room without duplicating socket logic.

---

## Webhook delivery & HMAC contract (Phase 3)

`WebhookDispatcherService.dispatch(companyId, event, data)` is the single
fan-out entry point (exported by `WebhooksModule`, injected by inbox, bots,
contacts, templates, billing). It loads active endpoints subscribed to the
event (cached at `webhook-endpoints:{companyId}`, TTL 60s, invalidated on every
endpoint mutation), enqueues one `'webhook'` job per matching endpoint, and
never throws to the caller.

`WebhookWorker` (concurrency 3) applies rules **in order** on each pickup:
(a) endpoint missing/inactive → log `failed` reason `endpoint_inactive_or_missing`, consume (no throw);
(b) stale job → log `failed` reason `stale`, consume — see "Phase 2 webhook backlog" in ERRORS.md;
(c) decrypt `secret_key_encrypted`;
(d) build canonical payload `{ event, delivery_id (uuid v4), timestamp (iso), company_id, data }`;
(e) sign `X-CodesApp-Signature: sha256=<hex>` = HMAC-SHA256(rawJsonBody, secret);
(f) POST via Node native `https` (10s timeout, `agent:false` — no keepalive) with
`X-CodesApp-Signature/-Event/-Delivery/-Timestamp` + `Content-Type: application/json`;
(g) status policy: 2xx → log success; 3xx/4xx except 408/429 → log `client_error`, consume (client misconfigured, do NOT retry); 5xx/408/429/network/timeout → log attempt then THROW so `JobQueueService` backs off 60s/300s/1800s;
(h) `usage_metering.webhook_calls` incremented (raw SQL, no UsageMeteringService — avoids re-entering the limit-warning → dispatcher path) on every attempt.

Signature is over the exact raw JSON body string the client receives.
`webhook_logs.payload` stores `{ payload, reason }` (schema has no `reason`
column).

## Limit warning idempotency (Phase 3)

`UsageMeteringService.increment()` calls `LimitWarningService.check(companyId,
field)` after every atomic increment. The check loads subscription limits
(cached `subscription:{companyId}`, 5m) + current-period usage. It fires
`subscription.limit.warning` via the dispatcher exactly once per
(period, dimension) when `0.8 <= used/limit < 1.0`, guarded by a cache flag
`warning:{companyId}:{YYYY-MM}:{dimension}` with TTL = ms remaining in the
month. The 100% hard block stays owned by `PlanGuard` (Phase 1). Only
`contacts` and `templates` dimensions have plan limits; other fields are no-ops.

## Cron secret fallback (Phase 3)

`CronGuard` reads `X-Cron-Secret` header first, then falls back to `?secret=`
query param (UptimeRobot free tier custom-header support is flaky). Compared
constant-time (`crypto.timingSafeEqual`) against `CRON_SECRET`. Missing or
mismatch → **403** (changed from 401 in Phase 2). All cron endpoints are GET,
idempotent, return a JSON summary.

## Cloud API onboarding state machine (Phase 3)

`companies.onboarding_status` JSON canonical shape:
`{ step:1-5, completed:boolean, metaAppId, metaAccessTokenEncrypted,
webhookVerifiedAt, testMessageSentAt }`. Step 3 throws **503** if
`EncryptionService.isUsingPlaceholderKey()` (no real ENCRYPTION_KEY) — never
store secrets under the insecure placeholder. Step 4 writes the real
`companies.waba_id` / `companies.phone_number_id` **columns** (inbox/broadcast/
templates read these). Step 5 sends a test template then stamps
`completed=true`. `/onboarding/status` never returns the token (redacts to
`(set)`). `reset` (owner-only) wipes the JSON + nulls the two columns; it does
NOT delete contacts/messages.

## Per-company Meta credentials (multi-tenant Meta client) (Phase 3)

`MetaClientService.getAccessToken()` reads `onboarding_status.metaAccessTokenEncrypted`
(falls back to the Phase 2 `metaAccessToken` key for pre-migration rows) and
decrypts per request. `MetaClientService.assertOnboarded(companyId)` throws
**412** when `onboarding.completed !== true`; it is called at the start of
inbox send, broadcast worker, and template sync — but NOT from onboarding
step-5 (that runs before `completed` is stamped, so it would deadlock the
wizard).

---

## Frontend patterns (FE-1)

### Token rehydration on mount
The access token lives only in JS memory (`lib/api.ts`). `AuthProvider` calls
`POST /auth/refresh` once on mount (httpOnly `refresh_token` cookie); success →
store new access token + user, failure → the `(app)` layout pushes to `/login`.
No localStorage/sessionStorage anywhere. The axios response interceptor also
does 401 → refresh → retry → (on refresh fail) redirect to `/login`.

### Onboarding gate placement
Enforced in `app/(app)/layout.tsx`, NOT middleware. Middleware (`middleware.ts`)
only checks `refresh_token` cookie presence to bounce logged-out users. The
layout fetches `GET /onboarding/status`; if `completed !== true` and route is
not `/onboarding` it redirects. The gate **fails open** if the status call
errors (never trap the user). `apiFetch({noOnboardingRedirect:true})` is used
by the layout + wizard so the 412 auto-redirect doesn't fight the gate.

### SocketProvider scoping
`SocketProvider` wraps only the `(app)` group (inside the layout, after auth +
gate pass). `auth: (cb) => cb({ token: getAccessToken() })` is invoked by
socket.io-client on every (re)connect, so a rotated access token is picked up
automatically with no manual reconnect. Transports `['websocket','polling']`.
`useSocket()` exposes `status` (connected/connecting/disconnected), `on()`
(returns unsubscribe), and `emit()`.

### 24hr window enforcement on the composer
`windowCountdown(window_expires_at)` (lib/utils) returns `{open,label}`.
`open===false` when the timestamp is null or in the past → free-form textarea
is replaced by a notice + template-only button. Open → textarea + send +
template picker + (disabled) attachment button. The backend independently
enforces this (403) — the UI is a UX mirror, not the source of truth.

### Agent collision detection
On thread mount: `emit('agent.viewing',{conversationId})`; on unmount:
`emit('agent.left',...)`. Incoming `agent.viewing` for the same conversation
from a different `userId` shows a yellow "another agent is also viewing"
banner; `agent.left` clears it. Incoming `typing.start/stop` rendered (we only
emit our own typing on textarea change/blur).

### Inbox realtime event handling
List (inbox layout): `message.received`→bump row unread (0 if active),
`message.read.bulk`→reset row unread, `conversation.assigned/updated`→refetch,
reconnect→refetch. Thread: append on `message.received`/`message.sent` (dedupe
by id), `message.status`→update ticks, `message.read.bulk`→mark inbound read,
`conversation.assigned/updated`→reload header, reconnect→reload convo+messages.
`broadcast.progress` is received by the socket but ignored in FE-1.

### Error code → UX mapping
401 → axios interceptor refresh+retry, then `/login`. 412 → redirect
`/onboarding`. 403 → toast backend `message`. 5xx → toast generic +
`console.error`. All via `ApiError` thrown from `apiFetch`.

### Library choices
Toast: internal `ToastProvider` (no external lib). Forms: react-hook-form +
zod. Charts: recharts. Icons: lucide-react. Styling: Tailwind only.

---

## Frontend patterns (FE-2a)

### CSV import — client-side column mapping
`POST /contacts/import` accepts **only** a multipart `file` (no mapping DTO;
the importer keys on literal column names `phone,name,email,tags` and ignores
custom_fields). The 3-step modal (`components/contacts/csv-import-modal.tsx`)
therefore: (1) parses headers + first 5 rows in-browser with a tiny inline
RFC-4180 parser — no papaparse dep added; (2) lets the user map each header to
`name|phone|email|tag|skip` (multiple `tag` columns merge, comma-split into
individual tags); (3) **re-exports a normalized CSV** (`phone,name,email,tags`
header) as a `Blob` and uploads it as `file` via `FormData`. Result step reads
the backend summary `{created, skipped, invalid, capped}`; `capped===true`
shows a plan-limit-reached upgrade notice (backend does not return X-of-Y or a
row number, so copy is generic). custom_fields mapping is intentionally NOT
offered (importer drops it).

### Super-admin route-group layout
`app/super-admin/layout.tsx` owns the dark chrome + nav for the whole
`/super-admin/*` group. It renders `/super-admin/login` bare and applies a
single token-presence gate (no `getAccessToken()` → `router.replace(login)`)
to all other routes. Real credential validation stays per-page: each page's
data load catches `ApiError` 401/403 and redirects. `/super-admin/dashboard`
was slimmed (header moved to layout) and now uses `apiFetch` like clients.

### Segment filter shape used by the UI
The segments drawer (`components/contacts/segments-drawer.tsx`) builds exactly
the backend `SegmentFilterDto`: `{ tags?: string[], status?:
active|blocked|archived, lastMessageAfter?: ISO, lastMessageBefore?: ISO,
hasEmail?: boolean }`. Date inputs are `YYYY-MM-DD` and converted to ISO on
save. The contacts page segment dropdown reads `GET /contacts/segments` and
filters server-side via `?segmentId=`.

### Contacts list filter reality
Backend `ListContactsDto` supports `search, tag (single), status, segmentId,
page, limit` only. The UI exposes single-select tag (not multi — backend takes
one), server status/segment/search/pagination. The "Last activity" filter has
**no backend support** and is applied client-side to the current page only
(documented limitation, surfaced via a tooltip).

### Optimistic super-admin actions
`/super-admin/clients` activate/suspend are **PATCH** (`/clients/:id/activate`
| `/suspend`) — the controller uses PATCH, not POST as some prompts state.
Row status is updated optimistically and rolled back on error with an inline
banner. List has no server search/status filter → both are client-side over
the server-paginated page. Owner email is NOT in the list response
(`getClients` includes only `subscription`) so the table shows plan instead;
owner email would need a per-row detail fetch (deferred).

## Frontend patterns (FE-2b)

### Broadcasts list pagination & live progress
`GET /broadcasts` returns a **plain array with no total count**. The list uses
prev/next where "Next" is enabled only when the returned page is full
(`rows.length === LIMIT`) — same approach as the inbox list. Live updates:
the page subscribes via `useSocket().on('broadcast.progress', …)` (payload
`{broadcastId,sent,failed,total,status?}`, emitted by `BroadcastWorker` every
25 jobs + on completion) and patches the matching row's counts/status in place.
A `rowsRef` mirror avoids resubscribing on every data change. Analytics is a
modal hitting `GET /broadcasts/:id/analytics` (the only place a real `total`
is available); there is no `/broadcasts/[id]` page (out of FE-2b scope).

### Audience builder
`components/broadcasts/audience-builder.tsx` is a controlled component emitting
either `{segmentId}` or `{filter: SegmentFilter}` (same `SegmentFilterDto`
shape as FE-2a segments). Manual contact-id selection is intentionally not
offered (no contact-picker endpoint). `/broadcasts/new` doubles as the draft
editor via `?id=` (read from `window.location.search`, not `useSearchParams`,
to avoid the Next 14 prerender/Suspense requirement) — backend only allows
editing while status is `draft`.

### Bot action builder
`components/bots/bot-form-modal.tsx` builds the `actions[]` array (1–10) to the
exact `BotActionDto` union. Per-type required-field validation runs client-side
before submit and empty optional fields are stripped. `assign_agent.userId`
and `fire_webhook.webhookEndpointId` are raw numeric inputs (no team-list
endpoint exists; webhook management UI is FE-3) with inline notes. Bot
`DELETE` is a **hard delete** (no soft-delete column) — the confirm copy says
so. Toggle is `PATCH /bots/:id/toggle` with optimistic status flip + rollback.

## Multi-tenant webhooks — Option B (per-tenant Meta app) + Option A fallback

The platform is **not** yet a verified Meta Tech Provider, so each client uses
**their own Meta app**. Meta signs inbound POSTs with the *subscribing app's*
secret and the GET handshake uses the verify token configured in *that* app —
so a single platform `META_APP_SECRET`/`META_VERIFY_TOKEN` cannot validate
many clients. Resolution:

- `companies.webhook_key` — immutable, company-name-seeded unique slug
  (`<slug>-<4hex>`, generated once in `OnboardingService.ensureWebhookKey`,
  never recomputed on rename). Each tenant's callback URL is
  `https://apps.codentra.pk/webhooks/meta/{webhook_key}`.
- `companies.webhook_verify_token` (plain) + `webhook_app_secret_encrypted`
  (AES-256-GCM) captured in **onboarding step 2** (`Step2WebhookDto`;
  app secret optional on re-submit → keeps stored value; 503 if
  `ENCRYPTION_KEY` is the placeholder, same guard as step 3).
- `MetaWebhookController.resolveSecrets(key?)`: with a key → that company's
  stored verify token / decrypted app secret, **each falling back to the
  platform `META_*` env when null**; without a key (legacy `/webhooks/meta`)
  → env only. Both `@Get()/@Post()` (keyless) and `@Get(':key')/@Post(':key')`
  routes exist; `webhooks/meta/(.*)` is already excluded from the `/api`
  prefix in `main.ts`, so the param route needs no routing changes.
- Inbound is still demultiplexed to the right tenant by `phone_number_id`
  in the payload (unchanged) — the key only selects which secrets validate.

**Forward-compatibility to Option A (Tech Provider / Embedded Signup):** when
verified, new tenants onboard via Embedded Signup and store **no** per-company
secret → `resolveSecrets` automatically uses the platform env. Legacy Option-B
tenants keep working on their own secrets. Switching a tenant to A = clear its
per-company secret columns + re-onboard (one client action); no schema teardown,
no CRM data migration (token/WABA/phone storage shape is identical).

## Single-process: Next.js mounted inside NestJS (deployment)

The PRD mandates one Node process at one origin (`apps.codentra.pk`). The
NestJS process serves the API **and** the prebuilt Next.js frontend:

- `backend/src/main.ts` creates an Express instance, registers a prelim
  middleware FIRST, then `NestFactory.create(AppModule, new
  ExpressAdapter(server))`. Because the middleware is on the Express stack
  before Nest wires its router, page requests never reach Nest's JSON 404.
- Prelim rule: if the path starts with a backend root
  (`/api /health /webhooks /integrations /cron /socket.io /storage`) →
  `next()` (NestJS handles it); otherwise → Next.js request handler.
- `app.setGlobalPrefix('api', { exclude: [...] })` moves all app modules
  under `/api`. Excluded (stay at root, public URLs unchanged): `health`,
  `webhooks/meta(/*)`, `integrations/shopify(/*)`, `cron(/*)`. Socket.io
  uses its own `/socket.io` path and is unaffected by the prefix.
- Next is loaded via `require('next')({ dev:false, dir: backend/web })`
  (`__dirname/../web`) and `await nextApp.prepare()` before `app.listen()`.
  Hostinger deploys ONLY `backend/`, so the built frontend is synced into
  `backend/web/` (`.next`+`next.config.js`+`package.json`) by
  `backend/scripts/sync-web.js`. `next/react/react-dom` are in **backend**
  `dependencies`; Next + react resolve from `backend/node_modules`.
- If Next init fails, non-API routes return a 503 JSON with diagnostics
  (resolved dir + existence probes + error stack) so prod issues are
  diagnosable without log access; API/health/webhooks stay up.
- Same origin ⇒ no CORS/cookie cross-site issues; the refresh cookie and
  Socket.io `auth.token` work unchanged.
- Verified locally: `/`→Next, `/login`→Next 200, `/health`→backend JSON,
  `/api/inbox/conversations`→401, `/webhooks/meta?...`→403.

### Module Decisions (single-process)
- API base for the frontend is `${origin}/api` (set in `lib/api.ts`);
  `NEXT_PUBLIC_API_URL` env is origin-only. Socket URL stays origin.
- Backend route names are unchanged in code — `setGlobalPrefix` applies the
  `/api` transparently; controllers/services/guards/DB logic untouched.
- No database/schema/migration impact from the single-process change.

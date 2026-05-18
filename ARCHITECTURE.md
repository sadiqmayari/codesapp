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

## Frontend/runtime patterns (FE-2c hardening)

- **Media serving:** WhatsApp media is written by `MediaService` to
  `<cwd>/../storage/media/<companyId>/<yyyy>/<mm>/<uuid>.<ext>`.
  `messages.media_url` stores the **web path** `/storage/media/...` (NOT the
  absolute fs path). `main.ts` mounts `express.static(<cwd>/../storage)` at
  `/storage` **before** the Next/backend router (registered on the raw
  Express instance, fallthrough:false). `/storage` is in `BACKEND_ROOTS` and
  excluded from the `/api` prefix. Filenames are random UUIDs (capability
  URLs); per-tenant media auth is a known future hardening. `mediaUrl()`
  resolves `window.location.origin` at runtime (root origin, not `/api`).
- **Session restore:** root `/` redirects to `/dashboard` (NOT `/login`) so
  the `(app)` silent-refresh gate can restore the tenant session; only a
  cookieless visitor is bounced to `/login` (middleware). `/login`
  auto-forwards an already-authenticated user. Super-admin mirrors this:
  `POST /super-admin/auth/refresh` (IP-guarded) rehydrates from the
  `sa_refresh_token` cookie; the super-admin layout calls it before
  bouncing to login (access token is memory-only by design).
- **Inbox realtime list:** on `message.received` the conversation is moved
  to the top with an updated `last_message`/`updated_at` (client-side
  re-sort — render is array-ordered); unknown conversation → `load()`
  (server sort+filters). List uses **infinite scroll** (append next page on
  scroll, dedupe by id), not prev/next; filter/search reload from page 1.
- **New-message notification:** the `(app)` shell shows a toast + a short
  WebAudio beep on `message.received`, suppressed when the active path is
  that conversation's thread. No audio asset; no-ops if audio is blocked.
- **Onboarding self-service:** `webhook_key` AND `webhook_verify_token` are
  auto-generated once (immutable) by `ensureWebhookConfig`; step 2 shows
  both read-only (copy buttons) and only collects the app secret. Step 3
  token + step 2 app secret are optional on re-submit (blank = keep);
  step 4 pre-fills — re-editing one step never forces re-entering secrets.

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
- `companies.webhook_verify_token` is **auto-generated** server-side
  (`vt_<16 bytes hex>`) by `ensureWebhookConfig`, alongside `webhook_key`,
  on first `getStatus`/step 2 — generate-once, never overwritten (same
  immutability rule as the key; preserves any pre-existing manually-set
  token). The client only copies it into Meta; step 2 no longer asks them
  to invent one. `webhook_app_secret_encrypted` (AES-256-GCM) is the only
  secret captured in **onboarding step 2** (`Step2WebhookDto.appSecret`,
  optional on re-submit → keeps stored value; 503 if `ENCRYPTION_KEY` is
  the placeholder, same guard as step 3).
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

## Outbound media + reply (FE-2d)

**Meta pre-upload flow.** Outbound media is a *new* path, never folded into
`sendMessage`. `InboxController POST /inbox/conversations/:id/send-media`
(multipart, `FileInterceptor` memory storage, 25MB hard cap) →
`InboxService.sendMedia`. Order inside `sendMedia`: `assertOnboarded` (412) →
conversation+company scope check → 24hr window (403, same message as
`sendMessage`) → per-type mime/size validation against `MEDIA_RULES` (400) →
save the buffer to disk under the **inbound convention**
(`<cwd>/../storage/media/{companyId}/{YYYY}/{MM}/{uuid}.{ext}`), persist the
**web path** `/storage/media/...` on `messages.media_url` (never the absolute
fs path — FE-2c regression guard) → `MetaClientService.uploadMedia` POSTs
multipart `messaging_product/type/file` to `/{phone_number_id}/media` and
returns `{ mediaId }` → the `/messages` send references `{ id: mediaId }`
(`caption` only on image/video, `filename` only on document). `uploadMedia`
uses native `https` (10s timeout, hand-built multipart boundary) and on a
non-2xx parses Meta's `{error:{message,code}}` (`extractMetaError`) so the
real reason surfaces (same policy as the FE-2c onboarding step-5 fix).
Worker count is unchanged — there is no new queue/worker; the upload+send is
synchronous within the request.

**context.message_id resolution.** Reply uses one nullable self-FK
`messages.context_message_id` (`ON DELETE SET NULL`).
- *Outbound* (`sendMessage` optional `contextMessageId`, and `sendMedia`):
  `resolveContext` looks up the quoted message scoped to `company_id`, and if
  it has a `meta_message_id` mutates `payload.context = { message_id: wamid }`.
  Lookup miss or null wamid → send WITHOUT context, log `warn`, never throw;
  the internal id is still persisted as `context_message_id` only when the
  row was found.
- *Inbound* (`MetaWebhookService.handleInbound`): if Meta's payload has
  `context.id`, look up our message by `meta_message_id` scoped to
  `company_id` and store its internal id as the new inbound row's
  `context_message_id`. Wrapped in try/catch — best-effort, never throws.

**Best-effort policy (why).** A reply must never block a send: Meta wamids
can be unknown to us (message predates a backfill, sent out-of-band), and a
quoted message can be hard-deleted. Degrading to a plain (un-quoted) message
is strictly better than a 5xx.

**Additive socket/fetch contract.** `message.received`/`message.sent` payload
shapes are unchanged; the embedded `message` object simply gains
`context_message_id` plus a hydrated `context_message` object. Message fetch
(`listMessages`) and both creates `include` `context_message` selecting only
`{ id, direction, message_type, content, media_url }`. **One level deep
only** — `context_message` is never itself hydrated with its own
`context_message` (no recursive chains, bounded query cost).

## Frontend patterns (FE-2d)

- `lib/api.ts postMultipart<T>` posts a `FormData` via the shared axios
  instance (no explicit `Content-Type` — the browser sets the boundary),
  reusing the envelope unwrap + `ApiError` mapping (incl. 412→/onboarding).
- `components/inbox/attachment-picker.tsx` owns `RULES` (mirrors backend
  `MEDIA_RULES`) + exported `validateFile`/`ACCEPT_ATTR`; bad type/size →
  toast + clear, good → `onPick({file,kind})`. `disabled` greys it out with
  a "Send a template first" tooltip (parent decides via `windowCountdown`).
- Composer order in `inbox/[id]/page.tsx`: picker | reply-quote-strip (when
  replying) | attachment-preview (when a file is staged, replaces the
  textarea row, has its own spinner-guarded Send) | textarea | send. Two
  send paths: no file → existing JSON `/send` (+ optional `contextMessageId`);
  file → `postMultipart /send-media`. Success clears reply + staged file
  (object URLs revoked on unmount/clear). Per-message Reply is a hover icon
  (desktop) on both inbound/outbound bubbles; an existing `context_message`
  renders a clickable quote strip above the bubble that scrolls to
  `#msg-{id}` (with a transient ring) if the original is loaded.

## Voice notes (FE-2d follow-up)

WhatsApp only renders a real PTT voice note when the audio is
`audio/ogg;codecs=opus`. The browser `MediaRecorder` produces
`audio/webm;codecs=opus` (Chrome/Edge — Meta **rejects** webm) or
`audio/mp4` (Safari), and Hostinger shared hosting cannot transcode (no
ffmpeg, no native compile). Resolution: **`opus-recorder`** (WASM) encodes
microphone input straight to ogg/opus in the browser.

- `components/inbox/voice-recorder.tsx` — mic button → record bar (timer,
  pause/resume, cancel, send). `streamPages:false` so `ondataavailable`
  fires once on `stop()` with the full OGG; we wrap it in a
  `File('voice-note-*.ogg','audio/ogg')` and POST it through the **existing**
  `/inbox/conversations/:id/send-media` path (audio is already in
  `MEDIA_RULES`; `MIME_EXT['audio/ogg']='ogg'`). No backend change.
- The encoder worker is **vendored** at `frontend/public/opus/encoderWorker.min.js`
  (opus-recorder 8.x inlines the WASM into that file — no separate `.wasm`).
  `scripts/sync-web.js` already copies `public/` into `dist/web/public`, and
  Next serves it at `/opus/encoderWorker.min.js` (not a backend root → Next
  handler). `Recorder({ encoderPath:'/opus/encoderWorker.min.js' })`.
  `opus-recorder` is a build-time dep only (bundled into the page chunk);
  production needs no frontend node_modules.
- 5-min safety auto-stop (Meta audio cap is 10MB; opus ≈ tiny). Mic
  permission denial / unsupported → toast, recorder resets. Voice send
  carries the staged reply context (`contextMessageId`) like other media.

## Frontend patterns (FE-3)

All five FE-3 pages are frontend-only, built strictly to the existing
Phase-3 controllers (contracts verified before coding — the recurring
prompt-vs-controller lesson). Reuse `apiFetch`/`apiFetchEnvelope`,
`components/ui/modal`, `lib/crm-types`, recharts, ToastProvider.

- **/analytics** — `GET /analytics/{overview,funnel,agents,conversation-cost,usage}`.
  `funnel`/`agents`/`conversation-cost` take `from`/`to` ISO query params
  (DateRangeDto, 90-day cap); 7/30/90d range buttons. Deeper than the
  dashboard: adds agent bar chart + leaderboard table. `usage` never cached.
- **/billing** — `GET /billing/subscription` (plan + period usage) and
  `GET /billing/invoices` (status filter + page/limit, envelope `meta.total`),
  invoice detail in a Modal. View-only: mark-paid/generate are super-admin /
  cron endpoints, intentionally not surfaced to tenants.
- **/webhooks** — two tabs. Endpoints: CRUD via `POST/PATCH/DELETE
  /webhooks/endpoints`, `PATCH …/toggle`, `POST …/test`. Secret is **never
  returned** (`'(set)'`), so the edit form leaves it blank = keep; create
  enforces ≥16 chars client-side mirroring the DTO. Event checkboxes are a
  **static list mirroring the dispatcher's emitted events** (no list
  endpoint exists). Logs tab: `GET /webhooks/logs` (status filter +
  pagination) + `POST /webhooks/logs/:id/retry` on failed rows.
- **/settings** — one tabbed page (not `/settings/*` sub-routes). WhatsApp
  tab reads `GET /onboarding/status` (`noOnboardingRedirect`) and shows the
  per-tenant callback URL `${origin}/webhooks/meta/{webhookKey}` + verify
  token (copy), links to `/onboarding` to edit, owner-only `POST
  /onboarding/reset` behind ConfirmDialog. Security tab = `POST
  /auth/2fa/setup` → QR + manual key, `POST /auth/2fa/verify`. Profile tab
  is **read-only** from `useAuth()` — there is no profile-update / team /
  in-app password endpoint (real backend gap; password change points to the
  forgot-password flow).
- **/super-admin/plans** — `GET/POST/PATCH /super-admin/plans` (Subscription
  rows: plan_name + 3 limits + monthly_price + setup_fee + webhook_enabled).
  Lives in the existing super-admin route-group layout (dark chrome); a
  Plans nav item was added. Each page still self-handles 401/403 → redirect
  to `/super-admin/login` (layout only does the token-presence gate).

Sidebar: Webhooks/Analytics/Billing enabled; Settings is now a live link.

## Team / Profile / Shopify settings (FE-3b)

- **Profile/password** (auth module, additive): `GET /api/auth/me`,
  `PATCH /api/auth/profile` (name only — email is `@unique` and would need
  re-verification, intentionally out), `POST /api/auth/change-password`
  (bcryptjs cost 12, verifies current). All `AuthGuard('jwt')` only.
- **Team** (new `TeamModule`, imports `AuthModule` for the JWT strategy):
  `@Controller('team')` guarded `AuthGuard('jwt') + TenantGuard + RolesGuard`
  `@Roles('owner','admin')`. `GET` list, `POST` create, `PATCH :id`
  role/status, `DELETE :id` = **soft-suspend** (status='suspended', never a
  hard delete — preserves audit/assignment FKs). Invariants enforced in the
  service: the `owner` row and the actor's own row are immutable; only an
  `owner` may create or promote to `admin`; `user_limit` is enforced by a
  live `count(status != suspended)` vs `company.subscription.user_limit`
  (the Phase-1 PlanGuard hardcodes users `current:0`, so it is deliberately
  NOT used here — count is authoritative). New members are created
  `status:'active'` with an admin-set temporary password (no email invite —
  Hostinger SMTP is unreliable, see ERRORS.md).
- **Shopify settings**: a SECOND controller `@Controller('settings/shopify')`
  (under `/api`) reusing the existing `ShopifyService`. The original
  `ShopifyController` (`/integrations/shopify/*`) stays excluded from the
  `/api` prefix so the OAuth **callback** + **webhook** keep the fixed root
  URLs registered in the Shopify app — we did NOT touch `main.ts`
  exclusions. New: `GET` status (returns null when unlinked, vs the old
  endpoint that 404s), `GET connect` (returns the `{shop}`-templated OAuth
  URL — the UI substitutes the store subdomain and redirects), `PATCH
  events` (whitelist-filtered `active_events`), `DELETE` disconnect. The
  order→WhatsApp-template dispatch is still the Phase-2 backend TODO; the UI
  only toggles which order events are active.
- **/settings UI**: Team + Shopify tabs added; Team tab is owner/admin-only
  (gated on `useAuth().role`); Profile tab is now editable (name +
  change-password). Profile rename doesn't refresh the in-memory auth
  context — copy tells the user to reload (name in nav is cosmetic).

## Shopify per-tenant order-confirmation (phased)

Each client uses their OWN custom Shopify app (not a single platform app),
so — exactly like Meta Option B — the signing secret differs per client and
a per-tenant callback URL is required.

- **Phase 1 (done):** `companies.shopify_webhook_key` (immutable
  `<slug>-sh-<hex>`, generate-once) + `shopify_webhook_secret_encrypted`
  (AES-GCM). `GET /api/settings/shopify` → `{integration,webhookKey,
  webhookSecretSet}`; `PATCH /api/settings/shopify/webhook-secret`. Settings
  → Shopify tab shows the per-client URL + secret capture, independent of
  the legacy OAuth read-only connect.
- **Phase 2 (done):** `POST /webhooks/shopify/:key` — public, at root
  (excluded from the `/api` prefix AND added to `BACKEND_ROOTS` so it
  reaches Nest, not Next). Resolves company by key, decrypts that company's
  secret, verifies `X-Shopify-Hmac-Sha256` = base64(HMAC-SHA256(rawBody,
  secret)) constant-time, parses `orders/create`. No JWT — authenticity is
  the per-company HMAC. Non-order topics / bad JSON → 200 ignored;
  unknown-key / no-secret / bad-HMAC → 401. Only validates+logs in P2.
- **Phase 3 (done):** `shopify_order_configs` (per company) — chosen
  approved template, Shopify-field→`{{n}}` map (validated against the fixed
  `SHOPIFY_ORDER_FIELDS` allowlist), Confirm/Cancel tag names; Settings UI.
- **Phase 4 (done):** `companies.shopify_admin_token_encrypted` (Settings →
  Shopify) + `shopify_order_messages` link table + a new **`shopify` job
  queue** (concurrency 3, registered in `ShopifyService.onModuleInit`). The
  `/webhooks/shopify/:key` receiver enqueues a `{kind:'send'}` job and
  returns 200 immediately (Shopify 5s ack). The worker: resolves/creates
  contact+conversation (mirrors `MetaWebhookService.handleInbound`), fills
  the template variables from the order, sends via
  `InboxService.sendMessage` (templates bypass the 24h window), and records
  a `shopify_order_messages` row (message→order GID + shop domain).
  `MetaWebhookService` detects a quick-reply **button** reply whose
  `context` points to that sent message, derives confirm/cancel from the
  button label (contains "confirm"/"cancel", case-insensitive), and
  enqueues a `{kind:'tag'}` job — no module cycle (it only needs prisma +
  jobQueue, which it already has). The tag worker decrypts the Admin token
  and calls Shopify Admin GraphQL `tagsAdd` (native https, 10s). All
  best-effort: missing token / no phone / disabled config → logged, never
  throws, webhook still 200s. Module wiring: `ShopifyModule` imports
  `InboxModule` + `UsageMeteringModule` (one-way → no cycle).

The webhook RECEIVE direction (Shopify→us, Settings→Shopify tab) is distinct
from the outbound Webhooks page (us→client systems, `/api/webhooks/*`) —
opposite directions, unrelated modules, only the word "webhook" is shared.

## Single-process: Next.js mounted inside NestJS (deployment)

The PRD mandates one Node process at one origin (`apps.codentra.pk`). The
NestJS process serves the API **and** the prebuilt Next.js frontend:

- `backend/src/main.ts` creates an Express instance, registers a prelim
  middleware FIRST, then `NestFactory.create(AppModule, new
  ExpressAdapter(server))`. Because the middleware is on the Express stack
  before Nest wires its router, page requests never reach Nest's JSON 404.
- Prelim rule: if the path starts with a backend root
  (`/api /health /webhooks/meta /integrations /cron /socket.io /storage`) →
  `next()` (NestJS handles it); otherwise → Next.js request handler.
  NOTE: the root is `/webhooks/meta`, NOT `/webhooks` — the FE-3 Next page
  is `/webhooks` and must fall through to Next; only the Meta webhook is at
  the root (endpoint CRUD is under `/api/webhooks/*`). Backend roots must
  stay as specific as possible so they never shadow a frontend route.
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

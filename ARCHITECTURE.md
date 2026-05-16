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

# CLAUDE.md — CodesApp Master Context
> Read this file at the start of EVERY session before writing any code.

---

## Project
- **Product:** CodesApp — Multi-Tenant SaaS WhatsApp CRM & Automation Platform
- **Company:** Codentra
- **Domain:** apps.codentra.pk
- **Repo:** codesapp/

---

## Tech Stack
| Layer | Technology |
|---|---|
| Frontend | Next.js 14 (App Router), TypeScript, Tailwind CSS |
| Backend | Node.js, NestJS (modular), TypeScript |
| Database | MySQL 8, Prisma ORM |
| Job Queue | MySQL `jobs` table + polling worker (node-cache for in-process cache) |
| Real-time | Socket.io (@nestjs/platform-socket.io) |
| Auth | JWT (15m) + Refresh tokens (7d), bcrypt, optional 2FA |
| WhatsApp | Meta WhatsApp Cloud API + Graph API |
| Media | Node.js fs module, NestJS ServeStaticModule |
| Encryption | AES-256-GCM (for Meta tokens + webhook secrets at rest) |
| Hosting | Hostinger Business Shared — single Node.js process |
| CI/CD | GitHub Actions + SSH deploy |

---

## Folder Structure
```
codesapp/
├── frontend/                        # Next.js 14 app
│   └── src/
│       ├── middleware.ts                    # refresh-cookie gate for (app)/* routes
│       ├── app/
│       │   ├── (auth pages: login/register/verify-email/...)
│       │   └── (app)/                       # FE-1: protected route group
│       │       ├── layout.tsx               # auth gate + onboarding gate + SocketProvider + shell
│       │       ├── onboarding/page.tsx      # 5-step Cloud API wizard
│       │       ├── dashboard/page.tsx
│       │       └── inbox/
│       │           ├── layout.tsx           # conversation list panel + list socket events
│       │           ├── page.tsx             # desktop placeholder
│       │           └── [id]/page.tsx        # thread + composer + templates + notes
│       ├── components/
│       │   ├── toast.tsx                    # internal ToastProvider/useToast
│       │   └── app-shell/{sidebar,navbar}.tsx
│       ├── context/{auth-context,socket-context}.tsx
│       └── lib/{api,utils,inbox-types}.ts   # apiFetch + ApiError, formatting, types
├── backend/
│   ├── src/
│   │   ├── modules/
│   │   │   ├── auth/
│   │   │   ├── inbox/                       # Phase 2: REST + Socket.io + Meta webhook
│   │   │   │   ├── inbox.controller.ts
│   │   │   │   ├── inbox.service.ts
│   │   │   │   ├── inbox.gateway.ts
│   │   │   │   ├── meta-webhook.controller.ts
│   │   │   │   ├── meta-webhook.service.ts  # registers 'message' worker
│   │   │   │   ├── meta-client.service.ts   # Graph API wrapper
│   │   │   │   └── ws-jwt.guard.ts
│   │   │   ├── contacts/                    # Phase 2: CRUD + CSV import + segments
│   │   │   ├── templates/                   # Phase 2: in-app create + Meta sync
│   │   │   ├── bots/                        # Phase 2: keyword engine + actions
│   │   │   ├── broadcasts/                  # Phase 2: scheduling + 10 msg/sec throttle
│   │   │   ├── webhooks/                    # Phase 3: outbound webhooks (dispatcher + HMAC worker + logs)
│   │   │   ├── billing/                     # Phase 3: invoices + subscription + limit-warning + auto-invoice cron
│   │   │   ├── analytics/                   # Phase 3: $queryRaw dashboards (overview/funnel/agents/cost/usage)
│   │   │   ├── onboarding/                  # Phase 3: Cloud API wizard (5-step state machine)
│   │   │   ├── cron/                        # Phase 3: media cleanup + job orphan/purge maintenance
│   │   │   ├── super-admin/
│   │   │   ├── usage-metering/
│   │   │   ├── canned-replies/             # Inbox-Polish: saved quick-reply CRUD (tenant-scoped)
│   │   │   ├── ai/                          # AI Copilot: Anthropic client + suggest/rewrite/translate/summarize + KB + metering/billing
│   │   │   └── integrations/
│   │   │       └── shopify/                # …+ ShopifyOrdersController: GET /api/shopify/products + POST /api/shopify/orders (create-order from chat)
│   │   ├── common/
│   │   │   ├── guards/
│   │   │   │   ├── tenant.guard.ts
│   │   │   │   ├── plan.guard.ts
│   │   │   │   ├── cron.guard.ts
│   │   │   │   ├── roles.guard.ts
│   │   │   │   └── super-admin-ip.guard.ts
│   │   │   ├── services/
│   │   │   │   ├── encryption.service.ts
│   │   │   │   ├── cache.service.ts
│   │   │   │   ├── media.service.ts
│   │   │   │   └── job-queue.service.ts
│   │   │   ├── filters/
│   │   │   │   └── http-exception.filter.ts
│   │   │   ├── interceptors/
│   │   │   │   └── response.interceptor.ts
│   │   │   ├── decorators/
│   │   │   │   ├── plan-limit.decorator.ts
│   │   │   │   ├── current-user.decorator.ts
│   │   │   │   └── roles.decorator.ts
│   │   │   └── common.module.ts
│   │   ├── prisma/
│   │   │   ├── prisma.service.ts
│   │   │   └── tenant.middleware.ts
│   │   └── main.ts
│   ├── server.js                    # entry point for Hostinger
│   └── package.json
├── database/
│   ├── migrations/
│   └── seeders/
│       └── super-admin.seeder.ts
├── storage/
│   └── media/                       # local NVMe media files
├── CLAUDE.md
├── PROGRESS.md
├── ARCHITECTURE.md
├── SCHEMA.md
├── ERRORS.md
├── PROMPT_PLAYBOOK.md
└── .github/
    └── workflows/
        └── deploy.yml
```

---

## CRITICAL RULES — Never Violate These

### 1. Tenant Scoping
- EVERY database table has `company_id`
- EVERY query must include `where: { company_id }` 
- Use `TenantGuard` on all authenticated routes
- Use Prisma middleware to enforce tenant scope automatically
- Missing `company_id` on any query = critical security bug

### 2. Security Guards (apply in this order)
```
JwtAuthGuard → TenantGuard → PlanGuard → RouteHandler
```
- Super admin routes: `JwtAuthGuard → SuperAdminIpGuard → RouteHandler`
- Cron routes: `CronGuard → RouteHandler` (no JWT, uses X-Cron-Secret header)

### 3. Encryption
- NEVER store Meta tokens, Shopify tokens, or webhook secrets as plain text
- Always use `EncryptionService.encrypt()` before saving to DB
- Always use `EncryptionService.decrypt()` before using in API calls

### 4. Passwords
- Always hash with bcrypt, cost factor 12
- Never return `password_hash` in any API response
- Use `class-transformer` `@Exclude()` on password fields

### 5. API Responses
- Always use consistent response shape: `{ success, data, message, meta? }`
- Never expose internal error details in production responses
- Use NestJS `ExceptionFilter` for global error handling

### 6. MySQL Job Queue
- Max concurrency: 3 per worker (shared hosting memory limit)
- Failed jobs: retry 3x with exponential backoff (1m, 5m, 30m)
- Workers registered via `JobQueueService.registerWorker()` inside the NestJS process
- Poller runs every 2 seconds via `setInterval` in `JobQueueService.onModuleInit()`
- Uses `SELECT ... FOR UPDATE SKIP LOCKED` to prevent double-processing
- Queue names: `'broadcast'` | `'webhook'` | `'message'`

### 7. Media Files
- Save to: `/storage/media/{company_id}/{YYYY}/{MM}/{filename}`
- Set `media_expires_at = NOW() + 30 days` on every media message (`MEDIA_RETENTION_MS` in `common/utils/media-path.ts` — single source of truth, both inbound and outbound write sites read it)
- Never serve media without verifying `company_id` matches JWT

### 8. Socket.io
- Verify JWT on socket handshake via `WsJwtGuard`
- Room naming: `company:{company_id}`
- Never emit to a room without verifying the emitting user belongs to that company

### 9. Entry Point & Single-Process Hosting
- Hostinger entry point: `backend/server.js` → `dist/main`
- `package.json` start script: `"start": "node server.js"`
- No PM2, no cluster mode
- **ONE process serves BOTH frontend and backend at `apps.codentra.pk`.**
  NestJS (Express adapter) mounts the prebuilt Next.js app (`frontend/.next`)
  in the same process. Backend routes live under **`/api`** (global prefix);
  everything else is served by Next.
- **Excluded from the `/api` prefix (URLs unchanged, do NOT break these):**
  `/health`, `/webhooks/meta`, `/integrations/shopify/*`, `/cron`, `/cron/*`.
  Socket.io stays on `/socket.io`. These exclusions are why Meta/Shopify/
  UptimeRobot need no re-registration.
- Frontend calls the API at `${NEXT_PUBLIC_API_URL}/api` (origin + `/api`).
  `NEXT_PUBLIC_API_URL` is the ORIGIN only (no `/api` suffix in env).
- Hostinger deploys **ONLY the Output dir (`dist`)** + `node_modules` +
  `package.json` — NOT arbitrary `backend/` siblings. So the built frontend
  ships **inside** `dist`, at **`backend/dist/web/`**. Next mounts with
  `dir = <deploy>/dist/web`; react/next resolve from `backend/node_modules`.
  `frontend/.next` is a local artifact, NOT deployed.
- Rebuild order (REQUIRED — `nest build` has `deleteOutDir:true`):
  1. `cd backend && npm run build:local`  (compiles src → dist)
  2. `cd frontend && npx next build`       (frontend/.next)
  3. `cd backend && npm run sync:web`      (copies build → dist/web)
  Then commit `backend/dist` (incl. `dist/web`). Never rely on a host build.

### 10. Environment Variables
- All env vars read via NestJS `ConfigService`
- Never hardcode any secret, URL, or key
- Always validate required env vars on app startup

### 11. In-Process Cache (node-cache)
- Use `CacheService` (wraps node-cache) for short-lived in-process cache
- Namespaces: `subscription:{companyId}` (TTL 5m), `analytics:{companyId}:{hash}` (TTL 5m)
- Do NOT cache across processes — single process on Hostinger, this is fine

---

## Coding Conventions
- Language: TypeScript strict mode everywhere
- DTOs: use `class-validator` decorators on all DTOs
- Services: business logic lives in services, never in controllers
- Controllers: only handle HTTP, delegate everything to services
- Prisma: always use transactions for multi-table writes
- Errors: throw NestJS built-in exceptions (`NotFoundException`, `ForbiddenException` etc.)
- Naming: camelCase for variables/functions, PascalCase for classes, kebab-case for files

### Frontend conventions (FE-2a additions)
- Sidebar (`components/app-shell/sidebar.tsx`): **Contacts, Templates, Broadcasts, Bots** are enabled (live routes). Webhooks/Analytics/Billing/Settings remain disabled stubs (FE-3). Active-state matches nested routes (`/contacts/[id]` highlights Contacts; `/broadcasts/new` highlights Broadcasts).
- Super-admin area has a route-group layout `app/super-admin/layout.tsx`: dark chrome + nav (**Overview**, **Clients**, Logout). `/super-admin/login` renders bare (layout skips chrome + the token-presence gate for it). Each super-admin page still handles its own API-401 → redirect to `/super-admin/login` (single gate per page; the layout only does the token-presence check).
- Shared UI primitives live in `components/ui/modal.tsx`: `Modal` (full-screen on narrow, centered card ≥sm) and `ConfirmDialog`. Use these for all modals/confirmations — no new modal libs.
- Shared CRM TS types in `lib/crm-types.ts` (Contact, Segment, Template, ClientCompany, Paged…).
- CSV import column-mapping is done **client-side** (the backend importer accepts only a `file`, no mapping DTO) — see ARCHITECTURE.md.

### Runtime conventions (FE-2c hardening)
- Multi-tenant Meta webhooks = **Option B**: each tenant uses their own Meta app; callback URL is per-tenant `/{origin}/webhooks/meta/{companies.webhook_key}`. `webhook_key` + `webhook_verify_token` are auto-generated once (immutable); `webhook_app_secret_encrypted` is per-company (AES-GCM). All three fall back to platform `META_VERIFY_TOKEN`/`META_APP_SECRET` env when null (future Tech-Provider/Embedded-Signup path). Inbound still routed to a company by `phone_number_id`.
- WhatsApp media: stored on disk under `<cwd>/../storage/...`; `messages.media_url` holds the **web path** `/storage/media/...`; `main.ts` serves `/storage` via `express.static`. Any user-facing URL (API, socket, media, webhook callback) resolves from `window.location.origin` at **runtime** — never bake `NEXT_PUBLIC_*` (build is off-host).
- Root `/` → `/dashboard` (session-restoring), not `/login`. Super-admin session rehydrates via `POST /super-admin/auth/refresh`.
- Onboarding step endpoints are idempotent re-edits: token/app-secret optional on re-submit (blank = keep), step 4 pre-fills, verify token auto-generated.
- "Delete for everyone" is **not possible** via WhatsApp Cloud API — never offer it. Forward + delete-for-me remain deferred (FE-2e).

### Runtime conventions (FE-2d — outbound media + reply)
- **Outbound media** = a NEW path: `POST /inbox/conversations/:id/send-media` (multipart `file`, optional `caption`, `contextMessageId`) → `InboxService.sendMedia` → `MetaClientService.uploadMedia` (pre-upload, returns `mediaId`) → existing `/messages` send by id. Existing `sendMessage`/`/send` UNCHANGED except an optional `contextMessageId`. Media saved on disk same as inbound; `messages.media_url` = web path `/storage/media/...` (never absolute). Per-type mime/size caps in `MEDIA_RULES` (image 5MB / video 16MB / audio 10MB / document 10MB); controller `FileInterceptor` memory storage, 25MB hard cap. 24hr window still enforced for media (403 outside).
- **Reply with context** = `messages.context_message_id` (nullable self-FK). Outbound: best-effort resolve quoted msg's `meta_message_id` → Meta `context.message_id`; miss → send without context (warn, never throw). Inbound: Meta `context.id` → our msg by `meta_message_id` (best-effort). Fetch/socket payloads carry additive optional `context_message_id` + ONE-level-deep hydrated `context_message` ({id,direction,message_type,content,media_url}) — never recurse.

### Runtime conventions (Shell-Polish-A — branding + tones)
- `companies.logo_url` (VARCHAR(500) NULL, additive) holds the **web path** `/storage/branding/{companyId}/logo.{ext}` (deterministic filename — overwrites on re-upload, no orphans). Endpoints: `POST/DELETE /api/settings/company/logo` in `SettingsModule` (`@Controller('settings/company')`), guards `JwtAuthGuard → TenantGuard → RolesGuard @Roles('owner','admin')`, 2MB cap, mimes jpeg/png/webp/svg. Served by the existing `/storage` static mount — **no main.ts change**.
- `/auth/me` additively returns `company: { id, name, logo_url, activation_status }` (`company_name` → `name`). Existing callers unaffected. `AuthProvider` fetches `/auth/me` after token set (refresh + login) and merges `company`; `setCompanyLogo()` patches it in place (no reload).
- Notification tones are **device-local**: `localStorage.notification_tone_id` + bundled `public/sounds/*.wav` via `lib/notification-sound.ts`. `playNotification()` replaced the inline WebAudio beep in `(app)/layout.tsx`. No backend/env/migration/worker.

### Runtime conventions (Decimal serialization — MUST follow)
- The global `ClassSerializerInterceptor` decomposes Prisma `Decimal` into `{s,e,d}` → frontend renders **$0**. Any service method returning a Prisma `Decimal` (e.g. `subscriptions.monthly_price`/`setup_fee`, `invoices.amount`) MUST wrap its return in `numifyDecimals()` (`common/utils/decimal.ts`) before it leaves the service. Never delete the interceptor (it strips `password_hash`). See ERRORS "[Billing/Plans] all prices render $0".

### Runtime conventions (Admin-Console — super-admin Billing/Usage/Audit + impersonate)
- Frontend-only; built to the **pre-existing** super-admin endpoints (`GET /api/super-admin/{invoices,usage,audit-logs,clients/:id}`, `DELETE /api/super-admin/clients/:id`, `POST /api/super-admin/impersonate/:companyId`). No backend/schema/env change. Pages: `/super-admin/{billing,usage,audit}` + clients Details modal/Delete/Impersonate; nav extended. **Billing is view-only** (no super-admin mark-paid/generate — cron/tenant-billing owns it; don't add one). **Usage = current calendar-month only** (single array, no pagination). **Impersonation**: new-tab `sessionStorage.ca_impersonation_token` handoff; `auth-context` mount effect has ONE leading branch that consumes it, bootstraps via `/auth/me`, and skips `/auth/refresh` — never move this into the same tab or remove the early return (see ERRORS "[Admin-Console]").

### Runtime conventions (Shell-Polish-B — pin / clear / block)
- Two additive nullable cols `conversations.pinned_at` + `cleared_before` (migration `20260526000000_conversation_pin_clear`, one-time phpMyAdmin Import; pair with redeploy WITH `npm install`). Pin is **company-wide** (shared, no cap). `POST /api/inbox/conversations/:id/{pin,unpin,clear}` (`AuthGuard('jwt')+TenantGuard`). List orderBy is `pinned_at desc → last_message_at desc → updated_at desc`; `listMessages` filters `timestamp > cleared_before`. **No new/changed socket event** — pin/clear emit the existing `conversation.updated {conversationId}` (list already refetches on it). "Clear chat" is a **soft marker** (no row deletes, reversible, server-side so it syncs across devices). **Block reuses existing `contacts.status='blocked'` via `PATCH /api/contacts/:id`** — no new column/endpoint. UI: pin glyph on list rows + thread-header Pin/Unpin/Clear(ConfirmDialog)/Block(ConfirmDialog). No bubble/media/reply/template change.

### Runtime conventions (Shell-Polish-C — inbound URL OG previews)
- `GET /api/og?url=<encoded>` (`OgModule`, under `/api`, `AuthGuard('jwt')` only — NOT tenant-scoped). Native `https`/`dns`/`URL`/`crypto`, **no new dep**, **regex-only** OG parse. **SSRF-blocked** (scheme allowlist + private/loopback/link-local/ULA/multicast IPv4+IPv6 + `localhost*` + DNS-resolved-IP, **re-validated on every redirect hop**; 5s deadline, 1MB cap, max 3 hops, html-only). In-memory cache via `CacheService` (`og:` namespace, **24h on ok, 1h on fail**). **Never throws/5xxes** — 400 only for missing/malformed/blocked-scheme-or-host on the initial URL; everything else → 200 `{ ok:false }`. Frontend: shared `lib/url-detect.ts` (`extractUrls`/`autolinkText`, cap 3) + `OgPreviewCard` (module-level promise dedup, returns null on miss, no toast). Cards render **inbound text only**; outbound text autolinked but no card. No schema/socket/inbox/Meta/Shopify change.

### Runtime conventions (Billing-Lifecycle — activation-anchored billing + auto-suspend)
- Migration `20260527000000_billing_lifecycle` (one-time phpMyAdmin Import; redeploy **WITH `npm install`** — Prisma client regen for the new columns/model, else 5xx). Adds nullable `companies.{activated_at,suspended_at,grace_until,usage_limit_action}` + new `platform_settings(key,value,updated_at)` k/v table (seeded `usage_limit_action='block'`). Backfill sets `activated_at=created_at` for already-active companies.
- **Billing cycle is activation-anchored, NOT calendar-month.** `companies.activated_at` is set **once** on the FIRST super-admin activation (`SuperAdminService.activateClient`) and **never moved on reactivation** (cycle must not drift). `InvoiceGeneratorService.generateDueInvoices()` bills fixed 30-day cycles from that anchor; cycle 0 = activation instant (first invoice raised immediately, prepaid). Idempotency = unique `invoice_number` `INV-{companyId}-{cycleStartYYYYMMDD}` (NOT the old `period`-based check — 30-day cycles can collide within one `YYYY-MM`). `due_date = issue + 7d`.
- **Cron schedule changed: `/cron/billing/auto-invoice` must run DAILY** (was monthly/1st-of-month — that gate is removed). New sibling **`GET /cron/billing/enforce`** (also daily, `CronGuard`): `pending`→`overdue` past `due_date`, then suspend companies overdue ≥3d unless `grace_until` is in the future (sets `activation_status='suspended'` + `suspended_at`). Both under `/cron` (excluded from `/api`).
- **Reactivation:** `BillingService.markPaid` auto-reactivates a company that was *cron-suspended* (`suspended_at` set) once it has **no** remaining `pending|overdue` invoices. A super-admin manual suspend (no `suspended_at`) is NOT auto-lifted. Super-admin `PATCH /api/super-admin/clients/:id/grace {until}` sets `grace_until` (future → also reactivates a cron-suspended company so they get access during the extension); `PATCH .../activate` clears `suspended_at`.
- **Usage-limit policy is super-admin controlled.** `PlanGuard` at 100% resolves `companies.usage_limit_action` (per-company override) **`??` platform default** (`PlatformSettingService`, key `usage_limit_action`, 5m node-cache). `block` = legacy 403; `warn_only` = let the request through (the 80% `subscription.limit.warning` webhook still owns notification — PlanGuard does not dispatch). Endpoints: `GET|PATCH /api/super-admin/settings` (platform default), `PATCH /api/super-admin/clients/:id/usage-limit-action {action:'block'|'warn_only'|null}` (null = clear override). `PlatformSettingService` lives in the `@Global` `CommonModule`.
- **Suspended-tenant UX:** `GET /api/billing/account-status` is **`AuthGuard('jwt')` ONLY — deliberately NOT `TenantGuard`'d** (TenantGuard 403s every tenant route for a suspended company; this one must still answer so the owner learns *why*). Returns `{activationStatus,suspendedForBilling,suspendedAt,graceUntil,unpaidInvoices}`. `(app)/layout.tsx` has a **billing gate that runs before the onboarding gate**, fail-open on error; `suspendedForBilling` → renders `<BillingBlocked>` (read-only balance + sign-out; no payment gateway exists, settlement is out-of-band). Never move this endpoint under TenantGuard.

### Runtime conventions (Inbox-Polish — socket refresh, unread tab, swipe, lightbox, quick replies, Shopify create-order)
- **App-shell gate runs ONCE per session (`(app)/layout.tsx`) — critical.** The onboarding gate must NOT depend on `pathname`. It uses `onboardingCheckedRef` (gate once) + `pathnameRef` (read current path without re-triggering); deps are `[loading,user,billing,router]`. The old version listed `pathname` and reset `gateState` to `'checking'` on every navigation, which returned a full-screen spinner and UNMOUNTED the whole shell — `SocketProvider` + the conversation list included — on every chat open. That single bug caused the per-chat "Reconnecting" flash, the flicker, AND the Unread filter snapping back to "All". **Never re-introduce a `pathname` dependency on that gate or reset `gateState` on navigation** — it tears down the socket + list and makes opening a chat feel like a full page load.
- **Socket auto-refresh:** `socket-context.tsx` `auth` callback is **async** — it decodes the JWT `exp` and calls `/auth/refresh` (single-flight `refreshSocketToken`) before a (re)connect when the token is expiring (≤60s) or expired; `connect_error` also triggers one refresh then a reconnect. Status shows `connecting` (never `disconnected`) while recovering. Do NOT revert the auth callback to the old synchronous `cb({ token: getAccessToken() })`.
- **Unread tab (`inbox/layout.tsx`):** under `status==='unread'`, `displayRows` keeps a conversation visible while it's the open one (`id === activeId`) even after it's marked read — WhatsApp sticky behavior; it drops out only when the next unread chat opens. `load()` re-inserts the cached active row (server's unread filter excludes a read chat). Active tab label shows `unread (N)` from the server total. `activeIdRef` keeps `load()`/realtime handlers from depending on `activeId` (would refetch the whole list on every chat open).
- **Mobile thread header:** the ~9 action controls are desktop-only (`hidden md:flex`); on mobile they collapse into a `MoreVertical` kebab dropdown (`menuOpen`, outside-click + route-change close). Keeps the header from overflowing the `overflow-hidden` shell off-screen. Any NEW header action must be added to BOTH the desktop row and the mobile menu. **Shell height is `h-[100dvh]` (NOT `h-screen`/100vh)** — on mobile, 100vh includes the area behind the browser chrome and pushed the composer off-screen; dvh tracks the visible viewport so the input stays pinned.
- **Swipe-to-reply** is touch-only (`onTouchStart/Move/End` in `Bubble`, horizontal-dominant, trigger ≥56px) so desktop hover-reply is unaffected. **Image lightbox** = in-app overlay (`ImageLightbox`, Esc/backdrop/X close, body-scroll lock) — never opens a new tab.
- **Canned/quick replies:** new `canned_replies` table + `CannedRepliesModule` → `/api/canned-replies` CRUD, guards `AuthGuard('jwt') + TenantGuard`, tenant-scoped (mirrors SettingsModule). Company-wide, no Meta involvement (plain text inserted client-side). Two ways to use them: (a) composer `+` menu (**Quick reply** → `QuickReplyPicker`; also doubles as add/edit/delete management); (b) **slash autocomplete** — typing a single `/token` (no space) in the composer pops an inline list filtered by title/body, navigable with ↑/↓/Enter/Esc (`showSlash`/`slashIdx`/`slashMatches` in `[id]/page.tsx`); selecting replaces the `/token` with the body. Thread page fetches the canned list (`loadCanned`) and the picker fires `onChanged` to refresh it. Only shown inside the 24h window (composer hidden outside it).
- **Composer `+` menu** is the single entry point for Quick reply / Send template / **Create Shopify order** (the Shopify item uses the real colored logo `components/icons/shopify-icon.tsx`, gated on a once-per-mount `/settings/shopify` `adminTokenSet` fetch → `shopifyReady`). There is NO separate header button.
- **Shopify order (agent-driven, `ShopifyOrdersController` `@Controller('shopify')` under `/api`, guards `AuthGuard('jwt')+TenantGuard`):** `GET /api/shopify/products?query=` (`searchProducts` — **requires the Admin token's `read_products` scope**; returns flattened variants w/ live price) + `POST /api/shopify/orders` (`createOrder`). Order = `draftOrderCreate` → `draftOrderComplete(paymentPending: !prepaid)` (COD → unpaid; **prepaid → marked paid**). Line items are **variant-based** (`{variantId,quantity}`, price from the store); a `{title,quantity,originalUnitPrice}` custom line is the fallback. Accepts `countryCode` (ISO-2, fixes the wrong default province), `tags` (frontend auto-adds the assigned agent's name), `email`. Resolution via `requireAdminApi` (throws clean 4xx/5xx, vs the worker's null-returning `resolveShopifyApi`). The Shopify **orders/create webhook** flow now also captures `order.email`/`customer.email` onto the contact. Frontend `create-order-modal.tsx`: product search, qty stepper, country `<select>` (`lib/countries.ts`, default PK), tag chips, COD/Prepaid toggle.
- **Shopify shipping rates (Phase 2):** `POST /api/shopify/shipping-rates` (`getShippingRates`) runs `draftOrderCalculate(input)` and returns the store's `availableShippingRates` (`{handle,title,amount,currencyCode}`) for the cart + destination; `[]` when the store offers none (not an error). `createOrder` accepts an optional `shippingLine {title,price}` and sets `input.shippingLine` (sent as title+price — the exact rate the agent picked — not the calculated handle, for cross-version reliability). `buildDraftBase` builds the shared line-items + shipping-address input for both calc and create. Frontend modal auto-recalculates rates (debounced) when items/country/city/address change and shows a radio list (+ "No shipping"); the chosen rate flows into `shippingLine`. `draftOrderCalculate` uses the same `write_draft_orders` access the order create already needs.
- **Shopify order tag flow (confirm/cancel/pending) — bug fix + additions:** the confirm/cancel decision job is enqueued (`meta-webhook.service.ts`) by matching `shopifyOrderMessage` on **`message_id + company_id` only — NOT `status`**. The old `status:'pending'` filter blocked the mind-change re-tag (after the first decision the row is no longer 'pending'). `processOrderTag` is idempotent (removes pending + opposite, adds chosen; touches only our 3 tags), so re-enqueuing is safe. **Undeliverable → hardcoded `⚠ NO WhatsApp` tag:** when a failed delivery status carries a no-WhatsApp/undeliverable error (Meta `131026`, or title/message matches `undeliverable`/`not a whatsapp`) AND the failed message is an order template, a `noWhatsapp` shopify job adds `NO_WHATSAPP_TAG` (constant, not client-configurable) and sets the row status `'undeliverable'` so the pending job no-ops. **Order create extras:** per-line + order-level manual discounts (`appliedDiscount` PERCENTAGE/FIXED_AMOUNT via `mapDiscount`). NO `customAttributes` are set (the earlier `Source`/`Payment method` attributes were reverted — they cluttered the order's Additional details; COD just stays the draft order's default manual payment).
- **`shopifyTagMutate` does TWO separate sequential requests (remove then add), each declaring only the variable it uses** (`runTagOp`). The previous single combined `tagsAdd`+`tagsRemove` mutation always declared `$add`+`$rem`, so an add-only call (pending / `⚠ NO WhatsApp`) shipped an unused variable → Shopify rejects unused-variable mutations → those tags silently never applied; the combined request also didn't reliably remove on the flip. **Do NOT recombine them into one mutation.**
- **Shopify customer check + create:** `GET /api/shopify/customers?phone=&email=` (`searchCustomer`, **needs `read_customers`**; matches phone OR email, tries phone with and without `+`) + `POST /api/shopify/customers` (`createCustomer`, **needs `write_customers`**; phone normalized to `+E.164`). `createOrder` links a found/created customer via `input.purchasingEntity = { customerId }` so the order isn't a "no customer" order. Frontend modal auto-searches on phone/email change (debounced) → links the first match, or shows a **Create customer** button when none (check-then-create, no duplicates). Email is prefilled from the contact (`contactEmail`).

### Runtime conventions (Super-admin redesign — overrides, notifier, timezone, invoice PDF, Resume access)
- **Two migrations in this batch — both one-time phpMyAdmin Import, pair with redeploy WITH `npm install` (Prisma client regen, else 5xx):** `20260531000000_company_overrides_and_warnings` adds `companies.{contact_limit_override,template_limit_override,user_limit_override} INT NULL` + `usage_metering.thresholds_notified JSON NULL`. `20260601000000_company_timezone` adds `companies.timezone VARCHAR(64) NULL`.
- **Effective-limit resolution = single source of truth.** `common/utils/effective-limits.ts` returns `override ?? subscription.<field>`. **Consumed by `PlanGuard` (100% enforce), `LimitNotifierService` (90/99/100 fire), `LimitWarningService` (legacy 80% webhook), and `SuperAdminService.getClientDetail` (UI).** Never inline that ternary anywhere else. `PATCH /api/super-admin/clients/:id/limits {contact_limit?,template_limit?,user_limit?}` saves overrides (null clears that field) and invalidates the 5m PlanGuard cache.
- **Usage notifications (90/99/100%)** fire once per `period:dim:threshold` via the `usage_metering.thresholds_notified` JSON ledger (e.g. `["contacts:90","templates:99"]`). `LimitNotifierService.evaluate` runs after every `UsageMeteringService.increment`, alongside the legacy 80% `LimitWarningService.check`. **Scope cut (intentional) — only `contacts` + `templates` are evaluated** (the two metered + capped dimensions); `users` is a live count, not per-period. Each threshold emits socket `usage.warning {dim,threshold,pct,current,limit,severity,period}`, sends an owner email via `MailService`, and fires outbound webhook `subscription.limit.warning` (90/99) / `subscription.limit.reached` (100). **All paths are non-throwing** so a notification failure never blocks the metered op.
- **`GET /api/billing/usage-warnings`** (`AuthGuard('jwt')+TenantGuard`) hydrates the in-app banner (`components/usage-warning-banner.tsx`, sticky above the navbar in `(app)/layout.tsx`, per-session sessionStorage-dismissed) + the navbar pulsing `AlertTriangle` chip (`warn`=amber static, `critical`=red pulsing). Returns currently-active warnings only.
- **`MailService` (`common/services/mail.service.ts`)** is the SHARED never-throws Resend-or-SMTP sender used by `LimitNotifierService` (warnings + suspension). `AuthService` keeps its own inline mailer for verification emails — too critical to refactor in the same commit. Suspension email fires from (a) `SuperAdminService.suspendClient` on `active→suspended` only (no re-spam on double-click), (b) `BillingService.enforceCron` per auto-suspended company per run.
- **Per-tenant timezone is GLOBAL on the frontend, not per-call.** `companies.timezone` (IANA), `PATCH /api/auth/company/timezone {timezone:string|null}` (owner/admin only, validated via `Intl`). `lib/utils.ts` holds module-level `activeTimeZone`; `AuthProvider` calls `setActiveTimeZone(me.company?.timezone ?? null)` after `/auth/me` (login + refresh + impersonate). `fmtDate`/`fmtDateTime` build `Intl.DateTimeFormat` with `timeZone: activeTimeZone`. **Never pass `tz` into individual `fmtDate` calls** — the global hook keeps the entire app in the tenant's clock.
- **Invoice PDF = client-side `html2pdf.js`, not server-side.** Won't run puppeteer on Hostinger shared. Print route `/billing/invoice/[id]/print` (tenant-only, under `(app)/`) renders the styled DOM and `html2pdf.js@^0.10.3` downloads a real `.pdf` — **no print dialog, no color stripping**. Trade-off: text is rasterized (not selectable in the PDF) — acceptable for invoices. Super-admin reaches the PDF via the existing Impersonate flow; do NOT duplicate the route.
- **Legacy-invoice rewrite has TWO entry points.** CLI: `npx ts-node backend/scripts/rewrite-legacy-invoices.ts` (dry-run by default; `--apply`, `--company=N`). Panel: `POST /api/super-admin/billing/invoices/rewrite-legacy {dryRun?,companyId?}` for Hostinger Business (no SSH). Both behave identically: recompute `invoice_number`/`period`/`due_date`/`description` + add `cycle_index`/`cycle_start` to `plan_snapshot`; NEVER touch `status`/`paid_at`/`amount`; skip companies without `activated_at` + skip any collisions with canonical numbers.
- **`scripts/` is EXCLUDED from `tsconfig.build.json`.** Including it shifts nest's `rootDir` → emits `dist/src/main.js` instead of `dist/main.js` and breaks `server.js`. Don't remove the exclude.
- **`useRouter()` is NEVER in a `useEffect` deps array** (Next 14.2.x wrapper identity isn't stable — fires the effect on every render). Call `router.replace/router.push` from inside the effect body without listing the wrapper in deps. Was a cause of the super-admin loader flicker.
- **3-file import cycle pattern: `BillingModule ↔ InboxModule ↔ UsageMeteringModule ↔ BillingModule`.** `forwardRef` alone defers Nest DI but NOT the JS top-level import. Use a **lazy `require()` inside the `forwardRef` callback** in `billing.module.ts` (see the CYCLE WARNING comment there). Don't restructure the imports — the lazy require IS the fix.
- **Resume-access action (suspended-only)** on `/super-admin/clients/[id]` is the supported one-click recovery: iterates pending/overdue invoices → `POST /super-admin/billing/invoices/:id/mark-paid` for each → `PATCH /super-admin/clients/:id/activate`. **No transaction available across these endpoints — each step is independent**; toast summarizes counts. Audit log entries flow automatically from the existing endpoints (don't add new audit calls). Suspension UX itself = strict (`BillingBlocked` only); don't add read-only-inbox-during-suspension.

### Runtime conventions (June-2026 batch — broadcast builder, PWA/notifications, inbox media/emoji/audio)
- **Broadcast campaign builder.** Additive backend (no schema): `POST /broadcasts/preview-audience` (count + 10-row sample), `POST /broadcasts/test-send` (one real template msg; **never touches counters**), `POST /broadcasts/:id/duplicate`. Audience persists one of `{all:true}` | `{contactIds}` | `{segmentId}` | `{filter}`; `all` resolves to all `status:'active'` contacts. **Per-recipient personalization:** a `variables[n]` value is a literal OR a contact token `{{contact.name|phone|email}}` / `{{contact.custom.<key>}}`, resolved per contact at send time by **`BroadcastsService.buildTemplateComponents(variables, contact)`** — the SINGLE resolver, used by both `broadcast.worker` and `testSend`; don't inline token logic elsewhere. Empty-resolved field tokens send empty (Meta may fail that one recipient) — by design. Frontend `/broadcasts/new` is a 4-step wizard (`lib/broadcast-utils.ts` parses `{{n}}`; `components/broadcasts/{audience-builder(4 modes incl. ContactPicker),contact-picker,template-preview}.tsx`).
- **PWA.** `public/manifest.webmanifest` (+ root-layout `metadata.manifest`/`viewport.themeColor`/`appleWebApp`) + `public/sw.js`. Both live in `public/` → synced to `dist/web/public` by `sync:web`, served by Next at root (NOT backend roots). `sw.js` does install/activate/claim, a **no-op fetch** (keeps installability — do NOT add offline caching; the app needs the network + socket), and `notificationclick` (focus/open + navigate via `postMessage`).
- **Desktop notifications (while app open only — NO Web Push).** `lib/notify.ts` shows via the SW registration (`tag: conv:{id}` coalesces, running "N new messages" count, inline `Reply`/`Open` actions). `(app)/layout` fires on `message.received` ONLY when `!document.hasFocus()` and not on that thread; clears on open + `message.read.bulk`. **Inline reply path:** `sw.js` mints a token via the httpOnly cookie (`POST /api/auth/refresh`) → `POST /api/inbox/conversations/:id/send` — the access token is NEVER stored (keeps the memory-only model). `meta-webhook` `message.received` emit carries `contactName` for the title. Closed-app push is deferred (needs VAPID + per-device subscription storage + server push).
- **Inbox composer/media.** Paste (`onPaste`) + drag-drop (root-level handlers + overlay, `dragDepth` ref, guarded to the 24h window) both stage a file through the existing `validateFile` + `/send-media`. `components/inbox/emoji-picker.tsx` is dependency-free (curated unicode) — inserts plain text at the cursor. **Inbound stickers** render via `Bubble` (`sticker` in `isMedia`, webp `media_url` as `<img>`); the backend already downloads them. **Voice notes** use `components/inbox/audio-message.tsx` (custom waveform scrubber) NOT `<audio controls>`; a module-level audio bus enforces single-playback + auto-advances ONLY to a **directly-consecutive** audio note (thread `nextAudioMap` → `nextAudioId` prop; bus `playById`).
- **Shopify Create-order modal (`components/inbox/create-order-modal.tsx`).** Section order is fixed by request: **Items → Shipping → Order summary → Payment → Customer details → Tags → Notes**. Address + City are required (`canSubmit`). Per-item discount is collapsed behind an inline `%` icon (`openDisc` map). The order summary computes per-line + order-level discounts and is the ONLY place the Total shows (don't re-add a Total under shipping). Shipping rates are effect-driven (recalc on items/country/city/address change) so customer-details sitting below shipping is fine.

### Runtime conventions (AI Copilot — Phase 1, suggest-only)
- **Module `modules/ai/`** (guards `AuthGuard('jwt') + TenantGuard`; settings PATCH adds `RolesGuard @Roles('owner','admin')`). Endpoints under `/api/ai`: `POST suggest-reply|summarize|rewrite|translate`, `GET usage`, `GET/POST/PATCH/DELETE knowledge`, `GET/PATCH settings`. **Suggest-only** — every result is returned as text for the agent to review/edit; nothing auto-sends.
- **ONE platform Anthropic key** (`ANTHROPIC_API_KEY` via `ConfigService`; NOT per-tenant, NOT encrypted — it's ours). `AnthropicClientService` is the only caller of `@anthropic-ai/sdk`; it throws **503** when the key is missing (rest of app unaffected). Two tiers in `ai.constants.ts`: `fast` = Haiku (`claude-haiku-4-5-20251001`) for suggest/rewrite/translate, `smart` = Sonnet (`claude-sonnet-4-6`) for summarize. Prompt-caching breakpoint on the KB system block.
- **NEVER hold a DB connection across the model call** (critical with `connection_limit=1`): `AiService.run` loads context → `assertAllowed` → acquires a **per-company in-process concurrency semaphore (max 3)** (429 if exceeded) → calls Anthropic (no DB) → records metering. Interactive/synchronous (non-streaming v1).
- **Tenant isolation is absolute** — every context query (`loadTranscript`/`loadKnowledge`/`loadCompany`) is scoped to the caller's `company_id`. Transcript respects `conversations.cleared_before`.
- **Metering + post-paid billing.** `AiMeteringService.recordUsage` writes the authoritative per-call ledger `ai_usage_log` AND bumps the monthly rollup `usage_metering.ai_{requests,input_tokens,output_tokens,cost_micros}`. **Cost stored RAW in micro-dollars** (token costs are sub-cent); markup (`platform_settings.ai_price_multiplier`, seeded `1.5`) applied at billing/display only. `InvoiceGeneratorService` bills the **previous** 30-day cycle's AI cost (`sumCostMicros` over `[cycleStart(n-1), cycleStart(n))` × multiplier) folded into the cycle-n invoice `amount` + `plan_snapshot.ai_usage` + description; cycle 0 has no AI line.
- **Gating** = `assertAllowed`: effective AI-on = `subscription.ai_enabled && companies.ai_enabled`; then a monthly spend cap (`companies.ai_monthly_cap_cents ?? platform_settings.ai_default_monthly_cap_cents`, 0 = unlimited) → 403 when reached. `subscriptions.ai_enabled` is edited in the super-admin Plans editor (whitelisted in `mapPlanData`). `GET /billing/subscription` returns `features.aiEnabled` so the inbox/Settings UI hides AI when off (mirrors `webhookEnabled`).
- **Frontend.** `lib/ai.ts` (typed calls). Inbox: `components/inbox/ai-copilot.tsx` — a violet ✨ button in the composer (within the 24h window), gated on `features.aiEnabled` fetched once per mount; suggest/rewrite/translate drop into the composer textarea, summarize opens a Modal. Settings → **AI tab** (owner/admin only): enable toggle, **auto-reply toggle**, brand-voice, default language, self-imposed monthly cap, this-month usage card, and the **knowledge-base editor**.
- **Provider abstraction (Anthropic ⇄ OpenAI).** `LlmService` is the provider-agnostic gateway; `AnthropicProvider` + `OpenAiProvider` implement `LlmProvider` (`modules/ai/providers/`). Active provider = `platform_settings.ai_provider` ('anthropic'|'openai', super-admin → Platform settings), resolved+cached per call. `PROVIDER_MODELS` in `ai.constants.ts` holds per-provider model ids + per-token micro-dollar prices (single source of truth); metering prices by the resolved provider+tier. Each provider's key is its own env (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`); the gateway 503s only if the ACTIVE provider's key is missing. Adding a 3rd provider = new `LlmProvider` impl + `PROVIDER_MODELS` entry + selector branch — nothing else changes.
- **Phase 2 — auto-responder (fully automated, confidence-gated).** Per-company toggle `companies.ai_autoreply_enabled` (Settings → AI). Orchestration lives in **BotsModule** (`AiAutoReplyService`), NOT AiModule — AiModule must stay free of InboxModule (else `BillingModule → AiModule → InboxModule → UsageMeteringModule → BillingModule` cycle). It runs in a dedicated **`ai` job queue** (concurrency 2, registered in `AiAutoReplyService.onModuleInit`) so the slow model call never holds a `message`-worker slot. `BotEngineService.runForMessage` enqueues an `ai` job when: inbound, NO keyword bot produced a reply (`reply_template`/`send_text`/`ai_reply`), `ai_autoreply_enabled`, and no human is assigned. There's also an explicit **`ai_reply` bot action** (enqueues the same job). **`AiAutoReplyService` is a GATE ONLY — it generates no replies.** It resolves the effective auto-reply state (explicit per-chat `false` always wins; otherwise workspace toggle OR per-chat `true`; `job.force` overrides), checks the platform rollout flag, and enqueues an `ai-agent` job (serialKey `conv:ai-agent:{id}`, which MUST match `AiAgentService.enqueue`). The single brain is `AiAgentService`. Auto-reply is metered like everything else (feature `autoreply`).
- **Per-conversation auto-pilot override (`conversations.ai_autoreply` Boolean? — migration `20260605000000_conversation_ai_autoreply`, redeploy WITH `npm install`).** `null` = follow workspace `companies.ai_autoreply_enabled`; `true` = force AI auto-reply on this chat; `false` = mute. `BotEngineService.runForMessage` resolves `effective = convo.ai_autoreply ?? company.ai_autoreply_enabled`; a chat with `ai_autoreply === true` is **`force`d** (enqueues even if a human is assigned). **`AutoReplyJob.force`** (set by an explicit `ai_reply` bot action AND by per-chat `true`) makes the worker skip its "human assigned → return" guard — this is the fix for "ai_reply + assign_agent in the same bot" silently never replying. On handoff the worker sets `ai_autoreply = false` (stops re-trigger loops). Toggle endpoint `POST /api/inbox/conversations/:id/ai-autoreply {mode:'on'|'off'|'default'}` (`AuthGuard('jwt')+TenantGuard`) reuses the `conversation.updated` socket event. UI: toggle in the composer ✨ menu (`ai-copilot.tsx`), `Bot` "Auto-pilot" badge in the thread header + a `Bot` glyph on inbox list rows.
- **Settings access control:** `SettingsShopifyController` is now `@Roles('owner','admin')` on every method (agents could previously see/edit Shopify credentials) EXCEPT a new agent-readable `GET /api/settings/shopify/ready` → `{adminTokenSet}` (no `@Roles`) which the inbox composer uses to gate the Create-order action — so agents can still create orders but not touch credentials. Frontend: Settings **Shopify tab is owner/admin-only**; the **AI tab is visible to everyone but agents see ONLY the knowledge-base editor** (`AiTab({canManage})` — settings/usage/plan-gate are admin-only; KB CRUD `/api/ai/knowledge` was always `AuthGuard+TenantGuard`, agent-allowed).

### Runtime conventions (AI simplification, Sept-2026 — READ BEFORE TOUCHING THE AI)
- **ONE brain, no fallback.** The legacy "two-brain" flow was DELETED: `AiService.autoReplyDecision`/`parseDecision`, `AiAutoOrderService` and the whole **`ai-order` job queue** are gone. Every auto-reply goes `BotEngine → 'ai' queue (AiAutoReplyService = gate only) → 'ai-agent' queue (AiAgentService = triage + specialists + tools)`. **Do NOT reintroduce a second reply path** — the two implementations drifted, which is exactly why one was removed. Any pre-existing `ai-order` rows left in the `jobs` table have no worker and will sit pending; purge them once (`DELETE FROM jobs WHERE queue='ai-order'`).
- **The enterprise-hardening layer was DELETED in full** — all 7 guards (Compliance Guard, Escalation Signals/fraud+frustration, Tool Validation, Multimodal Image Routing, Handoff SLA, Conversation State Machine, Response Confidence) AND all 7 kill switches, including their services, specs, `feature_overrides` registry entries (`OVERRIDABLE_FLAGS`), super-admin endpoints (`clients/:id/features`, `hardening-defaults`), the `/cron/handoffs/sla-sweep` route, and both super-admin UI components. They were flag-gated OFF and never ran. **`companies.feature_overrides` and the `platform_settings` guard keys remain in the DB, unread — no migration was needed and none should be written.** Drop the `/cron/handoffs/sla-sweep` entry from `/etc/cron.d/codesapp` (it now 404s harmlessly).
- **`ai_agent_company_ids` is now the ONE platform brake**, editable at super-admin → Settings → *AI Agent rollout*. `'*'` (default) = every tenant, `''` = AI replies OFF platform-wide, or a CSV of company ids. Because there is no fallback brain, a tenant excluded here gets **no AI replies at all** even with their own AI toggles on.
- **`ObservabilityService` survives** (it powers `/api/ai/metrics`, `/api/ai/audit/:conversationId` and the super-admin `clients/:id/metrics` mirror), minus the guard-derived counters. Remaining event types: `conversation.handoff`, `order.created`, `order.duplicate_prevented`, `tool.failed`, `image.routed`. `EventStoreService` also survives (engagement + order-idempotency depend on it).
- **"Why this reply?"** (`components/inbox/ai-audit-modal.tsx`) renders the per-conversation event timeline from the pre-existing `GET /api/ai/audit/:conversationId`. It lives in the thread header's overflow menu — present in **BOTH** the desktop (`deskMenuOpen`) and mobile (`menuOpen`) menus, per the header rule below.
- **Super-admin → Usage** shows per-tenant **AI calls** + **AI billed** (raw micro-dollar cost × `ai_price_multiplier`, raw cost in the cell's tooltip) so AI spend is visible without a DB query.

### Runtime conventions (AI RAG — products + policies retrieval, June-2026)
- **`ai_knowledge_chunks` table** (migrations `20260608000000_ai_rag_chunks` + `20260609000000_ai_chunk_embedding_text`; one-time phpMyAdmin Import, redeploy WITH `npm install` for Prisma client regen). One embedded chunk per product / store policy per tenant. **`embedding` is base64 of the Float32 vector stored as `LONGTEXT` — NOT Prisma `Bytes`/`LONGBLOB`** (a raw Buffer trips Prisma's "unexpected end of hex escape"). Cosine similarity is computed in-process (corpus is small per tenant; no vector DB).
- **`EmbeddingService`** = OpenAI `text-embedding-3-small` (1536d), reads `OPENAI_API_KEY` **directly** (independent of the active text provider — Anthropic has no embeddings API), fail-safe (null on missing key/error). **`AiRagService`**: `indexSource` (re-embed + replace a `source_type`, **slice THEN `sanitizeText` to strip lone surrogates** — an emoji cut in half breaks Prisma param serialization — each INSERT in try/catch so one odd row can't abort the sync, **raw `$executeRaw`/`$queryRaw`** so it's immune to a stale Prisma client/column mapping), `retrieve` (embed query → cosine top-K within `RAG_CHAR_BUDGET` → compact string; 5-min node-cache of the company's vectors), `status`, `clear`.
- **`AiService.buildKnowledge(companyId, query)`** = manual KB (small, always injected) + RAG-retrieved product/policy chunks for the customer's last ~3 inbound messages (`loadTranscript` returns `customerQuery`). Used by `suggest_reply`, `draft_order`, and the autonomous agent. **Fail-safe:** no embeddings key / no chunks → manual KB only (exactly the pre-RAG behaviour) — RAG NEVER breaks a reply. Don't reintroduce whole-catalogue injection.
- **Shopify `syncKnowledge` runs as a BACKGROUND JOB** — `POST /api/shopify/sync-knowledge` → `requestKnowledgeSync` (validates Admin token, enqueues `kind:'syncKnowledge'` on the `shopify` queue, returns `{started:true}`). A full sync (paginated fetch + embeddings + 100+ inserts) exceeds Hostinger's HTTP request timeout — **never run it inline.** The worker indexes a rich chunk per product (desc, all variants, price, stock, tags, link, **metafields incl. `rich_text_field` e.g. composition**) + one per policy (`shop { shopPolicies { type title body } }`, a **separate try/catch'd** query — policies may need `read_legal_policies`), then deletes the legacy `'Shopify Product Catalogue (auto-synced)'` manual KB entry.
- **Tenant confirmation:** `GET /api/shopify/knowledge-status` → `{configured,products,policies,total,lastSyncedAt}`; green status banner in Settings → AI knowledge base (polls ~90s after a sync). Only `status:active` products are indexed (draft/archived excluded by design).
- **OPS — every deploy:** Hostinger auto-deploy copies files but does **NOT restart the Node process**. Always hPanel → Node.js → Dashboard → **Running ▾ → Restart** after a deploy, else the old code keeps running.

### Frontend conventions (FE-1)
- All API calls go through `apiFetch<T>()` / `apiFetchEnvelope<T>()` in `lib/api.ts` — unwraps the `{success,data,message,meta}` envelope, throws `ApiError` with `status` + `userMessage`. Never call axios directly in components.
- Error → UX mapping: 401 handled by the axios interceptor (refresh→retry→/login); 412 → redirect to `/onboarding`; 403 → toast `message`; 5xx → toast generic + `console.error`.
- Toast: internal `ToastProvider` from `components/toast.tsx` (no external toast lib). `useToast()` → `success/error/info`.
- Forms: `react-hook-form` + `zod` (`@hookform/resolvers/zod`).
- Styling: Tailwind only. Icons: `lucide-react`. Charts: `recharts` only.
- Access token stays in JS memory (`lib/api.ts`); never localStorage/sessionStorage/JS-cookies.
- Socket: `useSocket()` from `context/socket-context.tsx`; `auth:{token}`, transports `['websocket','polling']`. Scoped to `(app)` only.
- Timestamps: backend sends UTC ISO; render via `Intl` helpers in `lib/utils.ts`.

---

## Environment Variables Reference
```env
NODE_ENV=
APP_URL=https://apps.codentra.pk
DATABASE_URL=
JWT_SECRET=
JWT_REFRESH_SECRET=
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
META_APP_ID=
META_APP_SECRET=
META_VERIFY_TOKEN=
META_PHONE_NUMBER_ID=
META_WABA_ID=
META_GRAPH_VERSION=v19.0
META_CONVERSATION_FLAT_USD=0.005
SHOPIFY_CLIENT_ID=
SHOPIFY_CLIENT_SECRET=
SHOPIFY_WEBHOOK_SECRET=
ENCRYPTION_KEY=
CRON_SECRET=
SUPER_ADMIN_EMAIL=
SUPER_ADMIN_PASSWORD=
SUPER_ADMIN_IP_WHITELIST=
SMTP_HOST=
SMTP_PORT=
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
```

---

## How to Run
```bash
# Install
cd backend && npm install
cd frontend && npm install

# Database
npx prisma migrate dev
npx prisma generate

# Seed super admin (run ONCE only)
npx ts-node database/seeders/super-admin.seeder.ts

# Dev
npm run start:dev   # backend
npm run dev         # frontend

# Production (Hostinger)
node server.js
```

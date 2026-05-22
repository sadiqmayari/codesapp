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
- Set `media_expires_at = NOW() + 7 days` on every media message
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

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
│   │   │   └── integrations/
│   │   │       └── shopify/
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

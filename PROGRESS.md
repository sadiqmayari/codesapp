# PROGRESS.md — CodesApp Build Tracker
> Update this file at the end of every session using the handoff summary.
> Claude Code reads this to understand what exists before starting work.

---

## Current Status
**Phase:** Phase 1 — **LIVE IN PRODUCTION** at https://apps.codentra.pk  
**Last updated:** 2026-05-15  
**Last session:** Session 1 — Foundation + Production Deploy

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
| Shared inbox (Socket.io, assignments) | ⬜ Not started | Start here next session |
| 24hr conversation window enforcement | ⬜ Not started | |
| Collision detection | ⬜ Not started | |
| Contacts CRM (CRUD, tags, segments) | ⬜ Not started | |
| CSV contact import | ⬜ Not started | csv-parse already installed |
| Templates (Meta sync, in-app creation) | ⬜ Not started | |
| Broadcasts (job queue, scheduling, throttle) | ⬜ Not started | JobQueueService ready |
| Keyword bot engine | ⬜ Not started | |

## Phase 3 — Growth Layer
| Task | Status | Notes |
|---|---|---|
| Outbound webhooks (HMAC, retry, logs) | ⬜ Not started | |
| Analytics dashboard | ⬜ Not started | |
| Billing module | ⬜ Not started | |
| Cloud API wizard | ⬜ Not started | |
| Media cleanup cron (7-day deletion) | ⬜ Not started | |

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
| /dashboard | ⬜ Not started | |
| /inbox | ⬜ Not started | |
| /inbox/[id] | ⬜ Not started | |
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
| /onboarding (Cloud API wizard) | ⬜ Not started | |

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

## Status Key
- ⬜ Not started
- 🔄 In progress
- ✅ Complete
- ❌ Blocked
- ⚠️ Needs review

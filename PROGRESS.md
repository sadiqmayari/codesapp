# PROGRESS.md — CodesApp Build Tracker
> Update this file at the end of every session using the handoff summary.
> Claude Code reads this to understand what exists before starting work.

---

## Current Status
**Phase:** Phase 1 Complete — Phase 2 Ready to Start  
**Last updated:** 2026-05-15  
**Last session:** Session 1 — Foundation

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

## Status Key
- ⬜ Not started
- 🔄 In progress
- ✅ Complete
- ❌ Blocked
- ⚠️ Needs review

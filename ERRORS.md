# ERRORS.md — CodesApp Known Issues & Workarounds
> Log every bug encountered and how it was solved.
> Claude Code reads this to avoid repeating the same mistakes.
> Add entries during sessions when bugs are found and fixed.

---

## How to Add an Entry
```
### [Module] — Short description of the bug
**Error message:** paste exact error
**Cause:** what caused it
**Fix:** what solved it
**Date:** YYYY-MM-DD
```

---

## Entries

### [CacheService] — node-cache is not a constructor
**Error message:** `TypeError: node_cache_1.default is not a constructor`
**Cause:** `node-cache` is a CommonJS module. TypeScript compiled `import NodeCache from 'node-cache'` to `node_cache_1.default` which doesn't exist — the package exports the class directly as `module.exports`.
**Fix:** Use `const NodeCacheCtor = require('node-cache') as typeof NodeCacheType` with a separate `import type` for the type annotation. Never use `import NodeCache from 'node-cache'` in this project.
**Date:** 2026-05-15

### [Prisma+Hostinger] — PrismaClientRustPanicError: timer has gone away
**Error message:** `PANIC: timer has gone away` from `futures-timer-3.0.2/src/native/delay.rs:112` on every Prisma query
**Cause:** Hostinger uses CloudLinux LVE which periodically kills idle threads. Prisma's library query engine spawns a Tokio runtime with timers; when LVE kills the timer driver thread, the next query panics. Affects all queries.
**Fix:** Append `?connection_limit=1&pool_timeout=0` to DATABASE_URL. Example: `mysql://user:pass@127.0.0.1:3306/db?connection_limit=1&pool_timeout=0`
**Date:** 2026-05-15

### [Prisma+Hostinger] — `localhost` auth fails, `127.0.0.1` works
**Error message:** `Authentication failed against database server at 'localhost'` even though `mysql -h localhost -u USER -p` succeeds with the same creds.
**Cause:** Node/Prisma resolves `localhost` to IPv6 `::1` by default; MariaDB user is only granted via IPv4. The `mysql` CLI uses Unix socket for `localhost` so it sidesteps the issue.
**Fix:** Always use `127.0.0.1` (not `localhost`) in DATABASE_URL on Hostinger.
**Date:** 2026-05-15

### [Hostinger Cloud Apps] — Build succeeds but state reports "Build failed"
**Error message:** Dashboard shows "Build failed" while the build log has no errors. Domain returns 404 from `Server: hcdn`.
**Cause:** Cloud Apps verifies that the Entry File exists at runtime AFTER wrapping output. With Output directory = `dist` and our committed `backend/dist/main.js`, Hostinger creates `backend/dist/dist/main.js` (nested) when it copies the workspace into the output dir.
**Fix:** Set `Output directory = dist` AND `Entry file = main.js` (not `dist/main.js`). Hostinger `cd`s into the Output directory before running Entry File.
**Date:** 2026-05-15

### [Hostinger Cloud Apps] — Build runs `nest build` twice → OOM kill
**Error message:** Build log cuts off at "> nest build" with no further output.
**Cause:** Hostinger's NestJS preset runs `npm run build` AFTER `npm install`. With `postinstall` also running `nest build`, the build runs twice and the second hits Hostinger's per-process memory cap and is silently killed.
**Fix:** Pre-compile `dist/` locally, commit it, and set `build` script to `echo "skipped"`. Use `build:local` script (`nest build`) for laptop rebuilds.
**Date:** 2026-05-15

### [Hostinger] — bcrypt native binary fails to compile
**Error message:** `npm install` errors building `bcrypt` from source (no prebuilt + no C compiler available).
**Cause:** Hostinger shared hosting has no C compiler for `node-gyp`. `bcrypt` requires a native compile if no prebuilt binary matches the target.
**Fix:** Use `bcryptjs` (pure JS, drop-in replacement). API identical to `bcrypt`.
**Date:** 2026-05-15

### [SuperAdminIpGuard+Hostinger] — req.ip returns proxy IP, not real client
**Error message:** `403 Forbidden — Access denied: IP not whitelisted` even after adding the caller's public IP to `SUPER_ADMIN_IP_WHITELIST`.
**Cause:** Express's `req.ip` returns the immediate connection IP — on Hostinger that's the reverse proxy's edge, not the real user. Whitelist match always fails.
**Fix:** In `main.ts`, `app.getHttpAdapter().getInstance().set('trust proxy', true)`. Express then reads `X-Forwarded-For` and resolves `req.ip` to the real client.
**Date:** 2026-05-15

### [Next.js 14] — Prerender error on /verify-email and /reset-password
**Error message:** `Error occurred prerendering page "/verify-email"` (and `/reset-password`) during `next build`
**Cause:** Both pages use `useSearchParams()` which can't be statically pre-rendered without a Suspense boundary in Next.js 14.
**Fix:** Wrap page body in `<Suspense>` AND add `export const dynamic = 'force-dynamic'`.
**Date:** 2026-05-15

### [Hostinger Cloud Apps] — `npm install --omit=dev` strips build tools
**Error message:** `sh: nest: command not found` or `sh: prisma: command not found` during postinstall.
**Cause:** Cloud Apps installs with `--omit=dev`, so devDependencies are missing at build time. `@nestjs/cli`, `prisma`, `typescript`, etc. were all unavailable.
**Fix:** Move all build-chain packages into `dependencies`. devDependencies kept only true dev-only tools (jest, eslint, prettier, ts-jest, ts-node, @nestjs/testing).
**Date:** 2026-05-15

### [Hostinger Cloud Apps] — Stale processes block new deploys → app appears down after redeploy
**Error message:** `curl https://apps.codentra.pk/health` hangs forever (no response) or returns `307 → /health` self-redirect from `Server: hcdn`. Runtime log shows only `[env-check]` and nothing else (no `CodesApp backend running on port 3001`).
**Cause:** After a successful build, Hostinger Cloud Apps does NOT automatically kill old Node processes from the previous deploy. The old crashed/stuck process keeps holding port 3001, so the new build's `app.listen(3001)` either silently fails or hangs before NestJS finishes booting. There is no "Restart" button in Hostinger Cloud Apps — only **Stop all running processes**.
**Fix:** After every deploy that changes module wiring or workers:
1. Hostinger hPanel → Websites → Advanced → Node.js → click **"Stop all running processes"**
2. Wait ~10 seconds
3. Send any request to the domain (`curl https://apps.codentra.pk/health`) — Hostinger lazy-starts the app on first request
4. Expect a 30–60s cold start, then `200 OK`
The trick: there is no separate "Start" button. Hostinger auto-starts on first inbound request, but only after the old process is fully dead.
**Date:** 2026-05-15

### [Hostinger] — Build/runtime stdout is separate from access log
**Error message:** N/A — diagnostic note. When debugging a crash, "Access log" only shows HTTP requests reaching the edge (`GET /health HTTP/1.1`) and tells you nothing about why the Node process is failing.
**Cause:** Hostinger Cloud Apps splits logs into three places: (a) Build log — `npm install` / `prisma generate` output, (b) Runtime log / Application output — `console.log` from the Node process (where `[env-check]` and `CodesApp backend running on port 3001` appear), (c) Access log — every HTTP request hitting the edge proxy.
**Fix:** When the app appears dead, read in this order: Runtime log first (look for the line right after `[env-check]`), then Build log (look for `prisma generate` errors), then Access log only to confirm requests are reaching Hostinger at all. Stderr from the Node process is NOT visible in any of these logs — to see stderr you need SSH access (Business plan only) and `node dist/main.js 2>&1 | head -100`.
**Date:** 2026-05-15

### [Hostinger Node.js] — Entry file must be `main.js`, not `dist/main.js` when Output directory = `dist`
**Error message:** Build "succeeds" but the app never starts; runtime log is empty; requests time out.
**Cause:** Hostinger's Cloud Apps `cd`s into the Output directory before running the Entry file. With `Output directory = dist` and `Entry file = dist/main.js`, it tries to load `backend/dist/dist/main.js` (nested) which doesn't exist → silent failure. (This is the same root cause as the Phase 1 entry as well — re-documented because the panel UI does NOT auto-correct the value and the deploy "succeeded" misleadingly.)
**Fix:** Build configuration → Output directory: `dist`, Entry file: `main.js` (NOT `dist/main.js`).
**Date:** 2026-05-15

### [Phase 2 Migration] — `ALTER TABLE ADD COLUMN IF NOT EXISTS` unsupported on MySQL 8
**Error message:** N/A (preventive note)
**Cause:** MySQL 8 does not support `IF NOT EXISTS` on `ALTER TABLE ADD COLUMN` (MariaDB does, but the Prisma migration file targets MySQL syntax). The Phase 2 migration `20260516000000_phase2_inbox/migration.sql` uses straight `ADD COLUMN` for `messages.read_at`, `messages.read_by_user_id`, `messages.broadcast_id`, and `conversations.unread_count`. The file is **one-time-import only** — re-running on a DB that already has these columns will fail with "Duplicate column name".
**Fix:** Run the migration exactly once via phpMyAdmin → Import. If a column already exists, comment that line out before re-running. Future schema changes go in a new migration directory dated later than `20260516000000`.
**Date:** 2026-05-15

### [Prisma+TypeScript] — Record<string, unknown> not assignable to InputJsonValue
**Error message:** `TS2322: Type 'Record<string, unknown>' is not assignable to type 'JsonNull | InputJsonValue | undefined'`
**Cause:** Prisma's generated `InputJsonValue` is a recursive union and TypeScript refuses to widen `Record<string, unknown>` (or DTOs typed that way) into it. Hits any place where a free-form `custom_fields`/`variables`/`filter` JSON DTO is passed to `prisma.X.create({ data })`.
**Fix:** Cast at the assignment site: `custom_fields: (dto.customFields ?? {}) as Prisma.InputJsonValue`. Don't cast the entire `data` object — TypeScript will then miss real field-type errors.
**Date:** 2026-05-15

### [Prisma] — Migration command fails: schema engine "OS can't start..."
**Error message:** `Could not parse schema engine response: SyntaxError: Unexpected token 'O', "OS can't s"... is not valid JSON`
**Cause:** Hostinger LVE kills the Prisma schema-engine subprocess as soon as it spawns. Same root cause as the Rust panic — process limits.
**Fix:** Bypass `prisma migrate` entirely on Hostinger. Generate migration SQL locally (`prisma migrate diff --from-empty --to-schema-datamodel ... --script`), commit it, then run via phpMyAdmin → Import. `@prisma/client` still works at runtime (with the `connection_limit=1` fix) — only the schema engine is broken.
**Date:** 2026-05-15

### [Phase 3 Webhooks] — Phase 2 webhook job backlog drained as `failed (reason='stale')`
**Error message:** N/A (preventive note). On first boot after the Phase 3 deploy you will see many `webhook_logs` rows with `delivery_status='failed'` and `reason='stale'`.
**Cause:** Phase 2's `BotEngineService` enqueued `'webhook'` jobs for the `fire_webhook` bot action, but no `'webhook'` worker existed yet, so they accumulated as `pending`. Those legacy payloads have no `enqueuedAt` field. The Phase 3 `WebhookWorker` treats a missing or >7-day-old `enqueuedAt` as **stale**: it writes a `failed`/`stale` log row and **consumes** the job (returns without throwing) instead of attempting delivery or burning retry attempts. This is intentional — it drains the backlog cleanly on first boot.
**Fix:** Nothing to do. The `stale` rows are expected one-time noise from the Phase 2 → 3 transition. New dispatches always carry `enqueuedAt` and deliver normally.
**Date:** 2026-05-16

### [Phase 3 CronGuard] — cron endpoints now return 403 (was 401) on bad/missing secret
**Error message:** N/A (behavioral note). `/cron/*` without a valid secret returns **403 Forbidden** (Phase 2 returned 401).
**Cause:** `CronGuard` was rewritten to accept `X-Cron-Secret` header OR `?secret=` query fallback (UptimeRobot free tier custom headers are flaky) and now throws `ForbiddenException` with a constant-time compare. UptimeRobot only needs HTTP 200 for "up", so the status code change is safe; smoke checks expect 403.
**Fix:** None — expected. Use `?secret=$CRON_SECRET` for UptimeRobot monitors.
**Date:** 2026-05-16

### [Phase 3 Migration] — invoices ALTER is one-time-import; verify idx_messages_media_expires first
**Error message:** N/A (preventive note).
**Cause:** `20260517000000_phase3/migration.sql` uses straight `ADD COLUMN` (MySQL 8 has no `IF NOT EXISTS`). The `idx_messages_media_expires` line is **commented out** because the Phase 1 init migration already created `messages_media_expires_at_media_expired_idx` from the schema `@@index`. Re-running, or uncommenting that line on the prod DB, will fail with "Duplicate column"/"Duplicate key name".
**Fix:** Run once via phpMyAdmin → Import. `SHOW INDEX FROM messages;` before uncommenting the media index line — leave it commented on the production DB.
**Date:** 2026-05-16

### [Phase 3 Onboarding] — step-3 returns 503 until ENCRYPTION_KEY is set
**Error message:** `503 Server encryption key is not configured — refusing to store secrets.`
**Cause:** `EncryptionService.isUsingPlaceholderKey()` is true when `ENCRYPTION_KEY` is missing or equals the insecure placeholder. `POST /onboarding/step-3-access-token` refuses to encrypt/store a Meta token under the placeholder key (it would be unrecoverable + insecure). A single `Logger.warn` is emitted at startup when the placeholder is active.
**Fix:** Set a real 32-char `ENCRYPTION_KEY` in Hostinger env vars and redeploy before completing onboarding.
**Date:** 2026-05-16

### [FE-1 Hostinger] — frontend/.next must be committed (build OOM) — .gitignore negation
**Error message:** N/A (preventive note). Same root cause as the backend `nest build` OOM.
**Cause:** Hostinger shared hosting OOM-kills a clean `next build`. The frontend `.next/` output must be pre-built locally and committed (same pattern as `backend/dist/`). The repo `.gitignore` had a blanket `**/.next/` rule.
**Fix:** `.gitignore` now negates it: `!frontend/.next/` + `!frontend/.next/**`, while still excluding `frontend/.next/cache/` (machine-specific, large). Run `npx next build` locally and commit `frontend/.next/` before deploy. Do NOT commit `.next/cache`.
**Date:** 2026-05-16

### [FE-1 Onboarding] — wizard endpoint/verify-token expectations vs actual backend
**Error message:** N/A (preventive note for future frontend work).
**Cause:** The FE-1 prompt referenced `/onboarding/step-2-webhook-verify-complete` and `/onboarding/step-4-waba`, and expected `/onboarding/status` to return the webhook verify token. The actual controller exposes only `step-2-webhook-verify` (single endpoint, stamps `webhookVerifiedAt` + advances) and `step-4-waba-phone`; `getStatus()` sanitizes and never returns the token (it redacts the access token to `(set)` and returns no verify token at all — `META_VERIFY_TOKEN` is a server env var).
**Fix:** UI calls the real endpoints and explains the verify token is admin-configured server-side. Step 5 sends `{toPhone,templateName,languageCode}` (DTO requires all three) with `hello_world`/`en_US` defaults. Future sessions: read the controller, not the prompt, for exact endpoint names.
**Date:** 2026-05-16

### [Single-process] — `apps.codentra.pk/` returned backend JSON 404 (frontend not served)
**Error message:** Browser at `https://apps.codentra.pk/` shows `{"success":false,"data":null,"message":"Cannot GET /"}`
**Cause:** Only the NestJS backend was deployed (Hostinger Root dir `backend`, entry `main.js`). The Next.js frontend was never hosted. The JSON is the backend's global `HttpExceptionFilter` formatting a NotFound for `/`.
**Fix:** Mount the prebuilt Next.js app inside the NestJS process and add an `/api` global prefix (see ARCHITECTURE.md "Single-process"). After deploy: `npm install` (pulls new `next/react/react-dom` backend deps), then Hostinger "Stop all running processes" + first request lazy-start. Backend routes are now `/api/*`; `/health`, `/webhooks/meta`, `/integrations/shopify/*`, `/cron*` stay at root (excluded from prefix) so Meta/Shopify/UptimeRobot need no changes.
**Date:** 2026-05-16

### [Single-process] — adding next/react to backend; frontend/node_modules absent in prod
**Error message:** N/A (preventive). Risk: `Cannot find module 'next'` at runtime on Hostinger.
**Cause:** Hostinger installs deps only in the `backend` root dir. `frontend/node_modules` does not exist in production. Next is invoked with `dir: ../../frontend` but must resolve `next/react/react-dom` from `backend/node_modules`.
**Fix:** `next@14.2.5`, `react@^18.3.1`, `react-dom@^18.3.1`, `express` added to backend **dependencies** (not devDeps — Hostinger strips devDeps). App code is prebuilt in committed `frontend/.next`, so `frontend/node_modules` is not needed at runtime. Memory note: two frameworks in one process raises RAM — watch Hostinger runtime memory; the no-host-build rule (committed dist + .next) is what keeps it within limits.
**Date:** 2026-05-16

### [Single-process] — Next "Could not find a production build in '.next'" — Hostinger deploys only backend/
**Error message:** `[next] FAILED ... Could not find a production build in the '.next' directory` ; browser diag showed `frontendExists:false`, `dirname:/home/.../apps.codentra.pk/nodejs/dist`.
**Cause:** Hostinger Cloud Apps deploys ONLY the Root directory (`backend`) into `…/apps.codentra.pk/nodejs/`. The sibling `frontend/` is never on the server, so `path.join(__dirname,'..','..','frontend')` did not exist. (`next` itself WAS resolvable from `nodejs/node_modules` — backend deps were fine.)
**Fix (attempt 1, INSUFFICIENT):** Shipped at `backend/web/` — still `frontendExists:false`. Hostinger deploys ONLY the **Output directory (`dist`)** + node_modules + package.json into `…/nodejs/`, NOT sibling `backend/` folders. `backend/web` was never on the server.
**Fix (attempt 2, WORKS):** Ship the prebuilt frontend INSIDE `dist`: **`backend/dist/web/`** (`.next`+`next.config.js`+`package.json`) via `npm run sync:web`. Next mounts with `dir = <deploy>/dist/web`. Because `nest build` has `deleteOutDir:true`, the order is build backend → build frontend → `sync:web` → commit `backend/dist`. `backend/dist/web/.next` committed via gitignore negation. react/react-dom/next resolve from `backend/node_modules`.
**Date:** 2026-05-16

### [SuperAdmin] — super-admin login 401 "Invalid credentials" after changing SUPER_ADMIN_PASSWORD
**Error message:** `POST /api/super-admin/auth/login` → 401 `Invalid credentials` (after the IP whitelist was fixed; not a 403).
**Cause:** `SuperAdminBootstrap.onModuleInit()` was create-only: `if (existing) return;`. The super-admin row was seeded once (Phase 1, `admin@codentra.pk`); later changes to `SUPER_ADMIN_PASSWORD` in Hostinger env were never written to the DB, so `bcrypt.compare(currentEnvPassword, oldHash)` always failed.
**Fix:** Bootstrap now treats env as the source of truth: if the row exists but the env password doesn't match (or role/status drifted), it re-hashes and `update`s `password_hash`/`role`/`status` on every boot. Changing `SUPER_ADMIN_PASSWORD` + redeploy now actually takes effect. (Diagnosed by probing prod: `/api/super-admin/auth/login` went 403→401 once `SUPER_ADMIN_IP_WHITELIST` was set, isolating it to credentials.)
**Date:** 2026-05-16

### [Frontend] — prod calling http://localhost:3001/api (ERR_CONNECTION_REFUSED)
**Error message:** Browser console: `POST http://localhost:3001/api/super-admin/auth/login net::ERR_CONNECTION_REFUSED`
**Cause:** `NEXT_PUBLIC_*` env vars are inlined into the bundle at **build time**. The frontend build is produced off-host (Hostinger never builds — committed `dist/web`). The local build read `.env.local` (`NEXT_PUBLIC_API_URL=http://localhost:3001`), so `localhost:3001` was hard-baked into production JS. Login requests never reached the server.
**Fix:** Resolve the API/socket base at **runtime** from `window.location.origin` (single-origin deployment), not from a build-time env var. `lib/api.ts` → ``typeof window !== 'undefined' ? `${window.location.origin}/api` : <ssr fallback>``; `socket-context.tsx` → `window.location.origin`. The committed build is now host-agnostic. (A `localhost` literal still appears in the bundle as the unreachable SSR-fallback branch — harmless; the browser always takes the origin branch.)
**Date:** 2026-05-16
> Pre-filled based on known Hostinger Node.js shared hosting quirks

### App crashes silently after deploy
**Cause:** Usually a missing env var or wrong entry point  
**Fix:** Check Hostinger error logs in panel. Ensure `package.json` start script is `"node server.js"` and all env vars are set in Hostinger panel

### Socket.io connection refused
**Cause:** Hostinger proxies WebSocket connections — needs sticky sessions  
**Fix:** Add `transports: ['websocket', 'polling']` on client. If still failing, check if Hostinger plan supports WebSocket upgrades on the Node.js app hosting (it does on Business plan)

### Prisma migration fails on deploy
**Cause:** DATABASE_URL not set or wrong format  
**Fix:** Verify `DATABASE_URL=mysql://user:pass@localhost:3306/dbname` — use `localhost` not `127.0.0.1` on Hostinger MySQL

---

### [SuperAdmin] — dynamic client IP makes exact-match whitelist unusable
**Error message:** Recurring `403 Access denied: IP not whitelisted` with a different `Detected IP` each time (observed 223.123.107.103 → 39.38.120.112).
**Cause:** `SuperAdminIpGuard` did exact-string match only; the owner's ISP hands out dynamic IPs, so any whitelisted value goes stale fast.
**Fix:** Guard now supports in `SUPER_ADMIN_IP_WHITELIST` (comma-separated): exact IPs, IPv4 CIDR (e.g. `39.38.0.0/16`), and `*` (explicit owner opt-out that disables the check + logs a warning). IPv4-mapped IPv6 normalized. Prefer a CIDR over `*`; tighten once IP is stable.
**Date:** 2026-05-16

### [Frontend] — infinite reload loop on /login & /super-admin/login; super-admin bounced to /login
**Error message:** Page auto-refreshes continuously; `/super-admin/login` immediately redirects to `/login`.
**Cause:** Root-layout `AuthProvider` calls `/auth/refresh` on mount on EVERY page (incl. public ones). For an unauthenticated visitor it 401s; the axios response interceptor caught that 401, attempted a second refresh, failed, and ran `window.location.href='/login'`. On `/login`/`/super-admin/login` that hard reload remounts `AuthProvider` → refresh → 401 → redirect → infinite loop. Pre-existing since FE-1, only exposed once the pages actually loaded (after the localhost-API-base fix).
**Fix:** `lib/api.ts` interceptor now (a) skips the refresh/redirect path entirely when the failing request is itself an auth endpoint (`/auth/refresh`, `/auth/login`), and (b) no longer does a hard `window.location` redirect — it just clears the token and rejects; the `(app)` layout already does a client-side `router.replace('/login')` when there's no user, and public pages need no redirect.
**Date:** 2026-05-17

### [Frontend] — dashboard infinite fetch/refresh loop + repeating error toasts
**Error message:** `/dashboard` continuously reloads/refetches; error toast keeps reappearing.
**Cause:** `ToastProvider` exposed a NON-memoized context value (`const api = {success,error,info}` rebuilt every render). A toast → `items` state change → provider re-render → new `api` identity → every `useToast()` consumer's deps change → dashboard `load` (`useCallback([params, toast])`) recreated → its `useEffect([load])` re-fires → fetch → error → toast → loop.
**Fix:** Wrap the toast api in `useMemo([push])` (`push` already `useCallback`-stable) so the context value is stable. Any context Provider value consumed in effect deps MUST be referentially stable.
**Date:** 2026-05-17

### [Auth] — browser refresh on an (app) page bounces to /login
**Error message:** N/A — refreshing the page while logged in redirects to `/login`.
**Cause:** `AuthService.refresh()` returned only `{ accessToken }`. `auth-context` sets `user = res.data.data.user ?? null`; with no `user` in the response, `user` became `null` on every silent refresh → `(app)` layout auth gate `router.replace('/login')`.
**Fix:** `refresh()` now returns `{ accessToken, user: { id, name, email, role } }` (same shape as `login()`), so the session/user survives a page reload.
**Date:** 2026-05-17

### [Auth/Email] — Hostinger SMTP 535 auth failed despite correct webmail creds
**Error message:** `/api/_debug/mail` → `EAUTH Invalid login: 535 5.7.8 Error: authentication failed`, while the SAME `noreply@codentra.pk` password logs into Hostinger webmail fine. Diagnostic showed env value clean (`passLength:22`, no whitespace/quotes).
**Cause:** Hostinger shared-hosting SMTP submission (smtp.hostinger.com:465) rejects AUTH for this mailbox even with the correct credential — a Hostinger SMTP-policy/credential-edge, not a code or env-formatting bug (verified: code passes the exact 22-char string to nodemailer; connection reaches AUTH so SMTP is not network-blocked).
**Fix:** Added a provider-pluggable mailer in `AuthService.send()`: if `RESEND_API_KEY` is set it sends via the Resend HTTPS API (native `https`, no SMTP, no escaping/port issues — works on shared hosting); otherwise it falls back to nodemailer SMTP. `/api/_debug/mail` reports `provider` and tests the active one. Requires a Resend account + verified `codentra.pk` domain (or `onboarding@resend.dev` for testing) and `SMTP_FROM` set to a verified sender. Quick non-Resend test: reset the mailbox password to alphanumeric-only and retry SMTP.
**Date:** 2026-05-17
**Error message:** Every endpoint (incl. `/health`) times out (curl `000`) right after deploy; browser spins.
**Cause:** No auto-restart; Hostinger lazy-starts on first request. Next+Nest in one process → cold start 60–90s+, everything times out meanwhile.
**Fix:** Not a bug. After deploy: "Stop all running processes" → hit `/health`, poll up to ~90s (don't conclude it's dead at 25s). Confirmed: successive polls returned `000,000,200` then served normally.
**Date:** 2026-05-16

---

### [FE-2a] — prompt endpoint/contract assumptions vs actual backend
**Error message:** N/A (preventive note — same lesson as the FE-1 onboarding entry).
**Cause:** The FE-2a prompt made several assumptions the controllers contradict. Building to the prompt would have shipped broken calls.
**Fix (controller wins, applied):**
- Super-admin activate/suspend are **PATCH** `/super-admin/clients/:id/{activate,suspend}` (prompt said POST). Clients list `GET /super-admin/clients?page&limit` returns `{items,meta}` (no server search/status filter; no owner email — only `subscription` is included). FE filters/searches client-side over the paged rows; column shows plan, not owner email.
- `POST /contacts/import` accepts **only** a multipart `file` — there is NO mapping DTO and the importer ignores custom_fields and keys on literal `phone,name,email,tags`. FE does the column mapping client-side and re-uploads a normalized CSV. Import summary is `{created,skipped,invalid,capped}` (no X-of-Y / row N).
- `GET /contacts/:id` returns the contact **only** — there is no per-contact message-timeline endpoint. The profile page omits the timeline and links to the Inbox instead. Block/Unblock/Archive are done via `PATCH /contacts/:id { status }` (enum active|blocked|archived).
- Tenant `/login` returns **401 "Account not active. Contact support."** for VALID-but-inactive credentials (not a 403 "pending approval" as the prompt assumed); wrong password returns 401 "Invalid credentials". Login page surfaces a pending-approval message only when the message matches `/not active/i` (does not leak account existence).
- `POST /templates` body is `{name, category, language, components[]}` (Meta `components` array), not discrete header/body/footer fields. FE builds the components array; preview renders it.
**Date:** 2026-05-17

### [FE-2b] — broadcasts/bots prompt assumptions vs actual backend
**Error message:** N/A (preventive note, same lesson as FE-1/FE-2a).
**Cause/Fix (controller wins, applied):**
- `GET /broadcasts` returns a **plain array, no `meta.total`** → list pagination is prev/next by "full page" heuristic, not total-based.
- Broadcast lifecycle: `POST :id/send|cancel`, `POST :id/schedule {runAt}` (all 200), `PATCH :id` edits only while `draft`. Create/update body is `{name, templateId, segmentId?|filter?|contactIds?, variables?}` — `filter` is the FE-2a `SegmentFilterDto`. `variables` is `Record<string,string>` keyed by placeholder number ("1","2"…).
- `broadcast.progress` socket payload is `{broadcastId,sent,failed,total,status?}` on the company room (every 25 jobs + completion) — FE-1 received but ignored it; FE-2b consumes it.
- Bots: `DELETE /bots/:id` is a **hard delete** (no `deleted_at`); toggle is **`PATCH /bots/:id/toggle`** (not POST). `actions` array is 1–10 of the `BotActionDto` union. `assign_agent` needs a raw `userId` and `fire_webhook` a raw `webhookEndpointId` — there is still **no users-list endpoint** and the webhook UI is FE-3, so both are numeric inputs with notes (the inbox assignee dropdown remains "Assign to me", unchanged).
**Date:** 2026-05-17

### [FE-1 Onboarding] — webhook callback URL showed http://localhost:3001
**Error message:** Onboarding step 2 displayed Callback URL `http://localhost:3001/webhooks/meta` in production instead of `https://apps.codentra.pk/webhooks/meta`.
**Cause:** `onboarding/page.tsx` had a module-level `const APP_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'`. `NEXT_PUBLIC_*` is inlined at build time and the build is produced off-host, so `localhost` was baked into the bundle — exact same bug class as the earlier `lib/api.ts` localhost issue. A tenant would have pasted the localhost URL into Meta.
**Fix:** Replaced with a runtime `publicOrigin()` that returns `window.location.origin` in the browser (SSR fallback only for the unreachable branch). Callback = `${publicOrigin()}/webhooks/meta` (webhook is excluded from the `/api` prefix, so it stays at root origin). Rebuilt + synced `dist/web`. Future: never derive a user-facing URL from `NEXT_PUBLIC_*` — always `window.location.origin` at runtime.
**Date:** 2026-05-17

### [Multi-tenant] — single META_APP_SECRET can't validate clients' own Meta apps
**Error message:** N/A (architecture). Symptom would be: webhook verify handshake passes but every inbound POST is dropped with 401 "HMAC verification failed", inbox stays empty.
**Cause:** Meta signs inbound webhooks with the **app secret of the subscribing Meta app** and the GET handshake uses **that app's** verify token. When each client uses their own Meta app, a single platform `META_APP_SECRET`/`META_VERIFY_TOKEN` env can only ever validate one of them.
**Fix:** Option B — per-tenant `companies.webhook_key` (unique callback URL `/webhooks/meta/{key}`), `webhook_verify_token`, encrypted `webhook_app_secret_encrypted`, captured in onboarding step 2. `MetaWebhookController.resolveSecrets(key)` uses the company's secrets, falling back to platform env when null (keeps the future Tech-Provider/Embedded-Signup path working). Migration `20260518000000_option_b_webhooks` is **one-time phpMyAdmin import** (MySQL 8, no `IF NOT EXISTS`); re-running fails on duplicate column/index. Immediate single-tenant unblock without the migration: set `META_APP_SECRET` to the one client's app secret in env.
**Date:** 2026-05-18

### [Onboarding UX] — re-editing an earlier step forced re-pasting the access token
**Error message:** N/A (UX). Symptom: every Reset or re-edit of step 1/2 regressed `status.step`, and step 3 required the token again even though it was already stored encrypted (never returned), so clients entered the access token twice.
**Cause:** `Step3AccessTokenDto.accessToken` was required and `step3()` always overwrote the encrypted token. Step 4 form had no prefill.
**Fix:** Same pattern as step 2's app secret — `accessToken` now optional; `step3()` keeps the existing encrypted token when blank (errors only if none stored and none provided). `getStatus` now also returns `wabaId`/`phoneNumberId` so step 4 pre-fills. Step 3 UI shows "(already saved — leave blank to keep)". Re-editing earlier steps no longer forces re-entering token/WABA/phone.
**Date:** 2026-05-18

### [Inbox media] — images/audio/video not displaying (3 bugs)
**Error message:** N/A. Media rows exist in `messages` but don't render in the inbox.
**Cause:** (a) `meta-webhook.service` stored `downloaded.path` — the **absolute filesystem path** (`/home/u633194943/.../storage/media/...`) — in `messages.media_url`; a browser can't load that. (b) **No static server** was mounted for `/storage` (it was only in `BACKEND_ROOTS`, routed to Nest, but nothing served the files → 404). (c) Frontend `mediaUrl()` used build-time `NEXT_PUBLIC_API_URL` (bakes `localhost` in prod — same class as the lib/api.ts bug).
**Fix:** (a) store the **web path** `/storage/media/<rel>` (relative to `STORAGE_ROOT`, forward slashes). (b) `main.ts` mounts `express.static(<cwd>/../storage)` at `/storage` before the Next/backend router (random-UUID filenames = capability URLs; tenant-scoped media auth is a known future hardening). (c) `mediaUrl()` resolves `window.location.origin` at runtime (root origin, not `/api`). **Existing rows** written before the fix keep absolute paths and won't render — one-time backfill:
```sql
UPDATE messages SET media_url = CONCAT('/storage/media/', SUBSTRING_INDEX(media_url, '/storage/media/', -1))
  WHERE media_url LIKE '%/storage/media/%' AND media_url NOT LIKE '/storage/media/%';
```
**Date:** 2026-05-18

### [Frontend] — "logged out on every visit" was root `/` → `/login`
**Error message:** N/A. Visiting `apps.codentra.pk` always showed the login page even with a valid session; same feeling for super-admin.
**Cause:** `app/page.tsx` did `redirect('/login')` unconditionally — it never attempted session restore. Super-admin had a real gap: access token is memory-only and there was **no** SA refresh endpoint, so every reload forced re-login.
**Fix:** root `/` → `/dashboard` (the `(app)` layout silent-refreshes from the `refresh_token` cookie; middleware bounces only cookieless visitors). `/login` auto-forwards authed users. Added `POST /super-admin/auth/refresh` (IP-guarded, `sa_refresh_token`) + super-admin layout rehydrate.
**Date:** 2026-05-18

### [Inbox] — conversations re-sorted by last *click*, not last message
**Error message:** N/A. Opening any conversation moved it to the top of the list and it stayed there; order reflected click recency, not message recency.
**Cause:** list `orderBy: { updated_at: 'desc' }`, but `markRead` (and label/assign/resolve) do `conversation.update(...)` and Prisma `@updatedAt` auto-bumps `updated_at` on every write — so opening a chat (→ markRead) made it the "newest".
**Fix:** added `conversations.last_message_at` (migration `20260518100000_conversation_last_message_at`, backfilled from `updated_at`), set it ONLY on inbound (`meta-webhook.service`) and outbound (`inbox.service.sendMessage`) message writes; list now `orderBy: [{ last_message_at: 'desc' }, { updated_at: 'desc' }]`. Frontend displays/sorts on `last_message_at`. Read/label/assign no longer reorder.
**Date:** 2026-05-18

### [Inbox] — new message didn't float the conversation to the top
**Error message:** N/A. A new inbound message only bumped the unread badge; the row didn't move to the top until a refetch (click/navigation).
**Cause:** the `message.received` handler updated the row in place but never re-sorted the array, and the list renders in array order. Server sort (updated_at desc) only re-applied on `load()`.
**Fix:** handler now moves the conversation to index 0, refreshes `last_message` from the payload, and `load()`s if the conversation isn't on the current page. (Also: list is now infinite-scroll, not prev/next.)
**Date:** 2026-05-18

### [Shopify per-tenant — Phase 1] — `20260520000000_shopify_per_tenant_webhook` is one-time phpMyAdmin Import
**Error message:** N/A (preventive note).
**Cause:** MySQL 8 has no `ADD COLUMN IF NOT EXISTS`. Migration adds `companies.shopify_webhook_key` + `shopify_webhook_secret_encrypted` and a UNIQUE index `companies_shopify_webhook_key_key`. Re-running fails on duplicate column / duplicate key.
**Fix:** Import exactly once via phpMyAdmin (NOT `prisma migrate` — Hostinger LVE kills the schema engine). `/webhooks/shopify` was added to `BACKEND_ROOTS` in `main.ts` now (Phase 1) so the Phase-2 receiver routes to NestJS; there is no Next page at `/webhooks/shopify` so this does not shadow any frontend route (unlike the earlier `/webhooks` collision).
**Date:** 2026-05-20

### [FE-3 / Single-process] — `/webhooks` page returned backend JSON 404 ("Cannot GET /webhooks")
**Error message:** Browser at `/webhooks` shows `{"success":false,"data":null,"message":"Cannot GET /webhooks"}`.
**Cause:** `main.ts` `BACKEND_ROOTS` listed `'/webhooks'`, so the single-process prelim middleware routed the ENTIRE `/webhooks` prefix to NestJS. The FE-3 Next.js page is `/webhooks`, so it never reached Next — Nest's HttpExceptionFilter formatted a 404 for the unmatched GET. Only the Meta webhook actually lives at the root (`/webhooks/meta` + `/webhooks/meta/:key`, excluded from the `/api` prefix); the endpoint-CRUD API is under `/api/webhooks/*` (covered by the `/api` root).
**Fix:** Narrow the root from `'/webhooks'` → `'/webhooks/meta'` in `BACKEND_ROOTS`. Now `/webhooks` (and any non-meta subpath) falls through to Next, while `/webhooks/meta` + `/webhooks/meta/<key>` stay backend. Verified locally: `/webhooks` → 307 (Next auth redirect, like `/analytics`); `/webhooks/meta?...wrong` → 403 (Meta handler intact); `/api/webhooks/endpoints` → 401 (API intact). **Lesson:** any future Next page route must not collide with a `BACKEND_ROOTS` prefix — keep backend roots as specific as possible.
**Date:** 2026-05-19

### [FE-2d follow-up] — voice notes must be ogg/opus; MediaRecorder webm is rejected by Meta
**Error message:** Would surface as `(131053) Media upload error — Unsupported ... mime type audio/webm` if webm were sent.
**Cause:** WhatsApp Cloud API only renders a PTT voice note for `audio/ogg;codecs=opus`. Browser `MediaRecorder` yields `audio/webm;codecs=opus` (Chrome/Edge, Meta rejects) or `audio/mp4` (Safari). Hostinger can't transcode (no ffmpeg).
**Fix:** `opus-recorder` (WASM) encodes mic input directly to ogg/opus in-browser. Worker vendored at `frontend/public/opus/encoderWorker.min.js` (8.x inlines the wasm — single file), shipped via `sync-web` copying `public/`, served by Next at `/opus/...`. Sent through the existing `send-media` path. If you upgrade `opus-recorder`, re-copy `dist/encoderWorker.min.js` to `frontend/public/opus/` (it is NOT auto-synced from node_modules).
**Date:** 2026-05-19

### [FE-2d follow-up] — new conversation never showed an unread badge
**Error message:** N/A. Some chats showed no unread count even with unread inbound messages.
**Cause:** `MetaWebhookService.handleInbound` incremented `conversations.unread_count` only when the conversation already existed; a brand-new conversation was created with the default `0` and never bumped, so the first inbound message of any new conversation had no badge (frontend `message.received` with `idx===-1` refetches and trusts the DB value).
**Fix:** create new conversations with `unread_count: 1`.
**Date:** 2026-05-19

### [FE-2d follow-up] — outbound media shows "failed", reason was invisible
**Error message:** Outbound image/media flips to `failed` (Meta async status webhook) with no surfaced reason.
**Cause:** `handleStatus` never read Meta's `statuses[].errors[]`, so the real cause (e.g. `(#131053)` media format, re-engagement window, etc.) was lost. The send POST itself returns 2xx (Meta accepts, then fails delivery asynchronously) so the upload/send code path looked fine.
**Fix:** `handleStatus` now extracts `errors[]` (`(code) title — details`), `Logger.error`s it, and adds an optional `error` to the additive `message.status` socket payload; the thread shows it on the `failed` tick (title + ⓘ) and toasts it. `sendMedia` also logs `mediaId` + accepted `metaMessageId`. This is diagnostic — to root-cause a specific failure, read the surfaced Meta error/code (Hostinger runtime log line `Message N (meta=…) FAILED: …`).
**Date:** 2026-05-19

### [FE-2d Migration] — `20260519000000_message_context_and_caption` is one-time phpMyAdmin Import
**Error message:** N/A (preventive note).
**Cause:** MySQL 8 has no `ADD COLUMN IF NOT EXISTS` / `ADD CONSTRAINT IF NOT EXISTS`. The migration does `ALTER TABLE messages ADD COLUMN context_message_id INT NULL`, adds the self-FK `fk_messages_context` (`ON DELETE SET NULL`), and `CREATE INDEX idx_messages_context`. Re-running on a DB that already has them fails with "Duplicate column name 'context_message_id'" / "Duplicate key name 'fk_messages_context'" / "Duplicate key name 'idx_messages_context'".
**Fix:** Run exactly once via phpMyAdmin → Import (NOT `prisma migrate` — schema engine is killed on Hostinger LVE). If a partial run occurred, comment out the statements that already applied before re-importing. Future schema changes go in a migration dated later than `20260519000000`.
**Date:** 2026-05-19

### [FE-2d] — outbound media / reply best-effort policy (do not "fix" into a throw)
**Error message:** N/A (behavioral note).
**Cause:** `InboxService.resolveContext` and `MetaWebhookService` inbound reply detection are intentionally best-effort: a missing quoted message, a quoted message with no `meta_message_id`, or a lookup error logs a `warn` and the message is sent/stored WITHOUT context — it never throws. A reply must never block a send (wamids can be unknown to us; a quoted row can be hard-deleted).
**Fix:** None — expected. Do not convert these warns into exceptions. Socket/fetch `context_message` is hydrated ONE level deep only — never add recursive hydration (unbounded query cost).
**Date:** 2026-05-19

## Meta WhatsApp API Known Quirks
> Pre-filled based on common integration issues

### Webhook verification fails
**Cause:** Response not sent fast enough or wrong challenge returned  
**Fix:** Return `hub.challenge` as plain text (not JSON) with 200 status within 3 seconds

### Media download returns 403
**Cause:** Media URL from Meta expired (they expire in ~10 min)  
**Fix:** Download media immediately in the `message.received` webhook handler, before any async processing

### Template rejected with no reason
**Cause:** Meta sometimes rejects without a clear message  
**Fix:** Check template name for special characters, verify variables use correct `{{1}}` format, ensure category matches content

---

## Shopify Known Quirks

### Webhook arrives with no body
**Cause:** Body parser consuming raw body before HMAC verification  
**Fix:** NestJS is created with `rawBody: true` option in `NestFactory.create()`. The Shopify webhook controller uses `RawBodyRequest<Request>` and reads `req.rawBody`. This is already implemented correctly in Phase 1.

### HMAC verification fails
**Cause:** Using API secret instead of webhook secret  
**Fix:** Use `SHOPIFY_WEBHOOK_SECRET` (from Shopify Partners dashboard webhook settings), NOT the API secret key

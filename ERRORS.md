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

---

## Common Hostinger Deployment Issues
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

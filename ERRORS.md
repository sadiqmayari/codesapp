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

### [Prisma] — Migration command fails: schema engine "OS can't start..."
**Error message:** `Could not parse schema engine response: SyntaxError: Unexpected token 'O', "OS can't s"... is not valid JSON`
**Cause:** Hostinger LVE kills the Prisma schema-engine subprocess as soon as it spawns. Same root cause as the Rust panic — process limits.
**Fix:** Bypass `prisma migrate` entirely on Hostinger. Generate migration SQL locally (`prisma migrate diff --from-empty --to-schema-datamodel ... --script`), commit it, then run via phpMyAdmin → Import. `@prisma/client` still works at runtime (with the `connection_limit=1` fix) — only the schema engine is broken.
**Date:** 2026-05-15

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

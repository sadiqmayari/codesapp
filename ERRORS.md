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

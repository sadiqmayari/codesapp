# CodesApp — WhatsApp Business Calling via self-hosted Asterisk (SIP)

This directory stands up a **free, self-hosted Asterisk SIP server** that routes
WhatsApp Business voice calls to CodesApp agents — no paid SIP trunk, no TURN
service. It runs as its **OWN container** alongside `codesapp-app` on the VPS
(NOT inside it — one-process rule, and Asterisk needs raw TLS + UDP RTP ports).

- SIP server (Meta dialog "SIP server"): **`sip.codentra.pk`**
- SIP port: **5061** (SIP over TLS — mandatory)
- Meta SIP domain (where we send business-initiated INVITEs): **`wa.meta.vc`**
- Media: **Opus**, SRTP. We use **SDES** for the first bring-up (simpler — no
  ICE/DTLS/STUN); DTLS is Meta's default and the hardened target later.

> ⚠ The Asterisk ⇄ Meta leg (TLS handshake, digest auth, SRTP) can only be fully
> validated ON THE BOX against a live test call. Treat these configs as a
> grounded starting skeleton, not a guaranteed-first-try setup.

---

## Prerequisites (verify BEFORE anything else)

1. **The WhatsApp number is on the Cloud API** (not the WhatsApp Business app).
2. **Daily messaging limit ≥ 2,000** unique recipients (Meta's gate for Calling).
3. App in **Live mode**, `whatsapp_business_management` with **Advanced access**
   (needed to read the Meta-generated SIP password).
4. DNS: **`sip.codentra.pk` → VPS IP, Cloudflare grey-cloud (DNS-only)** — DONE ✅.
   SIP/RTP can't be proxied by Cloudflare.

---

## Step 1 — Firewall / ports (VPS)

Open on the VPS host (ufw + Hostinger panel):

| Port | Proto | Purpose |
|---|---|---|
| 5061 | TCP | SIP over TLS (Meta ⇄ Asterisk) |
| 8089 | TCP | WSS (browser softphone ⇄ Asterisk) — via Traefik |
| 10000–20000 | UDP | RTP media (audio) — **the #1 "connects but no audio" gotcha** |

Also allowlist Meta's **Cloud API webhook IP ranges** for SIP signalling + media
(Meta publishes them; apply to the packet source IP, not SIP `Via` headers).

## Step 2 — TLS cert for `sip.codentra.pk`

The cert subject MUST cover `sip.codentra.pk`. Two options:

- **Reuse Traefik's Let's Encrypt** cert (preferred): export the cert+key from
  Traefik's `acme.json` for `sip.codentra.pk` into `./certs/` (fullchain.pem +
  privkey.pem), or run a tiny certbot sidecar. A router that terminates TLS at
  Traefik does NOT work for raw SIP — Asterisk must hold the cert itself for 5061.
- Verify once it's in place:
  ```
  openssl s_client -quiet -verify_hostname sip.codentra.pk -connect sip.codentra.pk:5061
  ```

## Step 3 — Build & run the Asterisk container (VPS)

1. Copy this `deploy/asterisk/` dir to the VPS under `/docker/codesapp/asterisk/`.
2. Put the cert at `/docker/codesapp/asterisk/certs/{fullchain.pem,privkey.pem}`.
3. Fill `/docker/codesapp/asterisk/.env` from `.env.example` (public IP, the
   Meta SIP password from Step 4, the agent SIP secret).
4. Merge the `asterisk` service from `docker-compose.asterisk.yml` into the VPS
   `/docker/codesapp/docker-compose.yml`, then:
   ```
   docker compose up -d asterisk
   docker compose logs -f asterisk
   ```

## Step 4 — Enable SIP on the number (Graph API — NOT the Meta UI)

SIP can only be enabled via the Graph API. Use `meta-enable-sip.http` (REST
Client / Postman). Summary:

```
POST https://graph.facebook.com/v21.0/<PHONE_NUMBER_ID>/settings
Authorization: Bearer <SYSTEM_USER_TOKEN>
{
  "calling": {
    "status": "ENABLED",
    "sip": {
      "status": "ENABLED",
      "webhook_delivery": "ENABLED",
      "servers": [{ "hostname": "sip.codentra.pk", "port": 5061 }]
    },
    "srtp_key_exchange_protocol": "SDES"
  }
}
```

Then **retrieve the Meta-generated SIP password**:
```
GET https://graph.facebook.com/v21.0/<PHONE_NUMBER_ID>/settings?include_sip_credentials=true
```
→ `calling.sip.servers[0].sip_user_password` + `app_id`. Put the password in the
Asterisk `.env` as `META_SIP_PASSWORD` and the number as `BUSINESS_NUMBER`
(normalized, `+<E.164>`). The **App ID** goes in the Meta dialog's "App ID" field.

Also subscribe the app to the **`calls`** webhook field so `call_created` /
`terminate` events fire.

## Step 5 — Agent softphone

- Quick proof: register free **MicroSIP** (Windows) / **Zoiper** to
  `sip.codentra.pk:5061` as endpoint `agent1` (secret from `.env`). Make/receive
  a WhatsApp call to confirm two-way audio FIRST.
- Then the in-app softphone (JsSIP over WSS 8089) + call logging land as the
  CodesApp `CallsModule` (separate PR — see the plan file).

## Step 6 — Verify end to end

1. `sngrep` on the VPS → see Meta's TLS INVITE arrive on 5061 when a test
   customer calls the number (user-initiated).
2. Asterisk challenges with 407, Meta re-INVITEs with digest creds → call rings
   `agent1`.
3. Answer → **two-way audio** (validates the RTP 10000–20000 range + NAT addrs).
4. Business-initiated: originate from Asterisk to
   `sip:+<customer>@wa.meta.vc;transport=tls` → customer's WhatsApp rings.

---

## Files
- `Dockerfile` — Asterisk 21 (Debian) with Opus + SRTP.
- `config/pjsip.conf` — TLS transport, Meta trunk (digest both ways), agent endpoints.
- `config/extensions.conf` — dialplan: inbound WA call → ring agent(s) by `tenant` param.
- `config/rtp.conf` — RTP port range + NAT external address.
- `config/asterisk.conf`, `config/logger.conf` — base.
- `docker-compose.asterisk.yml` — the service to merge into the VPS compose.
- `.env.example` — public IP, Meta SIP password, agent secret.
- `meta-enable-sip.http` — the Graph API enablement + password-retrieval calls.

## Notes / gotchas
- **No re-INVITE support** on Meta's side — keep media direct, don't hold/transfer
  mid-call via re-INVITE.
- **Business side sends the first SRTP packet** in BOTH directions (Asterisk does
  this by default when it has the remote media address).
- One SIP server per number. To rotate the password: disable SIP + empty servers,
  re-enable, re-fetch.
- When SIP is ENABLED the number **cannot use the Calling Graph API endpoints**
  (SIP owns signalling).

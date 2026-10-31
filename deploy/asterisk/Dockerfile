# Asterisk 21 for CodesApp WhatsApp Business Calling (SIP).
# Debian base with Opus + SRTP (DTLS/SDES) support. Runs as its OWN container
# alongside codesapp-app — never inside it.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Asterisk + pjproject + Opus codec + SRTP libs. The distro asterisk package
# ships chan_pjsip, res_srtp, and (via asterisk-opus or codec_opus) Opus.
RUN apt-get update && apt-get install -y --no-install-recommends \
      asterisk \
      asterisk-opus \
      asterisk-modules \
      ca-certificates \
      openssl \
    && rm -rf /var/lib/apt/lists/*

# Config is bind-mounted from ./config at runtime (see docker-compose.asterisk.yml),
# so we do NOT COPY it here — edit on the host and `docker restart asterisk`.
# Certs are bind-mounted from ./certs.

# SIP-TLS signalling + WSS softphone. RTP media range is published via the
# compose file (host networking is simplest for RTP on a single VPS).
EXPOSE 5061/tcp 8089/tcp

# Foreground, no realtime priority (shared VPS), verbose to container logs.
CMD ["asterisk", "-f", "-vvv"]

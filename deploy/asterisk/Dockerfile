# Asterisk for CodesApp WhatsApp Business Calling (SIP).
# Debian DROPPED the asterisk package in bookworm, so we build from Ubuntu
# (universe still ships asterisk, with pjsip + Opus passthrough + SRTP).
# Runs as its OWN container alongside codesapp-app — never inside it.
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      asterisk ca-certificates openssl curl \
    && rm -rf /var/lib/apt/lists/*
# SIP-TLS signalling + WSS softphone. RTP (10000-20000/udp) uses host networking.
EXPOSE 5061/tcp 8089/tcp
CMD ["asterisk","-f","-vvv"]

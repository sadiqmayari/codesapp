#!/bin/bash
# CodesApp host memory alert (runs from root's crontab every 2 minutes).
# Logs a snapshot when available RAM is low and emails SUPER_ADMIN_EMAIL
# (via the app's SMTP settings in /docker/codesapp/.env) at most once an hour.
# Also flags any kernel OOM kill since the last run.
set -u
ENV_FILE=/docker/codesapp/.env
LOG=/var/log/codesapp-mem.log
STATE=/var/tmp/codesapp-mem-alert
WARN_MB=${WARN_MB:-700}

avail=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
swap_free=$(awk '/SwapFree/ {print int($2/1024)}' /proc/meminfo)
since=$(cat "$STATE.oomcheck" 2>/dev/null || date -d '-2 min' '+%Y-%m-%d %H:%M:%S')
date '+%Y-%m-%d %H:%M:%S' > "$STATE.oomcheck"
ooms=$(journalctl -k --since "$since" 2>/dev/null | grep -c "Out of memory: Killed")

[ "$avail" -ge "$WARN_MB" ] && [ "$ooms" -eq 0 ] && exit 0

snapshot=$(docker stats --no-stream --format '{{.Name}}  {{.MemUsage}}  {{.CPUPerc}}' 2>/dev/null | sort -k2 -h)
echo "$(date '+%F %T') avail=${avail}MB swap_free=${swap_free}MB ooms=${ooms}" >> "$LOG"
echo "$snapshot" >> "$LOG"

last=$(cat "$STATE.sent" 2>/dev/null || echo 0)
now=$(date +%s)
[ $((now - last)) -lt 3600 ] && [ "$ooms" -eq 0 ] && exit 0
echo "$now" > "$STATE.sent"

get() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }
HOST=$(get SMTP_HOST); PORT=$(get SMTP_PORT); USER=$(get SMTP_USER); PASS=$(get SMTP_PASS)
FROM=$(get SMTP_FROM); TO=$(get SUPER_ADMIN_EMAIL)
[ -z "$HOST" ] || [ -z "$TO" ] && exit 0
FROM_ADDR=$(echo "$FROM" | grep -oE '[^<> ]+@[^<> ]+' | head -1)
[ -z "$FROM_ADDR" ] && FROM_ADDR="$USER"
SCHEME=smtp; [ "$PORT" = "465" ] && SCHEME=smtps

MAIL=$(mktemp)
cat > "$MAIL" <<EOF
From: CodesApp Monitor <$FROM_ADDR>
To: $TO
Subject: [CodesApp] Server memory low: ${avail} MB free$( [ "$ooms" -gt 0 ] && echo ", ${ooms} OOM kill(s)")

The production server (apps.codentra.pk) is low on memory.

Available RAM: ${avail} MB (alert below ${WARN_MB} MB)
Free swap:     ${swap_free} MB
OOM kills since last check: ${ooms}

Containers (memory, CPU):
${snapshot}

Log: ${LOG}
EOF
curl -s --max-time 20 --url "${SCHEME}://${HOST}:${PORT:-587}" --ssl-reqd \
  --mail-from "$FROM_ADDR" --mail-rcpt "$TO" --user "$USER:$PASS" --upload-file "$MAIL" >/dev/null 2>&1
rm -f "$MAIL"

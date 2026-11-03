#!/bin/sh
# Self-heal the Asterisk ODBC DSN when the codesapp-mysql container's bridge IP
# changes (a host reboot or mysql recreate can reassign it). Asterisk runs
# network_mode:host, so it cannot resolve codesapp-mysql by Docker DNS and the
# DSN must carry the literal IP — this keeps it current without downtime.
# Installed as a root cron (*/2). See memory project_whatsapp_calling_sip.
INI=/docker/codesapp/asterisk/config/odbc.ini
IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' codesapp-mysql 2>/dev/null | tr -d '[:space:]')
[ -z "$IP" ] && exit 0
CUR=$(grep -E '^[[:space:]]*Server[[:space:]]*=' "$INI" 2>/dev/null | head -1 | sed 's/.*=[[:space:]]*//' | tr -d '[:space:]')
[ "$IP" = "$CUR" ] && exit 0
sed -i "s/^\([[:space:]]*Server[[:space:]]*=[[:space:]]*\).*/\1$IP/" "$INI"
docker exec codesapp-asterisk asterisk -rx "module reload res_odbc.so" >/dev/null 2>&1
docker exec codesapp-asterisk asterisk -rx "module reload res_config_odbc.so" >/dev/null 2>&1
logger -t codesapp-odbc-heal "ODBC DSN Server updated ${CUR:-none} -> $IP" 2>/dev/null || true

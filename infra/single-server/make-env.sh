#!/bin/sh
# Writes /etc/puet/pulse.env for the single-server setup with fresh random
# secrets (openssl rand). Run once as root; it refuses to overwrite.
#   sudo sh infra/single-server/make-env.sh pulse.example.org sso.example.org meet.example.org
set -eu

PULSE_HOST="${1:?usage: make-env.sh <pulse host> <sso host> <meet host>}"
SSO_HOST="${2:?usage: make-env.sh <pulse host> <sso host> <meet host>}"
MEET_HOST="${3:?usage: make-env.sh <pulse host> <sso host> <meet host>}"
OUT="${PULSE_ENV_OUT:-/etc/puet/pulse.env}"

[ -e "$OUT" ] && { echo "$OUT already exists; refusing to overwrite" >&2; exit 1; }
hex() { openssl rand -hex "$1"; }

CLAMAV_IMAGE=clamav/clamav:1.4.7-debian   # multi-arch: amd64 and arm64

PG_PASS=$(hex 24); REDIS_PASS=$(hex 24); MINIO_ROOT=$(hex 24); MINIO_API=$(hex 24)
LK_KEY="pulse$(hex 6)"; LK_SECRET=$(hex 32)

umask 077
mkdir -p "$(dirname "$OUT")"
cat > "$OUT" <<EOF
# PUET.Pulse settings, generated $(date -u +%Y-%m-%dT%H:%MZ). Keep secret (mode 0600). See .env.example.
NODE_ENV=production
PULSE_HOST=$PULSE_HOST
SSO_HOST=$SSO_HOST

POSTGRES_USER=puet
POSTGRES_PASSWORD=$PG_PASS
POSTGRES_DB=puet_pulse
DATABASE_URL=postgresql://puet:$PG_PASS@127.0.0.1:5432/puet_pulse?schema=public

REDIS_PASSWORD=$REDIS_PASS
REDIS_URL=redis://:$REDIS_PASS@127.0.0.1:6379/0

MINIO_ROOT_USER=puet-admin
MINIO_ROOT_PASSWORD=$MINIO_ROOT
MINIO_KMS_SECRET_KEY=puet-pulse-kms:$(openssl rand -base64 32)
S3_ENDPOINT=http://127.0.0.1:9000
S3_BUCKET_ATTACHMENTS=puet-attachments
S3_BUCKET_QUARANTINE=puet-quarantine
S3_ACCESS_KEY_ID=puet-api
S3_SECRET_ACCESS_KEY=$MINIO_API
S3_REGION=us-east-1

CLAMAV_IMAGE=$CLAMAV_IMAGE
CLAMAV_HOST=127.0.0.1
CLAMAV_PORT=3310

API_PORT=3000
TRUSTED_PROXIES=127.0.0.1
WEB_ORIGIN=https://$PULSE_HOST

KC_BOOTSTRAP_ADMIN_PASSWORD=$(hex 16)
OIDC_ISSUER_URL=https://$SSO_HOST/realms/puet
OIDC_CLIENT_ID=puet-pulse
OIDC_CLIENT_SECRET=$(hex 32)
OIDC_REDIRECT_URI=https://$PULSE_HOST/api/auth/callback
OIDC_POST_LOGOUT_REDIRECT_URI=https://$PULSE_HOST/
SESSION_ABSOLUTE_HOURS=10
SESSION_IDLE_MINUTES=30

# "pilot": loads people from JSON files (pnpm sync:send) until HR / ЄДЕБО / ERP are connected.
INTEGRATION_CLIENTS={"pilot":{"id":"00000000-0000-4000-8000-00000000a001","secret":"$(hex 32)","tenantCode":"PUET_MAIN","kinds":["HR_STAFF","EDEBO_STUDENTS","TEACHING_LOAD","OFFBOARDING"]}}

E2EE_SERVER_NAME=$PULSE_HOST
JOBS_ENABLED=true
FILE_MAX_MB=50
FILE_SCAN_INLINE=true
PKI_CA_CERT_FILE=/etc/puet/ca/ca.crt.pem
PKI_CA_KEY_FILE=/etc/puet/ca/ca.key.pem
PKI_PUBLIC_URL=https://$PULSE_HOST/api
VERIFY_CODE_SECRET=$(hex 32)
TRUST_INTAKE_SECRET=$(hex 32)
MINOR_LINK_HOSTS=
SCHEDULE_LINK_HOSTS=moodle.puet.edu.ua

LIVEKIT_URL=http://127.0.0.1:7880
LIVEKIT_PUBLIC_URL=wss://$MEET_HOST
LIVEKIT_API_KEY=$LK_KEY
LIVEKIT_API_SECRET=$LK_SECRET

ADMISSIONS_ANSWERS=extractive
EOF
# The API service (user puet-pulse) reads it; nobody else.
if getent group puet-pulse >/dev/null 2>&1; then chgrp puet-pulse "$OUT" && chmod 640 "$OUT"; fi
echo "Written $OUT (root:puet-pulse, mode 0640). LiveKit API key: $LK_KEY (put it into infra/single-server/livekit.yaml, webhook.api_key)."

#!/bin/sh
# Nightly backup for the single-server setup (docs/SERVER_SETUP.md, step 15):
# PostgreSQL (messenger + Keycloak), the file buckets and /etc/puet, kept 14 days
# in /var/backups/puet. Copy that folder off the server too (rclone, rsync):
# a backup on the same disk does not survive the loss of the server.
#   sudo crontab -e   ->   30 2 * * * sh /srv/puet-pulse/app/infra/single-server/backup.sh
set -eu
APP=/srv/puet-pulse/app
ENV=/etc/puet/pulse.env
DEST=/var/backups/puet
STAMP=$(date +%Y%m%d-%H%M)
COMPOSE="docker compose --env-file $ENV -f $APP/docker-compose.yml -f $APP/infra/single-server/docker-compose.server.yml"

umask 077
mkdir -p "$DEST/$STAMP"
cd "$APP"
for db in puet_pulse keycloak; do
  $COMPOSE exec -T postgres sh -c "pg_dump -U \"\$POSTGRES_USER\" -Fc $db" > "$DEST/$STAMP/$db.dump"
done
# Files: a consistent copy of the MinIO data through the S3 API (keeps SSE, needs the root account).
$COMPOSE run --rm -T --entrypoint sh -v "$DEST/$STAMP:/backup" minio-init -c \
  'mc alias set puet http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null &&
   mc mirror --quiet puet/$S3_BUCKET_ATTACHMENTS /backup/attachments'
tar -C / -czf "$DEST/$STAMP/etc-puet.tgz" etc/puet
find "$DEST" -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} +
echo "Backup written to $DEST/$STAMP"

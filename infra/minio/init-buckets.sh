#!/bin/sh
# Creates PUET.Pulse buckets with default server-side encryption (SSE-S3, AES-256)
# and no anonymous access. Safe to run repeatedly.
set -eu

mc alias set puet http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null

for bucket in "$S3_BUCKET_ATTACHMENTS" "$S3_BUCKET_QUARANTINE"; do
  mc mb --ignore-existing "puet/$bucket"
  mc encrypt set sse-s3 "puet/$bucket"
  mc anonymous set none "puet/$bucket"
  mc version enable "puet/$bucket"
done

# Unscanned uploads land in quarantine and expire after 7 days if never released.
mc ilm rule add --expire-days 7 "puet/$S3_BUCKET_QUARANTINE" || true

echo "MinIO buckets ready."

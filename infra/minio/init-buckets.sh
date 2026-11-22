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

# Dedicated API account (not the root user): read/write on the two buckets only.
if [ -n "${S3_ACCESS_KEY_ID:-}" ] && [ -n "${S3_SECRET_ACCESS_KEY:-}" ]; then
  cat > /tmp/puet-api-policy.json <<POLICY
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:GetBucketLocation", "s3:ListBucket"],
      "Resource": ["arn:aws:s3:::$S3_BUCKET_ATTACHMENTS", "arn:aws:s3:::$S3_BUCKET_QUARANTINE"] },
    { "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": ["arn:aws:s3:::$S3_BUCKET_ATTACHMENTS/*", "arn:aws:s3:::$S3_BUCKET_QUARANTINE/*"] }
  ]
}
POLICY
  mc admin user add puet "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" >/dev/null
  mc admin policy create puet puet-api /tmp/puet-api-policy.json >/dev/null 2>&1 || true
  mc admin policy attach puet puet-api --user "$S3_ACCESS_KEY_ID" >/dev/null 2>&1 || true
  rm -f /tmp/puet-api-policy.json
  echo "MinIO API account ready."
fi

echo "MinIO buckets ready."

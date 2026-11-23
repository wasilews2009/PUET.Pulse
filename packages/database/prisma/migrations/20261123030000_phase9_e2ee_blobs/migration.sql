-- CreateTable
CREATE TABLE "encrypted_blobs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "uploader_id" UUID NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "encrypted_blobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "encrypted_blobs_channel_id_created_at_idx" ON "encrypted_blobs"("channel_id", "created_at");

-- CreateIndex
CREATE INDEX "encrypted_blobs_expires_at_idx" ON "encrypted_blobs"("expires_at");

-- AddForeignKey
ALTER TABLE "encrypted_blobs" ADD CONSTRAINT "encrypted_blobs_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Guardrails (not expressible in Prisma)
ALTER TABLE "encrypted_blobs" ADD CONSTRAINT "encrypted_blobs_sha256_hex" CHECK ("sha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "encrypted_blobs" ADD CONSTRAINT "encrypted_blobs_size_check" CHECK ("size_bytes" > 0);
-- Only end-to-end encrypted rooms hold encrypted blobs, in the channel's own tenant;
-- a blob never changes (its bytes are addressed by the hash).
CREATE OR REPLACE FUNCTION encrypted_blobs_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'encrypted_blobs: rows are immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "channels" c
    WHERE c."id" = NEW."channel_id" AND c."tenant_id" = NEW."tenant_id" AND c."e2ee_mode" <> 'DISABLED'
  ) THEN
    RAISE EXCEPTION 'encrypted_blobs: only end-to-end encrypted channels of the same tenant';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER encrypted_blobs_guard BEFORE INSERT OR UPDATE ON "encrypted_blobs"
  FOR EACH ROW EXECUTE FUNCTION encrypted_blobs_guard();

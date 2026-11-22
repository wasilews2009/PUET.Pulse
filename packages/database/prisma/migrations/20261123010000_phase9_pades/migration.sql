-- AlterTable
ALTER TABLE "document_signatures" ADD COLUMN     "signed_copy_sha256" TEXT;

-- CreateTable
CREATE TABLE "pades_drafts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "certificate_id" UUID NOT NULL,
    "base_sha256" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pades_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pades_drafts_expires_at_idx" ON "pades_drafts"("expires_at");

-- AddForeignKey
ALTER TABLE "pades_drafts" ADD CONSTRAINT "pades_drafts_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "file_objects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pades_drafts" ADD CONSTRAINT "pades_drafts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Guardrails (not expressible in Prisma)
-- A PAdES signature records the hash of its signed copy; other formats never do.
ALTER TABLE "document_signatures" ADD CONSTRAINT "document_signatures_pades_copy_check"
  CHECK (("format" LIKE 'PAdES%') = ("signed_copy_sha256" IS NOT NULL));
ALTER TABLE "pades_drafts" ADD CONSTRAINT "pades_drafts_expiry_check" CHECK ("expires_at" > "created_at");

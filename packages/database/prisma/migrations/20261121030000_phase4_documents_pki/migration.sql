-- CreateEnum
CREATE TYPE "AnnotationVisibility" AS ENUM ('PRIVATE', 'SHARED');

-- AlterTable
ALTER TABLE "approval_routes" ADD COLUMN     "tenant_id" UUID NOT NULL;

-- AlterTable
ALTER TABLE "approval_steps" ADD COLUMN     "require_signature" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "document_signatures" ADD COLUMN     "claimed_signing_time" TIMESTAMP(3),
ADD COLUMN     "revocation_checked_at" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "revocation_source" TEXT NOT NULL,
ADD COLUMN     "signer_id" UUID NOT NULL;

-- AlterTable
ALTER TABLE "file_objects" ADD COLUMN     "malware_name" TEXT,
ADD COLUMN     "page_count" INTEGER,
ADD COLUMN     "scan_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "scanned_at" TIMESTAMP(3),
ADD COLUMN     "served_sha256" TEXT,
ADD COLUMN     "served_size" BIGINT;

-- AlterTable
ALTER TABLE "pdf_annotations" ADD COLUMN     "visibility" "AnnotationVisibility" NOT NULL DEFAULT 'PRIVATE';

-- AlterTable
ALTER TABLE "user_certificates" ADD COLUMN     "public_key_sha256" TEXT;

-- CreateIndex
CREATE INDEX "approval_routes_file_id_status_idx" ON "approval_routes"("file_id", "status");

-- CreateIndex
CREATE INDEX "approval_steps_approver_id_status_idx" ON "approval_steps"("approver_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "document_signatures_file_id_certificate_id_key" ON "document_signatures"("file_id", "certificate_id");

-- CreateIndex
CREATE INDEX "file_objects_scan_status_created_at_idx" ON "file_objects"("scan_status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "user_certificates_public_key_sha256_key" ON "user_certificates"("public_key_sha256");

-- AddForeignKey
ALTER TABLE "pdf_annotations" ADD CONSTRAINT "pdf_annotations_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_signatures" ADD CONSTRAINT "document_signatures_signer_id_fkey" FOREIGN KEY ("signer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_routes" ADD CONSTRAINT "approval_routes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_routes" ADD CONSTRAINT "approval_routes_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ───────────── Hand-written guardrails (Phase 4) ─────────────

-- A file is released (served) only after ClamAV marked it CLEAN, and a PDF only
-- through its CDR-sanitized copy.
ALTER TABLE "file_objects" ADD CONSTRAINT "file_objects_sanitized_only_when_clean"
  CHECK ("sanitized_key" IS NULL OR ("scan_status" = 'CLEAN' AND "cdr_status" = 'SANITIZED'));
ALTER TABLE "file_objects" ADD CONSTRAINT "file_objects_served_only_when_clean"
  CHECK ("served_sha256" IS NULL OR "scan_status" = 'CLEAN');
-- Confidential (view-only, watermarked) documents must be PDFs.
ALTER TABLE "file_objects" ADD CONSTRAINT "file_objects_confidential_is_pdf"
  CHECK (NOT "confidential" OR "mime_type" = 'application/pdf');
ALTER TABLE "file_objects" ADD CONSTRAINT "file_objects_sha256_hex"
  CHECK ("sha256" ~ '^[0-9a-f]{64}$' AND ("served_sha256" IS NULL OR "served_sha256" ~ '^[0-9a-f]{64}$'));

-- One active internal (УЕП) certificate per person at a time.
CREATE UNIQUE INDEX "user_certificates_one_active_internal"
  ON "user_certificates" ("user_id") WHERE "status" = 'ACTIVE' AND "provider" = 'INTERNAL_PKI';
-- Only the status columns of a certificate may change after issuance.
CREATE OR REPLACE FUNCTION user_certificates_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW."certificate_pem" IS DISTINCT FROM OLD."certificate_pem"
     OR NEW."serial_number" IS DISTINCT FROM OLD."serial_number"
     OR NEW."fingerprint_sha256" IS DISTINCT FROM OLD."fingerprint_sha256"
     OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
     OR NEW."provider" IS DISTINCT FROM OLD."provider" THEN
    RAISE EXCEPTION 'user_certificates: certificate material is immutable';
  END IF;
  IF OLD."status" = 'REVOKED' AND NEW."status" <> 'REVOKED' THEN
    RAISE EXCEPTION 'user_certificates: a revoked certificate cannot be reinstated';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER user_certificates_immutable BEFORE UPDATE ON "user_certificates"
  FOR EACH ROW EXECUTE FUNCTION user_certificates_immutable();
ALTER TABLE "user_certificates" ADD CONSTRAINT "user_certificates_revocation_consistent"
  CHECK (("status" = 'REVOKED') = ("revoked_at" IS NOT NULL));

-- Signatures are evidence: append-only.
CREATE OR REPLACE FUNCTION document_signatures_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'document_signatures is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER document_signatures_no_update BEFORE UPDATE OR DELETE ON "document_signatures"
  FOR EACH ROW EXECUTE FUNCTION document_signatures_append_only();
CREATE TRIGGER document_signatures_no_truncate BEFORE TRUNCATE ON "document_signatures"
  FOR EACH STATEMENT EXECUTE FUNCTION document_signatures_append_only();
ALTER TABLE "document_signatures" ADD CONSTRAINT "document_signatures_digest_hex"
  CHECK ("signed_digest" ~ '^[0-9a-f]{64}$');

-- At most one open approval route per document.
CREATE UNIQUE INDEX "approval_routes_one_pending_per_file"
  ON "approval_routes" ("file_id") WHERE "status" = 'PENDING';
-- An approved step that requires a signature must reference one.
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_signed_when_required"
  CHECK ("status" <> 'APPROVED' OR NOT "require_signature" OR "signature_id" IS NOT NULL);
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_decided_at"
  CHECK (("status" = 'PENDING' OR "status" = 'CANCELLED') OR "decided_at" IS NOT NULL);
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_position_positive" CHECK ("position" >= 1);

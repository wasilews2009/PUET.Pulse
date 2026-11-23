-- Database-level guardrails that Prisma's schema language cannot express.

-- 1. Audit log is append-only. Block UPDATE, DELETE and TRUNCATE for every role,
--    including the application role. Retention/archival is done by exporting to SIEM
--    and dropping whole partitions under a separate, audited DBA procedure.
CREATE OR REPLACE FUNCTION audit_logs_block_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only (% blocked)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_block_mutation();

CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_block_mutation();

-- 2. Cross-tenant role grants (tenant_id IS NULL) only for SUPER_ADMIN and RECTORATE.
ALTER TABLE "role_assignments"
  ADD CONSTRAINT role_assignments_cross_tenant_roles
  CHECK ("tenant_id" IS NOT NULL OR "role" IN ('SUPER_ADMIN', 'RECTORATE'));

-- 3. A message carries either plaintext (E2EE disabled) or ciphertext, never both.
ALTER TABLE "messages"
  ADD CONSTRAINT messages_body_xor_ciphertext
  CHECK (NOT ("body" IS NOT NULL AND "ciphertext" IS NOT NULL));

-- 4. Ephemeral TTL is limited to the values in the specification: 1h, 24h, 7d.
ALTER TABLE "channels"
  ADD CONSTRAINT channels_message_ttl_values
  CHECK ("message_ttl_seconds" IS NULL OR "message_ttl_seconds" IN (3600, 86400, 604800));

-- 5. Channels with mandatory E2EE can never store plaintext bodies.
CREATE OR REPLACE FUNCTION messages_enforce_e2ee() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  mode "E2eeMode";
BEGIN
  SELECT "e2ee_mode" INTO mode FROM "channels" WHERE "id" = NEW."channel_id";
  IF mode = 'MANDATORY' AND NEW."body" IS NOT NULL THEN
    RAISE EXCEPTION 'channel % requires end-to-end encryption', NEW."channel_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER messages_e2ee_guard
  BEFORE INSERT OR UPDATE ON "messages"
  FOR EACH ROW EXECUTE FUNCTION messages_enforce_e2ee();

-- 6. Quiet hours bounds.
ALTER TABLE "quiet_hours_schedules"
  ADD CONSTRAINT quiet_hours_minutes_range
  CHECK ("start_minute" BETWEEN 0 AND 1439 AND "end_minute" BETWEEN 0 AND 1439);

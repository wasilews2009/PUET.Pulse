-- CreateEnum
CREATE TYPE "MembershipSource" AS ENUM ('AUTO', 'MANUAL');

-- CreateEnum
CREATE TYPE "EncryptionScheme" AS ENUM ('NONE', 'MEGOLM', 'OLM');

-- AlterTable
ALTER TABLE "channel_members" ADD COLUMN     "last_read_at" TIMESTAMP(3),
ADD COLUMN     "source" "MembershipSource" NOT NULL DEFAULT 'MANUAL';

-- AlterTable
ALTER TABLE "channels" ADD COLUMN     "direct_key" TEXT,
ADD COLUMN     "provision_key" TEXT;

-- AlterTable
ALTER TABLE "devices" ADD COLUMN     "device_keys" JSONB,
ADD COLUMN     "keys_updated_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "client_message_id" TEXT,
ADD COLUMN     "scheme" "EncryptionScheme" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "sender_device_id" UUID;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "presence_until" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "device_one_time_keys" (
    "id" BIGSERIAL NOT NULL,
    "device_id" UUID NOT NULL,
    "key_id" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL,
    "key" JSONB NOT NULL,
    "fallback" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_one_time_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cross_signing_keys" (
    "user_id" UUID NOT NULL,
    "usage" TEXT NOT NULL,
    "key" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cross_signing_keys_pkey" PRIMARY KEY ("user_id","usage")
);

-- CreateTable
CREATE TABLE "to_device_messages" (
    "id" BIGSERIAL NOT NULL,
    "recipient_device_id" UUID NOT NULL,
    "sender_user_id" UUID NOT NULL,
    "sender_device_id" UUID,
    "event_type" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "to_device_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "key_backup_versions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "algorithm" TEXT NOT NULL,
    "auth_data" JSONB NOT NULL,
    "etag" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "key_backup_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "key_backup_sessions" (
    "version_id" UUID NOT NULL,
    "room_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "key_backup_sessions_pkey" PRIMARY KEY ("version_id","room_id","session_id")
);

-- CreateTable
CREATE TABLE "user_secrets" (
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "ciphertext" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_secrets_pkey" PRIMARY KEY ("user_id","name")
);

-- CreateIndex
CREATE INDEX "device_one_time_keys_device_id_fallback_algorithm_idx" ON "device_one_time_keys"("device_id", "fallback", "algorithm");

-- CreateIndex
CREATE UNIQUE INDEX "device_one_time_keys_device_id_key_id_fallback_key" ON "device_one_time_keys"("device_id", "key_id", "fallback");

-- CreateIndex
CREATE INDEX "to_device_messages_recipient_device_id_id_idx" ON "to_device_messages"("recipient_device_id", "id");

-- CreateIndex
CREATE INDEX "key_backup_versions_user_id_deleted_at_idx" ON "key_backup_versions"("user_id", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "channels_direct_key_key" ON "channels"("direct_key");

-- CreateIndex
CREATE UNIQUE INDEX "channels_provision_key_key" ON "channels"("provision_key");

-- CreateIndex
CREATE INDEX "devices_keys_updated_at_idx" ON "devices"("keys_updated_at");

-- CreateIndex
CREATE INDEX "messages_thread_root_id_created_at_idx" ON "messages"("thread_root_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "messages_sender_id_client_message_id_key" ON "messages"("sender_id", "client_message_id");

-- AddForeignKey
ALTER TABLE "device_one_time_keys" ADD CONSTRAINT "device_one_time_keys_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cross_signing_keys" ADD CONSTRAINT "cross_signing_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "to_device_messages" ADD CONSTRAINT "to_device_messages_recipient_device_id_fkey" FOREIGN KEY ("recipient_device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "key_backup_versions" ADD CONSTRAINT "key_backup_versions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "key_backup_sessions" ADD CONSTRAINT "key_backup_sessions_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "key_backup_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_secrets" ADD CONSTRAINT "user_secrets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ───────────── Phase 3 guardrails (hand-written) ─────────────

-- The storage scheme must match the payload: plaintext only with NONE, ciphertext only with E2EE schemes.
ALTER TABLE "messages"
  ADD CONSTRAINT messages_scheme_matches_payload
  CHECK (
    ("scheme" = 'NONE' AND "ciphertext" IS NULL)
    OR ("scheme" <> 'NONE' AND "body" IS NULL)
  );

-- MANDATORY E2EE channels never store plaintext; DISABLED channels (official,
-- searchable, safe for minors) never store ciphertext the moderators cannot read.
CREATE OR REPLACE FUNCTION messages_enforce_e2ee() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  mode "E2eeMode";
BEGIN
  SELECT "e2ee_mode" INTO mode FROM "channels" WHERE "id" = NEW."channel_id";
  IF mode = 'MANDATORY' AND (NEW."body" IS NOT NULL OR NEW."scheme" = 'NONE') THEN
    RAISE EXCEPTION 'channel % requires end-to-end encryption', NEW."channel_id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF mode = 'DISABLED' AND (NEW."ciphertext" IS NOT NULL OR NEW."scheme" <> 'NONE') THEN
    RAISE EXCEPTION 'channel % does not allow end-to-end encryption', NEW."channel_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- A DIRECT channel is identified by its pair key; other types never carry one.
ALTER TABLE "channels"
  ADD CONSTRAINT channels_direct_key_only_for_direct
  CHECK (("type" = 'DIRECT') = ("direct_key" IS NOT NULL));

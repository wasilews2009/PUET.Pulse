-- CreateEnum
CREATE TYPE "CallKind" AS ENUM ('CHANNEL', 'CONSULTATION');

-- CreateEnum
CREATE TYPE "ConsultationMode" AS ENUM ('ONLINE', 'OFFLINE');

-- CreateEnum
CREATE TYPE "ConsultationSlotStatus" AS ENUM ('ACTIVE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ConsultationBookingStatus" AS ENUM ('BOOKED', 'CANCELLED');

-- CreateTable
CREATE TABLE "calls" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "CallKind" NOT NULL,
    "channel_id" UUID,
    "slot_id" UUID,
    "message_id" UUID,
    "started_by_id" UUID NOT NULL,
    "room_name" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "ended_by_id" UUID,

    CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_participants" (
    "call_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "first_joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_participants_pkey" PRIMARY KEY ("call_id","user_id")
);

-- CreateTable
CREATE TABLE "consultation_slots" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "host_id" UUID NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 1,
    "mode" "ConsultationMode" NOT NULL,
    "location" TEXT,
    "course_offering_id" UUID,
    "note" TEXT,
    "status" "ConsultationSlotStatus" NOT NULL DEFAULT 'ACTIVE',
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consultation_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consultation_bookings" (
    "id" UUID NOT NULL,
    "slot_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "topic" TEXT,
    "status" "ConsultationBookingStatus" NOT NULL DEFAULT 'BOOKED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelled_at" TIMESTAMP(3),

    CONSTRAINT "consultation_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "calls_message_id_key" ON "calls"("message_id");

-- CreateIndex
CREATE UNIQUE INDEX "calls_room_name_key" ON "calls"("room_name");

-- CreateIndex
CREATE INDEX "calls_channel_id_started_at_idx" ON "calls"("channel_id", "started_at");

-- CreateIndex
CREATE INDEX "calls_slot_id_idx" ON "calls"("slot_id");

-- CreateIndex
CREATE INDEX "calls_ended_at_idx" ON "calls"("ended_at");

-- CreateIndex
CREATE INDEX "consultation_slots_host_id_starts_at_idx" ON "consultation_slots"("host_id", "starts_at");

-- CreateIndex
CREATE INDEX "consultation_slots_tenant_id_starts_at_idx" ON "consultation_slots"("tenant_id", "starts_at");

-- CreateIndex
CREATE INDEX "consultation_bookings_slot_id_status_idx" ON "consultation_bookings"("slot_id", "status");

-- CreateIndex
CREATE INDEX "consultation_bookings_student_id_status_idx" ON "consultation_bookings"("student_id", "status");

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "consultation_slots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_started_by_id_fkey" FOREIGN KEY ("started_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_participants" ADD CONSTRAINT "call_participants_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_participants" ADD CONSTRAINT "call_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultation_slots" ADD CONSTRAINT "consultation_slots_host_id_fkey" FOREIGN KEY ("host_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultation_slots" ADD CONSTRAINT "consultation_slots_course_offering_id_fkey" FOREIGN KEY ("course_offering_id") REFERENCES "course_offerings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultation_bookings" ADD CONSTRAINT "consultation_bookings_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "consultation_slots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultation_bookings" ADD CONSTRAINT "consultation_bookings_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ───────────────────────── Phase 7 guardrails (hand-written) ─────────────────────────

-- A call belongs to exactly one place: a channel (with its timeline message) or a consultation slot.
ALTER TABLE "calls" ADD CONSTRAINT "calls_kind_target" CHECK (
  (kind = 'CHANNEL' AND channel_id IS NOT NULL AND slot_id IS NULL AND message_id IS NOT NULL)
  OR (kind = 'CONSULTATION' AND slot_id IS NOT NULL AND channel_id IS NULL AND message_id IS NULL)
);
ALTER TABLE "calls" ADD CONSTRAINT "calls_ended_after_start" CHECK (ended_at IS NULL OR ended_at >= started_at);
-- At most one live call per channel and per slot.
CREATE UNIQUE INDEX "calls_one_live_per_channel" ON "calls"("channel_id") WHERE ended_at IS NULL AND channel_id IS NOT NULL;
CREATE UNIQUE INDEX "calls_one_live_per_slot" ON "calls"("slot_id") WHERE ended_at IS NULL AND slot_id IS NOT NULL;

-- A call only ever goes from live to ended; nothing else about it changes.
CREATE OR REPLACE FUNCTION calls_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'calls: an ended call is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.kind <> OLD.kind
     OR NEW.channel_id IS DISTINCT FROM OLD.channel_id OR NEW.slot_id IS DISTINCT FROM OLD.slot_id
     OR NEW.message_id IS DISTINCT FROM OLD.message_id OR NEW.started_by_id <> OLD.started_by_id
     OR NEW.room_name <> OLD.room_name OR NEW.started_at <> OLD.started_at THEN
    RAISE EXCEPTION 'calls: only ending a call is allowed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER calls_guard BEFORE UPDATE ON "calls" FOR EACH ROW EXECUTE FUNCTION calls_guard();

-- Participation log: joins are recorded, never rewritten (only the last join time moves forward).
CREATE OR REPLACE FUNCTION call_participants_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM calls c WHERE c.id = OLD.call_id) THEN
      RAISE EXCEPTION 'call_participants: append-only' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.call_id <> OLD.call_id OR NEW.user_id <> OLD.user_id OR NEW.first_joined_at <> OLD.first_joined_at
     OR NEW.last_joined_at < OLD.last_joined_at THEN
    RAISE EXCEPTION 'call_participants: append-only' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER call_participants_guard BEFORE UPDATE OR DELETE ON "call_participants" FOR EACH ROW EXECUTE FUNCTION call_participants_guard();

-- Slots: sane times and sizes. A published slot never moves; it can only be cancelled.
ALTER TABLE "consultation_slots" ADD CONSTRAINT "consultation_slots_times" CHECK (
  ends_at > starts_at AND ends_at - starts_at <= interval '4 hours'
);
ALTER TABLE "consultation_slots" ADD CONSTRAINT "consultation_slots_capacity" CHECK (capacity BETWEEN 1 AND 50);
ALTER TABLE "consultation_slots" ADD CONSTRAINT "consultation_slots_place" CHECK (
  (mode = 'ONLINE' AND location IS NULL) OR (mode = 'OFFLINE' AND location IS NOT NULL)
);
ALTER TABLE "consultation_slots" ADD CONSTRAINT "consultation_slots_cancelled" CHECK (
  (status = 'CANCELLED') = (cancelled_at IS NOT NULL)
);

CREATE OR REPLACE FUNCTION consultation_slots_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'CANCELLED' THEN
    RAISE EXCEPTION 'consultation_slots: a cancelled slot is final' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.host_id <> OLD.host_id OR NEW.starts_at <> OLD.starts_at
     OR NEW.ends_at <> OLD.ends_at OR NEW.capacity <> OLD.capacity OR NEW.mode <> OLD.mode
     OR NEW.location IS DISTINCT FROM OLD.location OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.created_at <> OLD.created_at
     -- The course may only disappear (ON DELETE SET NULL), never be swapped.
     OR (NEW.course_offering_id IS NOT NULL AND NEW.course_offering_id IS DISTINCT FROM OLD.course_offering_id) THEN
    RAISE EXCEPTION 'consultation_slots: a published slot can only be cancelled' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER consultation_slots_guard BEFORE UPDATE ON "consultation_slots" FOR EACH ROW EXECUTE FUNCTION consultation_slots_guard();

-- One live booking per person and slot.
CREATE UNIQUE INDEX "consultation_bookings_one_live" ON "consultation_bookings"("slot_id", "student_id") WHERE status = 'BOOKED';
ALTER TABLE "consultation_bookings" ADD CONSTRAINT "consultation_bookings_cancelled" CHECK (
  (status = 'CANCELLED') = (cancelled_at IS NOT NULL)
);

-- Booking: the slot is live and in the future, has a free seat, and the host does not book themself.
-- The slot row is locked, so two last-seat bookings cannot both succeed.
CREATE OR REPLACE FUNCTION consultation_bookings_guard() RETURNS trigger AS $$
DECLARE
  s RECORD;
  taken INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM consultation_slots x WHERE x.id = OLD.slot_id) THEN
      RAISE EXCEPTION 'consultation_bookings: append-only' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'BOOKED' OR NEW.status <> 'CANCELLED' OR NEW.id <> OLD.id OR NEW.slot_id <> OLD.slot_id
       OR NEW.student_id <> OLD.student_id OR NEW.topic IS DISTINCT FROM OLD.topic OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'consultation_bookings: a booking can only be cancelled' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> 'BOOKED' THEN
    RAISE EXCEPTION 'consultation_bookings: new bookings start as BOOKED' USING ERRCODE = 'check_violation';
  END IF;
  SELECT host_id, status, starts_at, capacity INTO s FROM consultation_slots WHERE id = NEW.slot_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'consultation_bookings: unknown slot' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF s.status <> 'ACTIVE' OR s.starts_at <= now() THEN
    RAISE EXCEPTION 'consultation_bookings: slot is closed' USING ERRCODE = 'check_violation';
  END IF;
  IF s.host_id = NEW.student_id THEN
    RAISE EXCEPTION 'consultation_bookings: the host cannot book' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO taken FROM consultation_bookings b WHERE b.slot_id = NEW.slot_id AND b.status = 'BOOKED';
  IF taken >= s.capacity THEN
    RAISE EXCEPTION 'consultation_bookings: slot is full' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER consultation_bookings_guard BEFORE INSERT OR UPDATE OR DELETE ON "consultation_bookings" FOR EACH ROW EXECUTE FUNCTION consultation_bookings_guard();

CREATE OR REPLACE FUNCTION phase7_no_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '%: truncate is not allowed', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER calls_no_truncate BEFORE TRUNCATE ON "calls" EXECUTE FUNCTION phase7_no_truncate();
CREATE TRIGGER call_participants_no_truncate BEFORE TRUNCATE ON "call_participants" EXECUTE FUNCTION phase7_no_truncate();
CREATE TRIGGER consultation_bookings_no_truncate BEFORE TRUNCATE ON "consultation_bookings" EXECUTE FUNCTION phase7_no_truncate();

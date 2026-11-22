-- CreateEnum
CREATE TYPE "BotCode" AS ENUM ('DEANERY', 'SCHEDULE', 'SERVICE_DESK', 'CHANCELLERY', 'ADMISSIONS');

-- CreateEnum
CREATE TYPE "BotMessageDirection" AS ENUM ('USER', 'BOT');

-- CreateEnum
CREATE TYPE "StudentDocumentType" AS ENUM ('STUDY_CERTIFICATE', 'MILITARY_CERTIFICATE', 'INCOME_CERTIFICATE', 'ACADEMIC_TRANSCRIPT');

-- CreateEnum
CREATE TYPE "StudentDocumentStatus" AS ENUM ('REQUESTED', 'IN_PROGRESS', 'READY', 'ISSUED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StudyPlanStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'NEEDS_CHANGES');

-- CreateEnum
CREATE TYPE "ScheduleChangeKind" AS ENUM ('ROOM_CHANGE', 'CANCELLED', 'MOVED', 'ONLINE');

-- CreateEnum
CREATE TYPE "TicketCategory" AS ENUM ('IT', 'FACILITIES', 'DORMITORY');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('NEW', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'REJECTED');

-- CreateEnum
CREATE TYPE "TicketPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "TicketEventKind" AS ENUM ('CREATED', 'STATUS', 'COMMENT', 'FORWARDED', 'ASSIGNED');

-- CreateEnum
CREATE TYPE "OutboxTarget" AS ENUM ('DEANERY', 'EDO');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "IntegrationKind" ADD VALUE 'DEANERY';
ALTER TYPE "IntegrationKind" ADD VALUE 'SCHEDULE';
ALTER TYPE "IntegrationKind" ADD VALUE 'EDO';

-- AlterTable
ALTER TABLE "approval_routes" ADD COLUMN     "registered_at" TIMESTAMP(3),
ADD COLUMN     "registration_no" TEXT;

-- CreateTable
CREATE TABLE "bot_messages" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "bot" "BotCode" NOT NULL,
    "direction" "BotMessageDirection" NOT NULL,
    "body" TEXT,
    "card" JSONB,
    "read_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_document_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "type" "StudentDocumentType" NOT NULL,
    "copies" INTEGER NOT NULL DEFAULT 1,
    "purpose" TEXT,
    "status" "StudentDocumentStatus" NOT NULL DEFAULT 'REQUESTED',
    "deanery_note" TEXT,
    "external_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "student_document_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "individual_study_plans" (
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "semester_id" UUID NOT NULL,
    "status" "StudyPlanStatus" NOT NULL,
    "credits" DECIMAL(5,1),
    "note" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "individual_study_plans_pkey" PRIMARY KEY ("student_id","semester_id")
);

-- CreateTable
CREATE TABLE "schedule_changes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "course_offering_id" UUID,
    "academic_group_id" UUID,
    "date" DATE NOT NULL,
    "pair" INTEGER NOT NULL,
    "kind" "ScheduleChangeKind" NOT NULL,
    "room" TEXT,
    "new_date" DATE,
    "new_pair" INTEGER,
    "link" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedule_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_tickets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "requester_id" UUID NOT NULL,
    "category" "TicketCategory" NOT NULL,
    "priority" "TicketPriority" NOT NULL DEFAULT 'NORMAL',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "location" TEXT,
    "org_unit_id" UUID,
    "dormitory_id" UUID,
    "room_label" TEXT,
    "status" "TicketStatus" NOT NULL DEFAULT 'NEW',
    "assignee_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "resolved_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "service_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_ticket_events" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "kind" "TicketEventKind" NOT NULL,
    "status" "TicketStatus",
    "comment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_ticket_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admissions_documents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "source_sha256" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "chunk_count" INTEGER NOT NULL,
    "uploaded_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admissions_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admissions_chunks" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "heading" TEXT,
    "text" TEXT NOT NULL,

    CONSTRAINT "admissions_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_outbox" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "target" "OutboxTarget" NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),

    CONSTRAINT "integration_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bot_messages_user_id_bot_created_at_idx" ON "bot_messages"("user_id", "bot", "created_at");

-- CreateIndex
CREATE INDEX "bot_messages_expires_at_idx" ON "bot_messages"("expires_at");

-- CreateIndex
CREATE INDEX "student_document_requests_student_id_created_at_idx" ON "student_document_requests"("student_id", "created_at");

-- CreateIndex
CREATE INDEX "schedule_changes_tenant_id_date_idx" ON "schedule_changes"("tenant_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_changes_tenant_id_external_id_key" ON "schedule_changes"("tenant_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "service_tickets_number_key" ON "service_tickets"("number");

-- CreateIndex
CREATE INDEX "service_tickets_requester_id_created_at_idx" ON "service_tickets"("requester_id", "created_at");

-- CreateIndex
CREATE INDEX "service_tickets_org_unit_id_status_idx" ON "service_tickets"("org_unit_id", "status");

-- CreateIndex
CREATE INDEX "service_tickets_dormitory_id_status_idx" ON "service_tickets"("dormitory_id", "status");

-- CreateIndex
CREATE INDEX "service_ticket_events_ticket_id_created_at_idx" ON "service_ticket_events"("ticket_id", "created_at");

-- CreateIndex
CREATE INDEX "admissions_documents_tenant_id_created_at_idx" ON "admissions_documents"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "admissions_chunks_document_id_ordinal_key" ON "admissions_chunks"("document_id", "ordinal");

-- CreateIndex
CREATE INDEX "integration_outbox_status_next_attempt_at_idx" ON "integration_outbox"("status", "next_attempt_at");

-- AddForeignKey
ALTER TABLE "bot_messages" ADD CONSTRAINT "bot_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_document_requests" ADD CONSTRAINT "student_document_requests_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "individual_study_plans" ADD CONSTRAINT "individual_study_plans_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "individual_study_plans" ADD CONSTRAINT "individual_study_plans_semester_id_fkey" FOREIGN KEY ("semester_id") REFERENCES "semesters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_changes" ADD CONSTRAINT "schedule_changes_course_offering_id_fkey" FOREIGN KEY ("course_offering_id") REFERENCES "course_offerings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_changes" ADD CONSTRAINT "schedule_changes_academic_group_id_fkey" FOREIGN KEY ("academic_group_id") REFERENCES "academic_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_requester_id_fkey" FOREIGN KEY ("requester_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_org_unit_id_fkey" FOREIGN KEY ("org_unit_id") REFERENCES "org_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_dormitory_id_fkey" FOREIGN KEY ("dormitory_id") REFERENCES "dormitories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_ticket_events" ADD CONSTRAINT "service_ticket_events_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "service_tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_ticket_events" ADD CONSTRAINT "service_ticket_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admissions_documents" ADD CONSTRAINT "admissions_documents_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admissions_chunks" ADD CONSTRAINT "admissions_chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "admissions_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ───────────────────────── Phase 8 guardrails (hand-written) ─────────────────────────

-- Bot inbox: append-only; only the read marker moves (once); rows go only after they expire.
ALTER TABLE "bot_messages"
  ADD CONSTRAINT bot_messages_content CHECK (body IS NOT NULL OR card IS NOT NULL),
  ADD CONSTRAINT bot_messages_body_len CHECK (body IS NULL OR char_length(body) <= 8000);

CREATE OR REPLACE FUNCTION bot_messages_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.expires_at IS NOT NULL AND OLD.expires_at <= now() THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'bot_messages: only expired messages may be deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.user_id <> OLD.user_id OR NEW.bot <> OLD.bot
     OR NEW.direction <> OLD.direction OR NEW.body IS DISTINCT FROM OLD.body OR NEW.card::text IS DISTINCT FROM OLD.card::text
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'bot_messages: messages are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at THEN
    RAISE EXCEPTION 'bot_messages: read marker is set once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER bot_messages_guard BEFORE UPDATE OR DELETE ON "bot_messages" FOR EACH ROW EXECUTE FUNCTION bot_messages_guard();

-- Certificates ordered from the deanery: a fixed life cycle, terminal states are final.
ALTER TABLE "student_document_requests"
  ADD CONSTRAINT student_document_requests_copies CHECK (copies BETWEEN 1 AND 5),
  ADD CONSTRAINT student_document_requests_purpose_len CHECK (purpose IS NULL OR char_length(purpose) <= 200),
  ADD CONSTRAINT student_document_requests_note_len CHECK (deanery_note IS NULL OR char_length(deanery_note) <= 500),
  ADD CONSTRAINT student_document_requests_closed CHECK (
    (status IN ('ISSUED', 'REJECTED', 'CANCELLED')) = (closed_at IS NOT NULL));

CREATE UNIQUE INDEX student_document_requests_one_open
  ON "student_document_requests" (student_id, type) WHERE status IN ('REQUESTED', 'IN_PROGRESS', 'READY');

CREATE OR REPLACE FUNCTION student_document_requests_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'student_document_requests: requests are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.student_id <> OLD.student_id OR NEW.type <> OLD.type
     OR NEW.copies <> OLD.copies OR NEW.purpose IS DISTINCT FROM OLD.purpose OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'student_document_requests: the request itself is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('ISSUED', 'REJECTED', 'CANCELLED') THEN
    RAISE EXCEPTION 'student_document_requests: the request is closed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'REQUESTED' AND NEW.status IN ('IN_PROGRESS', 'READY', 'REJECTED', 'CANCELLED'))
    OR (OLD.status = 'IN_PROGRESS' AND NEW.status IN ('READY', 'REJECTED'))
    OR (OLD.status = 'READY' AND NEW.status IN ('ISSUED'))) THEN
    RAISE EXCEPTION 'student_document_requests: % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER student_document_requests_guard BEFORE UPDATE OR DELETE ON "student_document_requests"
  FOR EACH ROW EXECUTE FUNCTION student_document_requests_guard();

ALTER TABLE "individual_study_plans"
  ADD CONSTRAINT individual_study_plans_credits CHECK (credits IS NULL OR (credits >= 0 AND credits <= 200)),
  ADD CONSTRAINT individual_study_plans_note_len CHECK (note IS NULL OR char_length(note) <= 500);

-- Schedule changes: append-only facts from the schedule system.
ALTER TABLE "schedule_changes"
  ADD CONSTRAINT schedule_changes_target CHECK (course_offering_id IS NOT NULL OR academic_group_id IS NOT NULL),
  ADD CONSTRAINT schedule_changes_pair CHECK (pair BETWEEN 1 AND 10 AND (new_pair IS NULL OR new_pair BETWEEN 1 AND 10)),
  ADD CONSTRAINT schedule_changes_moved CHECK (kind <> 'MOVED' OR new_date IS NOT NULL),
  ADD CONSTRAINT schedule_changes_link CHECK (link IS NULL OR (link LIKE 'https://%' AND char_length(link) <= 500)),
  ADD CONSTRAINT schedule_changes_text_len CHECK (
    (room IS NULL OR char_length(room) <= 64) AND (note IS NULL OR char_length(note) <= 300));

-- Service desk tickets: routed to a unit or a dormitory; a fixed life cycle; history append-only.
ALTER TABLE "service_tickets"
  ADD CONSTRAINT service_tickets_route CHECK (
    (category IN ('IT', 'FACILITIES') AND org_unit_id IS NOT NULL) OR (category = 'DORMITORY' AND dormitory_id IS NOT NULL)),
  ADD CONSTRAINT service_tickets_text_len CHECK (
    char_length(title) BETWEEN 3 AND 120 AND char_length(description) BETWEEN 1 AND 4000
    AND (location IS NULL OR char_length(location) <= 120) AND (room_label IS NULL OR char_length(room_label) <= 32)),
  ADD CONSTRAINT service_tickets_closed CHECK ((status IN ('CLOSED', 'REJECTED')) = (closed_at IS NOT NULL)),
  ADD CONSTRAINT service_tickets_resolved CHECK (status <> 'RESOLVED' OR resolved_at IS NOT NULL);

CREATE OR REPLACE FUNCTION service_tickets_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'service_tickets: tickets are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.number <> OLD.number OR NEW.requester_id <> OLD.requester_id
     OR NEW.title <> OLD.title OR NEW.description <> OLD.description OR NEW.location IS DISTINCT FROM OLD.location
     OR NEW.dormitory_id IS DISTINCT FROM OLD.dormitory_id OR NEW.room_label IS DISTINCT FROM OLD.room_label
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'service_tickets: the ticket itself is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('CLOSED', 'REJECTED') THEN
    RAISE EXCEPTION 'service_tickets: the ticket is closed' USING ERRCODE = 'check_violation';
  END IF;
  -- Only a commandant's forward of a dormitory repair to the facilities service changes the route.
  IF (NEW.category <> OLD.category OR NEW.org_unit_id IS DISTINCT FROM OLD.org_unit_id)
     AND NOT (OLD.category = 'DORMITORY' AND NEW.category = 'FACILITIES' AND NEW.org_unit_id IS NOT NULL) THEN
    RAISE EXCEPTION 'service_tickets: the route cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'NEW' AND NEW.status IN ('IN_PROGRESS', 'RESOLVED', 'REJECTED'))
    OR (OLD.status = 'IN_PROGRESS' AND NEW.status IN ('RESOLVED', 'REJECTED'))
    OR (OLD.status = 'RESOLVED' AND NEW.status IN ('CLOSED', 'IN_PROGRESS'))) THEN
    RAISE EXCEPTION 'service_tickets: % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER service_tickets_guard BEFORE UPDATE OR DELETE ON "service_tickets"
  FOR EACH ROW EXECUTE FUNCTION service_tickets_guard();

ALTER TABLE "service_ticket_events"
  ADD CONSTRAINT service_ticket_events_comment_len CHECK (comment IS NULL OR char_length(comment) BETWEEN 1 AND 2000),
  ADD CONSTRAINT service_ticket_events_shape CHECK (
    (kind = 'STATUS') = (status IS NOT NULL) AND (kind <> 'COMMENT' OR comment IS NOT NULL));

CREATE OR REPLACE FUNCTION phase8_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '%: rows are append-only', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER service_ticket_events_append_only BEFORE UPDATE OR DELETE ON "service_ticket_events"
  FOR EACH ROW EXECUTE FUNCTION phase8_append_only();
CREATE TRIGGER schedule_changes_append_only BEFORE UPDATE OR DELETE ON "schedule_changes"
  FOR EACH ROW EXECUTE FUNCTION phase8_append_only();
CREATE TRIGGER admissions_chunks_append_only BEFORE UPDATE OR DELETE ON "admissions_chunks"
  FOR EACH ROW EXECUTE FUNCTION phase8_append_only();

-- Admission rules: one active document per tenant; a document never changes except its active flag.
CREATE UNIQUE INDEX admissions_documents_one_active ON "admissions_documents" (tenant_id) WHERE active;
ALTER TABLE "admissions_documents"
  ADD CONSTRAINT admissions_documents_title_len CHECK (char_length(title) BETWEEN 3 AND 200),
  ADD CONSTRAINT admissions_documents_sha CHECK (source_sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE "admissions_chunks"
  ADD CONSTRAINT admissions_chunks_text_len CHECK (char_length(text) BETWEEN 1 AND 4000);

CREATE OR REPLACE FUNCTION admissions_documents_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'admissions_documents: documents are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.title <> OLD.title OR NEW.source_sha256 <> OLD.source_sha256
     OR NEW.chunk_count <> OLD.chunk_count OR NEW.uploaded_by_id <> OLD.uploaded_by_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'admissions_documents: only the active flag may change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER admissions_documents_guard BEFORE UPDATE OR DELETE ON "admissions_documents"
  FOR EACH ROW EXECUTE FUNCTION admissions_documents_guard();

-- Registration of an approved order by the ЕДО: set once, only on an approved route.
ALTER TABLE "approval_routes"
  ADD CONSTRAINT approval_routes_registration CHECK (
    (registration_no IS NULL) = (registered_at IS NULL)
    AND (registration_no IS NULL OR (status = 'APPROVED' AND char_length(registration_no) BETWEEN 1 AND 64)));

CREATE OR REPLACE FUNCTION approval_routes_registration_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.registration_no IS NOT NULL AND (NEW.registration_no IS DISTINCT FROM OLD.registration_no
     OR NEW.registered_at IS DISTINCT FROM OLD.registered_at OR NEW.status <> OLD.status) THEN
    RAISE EXCEPTION 'approval_routes: a registered order is final' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER approval_routes_registration_guard BEFORE UPDATE ON "approval_routes"
  FOR EACH ROW EXECUTE FUNCTION approval_routes_registration_guard();

ALTER TABLE "integration_outbox"
  ADD CONSTRAINT integration_outbox_attempts CHECK (attempts BETWEEN 0 AND 100),
  ADD CONSTRAINT integration_outbox_sent CHECK ((status = 'SENT') = (sent_at IS NOT NULL));

CREATE OR REPLACE FUNCTION phase8_no_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '%: truncate is not allowed', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER bot_messages_no_truncate BEFORE TRUNCATE ON "bot_messages" EXECUTE FUNCTION phase8_no_truncate();
CREATE TRIGGER student_document_requests_no_truncate BEFORE TRUNCATE ON "student_document_requests" EXECUTE FUNCTION phase8_no_truncate();
CREATE TRIGGER schedule_changes_no_truncate BEFORE TRUNCATE ON "schedule_changes" EXECUTE FUNCTION phase8_no_truncate();
CREATE TRIGGER service_tickets_no_truncate BEFORE TRUNCATE ON "service_tickets" EXECUTE FUNCTION phase8_no_truncate();
CREATE TRIGGER service_ticket_events_no_truncate BEFORE TRUNCATE ON "service_ticket_events" EXECUTE FUNCTION phase8_no_truncate();
CREATE TRIGGER admissions_documents_no_truncate BEFORE TRUNCATE ON "admissions_documents" EXECUTE FUNCTION phase8_no_truncate();
CREATE TRIGGER admissions_chunks_no_truncate BEFORE TRUNCATE ON "admissions_chunks" EXECUTE FUNCTION phase8_no_truncate();

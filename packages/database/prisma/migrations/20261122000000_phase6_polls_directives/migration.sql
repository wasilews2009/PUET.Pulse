-- CreateEnum
CREATE TYPE "PollMode" AS ENUM ('OPEN', 'SECRET');

-- CreateEnum
CREATE TYPE "PollStatus" AS ENUM ('OPEN', 'CLOSED');

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "requires_ack" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "polls" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "question" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "mode" "PollMode" NOT NULL,
    "multiple_choice" BOOLEAN NOT NULL DEFAULT false,
    "formal" BOOLEAN NOT NULL DEFAULT false,
    "quorum" INTEGER,
    "eligible_count" INTEGER NOT NULL,
    "status" "PollStatus" NOT NULL DEFAULT 'OPEN',
    "closes_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "closed_by_id" UUID,
    "result" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "polls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "poll_participations" (
    "poll_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "poll_participations_pkey" PRIMARY KEY ("poll_id","user_id")
);

-- CreateTable
CREATE TABLE "poll_ballots" (
    "poll_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "option_indexes" INTEGER[],

    CONSTRAINT "poll_ballots_pkey" PRIMARY KEY ("poll_id","user_id")
);

-- CreateTable
CREATE TABLE "poll_tallies" (
    "poll_id" UUID NOT NULL,
    "option_index" INTEGER NOT NULL,
    "votes" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "poll_tallies_pkey" PRIMARY KEY ("poll_id","option_index")
);

-- CreateTable
CREATE TABLE "poll_eligible" (
    "poll_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,

    CONSTRAINT "poll_eligible_pkey" PRIMARY KEY ("poll_id","user_id")
);

-- CreateTable
CREATE TABLE "message_acks" (
    "message_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_acks_pkey" PRIMARY KEY ("message_id","user_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "polls_message_id_key" ON "polls"("message_id");

-- CreateIndex
CREATE INDEX "polls_channel_id_created_at_idx" ON "polls"("channel_id", "created_at");

-- CreateIndex
CREATE INDEX "polls_status_closes_at_idx" ON "polls"("status", "closes_at");

-- AddForeignKey
ALTER TABLE "polls" ADD CONSTRAINT "polls_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polls" ADD CONSTRAINT "polls_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polls" ADD CONSTRAINT "polls_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "poll_participations" ADD CONSTRAINT "poll_participations_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "polls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "poll_participations" ADD CONSTRAINT "poll_participations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "poll_ballots" ADD CONSTRAINT "poll_ballots_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "polls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "poll_ballots" ADD CONSTRAINT "poll_ballots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "poll_tallies" ADD CONSTRAINT "poll_tallies_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "polls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "poll_eligible" ADD CONSTRAINT "poll_eligible_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "polls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "poll_eligible" ADD CONSTRAINT "poll_eligible_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_acks" ADD CONSTRAINT "message_acks_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_acks" ADD CONSTRAINT "message_acks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ───────────────────────── Phase 6 guardrails (hand-written) ─────────────────────────

-- A poll's definition never changes; once closed, nothing changes.
CREATE OR REPLACE FUNCTION polls_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'CLOSED' THEN
    RAISE EXCEPTION 'polls: a closed poll is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.channel_id <> OLD.channel_id OR NEW.message_id <> OLD.message_id
     OR NEW.created_by_id <> OLD.created_by_id OR NEW.question <> OLD.question OR NEW.options <> OLD.options
     OR NEW.mode <> OLD.mode OR NEW.multiple_choice <> OLD.multiple_choice OR NEW.formal <> OLD.formal
     OR NEW.quorum IS DISTINCT FROM OLD.quorum OR NEW.eligible_count <> OLD.eligible_count
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'polls: the definition of a poll is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER polls_guard BEFORE UPDATE ON "polls" FOR EACH ROW EXECUTE FUNCTION polls_guard();

-- Votes are accepted only while the poll is open, and only in the storage of its mode.
CREATE OR REPLACE FUNCTION poll_vote_guard() RETURNS trigger AS $$
DECLARE
  p RECORD;
  i INTEGER;
BEGIN
  SELECT status, closes_at, mode, formal, jsonb_array_length(options) AS n INTO p FROM polls WHERE id = NEW.poll_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'polls: unknown poll' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF TG_TABLE_NAME = 'poll_tallies' AND TG_OP = 'INSERT' THEN
    -- Counters are created at zero together with the poll.
    IF p.mode <> 'SECRET' OR NEW.votes <> 0 OR NEW.option_index < 0 OR NEW.option_index >= p.n THEN
      RAISE EXCEPTION 'polls: invalid tally' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF p.status <> 'OPEN' OR (p.closes_at IS NOT NULL AND p.closes_at <= now()) THEN
    RAISE EXCEPTION 'polls: voting is closed' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_TABLE_NAME = 'poll_participations' THEN
    IF p.formal AND NOT EXISTS (SELECT 1 FROM poll_eligible e WHERE e.poll_id = NEW.poll_id AND e.user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'polls: not an eligible voter' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'poll_ballots' THEN
    IF p.mode <> 'OPEN' THEN
      RAISE EXCEPTION 'polls: a secret poll stores no attributed ballots' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM poll_participations v WHERE v.poll_id = NEW.poll_id AND v.user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'polls: ballot without participation' USING ERRCODE = 'check_violation';
    END IF;
    IF coalesce(array_length(NEW.option_indexes, 1), 0) = 0 THEN
      RAISE EXCEPTION 'polls: empty ballot' USING ERRCODE = 'check_violation';
    END IF;
    FOREACH i IN ARRAY NEW.option_indexes LOOP
      IF i IS NULL OR i < 0 OR i >= p.n THEN
        RAISE EXCEPTION 'polls: option out of range' USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
  ELSIF TG_TABLE_NAME = 'poll_tallies' THEN
    -- UPDATE: one vote at a time, never down, never moved to another poll or option.
    IF NEW.poll_id <> OLD.poll_id OR NEW.option_index <> OLD.option_index OR NEW.votes <> OLD.votes + 1 THEN
      RAISE EXCEPTION 'polls: tallies only grow by one' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER poll_participations_guard BEFORE INSERT ON "poll_participations" FOR EACH ROW EXECUTE FUNCTION poll_vote_guard();
CREATE TRIGGER poll_ballots_guard BEFORE INSERT ON "poll_ballots" FOR EACH ROW EXECUTE FUNCTION poll_vote_guard();
CREATE TRIGGER poll_tallies_guard BEFORE INSERT OR UPDATE ON "poll_tallies" FOR EACH ROW EXECUTE FUNCTION poll_vote_guard();

-- The eligible list is frozen when the vote opens.
CREATE OR REPLACE FUNCTION poll_eligible_guard() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM poll_participations v WHERE v.poll_id = NEW.poll_id) THEN
    RAISE EXCEPTION 'polls: the eligible list is frozen' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER poll_eligible_guard BEFORE INSERT ON "poll_eligible" FOR EACH ROW EXECUTE FUNCTION poll_eligible_guard();

-- Only directives can be acknowledged.
CREATE OR REPLACE FUNCTION message_acks_guard() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = NEW.message_id AND m.requires_ack AND m.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'message_acks: message does not require acknowledgement' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER message_acks_guard BEFORE INSERT ON "message_acks" FOR EACH ROW EXECUTE FUNCTION message_acks_guard();

-- Append-only: votes, eligibility and acknowledgements are never edited. Rows go away
-- only together with their poll / message (ON DELETE CASCADE).
CREATE OR REPLACE FUNCTION phase6_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF TG_TABLE_NAME = 'message_acks' THEN
      IF EXISTS (SELECT 1 FROM messages m WHERE m.id = OLD.message_id) THEN
        RAISE EXCEPTION 'message_acks: append-only' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF EXISTS (SELECT 1 FROM polls p WHERE p.id = OLD.poll_id) THEN
      RAISE EXCEPTION '%: append-only', TG_TABLE_NAME USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '%: append-only', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER poll_participations_append_only BEFORE UPDATE OR DELETE ON "poll_participations" FOR EACH ROW EXECUTE FUNCTION phase6_append_only();
CREATE TRIGGER poll_ballots_append_only BEFORE UPDATE OR DELETE ON "poll_ballots" FOR EACH ROW EXECUTE FUNCTION phase6_append_only();
CREATE TRIGGER poll_eligible_append_only BEFORE UPDATE OR DELETE ON "poll_eligible" FOR EACH ROW EXECUTE FUNCTION phase6_append_only();
CREATE TRIGGER poll_tallies_no_delete BEFORE DELETE ON "poll_tallies" FOR EACH ROW EXECUTE FUNCTION phase6_append_only();
CREATE TRIGGER message_acks_append_only BEFORE UPDATE OR DELETE ON "message_acks" FOR EACH ROW EXECUTE FUNCTION phase6_append_only();

CREATE OR REPLACE FUNCTION phase6_no_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '%: truncate is not allowed', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER polls_no_truncate BEFORE TRUNCATE ON "polls" EXECUTE FUNCTION phase6_no_truncate();
CREATE TRIGGER poll_participations_no_truncate BEFORE TRUNCATE ON "poll_participations" EXECUTE FUNCTION phase6_no_truncate();
CREATE TRIGGER poll_ballots_no_truncate BEFORE TRUNCATE ON "poll_ballots" EXECUTE FUNCTION phase6_no_truncate();
CREATE TRIGGER poll_tallies_no_truncate BEFORE TRUNCATE ON "poll_tallies" EXECUTE FUNCTION phase6_no_truncate();
CREATE TRIGGER message_acks_no_truncate BEFORE TRUNCATE ON "message_acks" EXECUTE FUNCTION phase6_no_truncate();

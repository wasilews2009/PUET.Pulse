-- CreateEnum
CREATE TYPE "AnonymousCaseStatus" AS ENUM ('OPEN', 'CLOSED');

-- AlterEnum
ALTER TYPE "PrincipalKind" ADD VALUE 'PSEUDONYM';

-- AlterEnum
ALTER TYPE "RoleCode" ADD VALUE 'ANONYMOUS_REQUESTER';

-- CreateTable
CREATE TABLE "anonymous_cases" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "org_unit_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "pseudonym_id" UUID NOT NULL,
    "requester_tag" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "status" "AnonymousCaseStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "anonymous_cases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "anonymous_cases_channel_id_key" ON "anonymous_cases"("channel_id");

-- CreateIndex
CREATE UNIQUE INDEX "anonymous_cases_pseudonym_id_key" ON "anonymous_cases"("pseudonym_id");

-- CreateIndex
CREATE INDEX "anonymous_cases_requester_tag_idx" ON "anonymous_cases"("requester_tag");

-- CreateIndex
CREATE UNIQUE INDEX "anonymous_cases_tenant_id_alias_key" ON "anonymous_cases"("tenant_id", "alias");

-- AddForeignKey
ALTER TABLE "anonymous_cases" ADD CONSTRAINT "anonymous_cases_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anonymous_cases" ADD CONSTRAINT "anonymous_cases_org_unit_id_fkey" FOREIGN KEY ("org_unit_id") REFERENCES "org_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anonymous_cases" ADD CONSTRAINT "anonymous_cases_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anonymous_cases" ADD CONSTRAINT "anonymous_cases_pseudonym_id_fkey" FOREIGN KEY ("pseudonym_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ───────────── Guardrails (not expressible in Prisma) ─────────────

ALTER TABLE "anonymous_cases" ADD CONSTRAINT "anonymous_cases_alias_check" CHECK ("alias" ~ '^[A-Z0-9]{4,8}$');
ALTER TABLE "anonymous_cases" ADD CONSTRAINT "anonymous_cases_tag_check" CHECK ("requester_tag" ~ '^[0-9a-f]{64}$');
ALTER TABLE "anonymous_cases" ADD CONSTRAINT "anonymous_cases_closed_check" CHECK (("status" = 'CLOSED') = ("closed_at" IS NOT NULL));

-- A case binds a PSEUDONYM user to an end-to-end encrypted trust room of a trust service.
CREATE OR REPLACE FUNCTION anonymous_cases_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.pseudonym_id AND kind::text = 'PSEUDONYM' AND tenant_id = NEW.tenant_id) THEN
      RAISE EXCEPTION 'anonymous case needs a pseudonym of the same tenant';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM channels WHERE id = NEW.channel_id AND type = 'TRUST_ROOM' AND e2ee_mode = 'MANDATORY' AND tenant_id = NEW.tenant_id) THEN
      RAISE EXCEPTION 'anonymous case needs a mandatory E2EE trust room';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM org_units WHERE id = NEW.org_unit_id AND kind = 'TRUST_SERVICE' AND tenant_id = NEW.tenant_id) THEN
      RAISE EXCEPTION 'anonymous case needs a trust service';
    END IF;
    IF NEW.status <> 'OPEN' THEN
      RAISE EXCEPTION 'a new case is open';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'anonymous cases are kept';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.org_unit_id <> OLD.org_unit_id OR NEW.channel_id <> OLD.channel_id
     OR NEW.pseudonym_id <> OLD.pseudonym_id OR NEW.requester_tag <> OLD.requester_tag OR NEW.alias <> OLD.alias
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'anonymous case fields are immutable';
  END IF;
  IF OLD.status = 'CLOSED' AND NEW.status <> 'CLOSED' THEN
    RAISE EXCEPTION 'a closed case stays closed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER anonymous_cases_guard BEFORE INSERT OR UPDATE OR DELETE ON "anonymous_cases"
  FOR EACH ROW EXECUTE FUNCTION anonymous_cases_guard();

-- A pseudonym belongs to its own case room and nowhere else, as a plain member.
CREATE OR REPLACE FUNCTION channel_members_pseudonym_guard() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND kind::text = 'PSEUDONYM') THEN
    IF NOT EXISTS (SELECT 1 FROM anonymous_cases WHERE pseudonym_id = NEW.user_id AND channel_id = NEW.channel_id) THEN
      RAISE EXCEPTION 'a pseudonym may only join its own case room';
    END IF;
    IF NEW.role <> 'MEMBER' THEN
      RAISE EXCEPTION 'a pseudonym is a plain member';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER channel_members_pseudonym_guard BEFORE INSERT OR UPDATE ON "channel_members"
  FOR EACH ROW EXECUTE FUNCTION channel_members_pseudonym_guard();

-- Pseudonyms never hold a role other than ANONYMOUS_REQUESTER, and nobody else holds that one.
CREATE OR REPLACE FUNCTION role_assignments_pseudonym_guard() RETURNS trigger AS $$
DECLARE is_pseudonym boolean;
BEGIN
  SELECT kind::text = 'PSEUDONYM' INTO is_pseudonym FROM users WHERE id = NEW.user_id;
  IF is_pseudonym IS DISTINCT FROM (NEW.role::text = 'ANONYMOUS_REQUESTER') THEN
    RAISE EXCEPTION 'ANONYMOUS_REQUESTER is reserved for pseudonyms';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER role_assignments_pseudonym_guard BEFORE INSERT OR UPDATE ON "role_assignments"
  FOR EACH ROW EXECUTE FUNCTION role_assignments_pseudonym_guard();

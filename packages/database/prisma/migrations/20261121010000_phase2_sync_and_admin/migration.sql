-- CreateEnum
CREATE TYPE "RoleSource" AS ENUM ('SYNC', 'ADMIN');

-- CreateEnum
CREATE TYPE "IntegrationKind" AS ENUM ('EDEBO_STUDENTS', 'HR_STAFF', 'TEACHING_LOAD', 'OFFBOARDING');

-- CreateEnum
CREATE TYPE "IntegrationEventStatus" AS ENUM ('PROCESSED', 'FAILED');

-- AlterEnum
ALTER TYPE "RoleCode" ADD VALUE 'INTEGRATION';

-- AlterTable
ALTER TABLE "role_assignments" ADD COLUMN     "source" "RoleSource" NOT NULL DEFAULT 'ADMIN';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "is_alumni" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "integration_events" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "IntegrationKind" NOT NULL,
    "status" "IntegrationEventStatus" NOT NULL,
    "summary" JSONB,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "integration_events_client_id_received_at_idx" ON "integration_events"("client_id", "received_at");


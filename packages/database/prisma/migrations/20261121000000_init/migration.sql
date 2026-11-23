-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "TenantCode" AS ENUM ('PUET_MAIN', 'PUET_LYCEUM', 'COLLEGE_POLTAVA', 'COLLEGE_CHERKASY', 'COLLEGE_BILHOROD');

-- CreateEnum
CREATE TYPE "OrgUnitKind" AS ENUM ('GOVERNANCE', 'ADMIN_SERVICE', 'TRUST_SERVICE', 'SAFETY_SERVICE', 'ACADEMIC_CENTER', 'FACILITIES', 'CAMPUS', 'COMMUNITY', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'OFFBOARDED');

-- CreateEnum
CREATE TYPE "PrincipalKind" AS ENUM ('STAFF', 'STUDENT', 'GUEST', 'SERVICE_BOT');

-- CreateEnum
CREATE TYPE "Locale" AS ENUM ('uk', 'en');

-- CreateEnum
CREATE TYPE "PresenceStatus" AS ENUM ('ONLINE', 'IN_CLASS', 'IN_COUNCIL', 'ON_BUSINESS_TRIP', 'DO_NOT_DISTURB', 'OFFLINE');

-- CreateEnum
CREATE TYPE "EducationLevel" AS ENUM ('LYCEUM', 'JUNIOR_BACHELOR', 'BACHELOR', 'MASTER', 'PHD', 'DOCTORATE');

-- CreateEnum
CREATE TYPE "StudyForm" AS ENUM ('FULL_TIME', 'PART_TIME', 'DISTANCE', 'DUAL');

-- CreateEnum
CREATE TYPE "RoleCode" AS ENUM ('SUPER_ADMIN', 'RECTORATE', 'INSTITUTE_DIRECTOR', 'DEPARTMENT_HEAD', 'LECTURER', 'ADMIN_STAFF', 'TRUST_SERVICE_OFFICER', 'CIVIL_PROTECTION_OFFICER', 'FACILITIES_STAFF', 'DORM_COMMANDANT', 'STUDENT', 'GROUP_LEADER', 'GUEST');

-- CreateEnum
CREATE TYPE "ChannelType" AS ENUM ('DIRECT', 'PRIVATE_GROUP', 'COURSE', 'ACADEMIC_GROUP', 'INSTITUTE', 'DEPARTMENT', 'GOVERNANCE', 'ADMIN_UNIT', 'TRUST_ROOM', 'EMERGENCY', 'DORMITORY', 'PROJECT', 'COMMUNITY', 'GUEST_SPACE', 'ANNOUNCEMENT');

-- CreateEnum
CREATE TYPE "E2eeMode" AS ENUM ('MANDATORY', 'OPTIONAL', 'DISABLED');

-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('OWNER', 'MODERATOR', 'MEMBER', 'READ_ONLY');

-- CreateEnum
CREATE TYPE "PolicyEffect" AS ENUM ('ALLOW', 'DENY');

-- CreateEnum
CREATE TYPE "FileScanStatus" AS ENUM ('PENDING', 'CLEAN', 'INFECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "CdrStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'SANITIZED', 'FAILED');

-- CreateEnum
CREATE TYPE "SignatureProviderKind" AS ENUM ('INTERNAL_PKI', 'EXTERNAL_QES');

-- CreateEnum
CREATE TYPE "CertificateStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RevocationReason" AS ENUM ('UNSPECIFIED', 'KEY_COMPROMISE', 'AFFILIATION_CHANGED', 'SUPERSEDED', 'CESSATION_OF_OPERATION');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AuditOutcome" AS ENUM ('SUCCESS', 'DENIED', 'FAILURE');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "code" "TenantCode" NOT NULL,
    "name_uk" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "city" TEXT,
    "minor_protected" BOOLEAN NOT NULL DEFAULT false,
    "default_locale" "Locale" NOT NULL DEFAULT 'uk',
    "theme_overrides" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "institutes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name_uk" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "default_locale" "Locale" NOT NULL DEFAULT 'uk',
    "bilingual_ui" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "institutes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name_uk" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_units" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "parent_id" UUID,
    "code" TEXT NOT NULL,
    "kind" "OrgUnitKind" NOT NULL,
    "name_uk" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "confidential" BOOLEAN NOT NULL DEFAULT false,
    "e2ee_mode" "E2eeMode" NOT NULL DEFAULT 'DISABLED',
    "anonymous_intake" BOOLEAN NOT NULL DEFAULT false,
    "bypasses_quiet_hours" BOOLEAN NOT NULL DEFAULT false,
    "forbid_external_forward" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dormitories" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "campus_id" UUID,
    "number" INTEGER NOT NULL,
    "name_uk" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "address" TEXT,
    "floors" INTEGER NOT NULL DEFAULT 5,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dormitories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dormitory_rooms" (
    "id" UUID NOT NULL,
    "dormitory_id" UUID NOT NULL,
    "floor" INTEGER NOT NULL,
    "number" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 3,

    CONSTRAINT "dormitory_rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "academic_groups" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "institute_id" UUID,
    "code" TEXT NOT NULL,
    "specialty" TEXT,
    "education_level" "EducationLevel" NOT NULL,
    "study_form" "StudyForm" NOT NULL DEFAULT 'FULL_TIME',
    "course_year" INTEGER NOT NULL,
    "external_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "academic_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "semesters" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "is_current" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "semesters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disciplines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "department_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name_uk" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "is_elective" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "disciplines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "course_offerings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "semester_id" UUID NOT NULL,
    "discipline_id" UUID NOT NULL,
    "department_id" UUID NOT NULL,
    "external_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "course_offerings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "course_offering_lecturers" (
    "course_offering_id" UUID NOT NULL,
    "staff_profile_id" UUID NOT NULL,
    "is_lead" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "course_offering_lecturers_pkey" PRIMARY KEY ("course_offering_id","staff_profile_id")
);

-- CreateTable
CREATE TABLE "course_offering_groups" (
    "course_offering_id" UUID NOT NULL,
    "academic_group_id" UUID NOT NULL,

    CONSTRAINT "course_offering_groups_pkey" PRIMARY KEY ("course_offering_id","academic_group_id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "corporate_id" TEXT NOT NULL,
    "kind" "PrincipalKind" NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "full_name_uk" TEXT NOT NULL,
    "full_name_en" TEXT,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "birth_date" DATE,
    "is_minor" BOOLEAN NOT NULL DEFAULT false,
    "locale" "Locale" NOT NULL DEFAULT 'uk',
    "presence" "PresenceStatus" NOT NULL DEFAULT 'OFFLINE',
    "oidc_subject" TEXT,
    "edebo_id" TEXT,
    "hr_id" TEXT,
    "mfa_enforced" BOOLEAN NOT NULL DEFAULT false,
    "session_epoch" INTEGER NOT NULL DEFAULT 0,
    "offboarded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "academic_degree" TEXT,
    "academic_title" TEXT,
    "position" TEXT NOT NULL,
    "consultation_schedule" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_departments" (
    "staff_profile_id" UUID NOT NULL,
    "department_id" UUID NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "staff_departments_pkey" PRIMARY KEY ("staff_profile_id","department_id")
);

-- CreateTable
CREATE TABLE "staff_org_units" (
    "staff_profile_id" UUID NOT NULL,
    "org_unit_id" UUID NOT NULL,
    "position" TEXT,

    CONSTRAINT "staff_org_units_pkey" PRIMARY KEY ("staff_profile_id","org_unit_id")
);

-- CreateTable
CREATE TABLE "student_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "education_level" "EducationLevel" NOT NULL,
    "study_form" "StudyForm" NOT NULL DEFAULT 'FULL_TIME',
    "institute_id" UUID,
    "academic_group_id" UUID,
    "specialty" TEXT,
    "course_year" INTEGER,
    "dormitory_room_id" UUID,
    "is_group_leader" BOOLEAN NOT NULL DEFAULT false,
    "is_activist" BOOLEAN NOT NULL DEFAULT false,
    "is_foreign" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "identity_key" BYTEA,
    "verified_at" TIMESTAMP(3),
    "last_seen_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "id" UUID NOT NULL,
    "role" "RoleCode" NOT NULL,
    "action" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_assignments" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "tenant_id" UUID,
    "role" "RoleCode" NOT NULL,
    "institute_id" UUID,
    "department_id" UUID,
    "org_unit_id" UUID,
    "dormitory_id" UUID,
    "expires_at" TIMESTAMP(3),
    "granted_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "abac_policies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "key" TEXT NOT NULL,
    "description" TEXT,
    "effect" "PolicyEffect" NOT NULL,
    "actions" TEXT[],
    "resource_types" TEXT[],
    "condition" JSONB NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "abac_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channels" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "type" "ChannelType" NOT NULL,
    "e2ee_mode" "E2eeMode" NOT NULL DEFAULT 'DISABLED',
    "name_uk" TEXT,
    "name_en" TEXT,
    "topic" TEXT,
    "confidential" BOOLEAN NOT NULL DEFAULT false,
    "is_official" BOOLEAN NOT NULL DEFAULT false,
    "threads_required" BOOLEAN NOT NULL DEFAULT false,
    "message_ttl_seconds" INTEGER,
    "archived_at" TIMESTAMP(3),
    "auto_archive_at" TIMESTAMP(3),
    "institute_id" UUID,
    "department_id" UUID,
    "org_unit_id" UUID,
    "dormitory_id" UUID,
    "academic_group_id" UUID,
    "course_offering_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_members" (
    "channel_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "MemberRole" NOT NULL DEFAULT 'MEMBER',
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "muted_until" TIMESTAMP(3),

    CONSTRAINT "channel_members_pkey" PRIMARY KEY ("channel_id","user_id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "sender_id" UUID NOT NULL,
    "thread_root_id" UUID,
    "body" TEXT,
    "ciphertext" BYTEA,
    "is_priority" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMP(3),
    "edited_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quiet_hours_schedules" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Kyiv',
    "start_minute" INTEGER NOT NULL DEFAULT 1080,
    "end_minute" INTEGER NOT NULL DEFAULT 510,
    "weekdays" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5]::INTEGER[],
    "digest_enabled" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quiet_hours_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_objects" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "channel_id" UUID,
    "message_id" UUID,
    "uploader_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "sanitized_key" TEXT,
    "scan_status" "FileScanStatus" NOT NULL DEFAULT 'PENDING',
    "cdr_status" "CdrStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "confidential" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_objects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pdf_annotations" (
    "id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "page" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pdf_annotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_certificates" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "SignatureProviderKind" NOT NULL,
    "serial_number" TEXT NOT NULL,
    "subject_dn" TEXT NOT NULL,
    "issuer_dn" TEXT NOT NULL,
    "certificate_pem" TEXT NOT NULL,
    "fingerprint_sha256" TEXT NOT NULL,
    "not_before" TIMESTAMP(3) NOT NULL,
    "not_after" TIMESTAMP(3) NOT NULL,
    "status" "CertificateStatus" NOT NULL DEFAULT 'ACTIVE',
    "revoked_at" TIMESTAMP(3),
    "revocation_reason" "RevocationReason",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_certificates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_signatures" (
    "id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "certificate_id" UUID NOT NULL,
    "provider" "SignatureProviderKind" NOT NULL,
    "format" TEXT NOT NULL,
    "signature_key" TEXT NOT NULL,
    "signed_digest" TEXT NOT NULL,
    "digest_algorithm" TEXT NOT NULL,
    "tsp_timestamp" TIMESTAMP(3),
    "tsp_token" BYTEA,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_signatures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_routes" (
    "id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_steps" (
    "id" UUID NOT NULL,
    "route_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "approver_id" UUID NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "signature_id" UUID,
    "comment" TEXT,
    "decided_at" TIMESTAMP(3),

    CONSTRAINT "approval_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenant_id" UUID,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "resource_type" TEXT,
    "resource_id" TEXT,
    "outcome" "AuditOutcome" NOT NULL,
    "reason" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "request_id" TEXT,
    "metadata" JSONB,
    "prev_hash" TEXT,
    "hash" TEXT NOT NULL,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_code_key" ON "tenants"("code");

-- CreateIndex
CREATE INDEX "institutes_tenant_id_idx" ON "institutes"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "institutes_tenant_id_code_key" ON "institutes"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "departments_tenant_id_idx" ON "departments"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "departments_tenant_id_code_key" ON "departments"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "org_units_tenant_id_kind_idx" ON "org_units"("tenant_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "org_units_tenant_id_code_key" ON "org_units"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "dormitories_tenant_id_number_key" ON "dormitories"("tenant_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "dormitory_rooms_dormitory_id_number_key" ON "dormitory_rooms"("dormitory_id", "number");

-- CreateIndex
CREATE INDEX "academic_groups_tenant_id_institute_id_idx" ON "academic_groups"("tenant_id", "institute_id");

-- CreateIndex
CREATE UNIQUE INDEX "academic_groups_tenant_id_code_key" ON "academic_groups"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "semesters_tenant_id_code_key" ON "semesters"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "disciplines_tenant_id_code_key" ON "disciplines"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "course_offerings_tenant_id_semester_id_idx" ON "course_offerings"("tenant_id", "semester_id");

-- CreateIndex
CREATE UNIQUE INDEX "course_offerings_tenant_id_external_id_key" ON "course_offerings"("tenant_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_corporate_id_key" ON "users"("corporate_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_oidc_subject_key" ON "users"("oidc_subject");

-- CreateIndex
CREATE UNIQUE INDEX "users_edebo_id_key" ON "users"("edebo_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_hr_id_key" ON "users"("hr_id");

-- CreateIndex
CREATE INDEX "users_tenant_id_status_idx" ON "users"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "users_tenant_id_kind_idx" ON "users"("tenant_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "staff_profiles_user_id_key" ON "staff_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_profiles_user_id_key" ON "student_profiles"("user_id");

-- CreateIndex
CREATE INDEX "student_profiles_academic_group_id_idx" ON "student_profiles"("academic_group_id");

-- CreateIndex
CREATE INDEX "devices_user_id_idx" ON "devices"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "role_permissions_role_action_key" ON "role_permissions"("role", "action");

-- CreateIndex
CREATE INDEX "role_assignments_user_id_idx" ON "role_assignments"("user_id");

-- CreateIndex
CREATE INDEX "role_assignments_tenant_id_role_idx" ON "role_assignments"("tenant_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "abac_policies_key_key" ON "abac_policies"("key");

-- CreateIndex
CREATE UNIQUE INDEX "channels_course_offering_id_key" ON "channels"("course_offering_id");

-- CreateIndex
CREATE INDEX "channels_tenant_id_type_idx" ON "channels"("tenant_id", "type");

-- CreateIndex
CREATE INDEX "channel_members_user_id_idx" ON "channel_members"("user_id");

-- CreateIndex
CREATE INDEX "messages_channel_id_created_at_idx" ON "messages"("channel_id", "created_at");

-- CreateIndex
CREATE INDEX "messages_expires_at_idx" ON "messages"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "quiet_hours_schedules_user_id_key" ON "quiet_hours_schedules"("user_id");

-- CreateIndex
CREATE INDEX "file_objects_tenant_id_channel_id_idx" ON "file_objects"("tenant_id", "channel_id");

-- CreateIndex
CREATE INDEX "pdf_annotations_file_id_page_idx" ON "pdf_annotations"("file_id", "page");

-- CreateIndex
CREATE UNIQUE INDEX "user_certificates_serial_number_key" ON "user_certificates"("serial_number");

-- CreateIndex
CREATE UNIQUE INDEX "user_certificates_fingerprint_sha256_key" ON "user_certificates"("fingerprint_sha256");

-- CreateIndex
CREATE INDEX "user_certificates_user_id_status_idx" ON "user_certificates"("user_id", "status");

-- CreateIndex
CREATE INDEX "user_certificates_status_revoked_at_idx" ON "user_certificates"("status", "revoked_at");

-- CreateIndex
CREATE INDEX "document_signatures_file_id_idx" ON "document_signatures"("file_id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_steps_signature_id_key" ON "approval_steps"("signature_id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_steps_route_id_position_key" ON "approval_steps"("route_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "audit_logs_hash_key" ON "audit_logs"("hash");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_occurred_at_idx" ON "audit_logs"("tenant_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_occurred_at_idx" ON "audit_logs"("actor_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_action_occurred_at_idx" ON "audit_logs"("action", "occurred_at");

-- AddForeignKey
ALTER TABLE "institutes" ADD CONSTRAINT "institutes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_units" ADD CONSTRAINT "org_units_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_units" ADD CONSTRAINT "org_units_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "org_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dormitories" ADD CONSTRAINT "dormitories_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dormitories" ADD CONSTRAINT "dormitories_campus_id_fkey" FOREIGN KEY ("campus_id") REFERENCES "org_units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dormitory_rooms" ADD CONSTRAINT "dormitory_rooms_dormitory_id_fkey" FOREIGN KEY ("dormitory_id") REFERENCES "dormitories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academic_groups" ADD CONSTRAINT "academic_groups_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academic_groups" ADD CONSTRAINT "academic_groups_institute_id_fkey" FOREIGN KEY ("institute_id") REFERENCES "institutes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "semesters" ADD CONSTRAINT "semesters_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disciplines" ADD CONSTRAINT "disciplines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disciplines" ADD CONSTRAINT "disciplines_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_offerings" ADD CONSTRAINT "course_offerings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_offerings" ADD CONSTRAINT "course_offerings_semester_id_fkey" FOREIGN KEY ("semester_id") REFERENCES "semesters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_offerings" ADD CONSTRAINT "course_offerings_discipline_id_fkey" FOREIGN KEY ("discipline_id") REFERENCES "disciplines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_offerings" ADD CONSTRAINT "course_offerings_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_offering_lecturers" ADD CONSTRAINT "course_offering_lecturers_course_offering_id_fkey" FOREIGN KEY ("course_offering_id") REFERENCES "course_offerings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_offering_lecturers" ADD CONSTRAINT "course_offering_lecturers_staff_profile_id_fkey" FOREIGN KEY ("staff_profile_id") REFERENCES "staff_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_offering_groups" ADD CONSTRAINT "course_offering_groups_course_offering_id_fkey" FOREIGN KEY ("course_offering_id") REFERENCES "course_offerings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_offering_groups" ADD CONSTRAINT "course_offering_groups_academic_group_id_fkey" FOREIGN KEY ("academic_group_id") REFERENCES "academic_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_departments" ADD CONSTRAINT "staff_departments_staff_profile_id_fkey" FOREIGN KEY ("staff_profile_id") REFERENCES "staff_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_departments" ADD CONSTRAINT "staff_departments_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_org_units" ADD CONSTRAINT "staff_org_units_staff_profile_id_fkey" FOREIGN KEY ("staff_profile_id") REFERENCES "staff_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_org_units" ADD CONSTRAINT "staff_org_units_org_unit_id_fkey" FOREIGN KEY ("org_unit_id") REFERENCES "org_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_institute_id_fkey" FOREIGN KEY ("institute_id") REFERENCES "institutes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_academic_group_id_fkey" FOREIGN KEY ("academic_group_id") REFERENCES "academic_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_dormitory_room_id_fkey" FOREIGN KEY ("dormitory_room_id") REFERENCES "dormitory_rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_granted_by_id_fkey" FOREIGN KEY ("granted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abac_policies" ADD CONSTRAINT "abac_policies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channels" ADD CONSTRAINT "channels_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channels" ADD CONSTRAINT "channels_institute_id_fkey" FOREIGN KEY ("institute_id") REFERENCES "institutes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channels" ADD CONSTRAINT "channels_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channels" ADD CONSTRAINT "channels_org_unit_id_fkey" FOREIGN KEY ("org_unit_id") REFERENCES "org_units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channels" ADD CONSTRAINT "channels_dormitory_id_fkey" FOREIGN KEY ("dormitory_id") REFERENCES "dormitories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channels" ADD CONSTRAINT "channels_academic_group_id_fkey" FOREIGN KEY ("academic_group_id") REFERENCES "academic_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channels" ADD CONSTRAINT "channels_course_offering_id_fkey" FOREIGN KEY ("course_offering_id") REFERENCES "course_offerings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_root_id_fkey" FOREIGN KEY ("thread_root_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quiet_hours_schedules" ADD CONSTRAINT "quiet_hours_schedules_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_objects" ADD CONSTRAINT "file_objects_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_objects" ADD CONSTRAINT "file_objects_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_objects" ADD CONSTRAINT "file_objects_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_objects" ADD CONSTRAINT "file_objects_uploader_id_fkey" FOREIGN KEY ("uploader_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pdf_annotations" ADD CONSTRAINT "pdf_annotations_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "file_objects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_certificates" ADD CONSTRAINT "user_certificates_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_signatures" ADD CONSTRAINT "document_signatures_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "file_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_signatures" ADD CONSTRAINT "document_signatures_certificate_id_fkey" FOREIGN KEY ("certificate_id") REFERENCES "user_certificates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_routes" ADD CONSTRAINT "approval_routes_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "file_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "approval_routes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_approver_id_fkey" FOREIGN KEY ("approver_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_signature_id_fkey" FOREIGN KEY ("signature_id") REFERENCES "document_signatures"("id") ON DELETE SET NULL ON UPDATE CASCADE;


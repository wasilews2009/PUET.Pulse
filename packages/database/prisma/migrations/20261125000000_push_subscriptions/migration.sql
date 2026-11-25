-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "session_epoch" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");

-- CreateIndex
CREATE INDEX "push_subscriptions_user_id_idx" ON "push_subscriptions"("user_id");

-- CreateIndex
CREATE INDEX "push_subscriptions_session_id_idx" ON "push_subscriptions"("session_id");

-- CreateIndex
CREATE INDEX "push_subscriptions_expires_at_idx" ON "push_subscriptions"("expires_at");

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Guardrails (not expressible in Prisma)
-- Only https push services; keys are base64url (P-256 public key, 16-byte auth secret).
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_endpoint_https" CHECK ("endpoint" LIKE 'https://%' AND length("endpoint") <= 1024);
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_keys_b64url" CHECK ("p256dh" ~ '^[A-Za-z0-9_-]{80,100}$' AND "auth" ~ '^[A-Za-z0-9_-]{16,32}$');
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_session_id_hex" CHECK ("session_id" ~ '^[0-9a-f]{64}$');

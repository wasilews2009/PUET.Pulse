-- AlterTable
ALTER TABLE "file_objects" ADD COLUMN     "outline" JSONB;

-- CreateTable
CREATE TABLE "file_bookmarks" (
    "id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "page" INTEGER NOT NULL,
    "label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_bookmarks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "file_bookmarks_file_id_user_id_page_key" ON "file_bookmarks"("file_id", "user_id", "page");

-- AddForeignKey
ALTER TABLE "file_bookmarks" ADD CONSTRAINT "file_bookmarks_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "file_objects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_bookmarks" ADD CONSTRAINT "file_bookmarks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Guardrails (not expressible in Prisma)
ALTER TABLE "file_bookmarks" ADD CONSTRAINT "file_bookmarks_page_check" CHECK ("page" BETWEEN 1 AND 2000);
ALTER TABLE "file_bookmarks" ADD CONSTRAINT "file_bookmarks_label_check" CHECK ("label" IS NULL OR char_length("label") BETWEEN 1 AND 120);
ALTER TABLE "file_objects" ADD CONSTRAINT "file_objects_outline_check" CHECK ("outline" IS NULL OR jsonb_typeof("outline") = 'array');

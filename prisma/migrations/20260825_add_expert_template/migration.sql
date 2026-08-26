-- CreateTable
CREATE TABLE "expert_templates" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "skeleton" TEXT NOT NULL,
    "styleNotes" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expert_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "expert_templates_userId_key" ON "expert_templates"("userId");

-- AddForeignKey
ALTER TABLE "expert_templates" ADD CONSTRAINT "expert_templates_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

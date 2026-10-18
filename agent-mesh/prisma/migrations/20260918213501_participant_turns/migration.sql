-- AlterTable
ALTER TABLE "Message" ADD COLUMN "author" TEXT;
ALTER TABLE "Message" ADD COLUMN "correlationId" TEXT;

-- CreateIndex
CREATE INDEX "Message_correlationId_idx" ON "Message"("correlationId");

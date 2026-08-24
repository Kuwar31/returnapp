-- CreateTable
CREATE TABLE "return_feedback" (
    "id" TEXT NOT NULL,
    "returnRequestId" TEXT NOT NULL,
    "easeScore" INTEGER,
    "repeatScore" INTEGER,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "return_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "return_feedback_returnRequestId_key" ON "return_feedback"("returnRequestId");

-- AddForeignKey
ALTER TABLE "return_feedback" ADD CONSTRAINT "return_feedback_returnRequestId_fkey" FOREIGN KEY ("returnRequestId") REFERENCES "return_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

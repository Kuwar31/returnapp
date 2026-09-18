-- A return method's own status-page wording, kept on the return at submission.
ALTER TABLE "return_routing_methods"
  ADD COLUMN "statusTitle" TEXT,
  ADD COLUMN "statusBody" TEXT,
  ADD COLUMN "packingTitle" TEXT;
ALTER TABLE "return_requests"
  ADD COLUMN "returnStatusTitle" TEXT,
  ADD COLUMN "returnStatusBody" TEXT,
  ADD COLUMN "returnPackingTitle" TEXT;

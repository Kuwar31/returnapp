-- CreateIndex
CREATE UNIQUE INDEX "order_line_items_orderId_externalId_key" ON "order_line_items"("orderId", "externalId");

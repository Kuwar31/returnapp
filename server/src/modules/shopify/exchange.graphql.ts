/**
 * Draft-order operations backing exchanges.
 *
 * The alternative is Shopify's native exchange (`exchangeLineItems` on
 * returnCreate), which puts the replacement on the original order and holds
 * fulfillment until any balance is paid. We use draft orders instead for one
 * reason: the native path doesn't commit exchange stock until `returnProcess`,
 * which in this app is days or weeks after approval, so a popular size can sell
 * out between the shopper asking for it and the parcel arriving back.
 * `reserveInventoryUntil` closes that window.
 *
 * The trade-off, deliberately accepted: the exchange is a second order, so it
 * doesn't net against the original in Shopify's reporting.
 *
 * All validated against API version 2026-04.
 */

/**
 * Opens the draft and reserves the stock.
 *
 * `purchasingEntity.customerId` attaches it to the real customer — the same
 * mistake we made with gift cards (issuing bearer value attached to nobody) is
 * one line away here, and an unattached draft order can't be paid by the
 * shopper from their account.
 */
export const DRAFT_ORDER_CREATE = `#graphql
  mutation ExchangeDraftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
        name
        status
        invoiceUrl
        totalPriceSet { shopMoney { amount currencyCode } }
      }
      userErrors { field message }
    }
  }
`;

/**
 * Re-syncs the draft when the exchange changes before it's paid.
 *
 * Sending `lineItems` replaces the whole set rather than appending, so callers
 * must always pass the complete list.
 */
export const DRAFT_ORDER_UPDATE = `#graphql
  mutation ExchangeDraftOrderUpdate($id: ID!, $input: DraftOrderInput!) {
    draftOrderUpdate(id: $id, input: $input) {
      draftOrder {
        id
        status
        invoiceUrl
        totalPriceSet { shopMoney { amount currencyCode } }
      }
      userErrors { field message }
    }
  }
`;

/**
 * Emails the shopper a secure checkout link for the balance.
 *
 * Shopify moves the draft to INVOICE_SENT and stamps `invoiceSentAt` itself,
 * so both are read back rather than assumed.
 */
export const DRAFT_ORDER_INVOICE_SEND = `#graphql
  mutation ExchangeDraftOrderInvoiceSend($id: ID!, $email: EmailInput!) {
    draftOrderInvoiceSend(id: $id, email: $email) {
      draftOrder { id status invoiceSentAt }
      userErrors { field message }
    }
  }
`;

/**
 * Turns the draft into a real, fulfillable order.
 *
 * Only used when nothing is owed — an even swap or a trade-down. When there is
 * a balance the shopper's own payment through the invoice link completes the
 * draft, and calling this would hand them the goods for free.
 */
export const DRAFT_ORDER_COMPLETE = `#graphql
  mutation ExchangeDraftOrderComplete($id: ID!) {
    draftOrderComplete(id: $id) {
      draftOrder {
        id
        status
        order { id name }
      }
      userErrors { field message }
    }
  }
`;

/**
 * Where a shopper pays a balance owed on the order itself.
 *
 * The native exchange route has no draft order and therefore no invoice link:
 * the replacement is added to the original order and Shopify holds fulfilment
 * until the difference is paid. This is the link that lets them pay it, so the
 * confirmation page can offer the same "pay now" the draft route already does.
 */
export const ORDER_PAYMENT_COLLECTION = `#graphql
  query OrderPaymentCollection($id: ID!) {
    order(id: $id) {
      id
      totalOutstandingSet {
        presentmentMoney { amount currencyCode }
      }
      paymentCollectionDetails {
        additionalPaymentCollectionUrl
      }
    }
  }
`;

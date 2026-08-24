/**
 * Admin GraphQL operations for return management, following
 * https://shopify.dev/docs/apps/build/orders-fulfillment/returns-apps/build-return-management
 *
 * All validated against API version 2026-04.
 */

/**
 * Step 1 — the fulfillments an order can still return.
 *
 * returnCreate keys off FulfillmentLineItem ids, which are distinct from the
 * LineItem ids we mirror during order sync, so they have to be resolved here
 * rather than stored up front. Quantities are also authoritative: they already
 * account for anything returned previously through any other app.
 */
export const RETURNABLE_FULFILLMENTS = `#graphql
  query ReturnableFulfillments($orderId: ID!) {
    returnableFulfillments(orderId: $orderId, first: 20) {
      nodes {
        id
        returnableFulfillmentLineItems(first: 100) {
          nodes {
            quantity
            fulfillmentLineItem {
              id
              lineItem { id sku title }
            }
          }
        }
      }
    }
  }
`;

/**
 * Step 4 — create the return.
 *
 * Creates it directly in OPEN state, which is right for this app: by the time
 * we call it a merchant has already approved the request in our own UI, so
 * routing through returnRequest + returnApproveRequest would make them approve
 * the same return twice.
 */
export const RETURN_CREATE = `#graphql
  mutation ReturnCreate($input: ReturnInput!) {
    returnCreate(returnInput: $input) {
      return {
        id
        name
        status
        totalQuantity
        returnLineItems(first: 50) {
          nodes {
            id
            quantity
            ... on ReturnLineItem {
              fulfillmentLineItem { id }
            }
          }
        }
      }
      userErrors { field message code }
    }
  }
`;

/**
 * Step 8 — what Shopify thinks the refund should be.
 *
 * Read-only. It resolves discounts, taxes, duties and the maximum refundable
 * amount per transaction, so we never have to reimplement Shopify's tax and
 * discount maths — which is where a hand-rolled refund would drift.
 */
export const SUGGESTED_FINANCIAL_OUTCOME = `#graphql
  query SuggestedFinancialOutcome(
    $returnId: ID!
    $returnLineItems: [SuggestedOutcomeReturnLineItemInput!]!
    $exchangeLineItems: [SuggestedOutcomeExchangeLineItemInput!]!
    $refundMethodAllocation: RefundMethodAllocation
  ) {
    return(id: $returnId) {
      id
      status
      suggestedFinancialOutcome(
        returnLineItems: $returnLineItems
        exchangeLineItems: $exchangeLineItems
        refundMethodAllocation: $refundMethodAllocation
      ) {
        maximumRefundable { shopMoney { amount currencyCode } }
        discountedSubtotal { shopMoney { amount currencyCode } }
        totalTax { shopMoney { amount currencyCode } }
        # A union: RefundReturnOutcome when money goes back to the customer,
        # InvoiceReturnOutcome when an exchange leaves them owing instead.
        financialTransfer {
          __typename
          ... on RefundReturnOutcome {
            amount { shopMoney { amount currencyCode } }
            suggestedTransactions {
              # presentmentMoney is what the customer was actually charged, and
              # is the currency the parent transaction is denominated in.
              # shopMoney is the merchant's own currency and will be rejected
              # on any store selling in a second currency.
              amountSet {
                shopMoney { amount currencyCode }
                presentmentMoney { amount currencyCode }
              }
              maximumRefundableSet {
                shopMoney { amount currencyCode }
                presentmentMoney { amount currencyCode }
              }
              parentTransaction { id }
              gateway
            }
          }
        }
      }
    }
  }
`;

/**
 * Step 9 — issue the refund and decide what happens to the items.
 *
 * Disposition and refund travel together: this is the call that puts stock
 * back on the shelf and moves the money.
 */
export const RETURN_PROCESS = `#graphql
  mutation ReturnProcess($input: ReturnProcessInput!) {
    returnProcess(input: $input) {
      return {
        id
        status
        refunds(first: 5) { nodes { id totalRefundedSet { shopMoney { amount currencyCode } } } }
      }
      userErrors { field message code }
    }
  }
`;

/**
 * Dispositions are addressed by ReverseFulfillmentOrderLineItem id — a third
 * identifier, distinct from both the FulfillmentLineItem used to create the
 * return and the ReturnLineItem on the return itself. Shopify mints these when
 * the return is created, so they can only be read back afterwards.
 */
export const REVERSE_FULFILLMENT_ORDERS = `#graphql
  query ReverseFulfillmentOrders($returnId: ID!) {
    return(id: $returnId) {
      id
      reverseFulfillmentOrders(first: 20) {
        nodes {
          id
          status
          lineItems(first: 100) {
            nodes {
              id
              totalQuantity
              fulfillmentLineItem { id }
            }
          }
        }
      }
    }
  }
`;

/**
 * Restocking has to name the location the stock goes back to; Shopify won't
 * infer one. This picks the shop's default fulfillment location.
 */
export const PRIMARY_LOCATION = `#graphql
  query PrimaryLocation {
    shop {
      fulfillmentServices { location { id name } serviceName }
    }
    locations(first: 5, includeInactive: false) {
      nodes { id name isActive fulfillsOnlineOrders }
    }
  }
`;

/**
 * Marks returned items as physically received and decides where they go.
 *
 * This is a separate step from the refund on purpose: until items are disposed,
 * Shopify's "returned quantity" is zero, and returnProcess refuses to refund
 * against quantities it has no record of receiving. So this belongs to the
 * merchant's "mark received" action, not to resolution.
 */
export const REVERSE_FULFILLMENT_ORDER_DISPOSE = `#graphql
  mutation ReverseFulfillmentOrderDispose(
    $dispositionInputs: [ReverseFulfillmentOrderDisposeInput!]!
  ) {
    reverseFulfillmentOrderDispose(dispositionInputs: $dispositionInputs) {
      reverseFulfillmentOrderLineItems {
        id
        totalQuantity
        dispositions { id quantity type }
      }
      userErrors { field message }
    }
  }
`;

/** Used to close a return once everything has been processed. */
export const RETURN_CLOSE = `#graphql
  mutation ReturnClose($id: ID!) {
    returnClose(id: $id) {
      return { id status }
      userErrors { field message code }
    }
  }
`;

/**
 * Credits a customer's Shopify store credit account.
 *
 * `id` accepts the account owner, so the Customer GID works directly and we
 * don't need to look the account up first — Shopify creates one on demand.
 * This replaces our own credit codes, which nothing at checkout could redeem.
 */
export const STORE_CREDIT_ACCOUNT_CREDIT = `#graphql
  mutation StoreCreditAccountCredit(
    $id: ID!
    $creditInput: StoreCreditAccountCreditInput!
  ) {
    storeCreditAccountCredit(id: $id, creditInput: $creditInput) {
      storeCreditAccountTransaction {
        amount { amount currencyCode }
        balanceAfterTransaction { amount currencyCode }
        account { id }
        createdAt
      }
      userErrors { field message }
    }
  }
`;

/**
 * Issues a Shopify gift card.
 *
 * `giftCardCode` is returned **only here, only once** — Shopify stores a hash
 * and afterwards exposes just the masked form. It has to be captured on this
 * response and delivered to the customer, or the card is unusable.
 */
export const GIFT_CARD_CREATE = `#graphql
  mutation GiftCardCreate($input: GiftCardCreateInput!) {
    giftCardCreate(input: $input) {
      giftCard {
        id
        maskedCode
        lastCharacters
        balance { amount currencyCode }
        expiresOn
        customer { id }
      }
      giftCardCode
      userErrors { field message code }
    }
  }
`;

/** Resolves a Customer GID from an email, for orders synced without one. */
export const FIND_CUSTOMER_BY_EMAIL = `#graphql
  query FindCustomer($query: String!) {
    customers(first: 1, query: $query) {
      nodes { id email }
    }
  }
`;

/**
 * Our reason codes are named to line up with Shopify's ReturnReason enum, but
 * merchants can add their own, so anything unrecognised degrades to OTHER
 * rather than failing the whole return.
 */
/**
 * Shopify's ReturnReason enum, in full.
 *
 * Merchants word their own reasons however they like, but each must still map
 * onto one of these — it's what `returnCreate` accepts and what Shopify's own
 * reporting groups by. Exported so the settings UI can only offer valid codes.
 */
export const SHOPIFY_RETURN_REASONS = new Set([
  "COLOR",
  "DEFECTIVE",
  "NOT_AS_DESCRIBED",
  "OTHER",
  "SIZE_TOO_LARGE",
  "SIZE_TOO_SMALL",
  "STYLE",
  "UNKNOWN",
  "UNWANTED",
  "WRONG_ITEM",
]);

export const toShopifyReturnReason = (code: string | null): string =>
  code && SHOPIFY_RETURN_REASONS.has(code) ? code : "OTHER";

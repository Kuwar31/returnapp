/**
 * Every string the app supplies to a shopper, in English.
 *
 * The source of truth: `keyof typeof en` is what the translator function
 * accepts, so a key that isn't here is a type error at the call site, and a
 * translation carrying a key that no longer exists is one here too.
 *
 * Keys are namespaced by screen. Plurals end in `_one` / `_other` and are
 * reached through `t.plural`, which asks Intl which form a language wants —
 * Polish has three, Arabic six, and none of that is expressible as a ternary.
 *
 * What is deliberately absent: anything the merchant writes themselves. Their
 * heading, field labels and footer are already theirs to word, and translating
 * a sentence they typed would mean overwriting it.
 */
export const en = {
  // --- lookup ------------------------------------------------------------
  "lookup.title": "Find your order",
  "lookup.intro": "Enter your order number and the email you used at checkout.",
  "lookup.orderPlaceholder": "e.g. 1001",
  "lookup.emailPlaceholder": "you@example.com",
  "lookup.busy": "Finding your order…",
  "lookup.error.missing": "Enter both your order number and email address.",
  "lookup.error.failed": "We couldn't look up your order. Please try again.",

  // --- shell -------------------------------------------------------------
  "shell.needHelp": "Need help?",
  "shell.unavailable.title": "Portal unavailable",
  "shell.unavailable.body":
    "We couldn't find that store's returns portal. Please use the link the store sent you.",
  "shell.resume": "You have a return in progress",
  "shell.resumeAction": "View it",

  // --- shared ------------------------------------------------------------
  "common.goBack": "Go back",
  "common.continue": "Continue",
  "common.loading": "Loading…",
  "common.remove": "Remove",
  "common.close": "Close",
  "common.back": "Back",

  // --- item picker -------------------------------------------------------
  "picker.title": "Select an item to return",
  "picker.intro": "You'll have the opportunity to add more later.",
  "picker.returnableUntil": "Returnable until {date}",
  "picker.existing": "You already have a return for this order",
  "picker.started": "started {date}",
  "picker.windowClosed": "This order is outside the {days}-day return window.",
  "picker.exchangingFor": "Exchanging for",
  "picker.remove": "Remove",
  "picker.unavailable": "Unavailable for return",
  "picker.shopFailed": "Couldn't open the store just now.",
  "picker.selected_one": "{count} item selected",
  "picker.selected_other": "{count} items selected",
  "picker.continue": "Continue with return",
  "picker.returnWord": "Return",

  // --- totals ------------------------------------------------------------
  "totals.items": "Item total",
  "totals.bonus": "Bonus credit",
  "totals.restocking": "Restocking fee",

  // --- the shop-now offer ------------------------------------------------
  "offer.leadIn": "Shop now and get",
  "offer.percentExtra": "{percent}% extra",
  "offer.plus": "plus {amount}",
  "offer.moreToSpend": "— {amount} more to spend.",
  "offer.fallback": "Spend your return with us instead?",
  "offer.takeMoney": "Get {amount}",
  "offer.opening": "Opening the store…",
  "offer.shopWith": "Shop now with {amount}",

  // --- the per-item drawer -----------------------------------------------
  "drawer.whyReturning": "Why are you returning this item?",
  "drawer.closest": "Which of these is closest?",
  "drawer.allReasons": "All reasons",
  "drawer.detailsHelp":
    "Specific details help us prevent similar issues in future.",
  "drawer.noteLabel": "Tell us what happened",
  "drawer.notePlaceholder": "A short description helps us put it right",
  "drawer.howProceed": "How would you like to proceed?",
  "drawer.bestMatch": "Best match for you",
  "drawer.exchangeSize": "Exchange for new size",
  "drawer.exchangeProduct": "Exchange for another product",
  "drawer.returnItem": "Return item",
  "drawer.paidNextStep": "Choose how you're paid on the next step",
  "drawer.seeAvailable": "See what's available",
  "drawer.sizeOptions_one": "{count} other option available",
  "drawer.sizeOptions_other": "{count} size options available",
  "drawer.loadingOptions": "Loading options…",
  "drawer.searchProducts": "Search products",
  "drawer.noProducts": "No products match that search.",
  "drawer.returning": "Returning",
  "drawer.options": "Options",
  "drawer.prevImage": "Previous image",
  "drawer.nextImage": "Next image",
  "drawer.currentOption": "This is the option you have",
  "drawer.outOfStock": "Out of stock",
  "drawer.confirmItem": "Confirm item",
  "drawer.chooseOption": "Choose a {option}",
  "drawer.absorbed": "No difference to pay — {store} covers it.",
  "drawer.youPay": "You'll pay {amount} more.",
  "drawer.youGetCredit": "You'll receive a credit of {amount}.",
  "drawer.evenSwap": "An even swap — nothing more to pay.",
  "drawer.suggest.fit":
    "You told us the fit was wrong, so we've kept the same item and opened its other sizes.",
  "drawer.suggest.wrongItem":
    "Same item, other options — swap to the one you meant to receive.",
  "drawer.suggest.generic": "Swap this for another option of the same item.",

  // --- how a shopper is paid ---------------------------------------------
  "resolution.refund": "Refund to original payment method",
  "resolution.storeCredit": "Store credit",
  "resolution.giftCard": "Gift card",
  "resolution.exchange": "Exchange",
  "resolution.instantExchange": "Instant exchange",
  "resolution.refund.blurb":
    "Receive a refund (minus applicable fees) to your original payment method once your return is approved",
  "resolution.storeCredit.blurb":
    "Added to your account balance to spend whenever you like, once your return is approved",
  "resolution.giftCard.blurb":
    "Receive a gift card code via email once your return has been approved",

  // --- review ------------------------------------------------------------
  "review.title": "Review your return",
  "review.sendBack": "Send back your return",
  "review.handlingFees": "Handling fees may apply.",
  "review.boxAndShip": "Box and ship it",
  "review.sendingBack": "What you're sending back",
  "review.getting": "What you're getting",
  "review.editBasket": "Edit basket",
  "review.yourDetails": "Your details",
  "review.email": "Email",
  "review.name": "Name",
  "review.order": "Order",
  "review.summary": "Return summary",
  "review.returnCredits": "Return credits ({count})",
  "review.creditSubtotal": "Credit subtotal",
  "review.purchasing": "Purchasing ({count})",
  "review.purchaseSubtotal": "Purchase subtotal",
  "review.covered": "Price difference · covered by {store}",
  "review.creditOptions": "Credit options",
  "review.howDifference": "How would you like the difference?",
  "review.refundForReturns": "Refund for your returns",
  "review.costOfExchange": "Cost of your exchange",
  "review.totalRefund": "Total estimated refund",
  "review.toPay": "To pay for your exchange",
  "review.toPayShort": "To pay",
  "review.submit": "Submit return",
  "review.submitting": "Submitting…",
  "review.payAndSubmit": "Pay and submit",
  "review.payDialogBody":
    "Checkout will open on a new page. Your return is submitted either way — if you'd rather pay later, the link is on your confirmation page and in your email.",
  "review.cancel": "Cancel",
  "review.shippingAddress": "Shipping address",
  "review.deliveringTo": "Delivering to",
  "common.error": "Something went wrong.",

  // --- shop now, returning from the storefront ---------------------------
  "shopReturn.back": "Back to your return",
  "shopReturn.restoring": "Bringing your basket back…",
  "shopReturn.failed": "We couldn't read your basket.",

  // --- status page -------------------------------------------------------
  "status.edit": "Edit your return",
  "status.cancel": "Cancel return",
  "status.cancelling": "Cancelling…",
  "status.confirmCancel": "Yes, cancel this return",
  "status.cancelled": "This return has been cancelled.",
  "status.contactInfo": "Contact info",
  "status.startAnother": "Start another return",
  "status.notFound.title": "We couldn't find that return",
  "status.notFound.body":
    "The reference and email don't match, or the link has expired.",
  "status.backToReturns": "Back to returns",
  "status.paymentReceived": "Payment received",
  "status.payNow": "Pay now",
  "status.paid": "Paid",
  "status.questions": "Questions?",
  "status.questionsEmail": "Questions? Email",
  "status.orderNo": "Order #{number}",
  "status.returnWord": "Return",
  "status.requestSubmitted": "Request submitted",
  "status.storeReview": "Store review",
  "status.declined": "Declined",
  "status.awaitingReview": "Waiting for the store to review",
  "status.approvedOn": "Approved {date}",
  "status.resolved": "Resolved",
  "status.onceItemsArrive": "Once your items arrive back with us",
  "status.youReceived": "You received",

  // One state's three lines together: the banner, the card title, the body.
  "status.DRAFT.heading": "Your return is saved",
  "status.DRAFT.title": "You haven't submitted this yet",
  "status.DRAFT.body": "Pick up where you left off whenever you're ready.",
  "status.SUBMITTED.heading": "Your return has been submitted",
  "status.SUBMITTED.title": "We're reviewing your request",
  "status.SUBMITTED.body":
    "You'll hear from us by email once the store has reviewed it, usually within one business day. Nothing to send back just yet.",
  "status.APPROVED.heading": "Your return has been approved",
  "status.APPROVED.title": "Your return label is on the way",
  "status.APPROVED.body":
    "We'll email your return label within 24 hours. If you have any questions or don't receive your email, please reach out to us.",
  "status.REJECTED.heading": "Your return wasn't approved",
  "status.REJECTED.title": "This request has been declined",
  "status.REJECTED.body":
    "Please get in touch if you think this was a mistake — we're happy to take another look.",
  "status.IN_TRANSIT.heading": "Your return is on its way",
  "status.IN_TRANSIT.title": "We're waiting for your parcel",
  "status.IN_TRANSIT.body":
    "Once it reaches our warehouse we'll check the items over and settle your return.",
  "status.RECEIVED.heading": "We've got your return",
  "status.RECEIVED.title": "Your items are being checked",
  "status.RECEIVED.body":
    "We're inspecting everything now. Your refund or credit follows shortly after.",
  "status.RESOLVED.heading": "Your return is complete",
  "status.RESOLVED.title": "All settled",
  "status.RESOLVED.body":
    "Everything has been processed. Thanks for shopping with us.",
  "status.CANCELLED.heading": "Your return was cancelled",
  "status.CANCELLED.title": "Nothing more to do",
  "status.CANCELLED.body":
    "This request has been cancelled. You can start a new return any time while the window is open.",
  "status.EXPIRED.heading": "This return has expired",
  "status.EXPIRED.title": "The window has closed",
  "status.EXPIRED.body":
    "We didn't receive your items in time. Please contact us if you'd still like to send them back.",

  // --- shop now ----------------------------------------------------------
  "shop.allProducts": "All products",
  "shop.collections": "Collections",
  "shop.searchPlaceholder": "Search for product…",
  "shop.loadingProducts": "Loading products…",
  "shop.nothingHere": "Nothing here yet.",
  "shop.emptyCart": "Nothing added yet.",
  "shop.newItems": "New items",
  "shop.yourCredit": "Your return credit",
  "shop.creditRemaining": "Credit remaining",
  "shop.creditFailed": "Couldn't load your credit.",
  "shop.leftToPay": "Left to pay",
  "shop.morePay": "more to pay",
  "shop.toSpend": "to spend from your return",
  "shop.keepShopping": "Keep shopping",
  "shop.continueCount": "Continue ({count})",
  "shop.addToCart": "Add to cart",
  "shop.inStock": "In stock",
  "shop.soldOut": "Sold out",
  "shop.quantity": "Quantity",
  "shop.closeAndBack": "Close and go back to your return",
  "shop.closeCart": "Close cart",
  "shop.oneFewer": "One fewer",
  "shop.oneMore": "One more",

  // --- why an item can't come back ---------------------------------------
  "ineligible.replacement":
    "This item is a replacement from an earlier exchange, so it can't be returned again.",
  "ineligible.unshipped": "This item hasn't shipped yet.",
  "ineligible.windowClosed": "The {days}-day return window has closed.",
  "ineligible.finalSale": "This item is final sale and can't be returned.",
  "ineligible.returnOpen": "This item already has a return open.",
  "ineligible.alreadyReturned": "This item has already been returned.",
  "ineligible.exchangeOnlyUnavailable":
    "This item can only be exchanged, and no exchange options are available.",
  "shop.alreadyInCart": "{count} already in your cart",
  "ineligible.exchangeLimit": "This item has already been exchanged as many times as this store allows.",
} as const;

/*
 * The credit bar on the merchant's storefront.
 *
 * A shopper sent here from the returns portal arrives with ?rm_credit=<token>.
 * The token is a signed JWT whose payload carries the credit, the currency and
 * the URL to go back to — read here, never verified here, because nothing on
 * this page is *granted* by it. The returns app re-prices the credit and the
 * basket from its own database and from Shopify when the return is submitted,
 * so the worst a forged token can do is show its holder a wrong number.
 *
 * Deliberately dependency-free and self-contained: it runs on somebody else's
 * theme, and the one thing it must never do is break their shop.
 */
(function () {
  var PARAM = "rm_credit";
  var STORE_KEY = "rm_credit_session";

  var root = document.getElementById("rm-credit-bar");
  if (!root) return;

  /** Reads a JWT payload without verifying it. See the note above. */
  function readToken(token) {
    try {
      var part = token.split(".")[1];
      if (!part) return null;
      var json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
      var claims = JSON.parse(json);
      if (!claims || typeof claims.credit !== "number" || !claims.returnUrl) {
        return null;
      }
      // Expiry is enforced properly by the returns app; honoured here so a
      // stale bar doesn't linger for an hour after the trip is over.
      if (claims.exp && claims.exp * 1000 < Date.now()) return null;
      return claims;
    } catch (e) {
      return null;
    }
  }

  /**
   * The session, from the URL if the shopper has just arrived, otherwise from
   * where the last page put it. Kept in sessionStorage so it survives browsing
   * around the shop but doesn't outlive the tab.
   */
  function loadSession() {
    var fromUrl = new URLSearchParams(window.location.search).get(PARAM);
    if (fromUrl) {
      var parsed = readToken(fromUrl);
      if (parsed) {
        try {
          sessionStorage.setItem(STORE_KEY, fromUrl);
        } catch (e) {
          /* private browsing: the bar lasts this page only */
        }
        /*
         * Take the token out of the address bar once it's stored. It is not a
         * secret, but leaving it there means it rides into the referrer of
         * every outbound link and sits in the shopper's history.
         */
        var clean = new URL(window.location.href);
        clean.searchParams.delete(PARAM);
        window.history.replaceState({}, "", clean.toString());
        return parsed;
      }
    }
    try {
      var stored = sessionStorage.getItem(STORE_KEY);
      return stored ? readToken(stored) : null;
    } catch (e) {
      return null;
    }
  }

  var session = loadSession();
  if (!session) return;

  var label = {
    credit: root.dataset.creditLabel || "return credit",
    remaining: root.dataset.remainingLabel || "left",
    over: root.dataset.overLabel || "over your credit",
    button: root.dataset.returnLabel || "Finish my return",
  };

  function money(amount) {
    try {
      return new Intl.NumberFormat(document.documentElement.lang || "en", {
        style: "currency",
        currency: session.currency,
      }).format(amount);
    } catch (e) {
      // An unknown currency code shouldn't cost the shopper the number.
      return session.currency + " " + amount.toFixed(2);
    }
  }

  root.hidden = false;
  root.innerHTML =
    '<div class="rm-credit-bar__inner">' +
    '<span class="rm-credit-bar__text" id="rm-credit-text"></span>' +
    '<button type="button" class="rm-credit-bar__btn" id="rm-credit-go"></button>' +
    "</div>";

  var text = root.querySelector("#rm-credit-text");
  var button = root.querySelector("#rm-credit-go");
  button.textContent = label.button;

  var cart = { items: [] };

  function render() {
    var spent = cart.items.reduce(function (sum, item) {
      // Shopify quotes money in minor units on /cart.js.
      return sum + (item.line_price || 0) / 100;
    }, 0);
    var left = Math.round((session.credit - spent) * 100) / 100;

    text.textContent =
      left >= 0
        ? money(session.credit) +
          " " +
          label.credit +
          " · " +
          money(left) +
          " " +
          label.remaining
        : money(session.credit) +
          " " +
          label.credit +
          " · " +
          money(Math.abs(left)) +
          " " +
          label.over;

    root.classList.toggle("is-over", left < 0);
    button.disabled = cart.items.length === 0;
  }

  /** Shopify's own cart endpoint — same origin, no app permissions needed. */
  function refresh() {
    fetch(window.Shopify && window.Shopify.routes
      ? window.Shopify.routes.root + "cart.js"
      : "/cart.js", { credentials: "same-origin" })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (data) {
        if (!data) return;
        cart = data;
        render();
      })
      .catch(function () {
        /* leave the last known figures up rather than blanking the bar */
      });
  }

  /**
   * Hands the basket back to the returns portal.
   *
   * Variant ids and quantities only — the portal re-reads titles and prices
   * from Shopify, so nothing here is trusted as a price.
   */
  button.addEventListener("click", function () {
    var lines = cart.items
      .filter(function (item) {
        return item.variant_id;
      })
      .map(function (item) {
        return item.variant_id + ":" + item.quantity;
      });

    var url = new URL(session.returnUrl);
    url.searchParams.set("cart", lines.join(","));
    try {
      sessionStorage.removeItem(STORE_KEY);
    } catch (e) {
      /* nothing to clean up */
    }
    window.location.assign(url.toString());
  });

  render();
  refresh();

  /*
   * Themes add to cart in a dozen different ways, so rather than guess at every
   * one, listen for the requests themselves. Both are patched non-destructively
   * — the original is always called, and its result always returned.
   */
  var isCartWrite = function (url) {
    return typeof url === "string" && /\/cart\/(add|change|update|clear)/.test(url);
  };

  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function () {
      var url = arguments[0];
      var target = url && url.url ? url.url : url;
      var result = origFetch.apply(this, arguments);
      if (isCartWrite(target)) result.then(refresh, function () {});
      return result;
    };
  }

  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (isCartWrite(url)) this.addEventListener("load", refresh);
    return origOpen.apply(this, arguments);
  };

  // A full page navigation after a form post is the other common pattern.
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) refresh();
  });
})();

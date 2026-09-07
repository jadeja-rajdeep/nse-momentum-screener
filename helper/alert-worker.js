/* ============================================================================
   alert-worker.js — Web Worker for the NSE Momentum Screener price-alert
   engine.
   ----------------------------------------------------------------------------
   Runs off the main thread. alert.js posts it a batch job every 5 minutes
   (only during 9:15 AM-3:30 PM IST market hours):

     postMessage({
       type: "CHECK_ALERTS",
       stocks: [{ code, name, prevClose }, ...],   // prevClose = previous day
                                                     // Close, pulled from allData
                                                     // by alert.js (a worker has
                                                     // no access to the page's
                                                     // globals/DOM)
       alerts: [{ id, code, condition, value, enabled }, ...]
     })

   It fetches ONE live-price API call for every stock that has at least one
   enabled alert, compares each alert's condition against the live price, and
   posts back only the alerts that fired:

     postMessage({ type: "TRIGGERED", results: [{ alertId, code, name,
                    condition, value, ltp, prevClose }, ...] })

   or, on any failure:

     postMessage({ type: "ERROR", error: "<message>" })

   ----------------------------------------------------------------------------
   LIVE PRICE API
   ----------------------------------------------------------------------------
   This defaults to Yahoo Finance's public quote endpoint, which accepts many
   symbols in a single request (NSE symbols use the ".NS" suffix) - matching
   "call the one api which get all the live price data". It's free and needs
   no key, but it's a third-party endpoint outside your control (rate limits/
   CORS behaviour can change over time).

   If you'd rather use your own PHP backend for a live-quotes endpoint, that's
   the more "rock solid" long-term option - just point LIVE_PRICE_API_URL at
   it and adjust parseLivePriceResponse() to match its JSON shape. Everything
   else in this file (the alert-matching logic) stays the same.
   ========================================================================= */

const LIVE_PRICE_API_URL =
    "https://query1.finance.yahoo.com/v7/finance/quote?symbols=";

// Turn our internal NSE "Code" into whatever the live-price API expects.
function toApiSymbol(code) {
    return code + ".NS";
}

// Build the request URL for a batch of stock codes.
function buildRequestUrl(codes) {
    const symbols = codes.map(toApiSymbol).join(",");
    return LIVE_PRICE_API_URL + encodeURIComponent(symbols);
}

// Parse the API's JSON body into { CODE: lastTradedPrice, ... }.
// Swap this out if you change LIVE_PRICE_API_URL to a different provider.
function parseLivePriceResponse(json) {
    const out = {};
    const quotes =
        (json && json.quoteResponse && json.quoteResponse.result) || [];
    quotes.forEach((q) => {
        const sym = (q.symbol || "").replace(/\.NS$/i, "");
        const price = q.regularMarketPrice;
        if (sym && typeof price === "number" && !isNaN(price)) {
            out[sym.toUpperCase()] = price;
        }
    });
    return out;
}

async function fetchLivePrices(codes) {
    const url = buildRequestUrl(codes);
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error("Live price API HTTP " + res.status);
    const json = await res.json();
    return parseLivePriceResponse(json);
}

// Sanity guard: if the live price is wildly off from yesterday's close
// (bad tick / stale/garbage API data), ignore it rather than firing a false
// alert. NSE circuit limits mean a genuine single-day move essentially never
// exceeds this.
const MAX_SANE_MOVE_PCT = 25;
function isSanePrice(ltp, prevClose) {
    if (!prevClose || prevClose <= 0) return true; // no baseline to check against
    const movePct = (Math.abs(ltp - prevClose) / prevClose) * 100;
    return movePct <= MAX_SANE_MOVE_PCT;
}

function checkAlerts(stocks, alerts, prices) {
    const prevCloseByCode = {};
    stocks.forEach((s) => (prevCloseByCode[s.code.toUpperCase()] = s.prevClose));
    const nameByCode = {};
    stocks.forEach((s) => (nameByCode[s.code.toUpperCase()] = s.name));

    const results = [];
    alerts.forEach((a) => {
        if (!a.enabled) return;
        const codeKey = (a.code || "").toUpperCase();
        const ltp = prices[codeKey];
        if (typeof ltp !== "number") return; // no live price for this code this round
        const prevClose = prevCloseByCode[codeKey];
        if (!isSanePrice(ltp, prevClose)) return;

        const hit =
            (a.condition === ">=" && ltp >= a.value) ||
            (a.condition === "<=" && ltp <= a.value);

        if (hit) {
            results.push({
                alertId: a.id,
                code: a.code,
                name: nameByCode[codeKey] || a.code,
                condition: a.condition,
                value: a.value,
                ltp: ltp,
                prevClose: prevClose,
            });
        }
    });
    return results;
}

self.onmessage = async function (e) {
    const msg = e.data || {};
    if (msg.type !== "CHECK_ALERTS") return;

    const stocks = msg.stocks || [];
    const alerts = msg.alerts || [];
    if (!stocks.length || !alerts.length) return;

    try {
        const codes = stocks.map((s) => s.code);
        const prices = await fetchLivePrices(codes);
        const results = checkAlerts(stocks, alerts, prices);
        self.postMessage({ type: "TRIGGERED", results: results });
    } catch (err) {
        self.postMessage({
            type: "ERROR",
            error: (err && err.message) || String(err),
        });
    }
};

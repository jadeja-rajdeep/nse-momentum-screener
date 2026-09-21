/* ============================================================================
   alert-worker.js — Web Worker for the NSE Momentum Screener price-alert
   engine.
   ----------------------------------------------------------------------------
   Runs off the main thread. alert.js posts it a batch job every 5 minutes
   (only during 9:15 AM-3:30 PM IST market hours):

     postMessage({
       type: "CHECK_ALERTS",
       requestId: <number>,            // echoed back so alert.js can ignore
                                       // stale / late replies
       allAlerts: [{ id, code, name, condition, value, prevClose, type }, ...]
     })

   It makes ONE live-price API call, compares every alert's condition against
   the live price, and posts back:

     postMessage({ type: "TRIGGERED", requestId,
                   results: [{ ...alert, alertId, ltp }, ...],   // fired only
                   livePrices: Map<SYMBOL, number> })            // compact LTP map

   or, on any failure:

     postMessage({ type: "ERROR", requestId, error: "<message>" })

   EVERY CHECK_ALERTS message gets exactly ONE reply (TRIGGERED or ERROR),
   including empty batches - alert.js relies on that to release its
   "check in flight" lock.
   ========================================================================= */

const LIVE_PRICE_API_URL = "https://nse-momentum-screener-api.vercel.app/api/get-live-data-proxy";
// Vercel cold start: the very first call after the worker starts can be slow
// while the serverless function boots, so it gets a bigger timeout.
// Every call after that uses the normal timeout.
const FIRST_CALL_TIMEOUT_MS = 60 * 1000;
const NORMAL_TIMEOUT_MS = 35 * 1000;
let isFirstCall = true;

async function fetchLivePrices() {
    const timeoutMs = isFirstCall ? FIRST_CALL_TIMEOUT_MS : NORMAL_TIMEOUT_MS;
    isFirstCall = false;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(LIVE_PRICE_API_URL, {
            headers: { Accept: "application/json" },
            cache: "no-store", // a cached response would mean a stale "live" price
            signal: ctrl.signal,
        });
        if (!res.ok) throw new Error("Live price API HTTP " + res.status);
        const json = await res.json();
        /*
        for testing purpose.
        const json = [
            { "identifier": "TMPVQN", "symbol": "TMPV", "series": "EQ", "marketType": "N", "pchange": 2.52, "change": 18, "basePrice": 0, "previousClose": 300, "lastPrice": 305, "totalTradedVolume": 394.0071, "issuedCap": 15414179062, "totalTradedValue": 2868.371688, "totalMarketCap": 1126776.4894322 },
        ];
         */
        const list = Array.isArray(json) ? json : (json.data || []);

        // symbol -> last traded price (number). Only finite prices are kept, and
        // only this compact map is posted back to the page (not ~2000 full rows).
        const ltpMap = new Map();
        list.forEach((r) => {
            const ltp = parseFloat(r.lastPrice);
            if (r && r.symbol != null && Number.isFinite(ltp)) {
                ltpMap.set(String(r.symbol).toUpperCase(), ltp);
            }
        });
        return ltpMap;
    } catch (err) {
        if (err && err.name === "AbortError") {
            throw new Error("Live price API timed out after " + timeoutMs / 1000 + "s");
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
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

function checkAlerts(allAlerts, prices) {
    const results = [];
    const seen = new Set(); // one fire per alert id per batch
    allAlerts.forEach((a) => {
        if (!a || seen.has(a.id)) return;
        const ltp = prices.get((a.code || "").toUpperCase());
        if (ltp === undefined) return;           // no live price this round
        if (!isSanePrice(ltp, a.prevClose)) return;

        const value = parseFloat(a.value);
        if (!Number.isFinite(value)) return;

        const hit =
            (a.condition === ">=" && ltp >= value) ||
            (a.condition === "<=" && ltp <= value);
        if (hit) {
            seen.add(a.id);
            // alertId is what the page's notification/dedupe code keys on
            results.push({ ...a, alertId: a.id, ltp });
        }
    });
    return results;
}

self.onmessage = async function (e) {
    const msg = e.data || {};
    if (msg.type !== "CHECK_ALERTS") return;
    const requestId = msg.requestId;

    try {
        const allAlerts = Array.isArray(msg.allAlerts) ? msg.allAlerts : [];
        if (!allAlerts.length) {
            // Still reply: otherwise the page's in-flight lock never releases.
            self.postMessage({ type: "TRIGGERED", requestId, results: [], livePrices: new Map() });
            return;
        }
        const prices = await fetchLivePrices();
        const results = checkAlerts(allAlerts, prices);
        self.postMessage({ type: "TRIGGERED", requestId, results, livePrices: prices });
    } catch (err) {
        self.postMessage({
            type: "ERROR",
            requestId,
            error: (err && err.message) || String(err),
        });
    }
};

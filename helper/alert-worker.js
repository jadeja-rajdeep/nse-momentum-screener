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

// Two independent backends serving the identical {s, l} JSON shape.
// Cloudflare is tried first (higher free-tier ceiling); Vercel is the
// fallback if Cloudflare errors, times out, or gets rate-limited.
const CLOUDFLARE_URL = "https://nse-momentum-screener-api.jadeja-rajdeep.workers.dev";
const VERCEL_URL = "https://nse-momentum-screener-api.vercel.app/api/get-live-data-proxy";

// After this many CONSECUTIVE Cloudflare failures in this session, stop
// trying Cloudflare at all and go straight to Vercel for every subsequent
// call — until the page/worker is reloaded. Purely in-memory: not persisted
// to localStorage/sessionStorage/anywhere, so a reload always resets it and
// gives Cloudflare a fresh chance.
const MAX_CONSECUTIVE_CLOUDFLARE_FAILURES = 5;
let consecutiveCloudflareFailures = 0;
let cloudflareDisabledForSession = false;

// Cold start on either platform can be slow on the very first call, so that
// one gets a bigger timeout. Every call after that uses the normal timeout.
const FIRST_CALL_TIMEOUT_MS = 60 * 1000;
const NORMAL_TIMEOUT_MS = 35 * 1000;
let isFirstCall = true;

async function fetchFromUrl(url, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            headers: { Accept: "application/json" },
            cache: "no-store", // a cached response would mean a stale "live" price
            signal: ctrl.signal,
        });
        // Covers normal HTTP errors AND platform rate-limit responses
        // (e.g. Cloudflare's 1015/1027 "you're rate limited" pages, which
        // also come back with a non-2xx status).
        if (!res.ok) throw new Error(url + " HTTP " + res.status);
        const json = await res.json();
        const list = Array.isArray(json) ? json : (json.data || []);

        // symbol -> last traded price (number). Only finite prices are kept, and
        // only this compact map is posted back to the page (not ~2000 full rows).
        const ltpMap = new Map();
        list.forEach((r) => {
            const ltp = parseFloat(r.l);
            if (r && r.s != null && Number.isFinite(ltp)) {
                ltpMap.set(String(r.s).toUpperCase(), ltp);
            }
        });
        return ltpMap;
    } catch (err) {
        if (err && err.name === "AbortError") {
            throw new Error(url + " timed out after " + timeoutMs / 1000 + "s");
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

async function fetchLivePrices() {
    const timeoutMs = isFirstCall ? FIRST_CALL_TIMEOUT_MS : NORMAL_TIMEOUT_MS;
    isFirstCall = false;

    const errors = [];

    // Once Cloudflare has failed too many times in a row this session, skip
    // straight to Vercel — don't even attempt Cloudflare.
    if (!cloudflareDisabledForSession) {
        try {
            const result = await fetchFromUrl(CLOUDFLARE_URL, timeoutMs);
            consecutiveCloudflareFailures = 0; // reset streak on success
            return result;
        } catch (err) {
            errors.push((err && err.message) || String(err));
            consecutiveCloudflareFailures++;
            if (consecutiveCloudflareFailures >= MAX_CONSECUTIVE_CLOUDFLARE_FAILURES) {
                cloudflareDisabledForSession = true;
                console.warn(
                    "[alert-worker] Cloudflare failed " + consecutiveCloudflareFailures +
                    " times in a row — switching to Vercel for the rest of this session."
                );
            }
        }
    }

    // Vercel fallback (also the only path taken once Cloudflare is disabled
    // for this session).
    try {
        return await fetchFromUrl(VERCEL_URL, timeoutMs);
    } catch (err) {
        errors.push((err && err.message) || String(err));
    }

    // Every backend failed — surface all of them so the ERROR message
    // posted back to the page is actually useful for debugging.
    throw new Error("All live-price backends failed: " + errors.join(" | "));
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

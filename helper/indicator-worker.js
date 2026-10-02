/* ============================================================================
   indicator-worker.js — background computation for the Indicator Advance
   Query feature.
   ----------------------------------------------------------------------------
   Message in:
     postMessage({
       type: "COMPUTE_INDICATORS",
       requestId, isins, chartBaseUrl, enabledIndicatorKeys, dataDate,
       tailBars            // how many most-recent bars the query engine keeps
     })

   For every stock and every enabled CANONICAL key the worker makes sure two
   things exist in IndexedDB (both stamped with dataDate):

     1. the full raw indicator payload  `${isin}::${key}`
        (shared with the chart modal - same key, same shape)
     2. a compact TAIL record           `${isin}::tail<N>::${key}`
        = { series: { fieldName: number[] (last N values) } }
        This is the only thing the main thread loads for querying.

   An extra `${isin}::tail<N>::ohlcv` record holds the last N open/high/low/
   close/volume values.

   Order of work per stock (cheapest first):
     a) all tail records already fresh in IndexedDB  -> done, candles are NOT
        fetched and raw payloads are NOT read.
     b) otherwise fetch candles once, then per missing tail: reuse the raw
        payload from IndexedDB if the chart already cached it, else compute
        it and store it. Existing chart indicators are therefore never
        recomputed.

   Messages out:
     { type: "PROGRESS", requestId, done, total }
     { type: "DONE", requestId, keys: string[], count, errors: string[] }
     { type: "ERROR", requestId, error }
   ========================================================================= */

importScripts("./indicator-db.js");           // defines IndicatorCacheDB (global const)
importScripts("./indicator-calculators.js");  // defines computeIndicatorRaw() etc. as globals

// Do NOT write `const { computeIndicatorRaw } = self.IndicatorCalculators;` -
// the calculators file already declares computeIndicatorRaw as a global
// function, and a const of the same name throws "Identifier has already been
// declared" and kills the worker.

const YIELD_EVERY_N_STOCKS = 25;
const FETCH_CONCURRENCY = 6;

function buildTail(key, raw, tailBars) {
    const kind = key.split("_")[0];
    const subs = kind === "macd" ? ["line", "signal", "hist"]
        : kind === "pivottrendline" ? ["a", "b"]
        : [undefined];
    const series = {};
    for (const sub of subs) {
        const arr = IndicatorCalculators.extractQuerySeries(key, sub, raw);
        if (arr && arr.length) {
            series[sub ? `${key}.${sub}` : key] = arr.length > tailBars ? arr.slice(-tailBars) : arr;
        }
    }
    return { series };
}

function buildOhlcvTail(candles, tailBars) {
    const t = candles.length > tailBars ? candles.slice(-tailBars) : candles;
    return {
        open: t.map((c) => c.open),
        high: t.map((c) => c.high),
        low: t.map((c) => c.low),
        close: t.map((c) => c.close),
        volume: t.map((c) => c.v),
    };
}

self.onmessage = async function (e) {
    const msg = e.data || {};
    if (msg.type !== "COMPUTE_INDICATORS") return;
    const requestId = msg.requestId;

    try {
        const { isins, chartBaseUrl, enabledIndicatorKeys, dataDate } = msg;
        const tailBars = msg.tailBars || 60;
        const TAIL_PREFIX = `tail${tailBars}::`;
        const OHLCV_TAIL_KEY = TAIL_PREFIX + "ohlcv";

        if (!Array.isArray(isins) || !isins.length || !Array.isArray(enabledIndicatorKeys) || !enabledIndicatorKeys.length) {
            self.postMessage({ type: "DONE", requestId, keys: [], count: 0, errors: [] });
            return;
        }

        const keySet = new Set();
        const errors = [];
        let done = 0;

        const safeGet = async (isin, key) => {
            try { return await IndicatorCacheDB.get(isin, key, dataDate); } catch { return null; }
        };
        const hasData = (tail) => tail && tail.series && Object.keys(tail.series).length > 0;

        async function processOne(isin) {
            // Pass 1 - tails already in IndexedDB?
            const tailHits = new Map();
            const ohlcvHit = await safeGet(isin, OHLCV_TAIL_KEY);
            for (const key of enabledIndicatorKeys) {
                const t = await safeGet(isin, TAIL_PREFIX + key);
                if (t) tailHits.set(key, t);
            }
            tailHits.forEach((t, key) => { if (hasData(t)) keySet.add(key); });
            if (ohlcvHit && tailHits.size === enabledIndicatorKeys.length) return;

            // Pass 2 - something is missing: fetch candles once.
            let candles;
            try {
                const res = await fetch(`${chartBaseUrl}${isin}.json`, { cache: "force-cache" });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                candles = await res.json();
            } catch (err) {
                errors.push(`${isin}: chart fetch failed — ${(err && err.message) || err}`);
                return;
            }
            if (!Array.isArray(candles) || !candles.length) return;

            for (const key of enabledIndicatorKeys) {
                if (tailHits.has(key)) continue;
                try {
                    // Reuse the raw payload if the chart modal already cached it.
                    let raw = await IndicatorCacheDB.get(isin, key, dataDate);
                    if (!raw) {
                        raw = computeIndicatorRaw(key, candles);
                        if (raw) await IndicatorCacheDB.set(isin, key, dataDate, raw);
                    }
                    const tail = raw ? buildTail(key, raw, tailBars) : { series: {} };
                    await IndicatorCacheDB.set(isin, TAIL_PREFIX + key, dataDate, tail);
                    if (hasData(tail)) keySet.add(key);
                } catch (err) {
                    errors.push(`${isin} / ${key}: ${(err && err.message) || err}`);
                }
            }

            if (!ohlcvHit) {
                try {
                    await IndicatorCacheDB.set(isin, OHLCV_TAIL_KEY, dataDate, buildOhlcvTail(candles, tailBars));
                } catch (err) {
                    errors.push(`${isin} / ohlcv: ${(err && err.message) || err}`);
                }
            }
        }

        let cursor = 0;
        async function pool() {
            while (cursor < isins.length) {
                const isin = isins[cursor++];
                await processOne(isin);
                done++;
                if (done % YIELD_EVERY_N_STOCKS === 0) {
                    self.postMessage({ type: "PROGRESS", requestId, done, total: isins.length });
                }
            }
        }
        await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, pool));

        self.postMessage({ type: "DONE", requestId, keys: [...keySet], count: isins.length, errors });
    } catch (err) {
        self.postMessage({ type: "ERROR", requestId, error: (err && err.message) || String(err) });
    }
};

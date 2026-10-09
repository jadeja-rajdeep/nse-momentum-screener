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

   (PACKED FORMAT) Both are merged into ONE record per stock:
   `${isin}::tail<N>::pack::<keySetSignature>` = { tails: { key: {series} }, ohlcv }
   - far fewer IndexedDB puts/index updates than one record per indicator.

   How a run works (IndexedDB is the slow part, so it is touched as little as
   possible - one transaction at a time is all it can do anyway):
     1. ONE read lists the ids already stored for this dataDate (keys only).
     2. Lanes (FETCH_CONCURRENCY in parallel) go through the stocks:
          - tails already stored  -> skipped, no fetch, no IndexedDB access
          - else fetch candles, compute the missing indicators in memory
     3. Results are queued and written by ONE writer in big batches
        (WRITE_BATCH_STOCKS stocks per transaction) - not one commit per record.
     4. DONE is posted only after the last batch is committed.

   Messages out:
     { type: "PROGRESS", requestId, done, total }
     { type: "DONE", requestId, keys: string[], count, errors: string[], stats }
     { type: "ERROR", requestId, error }
   ========================================================================= */

importScripts("./indicator-db.js");           // defines IndicatorCacheDB (global const)
importScripts("./indicator-calculators.js");  // defines computeIndicatorRaw() etc. as globals

// Do NOT write `const { computeIndicatorRaw } = self.IndicatorCalculators;` -
// the calculators file already declares computeIndicatorRaw as a global
// function, and a const of the same name throws "Identifier has already been
// declared" and kills the worker.

const YIELD_EVERY_N_STOCKS = 32;
const FETCH_CONCURRENCY = 32;      // fetch + compute lanes (IndexedDB is NOT the limit any more: one writer)
const WRITE_BATCH_STOCKS = 100;  // stocks per IndexedDB write transaction (1 packed record per stock)
const MAX_QUEUED_BATCHES = 4;    // lanes pause only if the writer falls this far behind (tail records are small)

// The query only needs the small TAIL records. The full raw payload (every bar,
// one object per bar, ~150-450 KB per stock) is stored ONLY so the chart modal
// / thumbnails can reuse it. Measured on a fresh run: computing ALL indicators
// for a stock takes ~0.5 ms, while writing the raw payloads was the biggest
// cost - so sharing is OFF. Set to true to pre-fill the chart's cache again.
const SHARE_RAW_WITH_CHART = false;

// Where the time went. fetch / compute are SUMMED over parallel lanes;
// idbWrite is the single writer's time; wall is real elapsed time.
const stats = { wall: 0, fetch: 0, compute: 0, idbList: 0, idbWrite: 0, flushes: 0, stocksComputed: 0, stocksSkipped: 0 };
const now = () => performance.now();

function buildTail(key, raw, tailBars) {
    const kind = IndicatorCalculators.getIndicatorKind(key);
    const subs = kind === "macd" ? ["line", "signal", "hist"]
        : kind === "pivottrendline" ? ["a", "b"]
        : (kind === "avwap" || kind === "afh_avwap") ? [undefined, "upper1", "lower1", "upper2", "lower2", "upper3", "lower3"]
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
        const indicatorSettings = msg.indicatorSettings || {};
        // ONE packed record per stock: { tails: { key: {series} }, ohlcv: {...} }.
        // Its id carries a signature of this run's key set (see IndicatorCacheDB.packKey).
        const PACK_KEY = IndicatorCacheDB.packKey(tailBars, enabledIndicatorKeys);

        if (!Array.isArray(isins) || !isins.length || !Array.isArray(enabledIndicatorKeys) || !enabledIndicatorKeys.length) {
            self.postMessage({ type: "DONE", requestId, keys: [], count: 0, errors: [] });
            return;
        }

        Object.keys(stats).forEach((k) => (stats[k] = 0));
        const runStart = now();
        const keySet = new Set();   // keys that have tail data (loaded into memory by the page afterwards)
        const errors = [];
        let done = 0;

        // 1. What is already stored for this dataDate? (one read, keys only)
        let existing;
        const tList = now();
        try { existing = await IndicatorCacheDB.getIdsForDate(dataDate); }
        catch { existing = new Set(); }   // can't tell -> recompute (always correct, just slower)
        stats.idbList = now() - tList;
        const idOf = (isin, key) => `${isin}::${key}`;
        const hasData = (tail) => tail && tail.series && Object.keys(tail.series).length > 0;

        // 3. The single writer: lanes queue entries, batches are committed one after another.
        // Writes are NOT awaited: IndicatorCacheDB queues them and commits them in the
        // background (merging queued batches into as few transactions as possible).
        let pending = [], pendingStocks = 0, queuedBatches = 0;
        function flushNow() {
            if (!pending.length) { pendingStocks = 0; return; }
            const batch = pending;
            pending = [];
            pendingStocks = 0;
            queuedBatches++;
            const t0 = now();
            IndicatorCacheDB.setMany(dataDate, batch)          // queued now, NOT awaited
                .catch((err) => errors.push(`cache write failed — ${(err && err.message) || err}`))
                .finally(() => { stats.idbWrite += now() - t0; stats.flushes++; queuedBatches--; });
        }
        function queueWrites(entries) {
            for (const en of entries) pending.push(en);
            if (++pendingStocks >= WRITE_BATCH_STOCKS) flushNow();
        }

        // 2. Per stock: skip if its packed record exists, else fetch + compute in memory + queue ONE write.
        async function processOne(isin) {
            if (existing.has(idOf(isin, PACK_KEY))) {
                enabledIndicatorKeys.forEach((k) => keySet.add(k));
                stats.stocksSkipped++;
                return;
            }

            let candles;
            const tFetch = now();
            try {
                const res = await fetch(`${chartBaseUrl}${isin}.json`, { cache: "force-cache" });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                candles = await res.json();
            } catch (err) {
                errors.push(`${isin}: chart fetch failed — ${(err && err.message) || err}`);
                return;
            } finally {
                stats.fetch += now() - tFetch;
            }
            if (!Array.isArray(candles) || !candles.length) return;
            stats.stocksComputed++;

            // Optional: reuse raw payloads the chart already cached (read only the ones that exist).
            let rawHave = new Map();
            if (SHARE_RAW_WITH_CHART) {
                const cachedRaw = enabledIndicatorKeys.filter((k) => existing.has(idOf(isin, k)));
                if (cachedRaw.length) {
                    try { rawHave = await IndicatorCacheDB.getMany(isin, cachedRaw, dataDate); } catch { /* recompute */ }
                }
            }

            const entries = [];
            const tails = {};
            const tCompute = now();
            for (const key of enabledIndicatorKeys) {
                try {
                    let raw = rawHave.get(key);
                    if (!raw) {
                        raw = computeIndicatorRaw(key, candles, indicatorSettings[key]); // full settings -> same options as the chart worker
                        if (raw && SHARE_RAW_WITH_CHART) entries.push({ isin, key, payload: raw });
                    }
                    const tail = raw ? buildTail(key, raw, tailBars) : { series: {} };
                    if (hasData(tail)) { tails[key] = tail; keySet.add(key); }
                } catch (err) {
                    errors.push(`${isin} / ${key}: ${(err && err.message) || err}`);
                }
            }
            entries.push({ isin, key: PACK_KEY, payload: { tails, ohlcv: buildOhlcvTail(candles, tailBars) } });
            stats.compute += now() - tCompute;

            queueWrites(entries);
        }

        let cursor = 0;
        async function lane() {
            while (cursor < isins.length) {
                const isin = isins[cursor++];
                await processOne(isin);
                done++;
                if (done % YIELD_EVERY_N_STOCKS === 0) {
                    self.postMessage({ type: "PROGRESS", requestId, done, total: isins.length });
                }
                if (queuedBatches > MAX_QUEUED_BATCHES) await IndicatorCacheDB.flush(); // writer is far behind: let it catch up (rare)
            }
        }
        await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, lane));
        flushNow();
        await IndicatorCacheDB.flush(); // the ONLY wait: DONE must mean "everything is committed" - the page reads it back from IndexedDB

        stats.wall = now() - runStart;
        const rounded = Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, Math.round(v)]));
        self.postMessage({ type: "DONE", requestId, keys: [...keySet], count: isins.length, errors, stats: rounded });
    } catch (err) {
        self.postMessage({ type: "ERROR", requestId, error: (err && err.message) || String(err) });
    }
};

/* ============================================================================
   data-engine.js — main-thread client for helper/data-worker.js
   ----------------------------------------------------------------------------
   Exposes window.DataEngine. index.html depends on it: filtering, sorting,
   grouping, saved-search runs and chart indicators all run in the workers.

     DataEngine.ready                       true once INIT has completed
     DataEngine.init(rows)                  -> { peerRankMap, groupRankMap }
     DataEngine.filter({state, wlCodes, sortCol, sortDir, doSort})
                                            -> { idx:Int32Array, adv }
     DataEngine.sort(idxArray, col, dir)    -> Int32Array
     DataEngine.groupStats(field, industry) -> groups
     DataEngine.chainCounts(field, idxArr)  -> groups
     DataEngine.runStates([{state,wlCodes}])-> [ [Code,...] | null, ... ]
     DataEngine.chart({...})                -> { data, ind, errors } | {cancelled}
     DataEngine.setChartGeneration(n)       drops queued thumbnail work < n
     DataEngine.rowIndex                    Map(rowObject -> position in rows)
   ========================================================================= */
(function () {
    "use strict";

    const WORKER_URL = "./helper/data-worker.js";
    const supported = typeof Worker !== "undefined";

    let dataWorker = null;
    let chartPool = [];
    let rr = 0;
    let seq = 1;
    const pending = new Map(); // id -> { resolve, reject, worker }
    let broken = false;

    const E = (window.DataEngine = {
        supported,
        ready: false,
        rowIndex: null,
        chartReady: false,
    });

    function failAll(worker, err) {
        for (const [id, p] of pending) {
            if (!worker || p.worker === worker) {
                pending.delete(id);
                p.reject(err);
            }
        }
    }

    function spawn() {
        const w = new Worker(WORKER_URL);
        w.onmessage = (ev) => {
            const m = ev.data || {};
            const p = pending.get(m.id);
            if (!p) return;
            pending.delete(m.id);
            if (m.error) p.reject(new Error(m.error));
            else p.resolve(m);
        };
        w.onerror = (ev) => {
            console.warn("[DataEngine] worker error:", ev && ev.message);
            if (w === dataWorker) {
                E.ready = false;
                broken = true;
            }
            failAll(w, new Error("worker error"));
        };
        return w;
    }

    function call(worker, msg, transfer) {
        return new Promise((resolve, reject) => {
            const id = seq++;
            pending.set(id, { resolve, reject, worker });
            try {
                worker.postMessage({ ...msg, id }, transfer || []);
            } catch (err) {
                pending.delete(id);
                reject(err);
            }
        });
    }

    /* ---------------- data role ---------------- */
    E.init = async function (rows) {
        if (!supported || broken) throw new Error("workers unavailable");
        if (!dataWorker) dataWorker = spawn();
        E.ready = false;
        const advNames = typeof ADV_FIELDS !== "undefined" ? ADV_FIELDS.map((f) => f.name) : null;
        const res = await call(dataWorker, { type: "INIT", rows, advNames });
        if (res.advMismatch) console.warn("[DataEngine] ADV_FIELDS in index.html and ADV_SPEC in data-worker.js have drifted:", res.advMismatch);
        E.rowIndex = new Map(rows.map((r, i) => [r, i]));
        E.ready = true;
        return { peerRankMap: res.peerRank, groupRankMap: res.groupRank };
    };

    E.filter = (opts) => call(dataWorker, { type: "FILTER", state: opts.state, wlCodes: opts.wlCodes || null, sortCol: opts.sortCol, sortDir: opts.sortDir, doSort: !!opts.doSort });

    E.sort = async (idx, sortCol, sortDir) => {
        const res = await call(dataWorker, { type: "SORT", idx, sortCol, sortDir }, [idx.buffer]);
        return res.idx;
    };

    E.groupStats = async (field, industry) => (await call(dataWorker, { type: "GROUP_STATS", field, industry: industry || null })).groups;
    E.chainCounts = async (field, idx) => (await call(dataWorker, { type: "CHAIN_COUNTS", field, idx })).groups;
    E.runStates = async (jobs) => (await call(dataWorker, { type: "RUN_STATES", jobs })).results;

    /* ---------------- chart role ---------------- */
    function ensureChartPool() {
        if (chartPool.length || !supported) return;
        const n = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 2));
        for (let i = 0; i < n; i++) chartPool.push(spawn());
        E.chartReady = true;
    }

    E.setChartGeneration = (gen) => {
        ensureChartPool();
        chartPool.forEach((w) => w.postMessage({ type: "SET_GEN", gen }));
    };

    E.chart = (msg) => {
        ensureChartPool();
        const w = chartPool[rr++ % chartPool.length];
        return call(w, { ...msg, type: "CHART" });
    };

    /* ---------------- chart bundle used by index.html ----------------
       Resolves { data, ind } where `ind` maps each IndicatorCacheDB key the
       chart settings need (e.g. "ema_50_close") to its computed result.
       Resolves null when a newer thumbnail pass superseded this request.
       Rejects if the stock has no stored candles or an indicator fails. */
    E.loadChartBundle = async function (isin, mode, settings, sliceLen, gen) {
        try {
            // daily indicator-cache wipe + ChartDataDB sync (first-visit download / daily append) must finish first
            if (window.indicatorCacheFresh) await window.indicatorCacheFresh;
        } catch (e) {}

        const r = await E.chart({
            isin,
            mode,
            settings,
            sliceLen: sliceLen || 0,
            gen: gen || 0,
            dataDate: CURRENT_DATA_DATE,
        });
        if (r.cancelled) return null;
        if (r.errors && r.errors.length) throw new Error("indicator error for " + isin + ": " + r.errors.join("; "));
        return { data: r.data, ind: r.ind };
    };
})();

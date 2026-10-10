/* ============================================================================
   chart-sync.js — main-thread handle for helper/chart-sync-worker.js
   ----------------------------------------------------------------------------
     ChartSync.start(dataDate)  -> Promise<{ ok, stats?, error? }>   (never rejects)
     ChartSync.status           "idle" | "syncing" | "ready" | "error"
   Window event "chartsync" fires with detail { status, phase, done, total }.
   A small progress pill is shown only when real downloading is happening
   (first visit, or a long gap) - not for the usual one-file daily update.
   ========================================================================= */
(function () {
    "use strict";
    const S = (window.ChartSync = { status: "idle", promise: null, dataDate: null, lastResult: null, start });
    let pill = null;

    function showPill(text) {
        if (!document.body) return;
        if (!pill) {
            pill = document.createElement("div");
            pill.setAttribute("role", "status");
            pill.style.cssText =
                "position:fixed;left:12px;bottom:12px;z-index:99999;padding:6px 12px;border-radius:999px;" +
                "font:600 12px/1.2 system-ui,sans-serif;background:rgba(20,24,33,.92);color:#e6e9f0;" +
                "box-shadow:0 2px 10px rgba(0,0,0,.35);pointer-events:none;";
            document.body.appendChild(pill);
        }
        pill.textContent = text;
    }
    function hidePill() {
        if (pill) { pill.remove(); pill = null; }
    }

    function emit(detail) {
        try { window.dispatchEvent(new CustomEvent("chartsync", { detail })); } catch (e) {}
    }

    function start(dataDate) {
        if (S.promise && S.dataDate === dataDate) return S.promise;
        S.dataDate = dataDate;
        S.status = "syncing";
        emit({ status: "syncing" });

        S.promise = new Promise((resolve) => {
            if (typeof Worker === "undefined") {
                S.status = "error";
                return resolve({ ok: false, error: "Web Workers are not available" });
            }
            const worker = new Worker("./helper/chart-sync-worker.js");
            const finish = (res) => {
                worker.terminate(); // free the worker's memory straight away
                hidePill();
                S.status = res.ok ? "ready" : "error";
                S.lastResult = res;
                if (!res.ok) console.warn("[ChartSync] failed:", res.error);
                else if (res.stats && res.stats.mode === "full") console.info("[ChartSync] full download:", res.stats);
                emit({ status: S.status, ...res });
                resolve(res);
            };
            worker.onmessage = (ev) => {
                const m = ev.data || {};
                if (m.type === "PROGRESS") {
                    emit({ status: "syncing", phase: m.phase, done: m.done, total: m.total });
                    if (m.phase === "full") showPill(`Downloading chart data… ${m.done}/${m.total}`);
                    else if (m.total > 3) showPill(`Updating chart data… ${m.done}/${m.total}`);
                } else if (m.type === "DONE") finish({ ok: true, stats: m.stats });
                else if (m.type === "ERROR") finish({ ok: false, error: m.error });
            };
            worker.onerror = (ev) => finish({ ok: false, error: (ev && ev.message) || "chart sync worker failed" });
            worker.postMessage({
                type: "SYNC",
                requestId: 1,
                dataDate,
                dataBase: new URL("data/", window.location.href).href,
            });
        });
        return S.promise;
    }
})();

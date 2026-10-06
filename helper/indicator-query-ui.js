/* ============================================================================
   indicator-query-ui.js — main-thread integration for the Indicator Advance
   Query feature. Depends on: indicator-query.js, indicator-calculators.js,
   indicator-db.js (already loaded in index.html), and existing app globals:
   allData, CURRENT_DATA_DATE, applyFilters(), FILTER_FIELDS, loadChartSettings().
   (Call-site wiring in index.html is already done - see applyFilters(),
   runFilterCodesAsync(), restoreFilters(), clearFilters(), loadData().)
   ========================================================================= */

// ---------------------------------------------------------------------------
// 1. Settings — mirrors the existing ALERT_SETTINGS_KEY / loadAlertSettings()
//    pattern already in index.html (see line ~21031).
// ---------------------------------------------------------------------------
const INDICATOR_SETTINGS_KEY = "nse_screener_indicator_settings";

const INDICATOR_TAIL_DEFAULT = 63;   // ~3 months of trading days
const INDICATOR_TAIL_MAX = 252;      // ~1 trading year
function clampIndicatorTailBars(v) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return INDICATOR_TAIL_DEFAULT;
    return Math.min(INDICATOR_TAIL_MAX, Math.max(1, n));
}

function loadIndicatorSettings() {
    const defaults = { advancedIndicatorQueryEnabled: false, indicatorTailBars: INDICATOR_TAIL_DEFAULT };
    try {
        const s = Object.assign(defaults, JSON.parse(localStorage.getItem(INDICATOR_SETTINGS_KEY) || "{}"));
        s.indicatorTailBars = clampIndicatorTailBars(s.indicatorTailBars); // also sanitises imported files
        return s;
    } catch (e) {
        return defaults;
    }
}
function saveIndicatorSettings(settings) {
    try {
        localStorage.setItem(INDICATOR_SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {
        console.warn("Could not save indicator settings:", e);
    }
}
function isIndicatorQueryEnabled() {
    return !!loadIndicatorSettings().advancedIndicatorQueryEnabled;
}
// How many most-recent bars of every field the query engine keeps (max lookback = this - 1).
function getIndicatorTailBars() {
    return loadIndicatorSettings().indicatorTailBars;
}
function setIndicatorTailBars(n) {
    const s = loadIndicatorSettings();
    s.indicatorTailBars = clampIndicatorTailBars(n);
    saveIndicatorSettings(s);
}
function setIndicatorQueryEnabled(enabled) {
    const s = loadIndicatorSettings();
    s.advancedIndicatorQueryEnabled = !!enabled;
    saveIndicatorSettings(s);
}

// Wire into exportSettings()/importSettings(): add ONE line to each —
//   payload.indicator_settings = loadIndicatorSettings();                  // in exportSettings()
//   if (payload.indicator_settings) localStorage.setItem(INDICATOR_SETTINGS_KEY, JSON.stringify(payload.indicator_settings)); // in importSettings()
// (same shape as the existing alert_settings lines right above/below them)

// ---------------------------------------------------------------------------
// 2. In-memory store — COMPACT TAILS ONLY.
//    A query only ever looks a few bars back ([0], [1], [5]...), so we keep
//    just the last N values (user setting, default 63, max 252) of each field, not the full
//    history. The worker writes these small "tail" records to IndexedDB;
//    this file loads only those (never the full raw payloads, never candles).
// ---------------------------------------------------------------------------
// Tail length is a user setting (Settings modal, default 63, max 252). The
// value in effect for the CURRENT engine run is frozen in indicatorActiveTailBars
// so loading/validation always match what the worker actually stored.
let indicatorActiveTailBars = INDICATOR_TAIL_DEFAULT;
const indicatorTailPrefix = () => `tail${indicatorActiveTailBars}::`;
const OHLCV_PILL_FIELDS = ["open", "high", "low", "close", "volume"];

let indicatorTailStore = new Map();   // isin -> Map<fieldName, number[]>
let indicatorOhlcvStore = new Map();  // isin -> { open:[], high:[], low:[], close:[], volume:[] }
let indicatorCanonicalKeys = [];      // keys whose tails are loaded in memory, in chart-settings order
const indicatorLoadedKeys = new Set();   // canonical keys currently available to queries
const indicatorFieldsByKey = new Map();  // canonical key -> Set<query field names it provides>
let indicatorRunKind = "full";           // "full" (everything) | "incremental" (only newly enabled keys)
let indicatorRunKeys = [];               // keys the running worker was asked to handle
let indicatorQueryFields = [];        // pills: OHLCV + indicator fields
let indicatorStockCount = 0;

// Engine state: "idle" (not started / waiting for data) | "computing" | "ready" | "error"
let indicatorEngineState = "idle";
let indicatorEngineDetail = null;
let indicatorEngineReady = false;
let indicatorLastKeys = "";           // enabled-key signature of the last run

function getOHLCVSeries(isin, key) {
    const o = indicatorOhlcvStore.get(isin);
    return o ? o[key] : undefined;
}

function getIndicatorSeries(isin, fieldName) {
    const m = indicatorTailStore.get(isin);
    return m ? m.get(fieldName) : undefined;
}

// ---------------------------------------------------------------------------
// 3. Worker lifecycle
// ---------------------------------------------------------------------------
let indicatorWorker = null;
let indicatorRequestId = 0;

// Single builder for BOTH the canonical cache keys and the full chart-settings
// object behind each key. The worker passes that object to every calculator, so
// a payload cached by the query worker is identical to the chart worker's.
function getEnabledChartIndicators() {
    const s = loadChartSettings();
    const settingsByKey = {};
    const add = (key, settings) => { if (!(key in settingsByKey)) settingsByKey[key] = settings; };

    (s.ma || []).forEach((ma) => {
        if (ma.enabled) add(`${ma.type}_${ma.length}_${ma.source}`, ma);
    });

    (s.afh || []).forEach((afh) => {
        if (afh.enabled && afh.length >= 15) add(`afh_${afh.length}`, afh);
    });

    // Must match the chart's cache keys exactly (see data-worker.js) so payloads are shared.
    (s.avwap || []).forEach((v) => {
        if (v.enabled && v.date != "") add(`avwap_${v.date}_${v.source}_${v.multiplier0}_${v.multiplier1}_${v.multiplier2}`, v);
    });

    (s.afh_avwap || []).forEach((v) => {
        if (v.enabled && v.length >= 15) add(`afh_avwap_${v.length}_${v.source}_${v.multiplier0}_${v.multiplier1}_${v.multiplier2}`, v);
    });

    (s.supertrend || []).forEach((st) => {
        if (st.enabled) add(`supertrend_${st.atrLength}_${st.factor}`, st);
    });

    (s.pivottrendline || []).forEach((pivot) => {
        if (pivot.enabled && pivot.length > 1) {
            add(`pivottrendline_${pivot.length}_high`, pivot);
            add(`pivottrendline_${pivot.length}_low`, pivot);
        }
    });

    if (s.rsi && s.rsi.enabled) {
        const { length, source, smoothingType, smoothingLength } = s.rsi;
        add(`rsi_${length}_${source}_${smoothingType}_${smoothingLength}`, s.rsi);
        if (smoothingLength > 0 && smoothingType !== "none") {
            add(`rsi_sma_${length}_${source}_${smoothingType}_${smoothingLength}`, s.rsi);
        }
    }

    if (s.macd && s.macd.enabled) {
        const { source, fastLength, slowLength, signalLength, oscMaType, signalMaType } = s.macd;
        add(`macd_${source}_${fastLength}_${slowLength}_${signalLength}_${oscMaType}_${signalMaType}`, s.macd);
    }

    return { keys: Object.keys(settingsByKey), settingsByKey };
}

function getEnabledChartIndicatorKeys() {
    return getEnabledChartIndicators().keys;
}

function startIndicatorEngine() {
    if (!isIndicatorQueryEnabled()) return;   // master switch off -> engine never runs
    if (indicatorEngineState === "computing" || indicatorEngineState === "ready") return;
    if (typeof allData === "undefined" || !allData.length) { // loadData() calls us again when ready
        setIndicatorEngineState("idle", null);
        return;
    }

    const enabledIndicatorKeys = getEnabledChartIndicatorKeys();
    indicatorActiveTailBars = getIndicatorTailBars();
    indicatorLastKeys = enabledIndicatorKeys.join("|");
    if (!enabledIndicatorKeys.length) {
        setIndicatorEngineState("error", "No chart indicators are enabled — enable some in Chart Settings first");
        return;
    }
    spawnIndicatorWorker(enabledIndicatorKeys, "full");
}

// Starts the worker for `keys`. The worker checks IndexedDB for EVERY stock x key
// first and only computes what is missing - so passing keys that already exist
// costs only cheap lookups, never a recalculation.
function spawnIndicatorWorker(keys, kind) {
    const requestId = ++indicatorRequestId;
    const worker = new Worker("./helper/indicator-worker.js");
    indicatorWorker = worker;
    indicatorRunKind = kind;
    indicatorRunKeys = keys;
    setIndicatorEngineState("computing", null);

    // Let the daily IndexedDB wipe finish first, otherwise clearAll() could erase results mid-run.
    Promise.resolve(window.indicatorCacheFresh)
        .catch(() => {})
        .then(() => {
            if (worker !== indicatorWorker) return; // stopped/restarted meanwhile
            launchIndicatorWorker(worker, keys, requestId);
        });
}

function launchIndicatorWorker(worker, enabledIndicatorKeys, requestId) {
    worker.onmessage = handleIndicatorWorkerMessage;
    worker.onerror = (err) => {
        console.error("[indicator-worker] fatal error:", err.message);
        setIndicatorEngineState("error", err.message || "indicator worker failed to start");
    };
    worker.postMessage({
        type: "COMPUTE_INDICATORS",
        requestId,
        isins: allData.map((row) => row["ISIN"]).filter(Boolean),
        chartBaseUrl: new URL("data/chart/", window.location.href).href,
        enabledIndicatorKeys,
        indicatorSettings: getEnabledChartIndicators().settingsByKey, // full settings per key -> calculators
        dataDate: CURRENT_DATA_DATE,
        tailBars: indicatorActiveTailBars,
    });
}

// Terminate worker, invalidate in-flight work and free all query data.
function teardownIndicatorEngine() {
    if (indicatorWorker) {
        indicatorWorker.terminate();
        indicatorWorker = null;
    }
    indicatorRequestId++; // invalidates any in-flight DONE / memory-load
    indicatorTailStore = new Map();
    indicatorOhlcvStore = new Map();
    indicatorLoadedKeys.clear();
    indicatorFieldsByKey.clear();
    indicatorCanonicalKeys = [];
    indicatorQueryFields = [];
    indicatorStockCount = 0;
    indicatorRunKind = "full";
    indicatorRunKeys = [];
    renderIndicatorPills([]);
}

// Master switch turned off: stop everything and release memory.
function stopIndicatorEngine() {
    teardownIndicatorEngine();
    setIndicatorEngineState("idle", null);
}

// Full rebuild (data date or tail length changed, or the engine wasn't ready).
// Still IndexedDB-first: anything already stored is skipped.
function restartIndicatorEngine() {
    teardownIndicatorEngine();
    indicatorEngineState = "idle";
    startIndicatorEngine();
}

// Chart settings changed while the engine is READY: diff the enabled keys against
// what is already loaded.
//   removed keys -> dropped from memory (nothing to compute)
//   added keys   -> worker is started for ONLY those keys; for each stock it looks
//                   the key up in IndexedDB first and calculates only what's missing
//   unchanged    -> untouched, stay available to queries
function syncIndicatorKeys(newKeys) {
    indicatorLastKeys = newKeys.join("|");
    if (!newKeys.length) { restartIndicatorEngine(); return; } // shows the "enable some indicators" message

    const wanted = new Set(newKeys);
    const removed = [...indicatorLoadedKeys].filter((k) => !wanted.has(k));
    const added = newKeys.filter((k) => !indicatorLoadedKeys.has(k));

    removed.forEach(dropIndicatorKeyFromMemory);
    if (removed.length) rebuildIndicatorFieldList();

    if (!added.length) {
        if (removed.length) {
            refreshIndicatorStatus();
            //applyFilters();
        }
        return;
    }
    spawnIndicatorWorker(added, "incremental"); // status line flips to "Calculating N new indicators…"
}

function dropIndicatorKeyFromMemory(key) {
    const fields = indicatorFieldsByKey.get(key);
    if (fields) {
        indicatorTailStore.forEach((perStock) => fields.forEach((f) => perStock.delete(f)));
    }
    indicatorFieldsByKey.delete(key);
    indicatorLoadedKeys.delete(key);
}

// Pills = OHLCV + fields of every loaded key, in the order the keys appear in chart settings.
function rebuildIndicatorFieldList() {
    const ordered = getEnabledChartIndicatorKeys().filter((k) => indicatorLoadedKeys.has(k));
    indicatorCanonicalKeys = ordered;
    indicatorQueryFields = [
        ...OHLCV_PILL_FIELDS,
        ...IndicatorCalculators.deriveQueryFieldsFromCanonicalKeys(ordered),
    ];
    renderIndicatorPills(indicatorQueryFields);
}

function indicatorKnownFieldSet() {
    const set = new Set(OHLCV_PILL_FIELDS);
    indicatorFieldsByKey.forEach((fields) => fields.forEach((f) => set.add(f)));
    return set;
}

function handleIndicatorWorkerMessage(e) {
    const msg = e.data || {};
    if (msg.requestId !== indicatorRequestId) return;

    if (msg.type === "PROGRESS") {
        setIndicatorEngineState("computing", `${msg.done.toLocaleString("en-IN")} / ${msg.total.toLocaleString("en-IN")}`);
        return;
    }
    if (msg.type === "ERROR") {
        console.error("[indicator-worker]", msg.error);
        setIndicatorEngineState("error", msg.error);
        return;
    }
    if (msg.type === "DONE") {
        if (msg.errors && msg.errors.length) {
            console.warn(`[indicator-worker] ${msg.errors.length} calc/fetch errors:`, msg.errors.slice(0, 20));
        }
        const doneRequestId = msg.requestId;
        const full = indicatorRunKind === "full";
        // The worker has nothing left to do - release its heap.
        if (indicatorWorker) { indicatorWorker.terminate(); indicatorWorker = null; }

        loadIndicatorTailsIntoMemory(doneRequestId, msg.keys, full).then((completed) => {
            if (!completed || doneRequestId !== indicatorRequestId) return; // superseded
            indicatorStockCount = msg.count;
            rebuildIndicatorFieldList();
            setIndicatorEngineState("ready", null);

            //only apply filters if indicator query is checked and have text. and main settings are enabled.
            const cb = document.getElementById("f_indicator_enabled");
            const ta = document.getElementById("f_indicator_query");
            const master = window.isIndicatorQuerySettingOn();
            // console.log(master,cb,cb.disabled,cb.checked,ta,ta.readOnly,ta.value);
            if(master && cb && cb.disabled===false && cb.checked && ta && ta.readOnly===false && ta.value.trim()!=""){
                if (typeof applyFilters === "function") applyFilters();
            }
        });
    }
}

// Load ONLY the small tail records for `keys` from IndexedDB (no raw payloads, no candles).
//   full=true  -> replaces everything in memory (and loads the OHLCV tails)
//   full=false -> merges just these keys into what is already in memory
async function loadIndicatorTailsIntoMemory(requestId, keys, full) {
    const additions = new Map();            // isin -> Map<field, number[]>
    const ohlcv = full ? new Map() : null;
    const fieldsByKey = new Map();          // key -> Set<field>
    const BATCH = 60;
    const isins = allData.map((r) => r["ISIN"]).filter(Boolean);
    const prefix = indicatorTailPrefix();

    async function loadOne(isin) {
        const fields = new Map();
        await Promise.all(keys.map(async (key) => {
            try {
                const t = await IndicatorCacheDB.get(isin, prefix + key, CURRENT_DATA_DATE);
                if (t && t.series) {
                    for (const [name, arr] of Object.entries(t.series)) {
                        const f = name.toLowerCase();
                        fields.set(f, arr);
                        if (!fieldsByKey.has(key)) fieldsByKey.set(key, new Set());
                        fieldsByKey.get(key).add(f);
                    }
                }
            } catch { /* missing field just won't resolve */ }
        }));
        if (fields.size) additions.set(isin, fields);
        if (full) {
            try {
                const o = await IndicatorCacheDB.get(isin, prefix + "ohlcv", CURRENT_DATA_DATE);
                if (o) ohlcv.set(isin, o);
            } catch { /* OHLCV just won't resolve for this stock */ }
        }
    }

    for (let i = 0; i < isins.length; i += BATCH) {
        if (requestId !== indicatorRequestId) return false;
        await Promise.all(isins.slice(i, i + BATCH).map(loadOne));
    }
    if (requestId !== indicatorRequestId) return false;

    // Commit atomically (no awaits below).
    if (full) {
        indicatorTailStore = additions;
        indicatorOhlcvStore = ohlcv;
        indicatorLoadedKeys.clear();
        indicatorFieldsByKey.clear();
    } else {
        additions.forEach((fields, isin) => {
            let dst = indicatorTailStore.get(isin);
            if (!dst) indicatorTailStore.set(isin, (dst = new Map()));
            fields.forEach((arr, f) => dst.set(f, arr));
        });
    }
    fieldsByKey.forEach((set, key) => {
        indicatorFieldsByKey.set(key, set);
        indicatorLoadedKeys.add(key);
    });
    return true;
}

// ---------------------------------------------------------------------------
// 4. UI state + pills
// ---------------------------------------------------------------------------
function setIndicatorEngineState(state, detail) {
    indicatorEngineState = state;
    indicatorEngineDetail = detail;
    indicatorEngineReady = state === "ready";
    refreshIndicatorStatus();
}

// The query box is locked (read-only) when the master switch is off or the
// filter-panel checkbox is unticked.
function isIndicatorQueryLocked() {
    if (!isIndicatorQueryEnabled()) return true;
    const cb = document.getElementById("f_indicator_enabled");
    return !(cb && cb.checked);
}

// SINGLE place that writes the status line, so it is always right:
//   master off  -> disabled message
//   computing   -> calculating (+ progress)
//   error       -> the error
//   ready       -> "Ready — N fields available" or, with text typed, validity
function refreshIndicatorTailInfo() {
    const el = document.getElementById("indicatorTailInfo");
    if (!el) return;
    const n = getIndicatorTailBars();
    el.textContent = `Lookback: last ${n} bars — use offsets [0] to [${n - 1}] (e.g. close[${n - 1}]). Max possible ${INDICATOR_TAIL_MAX}; change in Settings.`;
}

function refreshIndicatorStatus() {
    refreshIndicatorTailInfo();
    const section = document.getElementById("group_indicator");
    const statusEl = document.getElementById("indicatorQueryStatus");
    if (!section) return;

    let uiState, text, cls = "adv-query-status";
    if (!isIndicatorQueryEnabled()) {
        uiState = "disabled";
        text = "⚠ Disabled in Settings — turn on “Enable Indicator Advance Query” to use this filter";
        cls += " adv-query-err";
    } else if (indicatorEngineState === "error") {
        uiState = "error";
        text = `⚠ ${indicatorEngineDetail || "indicator engine failed"}`;
        cls += " adv-query-err";
    } else if (indicatorEngineState === "ready") {
        uiState = "ready";
        const q = getIndicatorQueryText();
        if (!q) {
            text = `✓ Ready — ${indicatorQueryFields.length} fields available · ${indicatorStockCount.toLocaleString("en-IN")} stocks`;
            cls += " adv-query-ok";
        } else {
            const v = IndicatorQuery.validateIndicatorQuery(q);
            if (!v.ok) {
                text = `⚠ ${v.error}`;
                cls += " adv-query-err";
            } else if (IndicatorQuery.extractIndicatorQueryMaxOffset(q) >= indicatorActiveTailBars) {
                text = `⚠ Offset too large — only the last ${indicatorActiveTailBars} bars are available (max [${indicatorActiveTailBars - 1}]). Raise “Bars kept” in Settings (max ${INDICATOR_TAIL_MAX}).`;
                cls += " adv-query-err";
            } else {
                const known = indicatorKnownFieldSet();
                const unknown = IndicatorQuery.extractIndicatorQueryFields(q).filter((f) => !known.has(f));
                if (unknown.length) {
                    const kind = unknown[0].split("_")[0];
                    const similar = [...known].filter((f) => f.startsWith(kind + "_")).slice(0, 4);
                    text = `⚠ Unknown field “${unknown[0]}” — ` + (similar.length
                        ? `available: ${similar.join(", ")}. To use “${unknown[0]}”, enable it in Chart Settings.`
                        : `no ${kind} indicator is loaded. Enable it in Chart Settings, then wait for “Calculating”.`);
                    cls += " adv-query-err";
                } else {
                    text = "✓ Valid";
                    cls += " adv-query-ok";
                }
            }
        }
    } else {
        uiState = "computing"; // "computing" or "idle" (waiting for stock data)
        const what = indicatorRunKind === "incremental" && indicatorRunKeys.length
            ? `${indicatorRunKeys.length} new indicator${indicatorRunKeys.length > 1 ? "s" : ""}`
            : "indicators";
        text = indicatorEngineState === "computing"
            ? `⏳ Calculating ${what}… ${indicatorEngineDetail || ""}`
            : "⏳ Waiting for stock data…";
    }

    section.dataset.state = uiState;
    if (statusEl) {
        statusEl.textContent = text;
        statusEl.className = cls;
    }
}

function renderIndicatorPills(fields) {
    const container = document.getElementById("indicatorPillList");
    if (!container) return;
    container.innerHTML = "";
    fields.forEach((field) => {
        const pill = document.createElement("button");
        pill.type = "button";
        pill.className = "btn-adv-token indicator-pill" + (OHLCV_PILL_FIELDS.includes(field) ? " ohlcv-pill" : "");
        pill.textContent = field;
        pill.addEventListener("click", () => insertIndicatorFieldAtCursor(field));
        container.appendChild(pill);
    });
}

function insertIndicatorFieldAtCursor(field) {
    const box = document.getElementById("f_indicator_query");
    if (!box || isIndicatorQueryLocked()) return;
    const insertText = `${field}[0]`;
    const start = box.selectionStart ?? box.value.length;
    const end = box.selectionEnd ?? box.value.length;
    box.value = box.value.slice(0, start) + insertText + box.value.slice(end);
    const caret = start + insertText.length;
    box.focus();
    box.setSelectionRange(caret, caret);
    onIndicatorQueryInput();
}

// AND / OR / NOT / ( ) buttons - respects the lock.
function appendIndicatorToken(token) {
    const box = document.getElementById("f_indicator_query");
    if (!box || isIndicatorQueryLocked()) return;
    box.value += token;
    onIndicatorQueryInput();
}

// ---------------------------------------------------------------------------
// 5. Validation + application
// ---------------------------------------------------------------------------
let indicatorValidateTimer = null;
function onIndicatorQueryInput() {
    if (!isIndicatorQueryEnabled()) return; // locked: no status change, no filtering
    clearTimeout(indicatorValidateTimer);
    indicatorValidateTimer = setTimeout(() => {
        reconcileIndicatorKeysWithChartSettings("query edited");
        refreshIndicatorStatus();
        applyFilters();
    }, 300);
}

function setIndicatorQueryText(text) {
    const box = document.getElementById("f_indicator_query");
    if (box) box.value = text || "";
    refreshIndicatorStatus();
}
function getIndicatorQueryText() {
    const box = document.getElementById("f_indicator_query");
    return box ? box.value.trim() : "";
}
function clearIndicatorQuery() {
    if (isIndicatorQueryLocked()) return;
    setIndicatorQueryText("");
    applyFilters();
}

// Narrow an already-filtered row array by an indicator query. Returns rows
// unchanged when the engine is off / not ready / text is empty or invalid.
function applyIndicatorQueryFilter(rows, text) {
    if (!isIndicatorQueryEnabled() || !indicatorEngineReady) return rows;
    const q = (text !== undefined ? text : getIndicatorQueryText()).trim();
    if (!q) return rows;

    let predicate;
    try {
        predicate = IndicatorQuery.compileIndicatorQuery(q, { getOHLCVSeries, getIndicatorSeries });
    } catch {
        return rows;
    }
    if (!predicate) return rows;
    return rows.filter((row) => predicate(row["ISIN"]));
}

// Saved-search / preset runs: returns null ("run failed") when the engine
// isn't ready so callers never treat an UNFILTERED list as the result.
let _indicatorCodeMap = null, _indicatorCodeMapSrc = null;
function filterCodesByIndicatorQuery(codes, text) {
    if (!codes) return codes;
    if (!isIndicatorQueryEnabled() || !indicatorEngineReady) return null;
    if (_indicatorCodeMapSrc !== allData) {
        _indicatorCodeMap = new Map(allData.map((r) => [r.Code, r]));
        _indicatorCodeMapSrc = allData;
    }
    let predicate;
    try {
        predicate = IndicatorQuery.compileIndicatorQuery(text, { getOHLCVSeries, getIndicatorSeries });
    } catch (e) {
        console.warn("Indicator query in saved search failed to parse:", e.message);
        return null;
    }
    if (!predicate) return codes;
    return codes.filter((c) => {
        const row = _indicatorCodeMap.get(c);
        return row && predicate(row["ISIN"]);
    });
}

// ---------------------------------------------------------------------------
// 6. Saved-search restore. The text goes into the (possibly read-only) box and
//    the status line reflects the real state; a saved search NEVER flips the
//    master switch on by itself.
// ---------------------------------------------------------------------------
function handleRestoredIndicatorQuery(text, enabled) {
    setIndicatorQueryText(text || "");
    // The restore loop has just set f_indicator_enabled; make sure lock state follows.
    if (typeof syncIndicatorQueryFieldUI === "function") syncIndicatorQueryFieldUI();
    refreshIndicatorStatus();
}

// ---------------------------------------------------------------------------
// 6b. Settings-modal control for the tail length ("Bars kept")
// ---------------------------------------------------------------------------
function syncIndicatorTailInput() {
    const el = document.getElementById("settingsIndicatorTailBars");
    if (el) el.value = getIndicatorTailBars();
}

// Fired on the input's `change` event (not every keystroke). Clamps to 1..252,
// saves, and rebuilds the engine only if the master switch is on.
function onSettingsIndicatorTailChange(raw) {
    const before = getIndicatorTailBars();
    const n = clampIndicatorTailBars(raw);
    setIndicatorTailBars(n);
    syncIndicatorTailInput();          // shows the clamped value back to the user
    refreshIndicatorTailInfo();
    if (n === before || !isIndicatorQueryEnabled()) return;
    restartIndicatorEngine();          // worker reuses cached raw payloads; only tails are rebuilt
}

// ---------------------------------------------------------------------------
// 7. Boot + re-trigger on data reload / chart-settings change
// ---------------------------------------------------------------------------
window.addEventListener("load", () => {
    syncIndicatorTailInput();
    if (typeof syncIndicatorQueryFieldUI === "function") syncIndicatorQueryFieldUI();
    refreshIndicatorStatus();
});

function onDataDateChanged() {
    if (isIndicatorQueryEnabled()) restartIndicatorEngine();
}

// Compares the indicators enabled in Chart Settings with what the engine has.
// Safe to call any time (cheap no-op when nothing changed). Called from:
//   - window.onChartSettingsSaved (fired by saveChartSettings())
//   - typing in / focusing the query box  (safety net in case the hook is ever
//     bypassed or overwritten by other code)
//
//   engine READY, same tail length -> syncIndicatorKeys(): keep loaded keys, drop
//     removed ones, run the worker for ONLY the newly enabled keys (IndexedDB is
//     checked per stock + key first; only missing ones are calculated).
//   anything else (computing, error, idle, tail length changed) -> full restart,
//     which is also IndexedDB-first.
let indicatorReconciling = false;
function reconcileIndicatorKeysWithChartSettings(reason) {
    if (indicatorReconciling || !isIndicatorQueryEnabled()) return;
    indicatorReconciling = true;
    try {
        const keys = getEnabledChartIndicatorKeys();
        const sig = keys.join("|");
        const tailChanged = indicatorEngineState !== "idle" && getIndicatorTailBars() !== indicatorActiveTailBars;
        if (sig === indicatorLastKeys && !tailChanged) return; // nothing new
        console.info(`[indicator] ${reason}: enabled chart indicators changed ->`, keys);

        if (indicatorEngineState === "ready" && !tailChanged) syncIndicatorKeys(keys);
        else restartIndicatorEngine();
    } finally {
        indicatorReconciling = false;
    }
}

window.addEventListener("chartSettingsSaved", function (e) {
    const { oldSettings, newSettings } = e.detail;
    reconcileIndicatorKeysWithChartSettings("chart settings saved");
});

// Handy from the browser console when something looks off: __indicatorDebug()
window.__indicatorDebug = () => ({
    masterEnabled: isIndicatorQueryEnabled(),
    state: indicatorEngineState,
    enabledKeysInChartSettings: getEnabledChartIndicatorKeys(),
    lastRunKeys: indicatorLastKeys.split("|"),
    loadedKeys: [...indicatorLoadedKeys],
    fieldsAvailable: indicatorQueryFields,
    workerRunning: !!indicatorWorker,
    runKind: indicatorRunKind,
    tailBarsActive: indicatorActiveTailBars,
    tailBarsSetting: getIndicatorTailBars(),
    hookInstalled: typeof window.onChartSettingsSaved === "function",
});

/* ============================================================================
   alert.js — Price Alert engine for NSE Momentum Screener
   ----------------------------------------------------------------------------
   Owns EVERYTHING alert related: the notification bell modal (two tabs —
   "Today's Alerts" and "Manage Custom Alerts"), localStorage persistence,
   the market-hours scheduler, and talking to alert-worker.js (a Web Worker)
   which does the actual live-price fetch + comparison off the main thread.

   Loaded at the very end of index.html, AFTER the main inline <script>, so it
   can freely read globals declared there with top-level `let`/`const`
   (allData, loadAlertSettings(), ALERT_SETTINGS_KEY, etc — top-level
   let/const in one classic <script> is visible to later classic <script>
   tags in the same document).

   Called by the main script:
     initPriceAlertSystem()  — call once allData is loaded/refreshed.
   ========================================================================= */

(function () {
    "use strict";

    // ------------------------------------------------------------------
    // Storage keys
    // ------------------------------------------------------------------
    const CUSTOM_ALERTS_KEY = "nse_screener_custom_alerts_v1";
    const TRIGGERED_ALERTS_KEY = "nse_screener_triggered_alerts_v1"; // { date, items:[...] }
    const SEEN_COUNT_KEY = "nse_screener_alerts_seen_v1"; // { date, count }

    // Market window (IST) — NSE cash market hours. Does not account for
    // exchange holidays; it only gates on weekday + clock time.
    const MARKET_OPEN_MIN = 9 * 60 + 15; // 09:15
    const MARKET_CLOSE_MIN = 15 * 60 + 30; // 15:30
    const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
    const SCHEDULER_TICK_MS = 30 * 1000; // how often we check "should we be running right now"

    const alertSound = new Audio('./assets/audio/nse_screener_alert.wav');
    alertSound.preload = 'auto';

    // Browsers have no "audio permission" prompt - autoplay is unlocked by playing
    // something once inside a user gesture. Called from ensureNotificationPermission()
    // (which only runs from clicks), so alerts can make sound later with no click.
    let audioUnlocked = false;
    let audioUnlocking = false;
    function unlockAlertSound() {
        if (audioUnlocked || audioUnlocking) return;
        audioUnlocking = true;
        alertSound.muted = true; // silent: the user shouldn't hear a sound just for ticking a box
        let p;
        try { p = alertSound.play(); } catch (e) { p = null; }
        const finish = (ok) => {
        try { alertSound.pause(); alertSound.currentTime = 0; } catch (e) {}
        alertSound.muted = false;
        audioUnlocked = ok;   // if it failed, the next click tries again
        audioUnlocking = false;
        };
        if (p && typeof p.then === "function") p.then(() => finish(true), () => finish(false));
        else finish(false);
    }

    function playAlertSound() {
        alertSound.muted = false;
        alertSound.currentTime = 0; // restart if it's already playing
        alertSound.play().catch(err => {
        console.warn('Alert sound blocked or failed:', err);
        });
    }

    // ------------------------------------------------------------------
    // Runtime state
    // ------------------------------------------------------------------
    let worker = null;
    let cycleInterval = null; // the 5-min "run a check" interval, only active in market hours
    let schedulerInterval = null; // the 30s "should the cycle be running?" interval
    let cycleRunning = false;
    // index.html reads `cycleRunning` as a bare global. `window.cycleRunning = cycleRunning`
    // only copies the boolean ONCE (always false), so use a live getter instead.
    Object.defineProperty(window, "cycleRunning", {
        configurable: true,
        get: function () { return cycleRunning; },
    });
    let cycleToken = 0;          // bumped on every start/stop so async work can tell it is stale
    let checkInFlight = false;
    let recheckQueued = false;   // a check was requested while one was running
    let activeRequestId = 0;     // matches worker replies to the request that caused them
    let watchdogTimer = null;
    let notifPermissionAsked = false;
    // type -> [alert, ...]. Same object identity for the page's lifetime because
    // index.html (window.allAlertStocksList) holds a reference to it.
    const allAlertStocksList = {};
    window.allAlertStocksList = allAlertStocksList;
    // Code -> row lookup, rebuilt lazily whenever allData is (re)loaded
    let rowByCode = null;
    let rowByCodeSource = null;
    const alertType = {
      "customAlerts": "Custom Alert",
      "awayFromHighAlerts": "Away From High",
      "pivotTrendLineAlerts": "Pivot Trend Line",
      "superTrendAlerts": "Super Trend",
    };
    let livePrices = null; // Map<SYMBOL, number> from the last worker reply

    const CHECK_TIMEOUT_MS = 75 * 1000;        // must stay above the worker's first-call timeout (60s)
    const DATA_WAIT_TIMEOUT_MS = 2 * 60 * 1000; // how long startCycle waits for allData
    const CHART_FETCH_CONCURRENCY = 6;

    // ==================================================================
    // Small date/time helpers (IST-aware, independent of the visitor's
    // own timezone)
    // ==================================================================
    function istParts(d) {
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: "Asia/Kolkata",
            hour12: false,
            weekday: "short",
            hour: "2-digit",
            minute: "2-digit",
        }).formatToParts(d || new Date());
        const map = {};
        parts.forEach((p) => (map[p.type] = p.value));
        return {
            weekday: map.weekday,
            hour: parseInt(map.hour, 10),
            minute: parseInt(map.minute, 10),
        };
    }

    function istDateStr(d) {
        // en-CA formats as YYYY-MM-DD which is what we want for a stable key
        return new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Kolkata",
        }).format(d || new Date());
    }

    function istTimeLabel(d) {
        return new Intl.DateTimeFormat("en-IN", {
            timeZone: "Asia/Kolkata",
            hour: "2-digit",
            minute: "2-digit",
            hour12: true,
        }).format(d || new Date());
    }

    function isMarketOpenIST() {
        const p = istParts();
        if (p.weekday === "Sat" || p.weekday === "Sun") return false;
        const mins = p.hour * 60 + p.minute;
        return mins >= MARKET_OPEN_MIN && mins <= MARKET_CLOSE_MIN;
    }
    window.isMarketOpenIST = isMarketOpenIST;

    function getAlertSettings() {
        const settings =
            typeof loadAlertSettings === "function"
                ? loadAlertSettings()
                : { customAlerts: false, awayFromHighAlerts: false,pivotTrendLineAlerts:false,superTrendAlerts:false };
        return settings;
    }
    window.getAlertSettings = getAlertSettings;

    // ==================================================================
    // localStorage helpers
    // ==================================================================
    function safeGet(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (e) {
            console.warn("[alert.js] could not read", key, e);
            return fallback;
        }
    }
    function safeSet(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (e) {
            console.warn("[alert.js] could not save", key, e);
            return false;
        }
    }

    // ---- Custom alerts (user defined script/condition/value) ----
    function getCustomAlerts() {
        return safeGet(CUSTOM_ALERTS_KEY, []);
    }
    function saveCustomAlerts(list) {
        safeSet(CUSTOM_ALERTS_KEY, list);

        if (anyAlertEnabled(getAlertSettings()) && isMarketOpenIST() && cycleRunning) {
            rebuildList("customAlerts");
        }
    }

    // Public helper requested by spec: "one function which get all the
    // enabled alerts or all alerts when required."
    function getStoredAlerts(enabledOnly) {
        const list = getCustomAlerts();
        return enabledOnly ? list.filter((a) => a.enabled) : list;
    }
    window.getStoredAlerts = getStoredAlerts;

    function addCustomAlert(code, name, condition, value) {
        const list = getCustomAlerts();
        list.push({
            id: "a" + Date.now() + Math.random().toString(36).slice(2, 7),
            code: code,
            name: name || code,
            condition: condition, // ">=" or "<="
            value: value,
            enabled: true,
            createdAt: new Date().toISOString(),
        });
        saveCustomAlerts(list);
        return list;
    }

    function toggleCustomAlert(id) {
        const list = getCustomAlerts();
        const item = list.find((a) => a.id === id);
        if (item) item.enabled = !item.enabled;
        saveCustomAlerts(list);
        renderCustomAlertsList();
        // Enabling an alert mid-day should make it eligible immediately, not
        // only from the next 5-min tick — but only if we're inside market hours.
        if (item && item.enabled && isMarketOpenIST()) runAlertCheck();
    }

    function deleteCustomAlert(id) {
        const list = getCustomAlerts().filter((a) => a.id !== id);
        saveCustomAlerts(list);
        renderCustomAlertsList();
    }
    window.toggleCustomAlert = toggleCustomAlert;
    window.deleteCustomAlert = deleteCustomAlert;

    // ---- Triggered alerts log (valid only for "today", IST) ----
    function getTriggeredStore() {
        const store = safeGet(TRIGGERED_ALERTS_KEY, null);
        const today = istDateStr();
        if (!store || store.date !== today) {
            // Rolled into a new trading day — the listing is only meant to
            // hold today's fires, so start fresh (no explicit "clear" needed).
            return { date: today, items: [] };
        }
        return store;
    }
    window.getTriggeredStore = getTriggeredStore; // used by the chart popup "Today's Alerts" list
    function saveTriggeredStore(store) {
        safeSet(TRIGGERED_ALERTS_KEY, store);
    }
    function getSeenCount() {
        const s = safeGet(SEEN_COUNT_KEY, null);
        const today = istDateStr();
        if (!s || s.date !== today) return 0;
        return s.count || 0;
    }
    function setSeenCount(n) {
        safeSet(SEEN_COUNT_KEY, { date: istDateStr(), count: n });
    }

    function recordTriggeredAlerts(results) {
        if (!results || !results.length) return;
        const settings = getAlertSettings();
        const store = getTriggeredStore();
        const fired = new Set(store.items.map((i) => i.alertId));
        let customList = null;
        let customChanged = false;
        const accepted = [];
        allowRenderTriggeredAlertChartwatchlistDrawer = true;

        results.forEach((r) => {
            if (!r || !r.type) return;
            const id = r.alertId || r.id;
            // Drop replies for alerts that were switched off / deleted / already
            // fired while the request was in flight.
            if (!id || fired.has(id) || !settings[r.type]) return;

            // Auto-disable the custom alert that fired so it doesn't spam the
            // user again every 5 minutes for the rest of the day.
            if (r.type === "customAlerts") {
                customList = customList || getCustomAlerts();
                const item = customList.find((a) => a.id === id);
                if (!item || !item.enabled) return;
                item.enabled = false;
                customChanged = true;
            }

            fired.add(id);
            r.alertId = id;
            accepted.push(r);
            store.items.push({
                id: "t" + Date.now() + Math.random().toString(36).slice(2, 7),
                alertId: id,
                code: r.code,
                name: r.name,
                isin: r.isin,
                condition: r.condition,
                target: r.value,
                ltp: r.ltp,
                prevClose: r.prevClose,
                type: r.type,
                pct:
                    r.prevClose > 0
                        ? ((r.ltp - r.prevClose) / r.prevClose) * 100
                        : null,
                triggeredAt: new Date().toISOString(),
            });
            dropFromList(r.type, id);
        });

        if (!accepted.length) return;
        // Written directly (not via saveCustomAlerts) so we don't trigger a
        // pointless rebuild of the list we just pruned.
        if (customChanged) safeSet(CUSTOM_ALERTS_KEY, customList);
        saveTriggeredStore(store);
        updateBellBadge();
        if (isAlertModalOpen()) {
            renderTriggeredAlertsList();
            renderCustomAlertsList();
        }
        playAlertSound();
        accepted.forEach(notifyUser);
    }

    // ==================================================================
    // Bell badge + app badge
    // ==================================================================
    function updateBellBadge() {
        const store = getTriggeredStore();
        const unseen = Math.max(0, store.items.length - getSeenCount());
        const el = document.getElementById("alertBellCount");
        if (el) {
            el.textContent = unseen > 99 ? "99+" : String(unseen);
            el.style.display = unseen > 0 ? "block" : "none";
        }
        try {
            if (unseen > 0 && navigator.setAppBadge) navigator.setAppBadge(unseen);
            else if (unseen === 0 && navigator.clearAppBadge) navigator.clearAppBadge();
        } catch (e) {
            /* Badging API not supported — non-fatal */
        }
    }

    function markAllSeen() {
        const store = getTriggeredStore();
        setSeenCount(store.items.length);
        updateBellBadge();
    }

    // ==================================================================
    // Browser notifications
    // ==================================================================
    function ensureNotificationPermission() {
        // Sound first, synchronously, so it stays inside the click gesture -
        // and even on browsers that have no Notification API.
        unlockAlertSound();

        if (!("Notification" in window)) return;
        if (Notification.permission === "default" && !notifPermissionAsked) {
            notifPermissionAsked = true;
            Notification.requestPermission().catch(() => {});
        }
    }

    function notifyUser(r) {
        if (!("Notification" in window) || Notification.permission !== "granted")
            return;
        const dir = r.condition === ">=" ? "≥" : "≤";
        const pctTxt =
            r.prevClose > 0
                ? ` (${r.ltp >= r.prevClose ? "+" : ""}${(
                      ((r.ltp - r.prevClose) / r.prevClose) *
                      100
                  ).toFixed(2)}% vs prev close ₹${r.prevClose})`
                : "";
        try {
            const n = new Notification(`🔔 ${r.code} ${dir} ₹${r.value.toFixed(2)}`, {
                body: `LTP ₹${r.ltp}${pctTxt}\n${alertType[r.type]}`,
                tag: "nse-alert-" + r.alertId,
                icon: "./assets/img/icon-192.png",
            });
            n.onclick = () => {
                window.focus();
                openPriceAlertModal();
                n.close();
            };
        } catch (e) {
            console.warn("[alert.js] notification failed", e);
        }
    }

    // ==================================================================
    // Modal UI
    // ==================================================================
    window.openPriceAlertModal = function () {
        populateCodeDatalist();
        renderTriggeredAlertsList();
        renderCustomAlertsList();
        refreshStatusLine();
        document.getElementById("priceAlertModal").classList.add("open");  // same for saved-open, watchlist-open
        markAllSeen();
    };
    window.closePriceAlertModal = function () {
        document.getElementById("priceAlertModal").classList.remove("open");
    };
    window.closePriceAlertModalOnOverlay = function (e) {
        if (e.target === document.getElementById("priceAlertModal"))
            closePriceAlertModal();
    };
    window.switchAlertTab = function (tab) {
        document
            .querySelectorAll(".pa-tab")
            .forEach((t) =>
                t.classList.toggle("active", t.dataset.paTab === tab),
            );
        document
            .querySelectorAll(".pa-tab-panel")
            .forEach((p) =>
                p.classList.toggle("active", p.dataset.paPanel === tab),
            );
        if (tab === "triggered") markAllSeen();
    };

    function refreshStatusLine() {
        const dot = document.getElementById("paStatusDot");
        const text = document.getElementById("paStatusText");
        if (!dot || !text) return;
        const settings = getAlertSettings();
        const anyEnabled = !!(settings.customAlerts || settings.awayFromHighAlerts || settings.pivotTrendLineAlerts || settings.superTrendAlerts);
        const open = isMarketOpenIST();
        dot.classList.toggle("live", anyEnabled && open && cycleRunning);
        if (!anyEnabled) {
            text.textContent =
                "Alerts are off — enable them from ⚙ Settings to start monitoring.";
        } else if (!open) {
            text.textContent =
                "Market is closed. Monitoring resumes 9:15 AM IST on the next trading day.";
        } else {
            text.textContent = "Live — checking prices every 5 minutes.";
        }
    }

    function populateCodeDatalist() {
        const dl = document.getElementById("paCodeList");
        if (!dl || typeof allData === "undefined" || !allData.length) return;
        if (dl.childElementCount === allData.length) return; // already populated for this dataset
        const frag = document.createDocumentFragment();
        allData.forEach((r) => {
            if (!r.Code) return;
            const opt = document.createElement("option");
            opt.value = r.Code;
            opt.label = r.Name + ' - ' + r.Code || "";
            frag.appendChild(opt);
        });
        dl.innerHTML = "";
        dl.appendChild(frag);
    }

    window.addCustomAlertFromForm = function () {
        const codeInput = document.getElementById("paCodeInput");
        const condSelect = document.getElementById("paCondSelect");
        const valueInput = document.getElementById("paValueInput");
        const hint = document.getElementById("paFormHint");
        const rawCode = (codeInput.value || "").trim().toUpperCase();
        const value = parseFloat(valueInput.value);

        if (!rawCode) {
            hint.textContent = "Enter a script code first.";
            return;
        }
        if (!value || value <= 0) {
            hint.textContent = "Enter a valid trigger price.";
            return;
        }

        let name = rawCode;
        if (typeof allData !== "undefined" && allData.length) {
            const match = allData.find(
                (r) => (r.Code || "").toUpperCase() === rawCode,
            );
            if (match) name = match.Name || rawCode;
            else
                hint.textContent =
                    "Note: code not found in today's data — alert saved anyway.";
        }
        if (
            typeof allData === "undefined" ||
            !allData.length ||
            allData.some((r) => (r.Code || "").toUpperCase() === rawCode)
        ) {
            hint.textContent = "";
        }

        addCustomAlert(rawCode, name, condSelect.value, value);
        ensureNotificationPermission();
        codeInput.value = "";
        valueInput.value = "";
        renderCustomAlertsList();

        // If we're inside market hours, kick an immediate check so a
        // just-added alert doesn't have to wait up to 5 minutes.
        if (isMarketOpenIST()) runAlertCheck();
    };

    function renderCustomAlertsList() {
        const el = document.getElementById("paCustomList");
        if (!el) return;
        const list = getCustomAlerts().slice().reverse();
        if (!list.length) {
            el.innerHTML =
                '<div class="pa-empty">No custom alerts yet. Add one above — e.g. RELIANCE ≥ 1500.</div>';
            return;
        }
        el.innerHTML = list
            .map((a) => {
                const symbol = a.condition === ">=" ? "&ge;" : "&le;";
                return `<div class="pa-item${a.enabled ? "" : " disabled"}">
                    <div class="pa-item-info">
                        <span class="pa-item-code">${escapeHtml(a.code)} <span style="color:var(--muted);font-weight:400">${escapeHtml(a.name || "")}</span></span>
                        <span class="pa-item-cond">${symbol} &#8377;${a.value}</span>
                    </div>
                    <div class="pa-item-actions">
                        <label class="pa-switch">
                            <input type="checkbox" ${a.enabled ? "checked" : ""} onchange="toggleCustomAlert('${a.id}')">
                            <span class="pa-switch-slider"></span>
                        </label>
                        <button class="pa-del-btn" title="Delete" onclick="deleteCustomAlert('${a.id}')">&times;</button>
                    </div>
                </div>`;
            })
            .join("");
    }

    let triggeredAlertItemClickHandler = null;
    function renderTriggeredAlertsList() {
        const el = document.getElementById("paTriggeredList");
        if (!el) return;
        const store = getTriggeredStore();
        const items = store.items.slice().reverse();
        if (!items.length) {
            el.innerHTML =
                '<div class="pa-empty">No alerts triggered today yet.</div>';
            return;
        }
        el.innerHTML = items
            .map((t) => {
                const symbol = t.condition === ">=" ? "&ge;" : "&le;";
                const pctCls =
                    t.pct == null ? "" : t.pct >= 0 ? "pa-tt-up" : "pa-tt-down";
                const pctTxt =
                    t.pct == null
                        ? ""
                        : ` · <span class="${pctCls}">${t.pct >= 0 ? "+" : ""}${t.pct.toFixed(2)}%</span> vs prev close &#8377;${t.prevClose.toFixed(2)}`;
                return `<div class="pa-triggered-item" data-isin="${t.isin}" data-code="${t.code}" data-name="${t.name}">
                    <div class="pa-tt-head">
                        <span>${escapeHtml(t.code)} ${symbol} &#8377;${t.target.toFixed(2)}</span>
                        <span class="pa-tt-time">${istTimeLabel(new Date(t.triggeredAt))}</span>
                    </div>
                    <div class="pa-tt-meta">LTP &#8377;${t.ltp}${pctTxt}</div>
                    <div class="pa-tt-badge"><span class="sector-pill">${alertType[t.type]}</span></div>
                </div>`;
            })
            .join("");

        requestAnimationFrame(() => {
            if (!triggeredAlertItemClickHandler) {
                triggeredAlertItemClickHandler = (event) => {
                    const stockButton = event.target.closest(
                        ".pa-triggered-item",
                    );
                    if (stockButton) openChartModal(stockButton);
                };
                el.addEventListener("click", triggeredAlertItemClickHandler);
            }
        })
    }

    function escapeHtml(s) {
        return String(s).replace(
            /[&<>"']/g,
            (c) =>
                ({
                    "&": "&amp;",
                    "<": "&lt;",
                    ">": "&gt;",
                    '"': "&quot;",
                    "'": "&#39;",
                })[c],
        );
    }

    // ==================================================================
    // Async helpers (keep heavy work off the main thread's critical path)
    // ==================================================================
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // Hand control back to the browser so input/paint can run between chunks.
    function yieldToMain() {
        if (window.scheduler && typeof window.scheduler.yield === "function") {
            return window.scheduler.yield();
        }
        return new Promise((r) => setTimeout(r, 0));
    }

    function once(fn) {
        let p;
        return () => p || (p = fn());
    }

    // Run `task(item)` over `items` with at most `limit` in flight, yielding
    // to the main thread after every item. One failing item never aborts the rest.
    async function runPool(items, limit, task) {
        let next = 0;
        const runners = Array.from(
            { length: Math.min(limit, items.length) },
            async () => {
                while (next < items.length) {
                    const item = items[next++];
                    try {
                        await task(item);
                    } catch (e) {
                        console.warn("[alert.js] task failed", e);
                    }
                    await yieldToMain();
                }
            },
        );
        await Promise.all(runners);
    }

    function anyAlertEnabled(s) {
        return !!(s && (s.customAlerts || s.awayFromHighAlerts || s.pivotTrendLineAlerts || s.superTrendAlerts));
    }
    function hasData() {
        return typeof allData !== "undefined" && allData.length > 0;
    }
    function isAlertModalOpen() {
        const m = document.getElementById("priceAlertModal");
        return !!(m && m.classList.contains("open"));
    }

    // allData is loaded asynchronously by the main script, AFTER this file has
    // already run - so the lookup must be (re)built lazily, never once at startup.
    function getRowByCode() {
        if (typeof allData === "undefined") return new Map();
        if (!rowByCode || rowByCodeSource !== allData) {
            rowByCode = new Map(allData.map((r) => [r.Code, {Code:r.Code,Name:r.Name,ISIN:r.ISIN,Close:r.Close}]));
            rowByCodeSource = allData;
        }
        return rowByCode;
    }

    async function waitForData() {
        const t0 = Date.now();
        while (!hasData()) {
            if (Date.now() - t0 > DATA_WAIT_TIMEOUT_MS) return false;
            await sleep(500);
        }
        return true;
    }

    function livePriceOf(code) {
        if (!livePrices) return null;
        const v = livePrices.get(String(code).toUpperCase());
        return Number.isFinite(v) ? v : null;
    }

    function getFiredIdsToday() {
        return new Set(getTriggeredStore().items.map((i) => i.alertId));
    }

    function getWatchlistCodes() {
        const lists = typeof loadWatchlists === "function" ? loadWatchlists() : [];
        return [
            ...new Set(
                lists
                    .flatMap((w) => (Array.isArray(w.codes) ? w.codes : []))
                    .map((c) => (typeof c === "string" ? c : c && c.code))
                    .filter(Boolean),
            ),
        ];
    }

    // One in-flight request per ISIN, shared by all three indicator builders
    // (they run at the same time in startCycle) instead of 3 identical downloads.
    const inflightChart = new Map();
    function fetchChartData(isin) {
        let p = inflightChart.get(isin);
        if (!p) {
            p = fetch(`data/chart/${isin}.json`)
                .then((res) => {
                    if (!res.ok) throw new Error(`HTTP ${res.status} for ${isin}`);
                    return res.json();
                })
                .finally(() => inflightChart.delete(isin));
            inflightChart.set(isin, p);
        }
        return p;
    }

    // Cache-first indicator lookup (same IndexedDB keys the charts use). Never
    // throws: any failure just means "no target for this indicator".
    async function getIndicator(isin, key, compute, loadData) {
        const db = typeof IndicatorCacheDB !== "undefined" ? IndicatorCacheDB : null; // indicator-db.js loads async
        const date = typeof CURRENT_DATA_DATE !== "undefined" ? CURRENT_DATA_DATE : "";
        try {
            if (db) {
                const hit = await db.get(isin, key, date);
                if (hit) return hit;
            }
            const result = compute(await loadData());
            if (db && result) await db.set(isin, key, date, result);
            return result;
        } catch (e) {
            console.warn("[alert.js] indicator failed", key, isin, e && e.message);
            return null;
        }
    }

    const lastLineValue = (line) =>
        Array.isArray(line) && line.length ? parseFloat(line[line.length - 1].value) : NaN;

    // ==================================================================
    // Alert list builders
    // ==================================================================
    function buildCustomAlertStocks() {
        const alertSettings = getAlertSettings();
        if (!alertSettings.customAlerts) return [];
        const enabledAlerts = getStoredAlerts(true);
        if (!enabledAlerts.length || !hasData()) return [];
        const rows = getRowByCode();

        return enabledAlerts
            .map((alert) => {
                const row = rows.get(alert.code);
                if (!row) return null; // stock not in allData

                const close = parseFloat(row.Close);
                const target = parseFloat(alert.value);
                if (isNaN(close) || isNaN(target)) return null;

                // Keep only alerts whose condition matches your rule
                const ltp = livePriceOf(alert.code);
                if (ltp !== null) {
                    const matchedLive =
                        (alert.condition === ">=" && ltp < target) ||
                        (alert.condition === "<=" && ltp > target);
                    if (!matchedLive) return null;
                }

                const matched =
                    (alert.condition === ">=" && close < target) ||
                    (alert.condition === "<=" && close > target);
                if (!matched) return null;

                return {
                    id: alert.id,
                    code: row.Code,
                    name: row.Name,
                    isin: row.ISIN,
                    prevClose: close,
                    condition: alert.condition,
                    value: target,
                    type: "customAlerts",
                };
            })
            .filter(Boolean);
    }

    // Shared engine for the three watchlist/indicator alert types.
    // collectTargets(row, chartSettings, loadData) -> [{ id, target }]
    // Ids are DETERMINISTIC (type:code:params) so an alert that already fired
    // today is not re-created (and re-fired) when the lists are rebuilt.
    async function buildIndicatorAlertStocks(type, collectTargets) {
        if (!getAlertSettings()[type]) return [];
        const codes = getWatchlistCodes();
        if (!codes.length || !hasData()) return [];

        const rows = getRowByCode();
        const chartSettings = getChartSettings();
        const fired = getFiredIdsToday();
        const out = [];

        await runPool(codes, CHART_FETCH_CONCURRENCY, async (code) => {
            const row = rows.get(code);
            if (!row) return; // stock not in allData
            const close = parseFloat(row.Close);
            if (isNaN(close)) return;

            const loadData = once(() => fetchChartData(row.ISIN)); // only fetched on a cache miss
            const targets = await collectTargets(row, chartSettings, loadData);

            for (const t of targets) {
                if (fired.has(t.id)) continue;
                if (!(close < t.target)) continue; // not below the level yet
                const ltp = livePriceOf(row.Code);
                if (ltp !== null && !(ltp < t.target)) continue;
                out.push({
                    id: t.id,
                    code: row.Code,
                    name: row.Name,
                    isin: row.ISIN,
                    prevClose: close,
                    condition: ">=",
                    value: t.target,
                    type: type,
                });
            }
        });
        return out;
    }

    function buildAwayFromHighAlertStocks() {
        return buildIndicatorAlertStocks("awayFromHighAlerts", async (row, cs, loadData) => {
            const targets = [];
            for (const afh of cs.afh || []) {
                if (!(afh.enabled && afh.length >= 15)) continue;
                const res = await getIndicator(
                    row.ISIN,
                    "afh_" + afh.length,
                    (d) => calculateHighestHighResistance(d, { length: afh.length }),
                    loadData,
                );
                const target = res ? parseFloat(res.price) : NaN;
                if (Number.isFinite(target)) targets.push({ id: `afh:${row.Code}:${afh.length}`, target });
            }
            return targets;
        });
    }
    window.buildAwayFromHighAlertStocks = buildAwayFromHighAlertStocks;

    function buildPivotTrendLineAlertStocks() {
        return buildIndicatorAlertStocks("pivotTrendLineAlerts", async (row, cs, loadData) => {
            const targets = [];
            for (const pivot of cs.pivottrendline || []) {
                if (!(pivot.enabled && pivot.length > 1)) continue;
                const res = await getIndicator(
                    row.ISIN,
                    "pivottrendline_" + pivot.length + "_high",
                    (d) => calculateTrendlinePoints(d, pivot.length, "high"),
                    loadData,
                );
                if (!res) continue;
                // Both trend lines are independent alerts (the old code returned
                // after lineA, and read lineB's value from lineA's array).
                const a = lastLineValue(res.lineA);
                const b = lastLineValue(res.lineB);
                if (Number.isFinite(a)) targets.push({ id: `ptl:${row.Code}:${pivot.length}:A`, target: a });
                if (Number.isFinite(b)) targets.push({ id: `ptl:${row.Code}:${pivot.length}:B`, target: b });
            }
            return targets;
        });
    }
    window.buildPivotTrendLineAlertStocks = buildPivotTrendLineAlertStocks;

    function buildSuperTrendAlertStocks() {
        return buildIndicatorAlertStocks("superTrendAlerts", async (row, cs, loadData) => {
            const targets = [];
            for (const st of cs.supertrend || []) {
                if (!st.enabled) continue;
                const calc = await getIndicator(
                    row.ISIN,
                    "supertrend_" + st.atrLength + "_" + st.factor,
                    (d) => calculateSupertrend(d, st),
                    loadData,
                );
                const target = Array.isArray(calc) && calc.length ? parseFloat(calc[calc.length - 1].value) : NaN;
                if (Number.isFinite(target)) {
                    targets.push({ id: `supt:${row.Code}:${st.atrLength}:${st.factor}`, target });
                }
            }
            return targets;
        });
    }
    window.buildSuperTrendAlertStocks = buildSuperTrendAlertStocks;

    // ==================================================================
    // List management: builds are async, so "latest build wins" - a slow,
    // older build can never overwrite the result of a newer one.
    // ==================================================================
    const LIST_BUILDERS = {
        customAlerts: buildCustomAlertStocks,
        awayFromHighAlerts: buildAwayFromHighAlertStocks,
        pivotTrendLineAlerts: buildPivotTrendLineAlertStocks,
        superTrendAlerts: buildSuperTrendAlertStocks,
    };
    const buildGen = {};
    const pendingBuilds = new Map();

    function rebuildList(type) {
        const builder = LIST_BUILDERS[type];
        if (!builder) return Promise.resolve([]);
        const gen = (buildGen[type] = (buildGen[type] || 0) + 1);

        let out;
        try {
            out = builder();
        } catch (e) {
            console.warn("[alert.js] build failed", type, e);
            out = [];
        }
        if (!out || typeof out.then !== "function") {
            // sync builder (custom alerts): apply immediately so a check that
            // is requested right after sees the new list
            allAlertStocksList[type] = Array.isArray(out) ? out : [];
            pendingBuilds.delete(type);
            return Promise.resolve(allAlertStocksList[type]);
        }
        const p = out
            .then((stocks) => {
                if (buildGen[type] === gen && cycleRunning) {
                    allAlertStocksList[type] = Array.isArray(stocks) ? stocks : [];
                }
                return stocks;
            })
            .catch((e) => {
                console.warn("[alert.js] build failed", type, e);
                return [];
            })
            .finally(() => {
                if (pendingBuilds.get(type) === p) pendingBuilds.delete(type);
            });
        pendingBuilds.set(type, p);
        return p;
    }

    function rebuildAllLists() {
        return Promise.all(Object.keys(LIST_BUILDERS).map(rebuildList));
    }

    function clearList(type) {
        buildGen[type] = (buildGen[type] || 0) + 1; // invalidate any build still running
        pendingBuilds.delete(type);
        allAlertStocksList[type] = [];
    }

    function dropFromList(type, id) {
        const cur = allAlertStocksList[type];
        if (Array.isArray(cur)) allAlertStocksList[type] = cur.filter((i) => i.id !== id);
    }

    // index.html's saveWatchlists() still does
    //   allAlertStocksList[type] = buildXxxAlertStocks();
    // which now stores a Promise. Settle any such entries into plain arrays
    // before they are posted to the worker (Promises can't be structured-cloned).
    async function resolveAlertLists() {
        await Promise.all(
            Object.keys(allAlertStocksList).map(async (type) => {
                const v = allAlertStocksList[type];
                if (Array.isArray(v)) return;
                let arr = [];
                try {
                    const r = await v;
                    arr = Array.isArray(r) ? r : [];
                } catch (e) {
                    console.warn("[alert.js] build failed", type, e);
                }
                if (allAlertStocksList[type] === v) allAlertStocksList[type] = arr;
            }),
        );
    }

    // ==================================================================
    // Worker lifecycle + the 5-minute check cycle
    // ==================================================================
    function ensureWorker() {
        if (worker || !("Worker" in window)) return worker;
        try {
            worker = new Worker("./helper/alert-worker.js");
            worker.onmessage = function (e) {
                const msg = e.data || {};
                // A reply for a request we already gave up on / cancelled.
                if (msg.requestId !== undefined && msg.requestId !== activeRequestId) return;
                try {
                    if (msg.type === "TRIGGERED") {
                        if (msg.livePrices instanceof Map) livePrices = msg.livePrices;
                        recordTriggeredAlerts(msg.results);
                    } else if (msg.type === "ERROR") {
                        console.warn("[alert-worker] ", msg.error);
                    }
                } catch (err) {
                    console.warn("[alert.js] failed to process worker reply", err);
                } finally {
                    finishCheck(); // ALWAYS release the lock, even if processing threw
                }
            };
            worker.onerror = function (err) {
                console.warn("[alert.js] worker error", err.message || err);
                finishCheck();
            };
        } catch (e) {
            console.warn("[alert.js] could not start alert-worker.js", e);
            worker = null;
        }
        return worker;
    }

    function finishCheck() {
        checkInFlight = false;
        if (watchdogTimer) {
            clearTimeout(watchdogTimer);
            watchdogTimer = null;
        }
        if (recheckQueued) {
            recheckQueued = false;
            if (cycleRunning) setTimeout(runAlertCheck, 0);
        }
    }

    // A worker that never answers must not freeze alerts for the rest of the day.
    function onCheckTimeout(requestId) {
        if (requestId !== activeRequestId || !checkInFlight) return;
        console.warn("[alert.js] alert check timed out - restarting worker");
        activeRequestId++; // ignore a late reply from the old request
        if (worker) {
            worker.terminate();
            worker = null;
        }
        finishCheck();
    }

    async function runAlertCheck() {
        if (!cycleRunning) return;
        if (checkInFlight) {
            recheckQueued = true; // e.g. a just-added alert: run again right after this one
            return;
        }
        checkInFlight = true; // reserved BEFORE any await so two callers can't both pass
        const myToken = cycleToken;
        let posted = false;
        try {
            if (pendingBuilds.size) await Promise.all([...pendingBuilds.values()]);
            await resolveAlertLists();
            if (!cycleRunning || myToken !== cycleToken || !hasData()) return;

            const fired = getFiredIdsToday();
            const allAlerts = Object.values(allAlertStocksList)
                .flat()
                .filter((a) => a && typeof a === "object" && a.id && !fired.has(a.id));
            if (!allAlerts.length) return;

            const w = ensureWorker();
            if (!w) return;

            const requestId = ++activeRequestId;
            w.postMessage({ type: "CHECK_ALERTS", requestId, allAlerts });
            posted = true;
            watchdogTimer = setTimeout(() => onCheckTimeout(requestId), CHECK_TIMEOUT_MS);
        } catch (e) {
            console.warn("[alert.js] alert check failed", e);
        } finally {
            if (!posted) finishCheck();
        }
    }

    async function startCycle() {
        if (cycleRunning) return;
        cycleRunning = true;
        const token = ++cycleToken;
        ensureWorker();
        refreshStatusLine();

        // allData is fetched asynchronously by the main script - wait for it
        // instead of building empty lists against an empty dataset.
        const ready = await waitForData();
        if (token !== cycleToken) return; // stopped while waiting
        if (!ready) {
            cycleRunning = false; // scheduler retries on its next 30s tick
            refreshStatusLine();
            return;
        }

        await rebuildAllLists();
        if (token !== cycleToken) return;

        cycleInterval = setInterval(runAlertCheck, CHECK_INTERVAL_MS);
        runAlertCheck(); // don't wait 5 min for the first check of the day
        refreshStatusLine();
    }

    function stopCycle() {
        if (!cycleRunning) return;
        cycleRunning = false;
        cycleToken++;
        if (cycleInterval) clearInterval(cycleInterval);
        cycleInterval = null;

        // terminate() drops the pending reply, so release the lock ourselves -
        // otherwise every check tomorrow would be skipped as "already in flight".
        activeRequestId++;
        checkInFlight = false;
        recheckQueued = false;
        if (watchdogTimer) {
            clearTimeout(watchdogTimer);
            watchdogTimer = null;
        }
        if (worker) {
            worker.terminate();
            worker = null;
        }

        // Yesterday's prices/lists must not leak into tomorrow's session.
        livePrices = null;
        Object.keys(buildGen).forEach((k) => buildGen[k]++);
        pendingBuilds.clear();
        Object.keys(allAlertStocksList).forEach((k) => delete allAlertStocksList[k]);
        refreshStatusLine();
    }

    // The scheduler is the thing that runs continuously (every 30s) once
    // alerts are enabled at all — it starts/stops the actual 5-min cycle as
    // the market opens/closes, so the worker never runs outside 9:15–15:30 IST.
    function schedulerTick() {
        if (anyAlertEnabled(getAlertSettings()) && isMarketOpenIST()) {
            startCycle().catch((e) => console.warn("[alert.js] startCycle failed", e));
        } else {
            stopCycle();
        }
    }

    function ensureScheduler() {
        if (!schedulerInterval) {
            schedulerInterval = setInterval(schedulerTick, SCHEDULER_TICK_MS);
        }
    }

    // ==================================================================
    // Public entry point — safe to call any time (at load, or again after
    // allData is refreshed)
    // ==================================================================
    window.initPriceAlertSystem = function () {
        rowByCode = null; // allData may have been (re)loaded - rebuild lookup lazily
        updateBellBadge();

        if (!anyAlertEnabled(getAlertSettings())) {
            stopCycle(); // nothing to monitor
            refreshStatusLine();
            return;
        }
        ensureScheduler();
        if (cycleRunning) rebuildAllLists(); // data refreshed while running
        else schedulerTick(); // evaluate immediately instead of waiting up to 30s
    };

    // ==================================================================
    // Chart settings changed → rebuild only the indicator alert lists whose
    // inputs (enabled / length / atrLength / factor) actually changed.
    // Colours etc. are ignored.
    // ==================================================================
    const CHART_ALERT_DEPS = {
        awayFromHighAlerts: (cs) => (cs.afh || []).map((a) => [a.enabled, a.length]),
        pivotTrendLineAlerts: (cs) => (cs.pivottrendline || []).map((p) => [p.enabled, p.length]),
        superTrendAlerts: (cs) => (cs.supertrend || []).map((s) => [s.enabled, s.atrLength, s.factor]),
    };

    window.onChartSettingsSaved = function (oldSettings, newSettings) {
        // Not running (market closed / alerts off): startCycle() rebuilds from
        // the saved chart settings anyway, so nothing to do.
        if (!cycleRunning) return;
        const enabled = getAlertSettings();
        const changed = Object.keys(CHART_ALERT_DEPS).filter(
            (type) =>
                enabled[type] &&
                JSON.stringify(CHART_ALERT_DEPS[type](oldSettings || {})) !==
                    JSON.stringify(CHART_ALERT_DEPS[type](newSettings || {})),
        );
        if (!changed.length) return;
        // rebuildList replaces the whole list (latest build wins), so removed
        // or re-parameterised targets disappear automatically.
        Promise.all(changed.map(rebuildList)).then(() => runAlertCheck());
    };

    // Re-evaluate the instant the user flips a setting on/off, and grab
    // notification permission right away (this fires from a direct user click,
    // so the permission prompt is allowed).
    // NOTE: index.html's inline onchange="onAlertSettingChange()" always runs
    // BEFORE this listener, so the new settings are already saved here - no
    // artificial 1-second delay is needed.
    const SETTING_BY_CHECKBOX = {
        alertEnableCustom: "customAlerts",
        alertEnableAwayFromHigh: "awayFromHighAlerts",
        alertEnablePivotTrendLine: "pivotTrendLineAlerts",
        alertEnableSuperTrend: "superTrendAlerts",
    };
    document.addEventListener("DOMContentLoaded", function () {
        Object.keys(SETTING_BY_CHECKBOX).forEach((id) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener("change", function (event) {
                ensureNotificationPermission();
                const type = SETTING_BY_CHECKBOX[id];
                const settings = getAlertSettings();

                if (!anyAlertEnabled(settings)) {
                    stopCycle();
                    refreshStatusLine();
                    return;
                }
                ensureScheduler();

                if (cycleRunning && isMarketOpenIST()) {
                    if (event.target.checked) rebuildList(type).then(() => runAlertCheck());
                    else clearList(type);
                } else {
                    schedulerTick();
                }
                refreshStatusLine();
            });
        });

        requestAnimationFrame(() => {
            initPriceAlertSystem();
        });
    });
})();

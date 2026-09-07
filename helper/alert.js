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

    // ------------------------------------------------------------------
    // Runtime state
    // ------------------------------------------------------------------
    let worker = null;
    let cycleInterval = null; // the 5-min "run a check" interval, only active in market hours
    let schedulerInterval = null; // the 30s "should the cycle be running?" interval
    let cycleRunning = false;
    let checkInFlight = false;
    let notifPermissionAsked = false;

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
        const store = getTriggeredStore();
        results.forEach((r) => {
            store.items.push({
                id: "t" + Date.now() + Math.random().toString(36).slice(2, 7),
                alertId: r.alertId,
                code: r.code,
                name: r.name,
                condition: r.condition,
                target: r.value,
                ltp: r.ltp,
                prevClose: r.prevClose,
                pct:
                    r.prevClose > 0
                        ? ((r.ltp - r.prevClose) / r.prevClose) * 100
                        : null,
                triggeredAt: new Date().toISOString(),
            });

            // Auto-disable the custom alert that fired so it doesn't spam the
            // user again every 5 minutes for the rest of the day.
            const list = getCustomAlerts();
            const item = list.find((a) => a.id === r.alertId);
            if (item) {
                item.enabled = false;
                saveCustomAlerts(list);
            }
        });
        saveTriggeredStore(store);
        updateBellBadge();
        renderTriggeredAlertsList();
        renderCustomAlertsList();
        results.forEach(notifyUser);
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
            el.style.display = unseen > 0 ? "flex" : "none";
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
            const n = new Notification(`🔔 ${r.code} ${dir} ₹${r.value}`, {
                body: `LTP ₹${r.ltp}${pctTxt}`,
                tag: "nse-alert-" + r.alertId,
                icon: "icons/icon-192.png",
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
        document.getElementById("priceAlertModal").classList.add("open");
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
        const settings =
            typeof loadAlertSettings === "function"
                ? loadAlertSettings()
                : { customAlerts: false, awayFromHighAlerts: false };
        const anyEnabled = !!(settings.customAlerts || settings.awayFromHighAlerts);
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
            opt.label = r.Name || "";
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
                        : ` · <span class="${pctCls}">${t.pct >= 0 ? "+" : ""}${t.pct.toFixed(2)}%</span> vs prev close &#8377;${t.prevClose}`;
                return `<div class="pa-triggered-item">
                    <div class="pa-tt-head">
                        <span>${escapeHtml(t.code)} ${symbol} &#8377;${t.target}</span>
                        <span class="pa-tt-time">${istTimeLabel(new Date(t.triggeredAt))}</span>
                    </div>
                    <div class="pa-tt-meta">LTP &#8377;${t.ltp}${pctTxt}</div>
                </div>`;
            })
            .join("");
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
    // Worker lifecycle + the 5-minute check cycle
    // ==================================================================
    function ensureWorker() {
        if (worker || !("Worker" in window)) return worker;
        try {
            worker = new Worker("alert-worker.js");
            worker.onmessage = function (e) {
                const msg = e.data || {};
                if (msg.type === "TRIGGERED") {
                    recordTriggeredAlerts(msg.results);
                } else if (msg.type === "ERROR") {
                    console.warn("[alert-worker] ", msg.error);
                }
                checkInFlight = false;
            };
            worker.onerror = function (err) {
                console.warn("[alert.js] worker error", err.message || err);
                checkInFlight = false;
            };
        } catch (e) {
            console.warn("[alert.js] could not start alert-worker.js", e);
            worker = null;
        }
        return worker;
    }

    function runAlertCheck() {
        if (checkInFlight) return; // don't overlap a slow check with the next tick
        const enabledAlerts = getStoredAlerts(true);
        if (!enabledAlerts.length) return;
        if (typeof allData === "undefined" || !allData.length) return;

        const w = ensureWorker();
        if (!w) return;

        // Build a code -> previous day Close lookup from allData (this is the
        // "previous day close" the worker needs but can't reach on its own,
        // since a Web Worker has no access to the page's DOM/global scope).
        const codesNeeded = [...new Set(enabledAlerts.map((a) => a.code.toUpperCase()))];
        const stocks = codesNeeded
            .map((code) => {
                const row = allData.find(
                    (r) => (r.Code || "").toUpperCase() === code,
                );
                return row
                    ? {
                          code: row.Code,
                          name: row.Name,
                          prevClose: parseFloat(row.Close) || null,
                      }
                    : { code: code, name: code, prevClose: null };
            })
            .filter((s) => s.prevClose != null);

        if (!stocks.length) return;

        checkInFlight = true;
        w.postMessage({
            type: "CHECK_ALERTS",
            stocks: stocks,
            alerts: enabledAlerts,
        });
    }

    function startCycle() {
        if (cycleRunning) return;
        cycleRunning = true;
        ensureWorker();
        runAlertCheck(); // don't wait 5 min for the first check of the day
        cycleInterval = setInterval(runAlertCheck, CHECK_INTERVAL_MS);
        refreshStatusLine();
    }

    function stopCycle() {
        if (!cycleRunning) return;
        cycleRunning = false;
        if (cycleInterval) clearInterval(cycleInterval);
        cycleInterval = null;
        if (worker) {
            worker.terminate();
            worker = null;
        }
        refreshStatusLine();
    }

    // The scheduler is the thing that runs continuously (every 30s) once
    // alerts are enabled at all — it starts/stops the actual 5-min cycle as
    // the market opens/closes, so the worker never runs outside 9:15–15:30 IST.
    function schedulerTick() {
        const settings =
            typeof loadAlertSettings === "function"
                ? loadAlertSettings()
                : { customAlerts: false, awayFromHighAlerts: false };
        const anyEnabled = !!(settings.customAlerts || settings.awayFromHighAlerts);

        if (anyEnabled && isMarketOpenIST()) {
            startCycle();
        } else {
            stopCycle();
        }
    }

    // ==================================================================
    // Public entry point — called by the main script after allData loads
    // ==================================================================
    window.initPriceAlertSystem = function () {
        updateBellBadge();

        const settings =
            typeof loadAlertSettings === "function"
                ? loadAlertSettings()
                : { customAlerts: false, awayFromHighAlerts: false };
        const anyEnabled = !!(settings.customAlerts || settings.awayFromHighAlerts);

        if (!anyEnabled) {
            refreshStatusLine();
            return; // nothing to monitor — don't even start the scheduler/worker
        }

        if (!schedulerInterval) {
            schedulerInterval = setInterval(schedulerTick, SCHEDULER_TICK_MS);
        }
        schedulerTick(); // evaluate immediately instead of waiting up to 30s
    };

    // Re-evaluate the scheduler the instant the user flips a setting on/off,
    // and grab notification permission right away (this fires from a direct
    // user click, so the permission prompt is allowed).
    document.addEventListener("DOMContentLoaded", function () {
        ["alertEnableCustom", "alertEnableAwayFromHigh"].forEach((id) => {
            const el = document.getElementById(id);
            if (el)
                el.addEventListener("change", function () {
                    ensureNotificationPermission();
                    if (typeof initPriceAlertSystem === "function")
                        initPriceAlertSystem();
                    else schedulerTick();
                });
        });
    });
})();

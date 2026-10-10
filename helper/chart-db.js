/* ============================================================================
   chart-db.js — IndexedDB store for the price history ("chart data") of every
   stock, ONE record per ISIN.
   ----------------------------------------------------------------------------
   Works on the main thread AND inside workers (importScripts("chart-db.js")).

   Database  ScreenerChartData
     store "candles"  keyPath "isin"  ->  { isin, rows: [[time,open,high,low,close,volume], ...] }
     store "meta"     key "state"     ->  { key, schema, lastDate, count, syncedAt }

   Rows are kept EXACTLY as the server ships them (value-only arrays, no keys)
   because that is the smallest thing to download, store and clone. Anything
   that needs the old object shape ({time, open, high, low, close, v}) -
   indicator calculators, Lightweight Charts - gets it from getCandles() /
   rowsToCandles(), which maps the arrays back once, in memory.

   Only chart-sync-worker.js writes here (putChunk / applyDaily / prune).
   Everyone else only reads (getRows / getCandles / getManyRows).
   ========================================================================= */
const ChartDataDB = (() => {
  const DB_NAME = "ScreenerChartData";
  const DB_VERSION = 1;
  const S_CANDLES = "candles";
  const S_META = "meta";
  const META_KEY = "state";
  const SCHEMA = 1; // bump to force every client to re-download everything

  /* ---------------- one shared connection ---------------- */
  let dbPromise = null;
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (ev) => {
        const db = ev.target.result;
        if (!db.objectStoreNames.contains(S_CANDLES)) db.createObjectStore(S_CANDLES, { keyPath: "isin" });
        if (!db.objectStoreNames.contains(S_META)) db.createObjectStore(S_META, { keyPath: "key" });
      };
      req.onsuccess = (ev) => {
        const db = ev.target.result;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        db.onclose = () => { dbPromise = null; };
        resolve(db);
      };
      req.onerror = (ev) => { dbPromise = null; reject(ev.target.error); };
      req.onblocked = () => console.warn("ChartDataDB: upgrade blocked by another open tab");
    });
    return dbPromise;
  }

  const reqP = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  const txDone = (tx) => new Promise((res, rej) => {
    tx.oncomplete = () => res(true);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error || new Error("transaction aborted"));
  });
  const rwTx = (db, stores) => db.transaction(stores, "readwrite", { durability: "relaxed" }); // it is only a cache: re-downloadable

  const isRow = (r) => Array.isArray(r) && r.length >= 6 && typeof r[0] === "string";
  const lastDateOf = (rows) => (rows && rows.length ? rows[rows.length - 1][0] : "");

  /* ---------------- decode: value arrays -> candle objects ---------------- */
  /** [[t,o,h,l,c,v], ...] -> [{time,open,high,low,close,v}, ...]  (the shape every calculator expects) */
  function rowsToCandles(rows) {
    const n = rows.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const r = rows[i];
      out[i] = { time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], v: r[5] };
    }
    return out;
  }

  /* ---------------- reads ---------------- */
  /** Raw value-array rows for one ISIN, or null when we have none. */
  async function getRows(isin) {
    const db = await openDB();
    const rec = await reqP(db.transaction(S_CANDLES, "readonly").objectStore(S_CANDLES).get(isin));
    return rec && rec.rows && rec.rows.length ? rec.rows : null;
  }

  /** Candle objects for one ISIN, or null when we have none. */
  async function getCandles(isin) {
    const rows = await getRows(isin);
    return rows ? rowsToCandles(rows) : null;
  }

  /** Many ISINs in ONE read transaction. Returns an array parallel to `isins` (null = missing). */
  async function getManyRows(isins) {
    const db = await openDB();
    const store = db.transaction(S_CANDLES, "readonly").objectStore(S_CANDLES);
    return Promise.all(isins.map((isin) => reqP(store.get(isin)).then((rec) => (rec && rec.rows && rec.rows.length ? rec.rows : null))));
  }

  async function getMeta() {
    const db = await openDB();
    return (await reqP(db.transaction(S_META, "readonly").objectStore(S_META).get(META_KEY))) || null;
  }

  async function count() {
    const db = await openDB();
    return reqP(db.transaction(S_CANDLES, "readonly").objectStore(S_CANDLES).count());
  }

  /* ---------------- writes (used by chart-sync-worker.js) ---------------- */
  /**
   * Store one downloaded chunk ({ isin: rows }) - one transaction, one put per ISIN.
   * @param {Object} chunk
   * @param {Set<string>=} only  when given, only these ISINs are written
   * @returns {Promise<string>} the newest bar date seen in the chunk
   */
  async function putChunk(chunk, only) {
    const db = await openDB();
    const tx = rwTx(db, S_CANDLES);
    const store = tx.objectStore(S_CANDLES);
    let newest = "";
    for (const isin of Object.keys(chunk)) {
      if (only && !only.has(isin)) continue;
      const rows = chunk[isin];
      if (!Array.isArray(rows) || !rows.length) continue;
      store.put({ isin, rows });
      const d = lastDateOf(rows);
      if (d > newest) newest = d;
    }
    await txDone(tx);
    return newest;
  }

  /**
   * Append one trading day ({ isin: [time,o,h,l,c,v] }) to every stock, atomically
   * (together with the meta.lastDate bump). Safe to run twice for the same date.
   *   newer than the stored last bar -> appended
   *   same date as the last bar      -> replaced (corrected data)
   *   older than the last bar        -> inserted at its sorted position / replaced
   *   ISIN not stored yet            -> a new record is created and its ISIN is reported in `unknown`
   */
  async function applyDaily(date, day) {
    const db = await openDB();
    const tx = rwTx(db, [S_CANDLES, S_META]);
    const cs = tx.objectStore(S_CANDLES);
    const ms = tx.objectStore(S_META);
    const st = { appended: 0, replaced: 0, inserted: 0, skipped: 0, unknown: [] };

    for (const isin of Object.keys(day)) {
      const row = day[isin];
      if (!isRow(row)) { st.skipped++; continue; }
      const g = cs.get(isin);
      g.onsuccess = () => {
        const rec = g.result;
        if (!rec || !rec.rows) { st.unknown.push(isin); cs.put({ isin, rows: [row] }); return; }
        const rows = rec.rows;
        const last = lastDateOf(rows);
        if (!last || last < row[0]) { rows.push(row); st.appended++; }
        else if (last === row[0]) { rows[rows.length - 1] = row; st.replaced++; }
        else {
          let i = rows.length - 1;                       // rare: an older day arrives late
          while (i >= 0 && rows[i][0] > row[0]) i--;
          if (i >= 0 && rows[i][0] === row[0]) { rows[i] = row; st.replaced++; }
          else { rows.splice(i + 1, 0, row); st.inserted++; }
        }
        cs.put(rec);
      };
    }

    const mg = ms.get(META_KEY);
    mg.onsuccess = () => {
      const m = mg.result || { key: META_KEY, schema: SCHEMA, lastDate: "" };
      if (!m.lastDate || date > m.lastDate) m.lastDate = date;
      m.syncedAt = Date.now();
      ms.put(m);
    };
    await txDone(tx);
    return st;
  }

  async function setMeta(patch) {
    const db = await openDB();
    const tx = rwTx(db, S_META);
    const ms = tx.objectStore(S_META);
    const g = ms.get(META_KEY);
    g.onsuccess = () => ms.put({ ...(g.result || {}), key: META_KEY, schema: SCHEMA, ...patch, syncedAt: Date.now() });
    await txDone(tx);
  }

  /** Delete every stored ISIN that is NOT in `keep` (delisted stocks after a full download). */
  async function pruneNotIn(keep) {
    const db = await openDB();
    const tx = rwTx(db, S_CANDLES);
    const store = tx.objectStore(S_CANDLES);
    let removed = 0;
    const req = store.openKeyCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      if (!keep.has(c.key)) { store.delete(c.key); removed++; }
      c.continue();
    };
    await txDone(tx);
    return removed;
  }

  async function clearAll() {
    const db = await openDB();
    const tx = rwTx(db, [S_CANDLES, S_META]);
    tx.objectStore(S_CANDLES).clear();
    tx.objectStore(S_META).clear();
    await txDone(tx);
  }

  return { SCHEMA, rowsToCandles, getRows, getCandles, getManyRows, getMeta, count, putChunk, applyDaily, setMeta, pruneNotIn, clearAll };
})();

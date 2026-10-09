// indicator-db.js
// IndexedDB wrapper for caching per-indicator chart data.
//
// Design:
//  - ONE connection, opened once and reused (auto-resets if the browser closes it).
//  - WRITES are write-behind: setMany()/set() queue records in memory and the
//    caller does not have to wait. A single drain loop commits the queue, one
//    readwrite transaction at a time, merging everything queued meanwhile into
//    the next transaction (adaptive batching: busy writer => bigger batches).
//    The returned promise still resolves when that data is committed, so
//    `await IndicatorCacheDB.flush()` (or awaiting setMany) means "on disk".
//  - READS issued in the same tick share ONE readonly transaction.
//  - Reads see queued-but-uncommitted records (read-your-writes).
//  - Deletes/clears flush the queue first so ordering is preserved.
// NOTE: IndexedDB transactions auto-commit when idle and cannot be held open
// for reuse, so "one transaction" here means: as few as possible, never more
// than one write transaction in flight.

const IndicatorCacheDB = (() => {
  const DB_NAME = 'ScreenerIndicatorCache';
  const DB_VERSION = 1;
  const STORE_NAME = 'indicators';
  const MAX_RECORDS_PER_TX = 1000;

  /* ---------------- single shared connection ---------------- */
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('isin', 'isin', { unique: false });
          store.createIndex('dataDate', 'dataDate', { unique: false });
        }
      };

      req.onsuccess = (event) => {
        const db = event.target.result;
        // Let another tab upgrade the DB, and reopen lazily if the browser drops us.
        db.onversionchange = () => { db.close(); dbPromise = null; };
        db.onclose = () => { dbPromise = null; };
        resolve(db);
      };
      req.onerror = (event) => { dbPromise = null; reject(event.target.error); };
      req.onblocked = () => console.warn('IndicatorCacheDB: upgrade blocked by another open tab');
    });

    return dbPromise;
  }

  function makeId(isin, indicatorKey) {
    return `${isin}::${indicatorKey}`;
  }

  function rwTx(db) {
    // "relaxed" durability = don't wait for the OS to flush to disk. This is
    // only a cache (a lost write is just recomputed).
    const t = db.transaction(STORE_NAME, 'readwrite', { durability: 'relaxed' });
    return { t, store: t.objectStore(STORE_NAME) };
  }

  function roTx(db) {
    const t = db.transaction(STORE_NAME, 'readonly');
    return { t, store: t.objectStore(STORE_NAME) };
  }

  const isFresh = (rec, currentDataDate) =>
    !!rec && (currentDataDate === undefined || currentDataDate === null || rec.dataDate === currentDataDate);

  /* ---------------- write-behind queue ---------------- */
  let queue = [];                 // [{ recs, resolve, reject }]
  const pendingById = new Map();  // id -> newest queued (uncommitted) record
  let drainPromise = null;

  function commit(db, groups) {
    return new Promise((resolve, reject) => {
      let t;
      try {
        const tx2 = rwTx(db);
        t = tx2.t;
        t.oncomplete = () => resolve(true);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
        for (const g of groups) for (const rec of g.recs) tx2.store.put(rec);
      } catch (err) {
        try { t && t.abort(); } catch { /* already finished */ }
        reject(err);
      }
    });
  }

  async function drainLoop() {
    while (queue.length) {
      // Merge as many queued groups as fit into ONE transaction.
      const groups = [];
      let n = 0;
      while (queue.length && (n === 0 || n + queue[0].recs.length <= MAX_RECORDS_PER_TX)) {
        const g = queue.shift();
        groups.push(g);
        n += g.recs.length;
      }
      try {
        const db = await openDB();
        await commit(db, groups);
        groups.forEach((g) => g.resolve(true));
      } catch (err) {
        groups.forEach((g) => g.reject(err));
      } finally {
        for (const g of groups) {
          for (const rec of g.recs) {
            if (pendingById.get(rec.id) === rec) pendingById.delete(rec.id);
          }
        }
      }
    }
  }

  function startDrain() {
    if (drainPromise) return;
    drainPromise = drainLoop().finally(() => { drainPromise = null; });
  }

  /** Resolves when everything queued so far has been committed. Never rejects. */
  async function flush() {
    while (drainPromise) await drainPromise;
  }

  /* ---------------- coalesced reads ---------------- */
  let readQ = [];
  let readScheduled = false;

  function readRec(id) {
    return new Promise((resolve, reject) => {
      readQ.push({ id, resolve, reject });
      if (!readScheduled) {
        readScheduled = true;
        queueMicrotask(runReads);
      }
    });
  }

  async function runReads() {
    readScheduled = false;
    const batch = readQ;
    readQ = [];
    try {
      const db = await openDB();
      const { store } = roTx(db);          // ONE transaction for the whole tick
      for (const r of batch) {
        const q = store.get(r.id);
        q.onsuccess = () => r.resolve(q.result || null);
        q.onerror = () => r.reject(q.error);
      }
    } catch (err) {
      batch.forEach((r) => r.reject(err));
    }
  }

  /* ---------------- public API ---------------- */

  /**
   * Store many records. Queued immediately; the returned promise resolves once
   * they are committed (you do NOT have to await it - attach .catch if you don't).
   * @param {string|number} dataDate
   * @param {{isin:string, key:string, payload:*}[]} entries
   */
  function setMany(dataDate, entries) {
    if (!entries || !entries.length) return Promise.resolve(true);
    const now = Date.now();
    const recs = entries.map((e) => ({
      id: makeId(e.isin, e.key),
      isin: e.isin,
      indicatorKey: e.key,
      dataDate,
      payload: e.payload,
      updatedAt: now,
    }));
    return new Promise((resolve, reject) => {
      for (const rec of recs) pendingById.set(rec.id, rec);
      queue.push({ recs, resolve, reject });
      startDrain();
    });
  }

  /**
   * FIRE-AND-FORGET write: queues the records and returns immediately (undefined).
   * Never throws, never leaves an unhandled rejection. Commit failures are kept
   * in lastWriteError / writeErrorCount (inspect or clear with takeWriteErrors()).
   * Use this anywhere you don't need to know the write finished.
   */
  let lastWriteError = null;
  let writeErrorCount = 0;
  function writeBehind(dataDate, entries) {
    setMany(dataDate, entries).catch((err) => {
      lastWriteError = err;
      writeErrorCount++;
    });
  }

  /** Returns { count, last } of fire-and-forget write failures since last call, then resets. */
  function takeWriteErrors() {
    const out = { count: writeErrorCount, last: lastWriteError && (lastWriteError.message || String(lastWriteError)) };
    writeErrorCount = 0;
    lastWriteError = null;
    return out;
  }

  /**
   * PACKED tail records: ONE record per stock holding every indicator tail of a
   * run (instead of ~15 tiny records), so IndexedDB does ~15x fewer puts/index
   * updates. The id carries a signature of the key set so "is this stock done?"
   * stays a keys-only lookup. Worker (writer) and page (reader) both call this,
   * so the two always agree.
   */
  function packSig(keys) {
    const s = [...keys].sort().join('|');
    let h1 = 0x811c9dc5, h2 = 5381;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 16777619);
      h2 = Math.imul(h2, 33) ^ c;
    }
    return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36) + '.' + keys.length;
  }
  function packKey(tailBars, keys) {
    return `tail${tailBars}::pack::${packSig(keys)}`;
  }

  /** Store one indicator payload (same queue/batching as setMany). */
  function set(isin, indicatorKey, dataDate, payload) {
    return setMany(dataDate, [{ isin, key: indicatorKey, payload }]);
  }

  /**
   * Get indicator data. Returns null if missing OR if dataDate doesn't match
   * currentDataDate (pass null/undefined to skip the date check).
   */
  async function get(isin, indicatorKey, currentDataDate) {
    const id = makeId(isin, indicatorKey);
    const rec = pendingById.get(id) || await readRec(id);
    return isFresh(rec, currentDataDate) ? rec.payload : null;
  }

  /**
   * Read several keys of ONE isin (all share the same read transaction).
   * Returns Map<indicatorKey, payload>; stale / missing keys are absent.
   */
  async function getMany(isin, indicatorKeys, currentDataDate) {
    const out = new Map();
    await Promise.all(indicatorKeys.map(async (key) => {
      const id = makeId(isin, key);
      const rec = pendingById.get(id) || await readRec(id);
      if (isFresh(rec, currentDataDate)) out.set(key, rec.payload);
    }));
    return out;
  }

  /** ids ("isin::indicatorKey") of every record stored for `dataDate`. Keys only. */
  async function getIdsForDate(dataDate) {
    const db = await openDB();
    const { store } = roTx(db);
    const ids = await new Promise((resolve, reject) => {
      const req = store.index('dataDate').getAllKeys(IDBKeyRange.only(dataDate));
      req.onsuccess = () => resolve(new Set(req.result));
      req.onerror = () => reject(req.error);
    });
    for (const [id, rec] of pendingById) if (rec.dataDate === dataDate) ids.add(id);
    return ids;
  }

  /* Destructive ops: flush queued writes first so ordering is preserved. */
  async function runWrite(fn) {
    await flush();
    const db = await openDB();
    const { t, store } = rwTx(db);
    return new Promise((resolve, reject) => {
      fn(store);
      t.oncomplete = () => resolve(true);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  /** Delete one specific indicator entry. */
  function remove(isin, indicatorKey) {
    return runWrite((store) => store.delete(makeId(isin, indicatorKey)));
  }

  /** Delete ALL cached indicator entries for one ISIN. */
  function removeByIsin(isin) {
    return runWrite((store) => {
      const req = store.index('isin').openCursor(IDBKeyRange.only(isin));
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) { cursor.delete(); cursor.continue(); }
      };
    });
  }

  /** Wipe the entire cache - use when the main data date changes. */
  function clearAll() {
    return runWrite((store) => store.clear());
  }

  /** Delete only entries whose dataDate != currentDataDate (cursor scan). */
  function clearStale(currentDataDate) {
    return runWrite((store) => {
      const req = store.openCursor();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          if (cursor.value.dataDate !== currentDataDate) cursor.delete();
          cursor.continue();
        }
      };
    });
  }

  /** Peek at any one record's dataDate to judge whether the cache is fresh. */
  async function getAnyStoredDate() {
    const db = await openDB();
    const { store } = roTx(db);
    return new Promise((resolve, reject) => {
      const req = store.openCursor();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        resolve(cursor ? cursor.value.dataDate : null);
      };
      req.onerror = () => reject(req.error);
    });
  }

  /** Rough count of committed entries - debugging/telemetry. */
  async function count() {
    const db = await openDB();
    const { store } = roTx(db);
    return new Promise((resolve, reject) => {
      const req = store.count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  return { set, get, getMany, setMany, writeBehind, takeWriteErrors, packSig, packKey, getIdsForDate, remove, removeByIsin, clearAll, clearStale, getAnyStoredDate, count, flush };
})();

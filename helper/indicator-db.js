// indicatorCacheDB.js
// Solid IndexedDB wrapper for caching per-indicator chart data.

const IndicatorCacheDB = (() => {
  const DB_NAME = 'ScreenerIndicatorCache';
  const DB_VERSION = 1;
  const STORE_NAME = 'indicators';

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

      req.onsuccess = (event) => resolve(event.target.result);
      req.onerror = (event) => reject(event.target.error);
      req.onblocked = () => console.warn('IndicatorCacheDB: upgrade blocked by another open tab');
    });

    return dbPromise;
  }

  function makeId(isin, indicatorKey) {
    return `${isin}::${indicatorKey}`;
  }

  function tx(db, mode) {
    const t = db.transaction(STORE_NAME, mode);
    return { t, store: t.objectStore(STORE_NAME) };
  }

  /**
   * Store indicator data for a given isin + indicator key.
   * @param {string} isin
   * @param {string} indicatorKey  e.g. "afh_20", "ema_50_close", "macd_12_26_9"
   * @param {string|number} dataDate  your main data's date stamp, e.g. "2026-09-05"
   * @param {*} payload  the calculated indicator data (array/object)
   */
  async function set(isin, indicatorKey, dataDate, payload) {
    const db = await openDB();
    const { t, store } = tx(db, 'readwrite');
    return new Promise((resolve, reject) => {
      store.put({
        id: makeId(isin, indicatorKey),
        isin,
        indicatorKey,
        dataDate,
        payload,
        updatedAt: Date.now(),
      });
      t.oncomplete = () => resolve(true);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  /**
   * Get indicator data. Returns null if missing OR if dataDate doesn't match
   * currentDataDate (so caller knows to recalculate).
   * @param {string} isin
   * @param {string} indicatorKey
   * @param {string|number} currentDataDate  pass null/undefined to skip date check
   */
  async function get(isin, indicatorKey, currentDataDate) {
    const db = await openDB();
    const { store } = tx(db, 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.get(makeId(isin, indicatorKey));
      req.onsuccess = () => {
        const rec = req.result;
        if (!rec) return resolve(null);
        if (currentDataDate !== undefined && currentDataDate !== null
            && rec.dataDate !== currentDataDate) {
          return resolve(null); // stale
        }
        resolve(rec.payload);
      };
      req.onerror = () => reject(req.error);
    });
  }

  /** Delete one specific indicator entry. */
  async function remove(isin, indicatorKey) {
    const db = await openDB();
    const { t, store } = tx(db, 'readwrite');
    return new Promise((resolve, reject) => {
      store.delete(makeId(isin, indicatorKey));
      t.oncomplete = () => resolve(true);
      t.onerror = () => reject(t.error);
    });
  }

  /** Delete ALL cached indicator entries for one ISIN (e.g. isin removed from list). */
  async function removeByIsin(isin) {
    const db = await openDB();
    const { t, store } = tx(db, 'readwrite');
    return new Promise((resolve, reject) => {
      const idx = store.index('isin');
      const req = idx.openCursor(IDBKeyRange.only(isin));
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
      t.oncomplete = () => resolve(true);
      t.onerror = () => reject(t.error);
    });
  }

  /** Wipe the entire cache — fast, use this daily when main data date changes. */
  async function clearAll() {
    const db = await openDB();
    const { t, store } = tx(db, 'readwrite');
    return new Promise((resolve, reject) => {
      store.clear();
      t.oncomplete = () => resolve(true);
      t.onerror = () => reject(t.error);
    });
  }

  /**
   * Delete only entries whose dataDate != currentDataDate.
   * Use instead of clearAll() if you want to keep same-day entries
   * and only purge stale ones (slower — cursor scan).
   */
  async function clearStale(currentDataDate) {
    const db = await openDB();
    const { t, store } = tx(db, 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.openCursor();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          if (cursor.value.dataDate !== currentDataDate) {
            cursor.delete();
          }
          cursor.continue();
        }
      };
      t.oncomplete = () => resolve(true);
      t.onerror = () => reject(t.error);
    });
  }

  /** Check whether cache as a whole is "fresh" by peeking at any one record's date. */
  async function getAnyStoredDate() {
    const db = await openDB();
    const { store } = tx(db, 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.openCursor();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        resolve(cursor ? cursor.value.dataDate : null);
      };
      req.onerror = () => reject(req.error);
    });
  }

  /** Rough count of stored entries — useful for debugging/telemetry. */
  async function count() {
    const db = await openDB();
    const { store } = tx(db, 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  return { set, get, remove, removeByIsin, clearAll, clearStale, getAnyStoredDate, count };
})();

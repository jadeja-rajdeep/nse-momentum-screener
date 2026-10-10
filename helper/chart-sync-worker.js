/* ============================================================================
   chart-sync-worker.js — keeps ChartDataDB up to date. Runs off the main thread.
   ----------------------------------------------------------------------------
   In:   { type:"SYNC", requestId, dataDate:"YYYY-MM-DD", dataBase:"<abs url of data/>" }
   Out:  { type:"PROGRESS", requestId, phase:"full"|"daily"|"repair", done, total }
         { type:"DONE",     requestId, stats }
         { type:"ERROR",    requestId, error, stats }   (progress made so far IS kept)

   Layout it expects on the server:
     data/chart/chunks/index.json        { isin: "chunk_001.json", ... }
     data/chart/chunks/chunk_001.json    { isin: [[time,o,h,l,c,v], ...], ... }   (~100 stocks each)
     data/daily/YYYY-MM-DD.json          { isin: [time,o,h,l,c,v], ... }

   Plan on every page load:
     1. Nothing stored (or schema changed, or gap > MAX_DAILY_GAP_DAYS)
          -> read index.json, download every distinct chunk, store per ISIN.
     2. Then, for every calendar day AFTER the newest stored bar up to the m.json
        data date, try data/daily/<day>.json. 404 = no session that day (weekend /
        holiday) and is skipped; a file that exists is appended to every ISIN.
        Weekends are tried on purpose: special sessions happen.
     3. ISINs that appear in a daily file but were never stored (new listings) get
        their history repaired from the chunk that holds them.
   ========================================================================= */
"use strict";
importScripts("./chart-db.js"); // defines ChartDataDB

const MAX_DAILY_GAP_DAYS = 90; // older than this: re-download the chunks instead of ~65 daily files
const CHUNK_CONCURRENCY = 4;
const DAILY_CONCURRENCY = 6;

/* ---------------- small helpers ---------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const toUtc = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const fmt = (ms) => new Date(ms).toISOString().slice(0, 10);
const DAY = 86400000;
const istToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

function datesAfter(lastIso, endIso) {
  const out = [];
  for (let t = toUtc(lastIso) + DAY, end = toUtc(endIso); t <= end; t += DAY) out.push(fmt(t));
  return out;
}

// revalidate (ETag / 304) instead of trusting a possibly 10-minute-old HTTP cache
async function fetchJson(url, allow404) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { cache: "no-cache" });
      if (res.status === 404 && allow404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (err) {
      if (attempt >= 1) throw err;
      await sleep(400);
    }
  }
}

function pool(limit) {
  let active = 0;
  const waiting = [];
  const pump = () => {
    while (active < limit && waiting.length) {
      const { fn, resolve, reject } = waiting.shift();
      active++;
      fn().then(resolve, reject).finally(() => { active--; pump(); });
    }
  };
  return (fn) => new Promise((resolve, reject) => { waiting.push({ fn, resolve, reject }); pump(); });
}

/* ---------------- phases ---------------- */
async function downloadChunks(chunksBase, files, post, phase, only) {
  const queue = [...files];
  const seen = new Set();
  let done = 0, newest = "", abort = false;
  const lane = async () => {
    while (queue.length && !abort) {
      const f = queue.shift();
      try {
        const chunk = await fetchJson(chunksBase + f);
        for (const k of Object.keys(chunk)) seen.add(k);
        const d = await ChartDataDB.putChunk(chunk, only);
        if (d > newest) newest = d;
        post({ type: "PROGRESS", phase, done: ++done, total: files.length });
      } catch (err) { abort = true; throw err; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHUNK_CONCURRENCY, files.length) }, lane));
  return { seen, newest };
}

async function fullDownload(base, post, stats) {
  const chunksBase = base + "chart/chunks/";
  const index = await fetchJson(chunksBase + "index.json"); // tells us how many chunk files exist
  const files = [...new Set(Object.values(index))].sort();
  const { seen, newest } = await downloadChunks(chunksBase, files, post, "full");
  const removed = await ChartDataDB.pruneNotIn(new Set([...seen, ...Object.keys(index)]));
  await ChartDataDB.setMeta({ lastDate: newest, count: seen.size }); // written LAST: a half-finished download re-runs next load
  stats.chunks = files.length;
  stats.stocks = seen.size;
  stats.pruned = removed;
}

async function dailyUpdate(base, dataDate, post, stats) {
  const meta = await ChartDataDB.getMeta();
  const dates = datesAfter(meta.lastDate, dataDate);
  stats.dailyChecked = dates.length;
  stats.dailyApplied = [];
  if (!dates.length) return;

  const limited = pool(DAILY_CONCURRENCY);
  const jobs = dates.map((d) => limited(() => fetchJson(`${base}daily/${d}.json`, true)));
  jobs.forEach((p) => p.catch(() => {})); // errors are handled in order below

  const applied = []; // [{date, day}] kept for the repair step
  const unknown = new Set();
  let failure = null;
  for (let i = 0; i < dates.length; i++) {
    let day;
    try { day = await jobs[i]; } catch (err) { failure = err; break; } // stop at the first real failure: never leave a hole
    post({ type: "PROGRESS", phase: "daily", done: i + 1, total: dates.length });
    if (!day) continue; // no file = no session
    const r = await ChartDataDB.applyDaily(dates[i], day);
    r.unknown.forEach((k) => unknown.add(k));
    applied.push({ date: dates[i], day });
    stats.dailyApplied.push(dates[i]);
  }

  if (unknown.size) await repairNewListings(base, unknown, applied, post, stats);
  if (failure) throw failure;
}

// A stock first seen in a daily file only has that one bar. Pull its history from the chunk that holds it.
async function repairNewListings(base, unknown, applied, post, stats) {
  try {
    const chunksBase = base + "chart/chunks/";
    const index = await fetchJson(chunksBase + "index.json");
    const files = [...new Set([...unknown].map((k) => index[k]).filter(Boolean))].sort();
    stats.newListings = unknown.size;
    if (!files.length) return;
    await downloadChunks(chunksBase, files, post, "repair", unknown);
    // The chunk may be older than the daily files already applied: top those days back up.
    for (const { date, day } of applied) {
      const partial = {};
      for (const k of unknown) if (day[k]) partial[k] = day[k];
      if (Object.keys(partial).length) await ChartDataDB.applyDaily(date, partial);
    }
  } catch (err) {
    stats.repairError = (err && err.message) || String(err); // non-fatal: they just have a short history
  }
}

async function sync(m, post) {
  const base = m.dataBase;
  const dataDate = ISO.test(m.dataDate || "") ? m.dataDate : istToday();
  const stats = { mode: "daily", dataDate };

  const meta = await ChartDataDB.getMeta();
  const have = meta && meta.schema === ChartDataDB.SCHEMA && ISO.test(meta.lastDate || "") && (await ChartDataDB.count()) > 0;
  const gap = have ? Math.round((toUtc(dataDate) - toUtc(meta.lastDate)) / DAY) : Infinity;

  if (!have || gap > MAX_DAILY_GAP_DAYS) {
    stats.mode = "full";
    await fullDownload(base, post, stats);
  }
  await dailyUpdate(base, dataDate, post, stats);

  const end = await ChartDataDB.getMeta();
  stats.lastDate = end && end.lastDate;
  return stats;
}

// One sync at a time across ALL open tabs (the second tab simply finds everything up to date).
function withLock(fn) {
  if (self.navigator && navigator.locks) return navigator.locks.request("nse-chart-sync", fn);
  return fn();
}

self.onmessage = async (e) => {
  const m = e.data || {};
  if (m.type !== "SYNC") return;
  const post = (p) => self.postMessage({ requestId: m.requestId, ...p });
  const stats = {};
  try {
    const out = await withLock(() => sync(m, post));
    post({ type: "DONE", stats: out });
  } catch (err) {
    post({ type: "ERROR", error: (err && err.message) || String(err), stats });
  }
};

// NSE Momentum Screener — Service Worker
// Bump CACHE_VERSION whenever you update index.html or any static asset.
//
// m.json strategy: this SW always fetches m.json fresh from network and
// updates DATA_CACHE on every successful response (cache is a fallback for
// offline use). The PAGE (index.html) has a separate, faster optimization:
// before even calling fetch(), it checks if today's date matches the last
// successfully-loaded date (stored in localStorage) and, if so, reads
// m.json directly out of this same DATA_CACHE — skipping the network
// request entirely and saving the ~4MB download on repeat same-day visits.
// Keep DATA_CACHE's name in sync with DATA_CACHE_NAME in index.html.
const CACHE_VERSION = "nse-screener-v60";
const DATA_CACHE = "nse-screener-data-v1";

// Fonts (and the CSS that declares them) rarely change and are identical
// across app versions, so they get their own cache that is NEVER deleted
// during activate's version-bump cleanup — a deploy shouldn't force
// re-downloading Bootstrap/Google Fonts from the CDN again.
const FONT_CACHE = "nse-screener-fonts-v1";
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com", "cdn.jsdelivr.net"];

const STATIC_ASSETS = [
    "./",
    "./index.html",
    "./assets/img/og-image.png",
    "./assets/img/favicon.svg",
    "./assets/img/favicon-32.png",
    "./assets/img/favicon.png"
];

// The Bootstrap CSS + Google Fonts CSS URLs, precached into FONT_CACHE at
// install time. The actual .woff2 files referenced by that CSS have
// versioned/hashed filenames that can change without notice, so we don't
// hardcode them here — they're picked up and cached automatically the
// first time the browser requests them (see the fetch handler below),
// and then persist in FONT_CACHE across future deploys.
const FONT_ASSETS = [
    "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css",
    "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Sora:wght@400;600;700&display=swap",
    "https://unpkg.com/lightweight-charts/dist/lightweight-charts.standalone.production.js"
];

// ── Message: allow page to trigger SW update ─────────────────────────────────
self.addEventListener("message", (event) => {
    if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

// ── Install: pre-cache all static assets ────────────────────────────────────
self.addEventListener("install", (event) => {
    event.waitUntil(
        Promise.all([
            caches.open(CACHE_VERSION).then((cache) => {
                // Cache what we can; don't fail install if an asset misses
                return Promise.allSettled(
                    STATIC_ASSETS.map((url) =>
                        cache
                            .add(url)
                            .catch(() =>
                                console.warn("[SW] Could not cache:", url),
                            ),
                    ),
                );
            }),
            caches.open(FONT_CACHE).then((cache) => {
                return Promise.allSettled(
                    FONT_ASSETS.map((url) =>
                        cache
                            .add(url)
                            .catch(() =>
                                console.warn("[SW] Could not cache font asset:", url),
                            ),
                    ),
                );
            }),
        ]).then(() => self.skipWaiting()),
    );
});

// ── Activate: delete old cache versions ─────────────────────────────────────
self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((keys) =>
                Promise.all(
                    keys
                        .filter(
                            (k) =>
                                k !== CACHE_VERSION &&
                                k !== DATA_CACHE &&
                                k !== FONT_CACHE,
                        )
                        .map((k) => {
                            console.log("[SW] Deleting old cache:", k);
                            return caches.delete(k);
                        }),
                ),
            )
            .then(() => self.clients.claim()),
    );
});

// ── Fetch: route requests by strategy ───────────────────────────────────────
self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);

    // Ignore unsupported schemes
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        return;
    }

    // m.json → Network-first, fall back to stale cache
    if (url.pathname.endsWith("m.json")) {
        event.respondWith(networkFirstData(event.request));
        return;
    }

    // Bootstrap CSS, Google Fonts CSS, and the .woff2 files it references
    // → Cache-first into FONT_CACHE, which survives app version bumps.
    if (FONT_HOSTS.includes(url.hostname)) {
        event.respondWith(cacheFirst(event.request, FONT_CACHE));
        return;
    }

    // Everything else → Cache-first, fall back to network
    event.respondWith(cacheFirst(event.request, CACHE_VERSION));
});

// Network-first: try fresh, update cache, fall back to stale on error
async function networkFirstData(request) {
    const cache = await caches.open(DATA_CACHE);
    try {
        const response = await fetch(request, { cache: "no-store" });
        if (response.ok) {
            cache.put(request, response.clone());
        }
        return response;
    } catch {
        const cached = await cache.match(request);
        if (cached) {
            console.log("[SW] Offline – serving stale m.json from cache");
            return cached;
        }
        return new Response(
            JSON.stringify([
                {
                    type: "error",
                    message: "Offline and no cached data available.",
                },
            ]),
            { headers: { "Content-Type": "application/json" } },
        );
    }
}

// Cache-first: serve from cache instantly, fall back to network + cache
async function cacheFirst(request, cacheName = CACHE_VERSION) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request);

    if (cached) return cached;

    try {
        const response = await fetch(request);

        // Only cache valid http/https responses. Cross-origin requests made
        // by the browser itself (e.g. the <link> tags for the font CSS and
        // the .woff2 files that CSS references) are fetched in "no-cors"
        // mode and come back as opaque responses — status 0, response.ok
        // is always false for these even on success — so we explicitly
        // allow type "opaque" through as well, or fonts would never
        // actually get cached here.
        const cacheable =
            response.ok || response.type === "opaque";
        if (cacheable && request.url.startsWith("http")) {
            await cache.put(request, response.clone());
        }

        return response;
    } catch {
        return new Response("Offline", {
            status: 503,
            statusText: "Service Unavailable",
        });
    }
}

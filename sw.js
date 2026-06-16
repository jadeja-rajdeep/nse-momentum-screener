// NSE Momentum Screener — Service Worker
// Bump CACHE_VERSION whenever you update index.html or any static asset.
// m.json is always fetched fresh from network; cache is only a fallback.
const CACHE_VERSION = "nse-screener-v4";
const DATA_CACHE = "nse-screener-data-v1";

const STATIC_ASSETS = [
    "./",
    "./index.html",
    "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css",
    "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Sora:wght@300;400;600;700&display=swap",
];

// ── Message: allow page to trigger SW update ─────────────────────────────────
self.addEventListener("message", (event) => {
    if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

// ── Install: pre-cache all static assets ────────────────────────────────────
self.addEventListener("install", (event) => {
    event.waitUntil(
        caches
            .open(CACHE_VERSION)
            .then((cache) => {
                // Cache what we can; don't fail install if a CDN asset misses
                return Promise.allSettled(
                    STATIC_ASSETS.map((url) =>
                        cache
                            .add(url)
                            .catch(() =>
                                console.warn("[SW] Could not cache:", url),
                            ),
                    ),
                );
            })
            .then(() => self.skipWaiting()),
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
                        .filter((k) => k !== CACHE_VERSION && k !== DATA_CACHE)
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

    // Everything else → Cache-first, fall back to network
    event.respondWith(cacheFirst(event.request));
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
async function cacheFirst(request) {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(request);

    if (cached) return cached;

    try {
        const response = await fetch(request);

        // Only cache valid http/https responses
        if (response.ok && request.url.startsWith("http")) {
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

/* Cache only immutable, public OCR vendor files. Never cache user content. */
const CACHE_NAME = 'kuwei-label-public-ocr-v1';
const BASE = new URL('./', self.registration.scope);
const ASSETS = new Set([
  'vendor/tesseract/tesseract.min.js',
  'vendor/tesseract/worker.min.js',
  'vendor/tesseract/core/tesseract-core-lstm.wasm.js',
  'vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js',
  'vendor/tesseract/core/tesseract-core-relaxedsimd-lstm.wasm.js',
  'vendor/tesseract/lang/eng.traineddata.gz',
  'vendor/tesseract/lang/chi_sim.traineddata.gz',
  'vendor/tesseract/lang/eng_codes.traineddata.gz',
].map(path => new URL(path, BASE).href));

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

async function publicAsset(request) {
  let cache;
  try {
    cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(request);
    if (hit?.type === 'basic' && hit.status === 200) return { response: hit };
  } catch {
    // Blocked storage, eviction and quota errors must not prevent online OCR.
    cache = null;
  }
  const response = await fetch(request);
  let store;
  if (cache && response.type === 'basic' && response.status === 200
      && !/text\/html/i.test(response.headers.get('content-type') || '')) {
    try { store = cache.put(request, response.clone()).catch(() => {}); }
    catch { /* The original network response remains available. */ }
  }
  return { response, store };
}

self.addEventListener('fetch', event => {
  const request = event.request;
  // Exact URLs deliberately exclude query variants, Range responses and all
  // other site assets, even those under the vendor directory.
  if (request.method !== 'GET' || request.headers.has('range') || !ASSETS.has(request.url)) return;
  const handled = publicAsset(request);
  event.respondWith(handled.then(result => result.response));
  event.waitUntil(handled.then(result => result.store).catch(() => {}));
});

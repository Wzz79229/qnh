/* Cache only the published application shell. Business data and credentials never enter this cache. */
const CACHE_PREFIX = 'xianqi-shell-';
const CACHE_NAME = `${CACHE_PREFIX}v15-qnh-auto-login`;
const SHELL = [
  './', './index.html', './styles.css', './app.mjs', './core.mjs', './github.mjs',
  './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png',
  './icons/icon-512.png', './icons/maskable-512.png',
  './cloud.mjs', './connection.json', './photo-flow.mjs', './photo-parser.mjs', './photo-sync.mjs', './ocr.mjs', './catalog.mjs', './sku-flow.mjs', './sku-query.mjs', './qnh-login-viewer.mjs',
];
// OCR models are cached only after first use, rather than forcing a large initial install.
const OCR = ['./vendor/tesseract/recognize.worker.js','./vendor/tesseract/tesseract.min.js','./vendor/tesseract/worker.min.js',
  ...['lstm','simd-lstm','relaxedsimd-lstm'].map(kind=>`./vendor/tesseract/core/tesseract-core-${kind}.wasm.js`),
  './vendor/tesseract/lang/chi_sim.traineddata.gz','./vendor/tesseract/lang/eng.traineddata.gz', './vendor/zxing/index.min.js'];
const shellURLs = new Set([...SHELL,...OCR].map((entry) => new URL(entry, self.registration.scope).href));
const indexURL = new URL('./index.html', self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key))
  )).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // Only exact, same-origin static URLs belong to the cache. In particular,
  // Catalog/photo API data, external product images, Authorization headers and queries bypass it.
  if (request.method !== 'GET' || url.origin !== self.location.origin ||
      request.headers.has('Authorization') || url.search || !shellURLs.has(url.href)) return;

  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    } catch (error) {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      if (cached) return cached;
      if (request.mode === 'navigate') {
        const fallback = await cache.match(indexURL);
        if (fallback) return fallback;
      }
      throw error;
    }
  })());
});

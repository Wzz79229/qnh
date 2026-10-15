/** Best-effort persistent cache for public OCR files, with bounded setup. */
const BASE = new URL('./', import.meta.url);
const SCRIPT = new URL('ocr-assets-sw.js?v=20261015-7', BASE);
const READY_TIMEOUT_MS = 2500;
let setup = null;

/**
 * Register without prefetching any model. Resolves true when this document is
 * controlled, false when unavailable or not ready within 2.5 seconds. Storage
 * failures remain transparent network fallbacks inside the service worker.
 */
export function ensureAssetCache() {
  if (setup) return setup;
  if (typeof navigator === 'undefined' || !globalThis.isSecureContext
      || !('serviceWorker' in navigator) || !('caches' in globalThis)) return Promise.resolve(false);
  setup = new Promise(resolve => {
    let finished = false;
    let timer;
    const controlled = () => navigator.serviceWorker.controller?.scriptURL === SCRIPT.href;
    const finish = value => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener('controllerchange', changed);
      resolve(value);
    };
    const changed = () => { if (controlled()) finish(true); };
    navigator.serviceWorker.addEventListener('controllerchange', changed);
    timer = setTimeout(() => finish(controlled()), READY_TIMEOUT_MS);
    try {
      void navigator.serviceWorker.register(SCRIPT.href, {
        scope: BASE.href,
        updateViaCache: 'none',
      }).then(changed, () => finish(controlled()));
      changed();
    } catch { finish(controlled()); }
  }).then(ready => {
    if (!ready) setup = null; // A later fallback attempt may retry setup.
    return ready;
  });
  return setup;
}

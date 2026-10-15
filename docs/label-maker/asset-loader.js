/** Parallel preparation of public OCR assets. No files or product data enter here. */
import { ensureAssetCache } from './asset-cache.js?v=20261015-6';

const ROOT = new URL('./vendor/tesseract/', import.meta.url);
const prepared = new Map();
const CORE_LENGTHS = {
  'tesseract-core-lstm.wasm.js': 3896484,
  'tesseract-core-simd-lstm.wasm.js': 3899472,
  'tesseract-core-relaxedsimd-lstm.wasm.js': 3905767,
};

// These probes are the same probes used by our bundled Tesseract worker.
function selectedCore() {
  const valid = bytes => {
    try { return WebAssembly.validate(new Uint8Array(bytes)); } catch { return false; }
  };
  const relaxed = valid([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,15,1,13,0,65,1,253,15,65,2,253,15,253,128,2,11]);
  const simd = relaxed || valid([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11]);
  return relaxed ? 'tesseract-core-relaxedsimd-lstm.wasm.js'
    : simd ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js';
}

/**
 * Fetch the selected engine and required language data together, through our
 * service worker. Waiting for its control avoids duplicate downloads in a
 * browser that cannot share a pending document fetch with importScripts().
 * Byte counts are decoded response bytes, not compressed network traffic.
 */
export async function prepareOcrAssets({ mode = 'location', onProgress } = {}) {
  const core = selectedCore();
  const coreUrl = new URL('core/' + core, ROOT).href;
  if (!await ensureAssetCache()) return { coreUrl, prefetched: false };
  const language = mode === 'full' ? 'full' : 'location';
  const key = core + ':' + language;
  let entry = prepared.get(key);
  if (!entry) {
    const assets = [
      ['tesseract.min.js', 62961],
      ['worker.min.js', 111307],
      ['core/' + core, CORE_LENGTHS[core]],
      ...(language === 'full' ? [['lang/chi_sim.traineddata.gz', 1726902], ['lang/eng.traineddata.gz', 1967017]]
        : [['lang/eng_codes.traineddata.gz', 367277]]),
    ];
    entry = { listeners: new Set(), loaded: new Array(assets.length).fill(0), complete: 0, latest: null, promise: null };
    prepared.set(key, entry);
    const publish = () => {
      const bytesReceived = entry.loaded.reduce((sum, value) => sum + value, 0);
      const bytesExpected = assets.reduce((sum, asset) => sum + asset[1], 0);
      entry.latest = { status: `正在加载本地识别资源（已就绪 ${entry.complete}/${assets.length}）`,
        progress: Math.min(1, bytesReceived / bytesExpected), bytesReceived, bytesExpected };
      for (const listener of entry.listeners) { try { listener(entry.latest); } catch { /* Rendering cannot stop loading. */ } }
    };
    entry.promise = Promise.all(assets.map(async ([path, expected], index) => {
      const response = await fetch(new URL(path, ROOT), { credentials: 'same-origin' });
      if (!response.ok || /text\/html/i.test(response.headers.get('content-type') || '')) throw new Error('Public OCR asset unavailable');
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            entry.loaded[index] = Math.min(expected, entry.loaded[index] + chunk.value.byteLength);
            publish();
          }
        } finally { reader.releaseLock(); }
      } else await response.arrayBuffer();
      entry.loaded[index] = expected;
      entry.complete++;
      publish();
    })).then(() => ({ coreUrl, prefetched: true }), () => {
      // The worker's normal loader remains the fallback if a prefetch fails.
      if (prepared.get(key) === entry) prepared.delete(key);
      return { coreUrl, prefetched: false };
    });
    publish();
  }
  if (typeof onProgress === 'function') {
    entry.listeners.add(onProgress);
    if (entry.latest) { try { onProgress(entry.latest); } catch {} }
  }
  try { return await entry.promise; }
  finally { if (typeof onProgress === 'function') entry.listeners.delete(onProgress); }
}

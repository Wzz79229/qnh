/** Browser-only OCR. Images stay in memory; only bundled OCR assets are loaded. */
import { parseScreenshotText } from './label.js?v=20261015-8';
import { ensureAssetCache } from './asset-cache.js?v=20261015-7';
import { prepareOcrAssets } from './asset-loader.js?v=20261015-7';
import { recognizeLocationFast } from './lightweight-location-ocr.js?v=20261015-5';
import { prepareMetadataSheet, validateMetadataCardsResult, validateSpatialSkuResult, validateKnownSkuText } from './metadata-ocr.js?v=20261015-9';
export { validateKnownSkuText } from './metadata-ocr.js?v=20261015-9';

const ASSET_ROOT = new URL('./vendor/tesseract/', import.meta.url);
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const MAX_EDGE = 2400;
const LOCATION_MAX_WIDTH = 960;
const LOCATION_IMAGE_MAX_WIDTH = 1600;
const LOCATION_IMAGE_MAX_EDGE = 4000;
const WORKER_IDLE_MS = 120_000;
const ACCEPTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
let runtimePromise;
let activeJob = null;
let resident = null;
let idleTimer;
let templateAttempted = false;

function abortError() {
  return new DOMException('识别已取消。', 'AbortError');
}

function loadRuntime() {
  if (globalThis.Tesseract?.createWorker) return Promise.resolve(globalThis.Tesseract);
  if (!runtimePromise) {
    runtimePromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = new URL('tesseract.min.js', ASSET_ROOT).href;
      script.async = true;
      const timer = setTimeout(() => {
        script.remove();
        reject(new Error('识别组件加载超时，请检查网络后重试。'));
      }, 45_000);
      script.onload = () => {
        clearTimeout(timer);
        if (globalThis.Tesseract?.createWorker) resolve(globalThis.Tesseract);
        else reject(new Error('识别组件未能启动，请刷新页面重试。'));
      };
      script.onerror = () => {
        clearTimeout(timer);
        script.remove();
        reject(new Error('识别组件加载失败，请检查网络后重试。'));
      };
      document.head.appendChild(script);
    }).catch(error => {
      runtimePromise = undefined;
      throw error;
    });
  }
  return runtimePromise;
}

function validateFile(file) {
  if (!(file instanceof Blob) || !file.size) throw new Error('请选择一张清晰的商品截图。');
  if (file.size > MAX_FILE_BYTES) throw new Error('图片超过 15 MB，请裁剪或缩小后再试。');
  const type = file.type.toLowerCase();
  if (!ACCEPTED_TYPES.has(type)
      && !(type === '' && /\.(png|jpe?g|webp)$/i.test(file.name || ''))) {
    throw new Error('请使用 PNG、JPG 或 WebP 截图；暂不支持 HEIC、PDF 和动图。');
  }
}

function decodeImage(file, signal) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    const dispose = () => {
      image.onload = null;
      image.onerror = null;
      signal?.removeEventListener('abort', cancel);
      URL.revokeObjectURL(url);
    };
    const cancel = () => {
      dispose();
      image.src = '';
      reject(abortError());
    };
    image.onload = () => { dispose(); resolve(image); };
    image.onerror = () => {
      dispose();
      reject(new Error('无法读取这张图片，请重新截图后再试。'));
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    else image.src = url;
  });
}

async function prepareImage(file, signal, wait, mode, wholeImage = false) {
  const image = await wait(decodeImage(file, signal));
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (width < 64 || height < 64) throw new Error('图片过小，请使用原始清晰截图。');
  if (width * height > MAX_PIXELS || width > 20_000 || height > 20_000) {
    throw new Error('图片尺寸过大，请裁剪到商品信息区域后再试。');
  }
  // QNH places the location near the top of a stock screenshot. The fast pass
  // leaves the original file intact so a failed/ambiguous pass can fall back.
  const sourceHeight = mode === 'location' && !wholeImage && height > width * 1.25
    ? Math.min(height, Math.max(width * 0.65, height * 0.34)) : height;
  const scale = mode === 'location'
    ? wholeImage
      ? Math.min(1, LOCATION_IMAGE_MAX_WIDTH / width, LOCATION_IMAGE_MAX_EDGE / Math.max(width, height))
      : Math.min(1, LOCATION_MAX_WIDTH / width)
    : Math.min(1, MAX_EDGE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(sourceHeight * scale);
  if (scale < 1 && canvas.width < 400) {
    throw new Error('长截图缩小后文字太小，请裁剪到商品名称、库位和编码所在区域。');
  }
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('当前浏览器无法处理图片，请使用 Safari 或 Chrome 打开。');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, width, sourceHeight, 0, 0, canvas.width, canvas.height);
  const blob = await wait(new Promise((resolve, reject) => {
    canvas.toBlob(result => result ? resolve(result)
      : reject(new Error('图片处理失败，请裁剪截图后再试。')), 'image/png');
  }));
  canvas.width = 1;
  canvas.height = 1;
  return blob;
}

/**
 * Conservative QNH card-header fast pass for a known numeric target SKU.
 * Returns null for unfamiliar layouts. This is a card crop, never full-image
 * evidence: the caller must match the visible SKU and fall back on ambiguity.
 * Keep native text size; reducing width can turn a valid 9 into OCR noise.
 */
async function prepareCompactCards(file, signal, wait) {
  const image = await wait(decodeImage(file, signal));
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (width < 400 || width > LOCATION_IMAGE_MAX_WIDTH || height > LOCATION_IMAGE_MAX_EDGE
      || height < width * 1.25) return null;
  const source = document.createElement('canvas');
  source.width = width;
  source.height = height;
  const context = source.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!context) return null;
  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0);

  // Only inspect the narrow badge column. Its pale-blue rectangular background
  // remains recognizable even where dark blue Chinese letters cross a row.
  const scanX = Math.round(width * 0.04);
  const scanWidth = Math.round(width * 0.12) - scanX;
  const pixels = context.getImageData(scanX, 0, scanWidth, height).data;
  const groups = [];
  for (let y = 0; y < height; y++) {
    let blue = 0;
    for (let x = 0; x < scanWidth; x++) {
      const index = (y * scanWidth + x) * 4;
      const red = pixels[index], green = pixels[index + 1], value = pixels[index + 2];
      if (red > 170 && green > 200 && value > 215 && value - red > 12 && green - red > 5) blue++;
    }
    if (blue <= width * 0.02) continue;
    const previous = groups[groups.length - 1];
    if (!previous || y > previous.end + 8) groups.push({ start: y, end: y });
    else previous.end = y;
  }
  const badges = groups.filter(group => group.end - group.start > width * 0.015
    && group.end - group.start < width * 0.08);
  // A regular portrait stock-list layout has one badge per separated card.
  // Tightly packed/overlapping detections are not reliable enough to crop.
  if (!badges.length || badges.length > 12 || badges.some((badge, index) => index
      && badge.start - badges[index - 1].start < width * 0.38)) {
    source.width = source.height = 1;
    return null;
  }
  const regions = badges.map(badge => {
    const y = Math.max(0, badge.start - Math.round(width * 0.01));
    return { y, height: Math.min(Math.round(width * 0.33), height - y) };
  });
  // A cut-off footer with too little space for its SKU is sent to the original
  // image path rather than used as incomplete card evidence.
  if (regions.some(region => region.height < width * 0.26)) {
    source.width = source.height = 1;
    return null;
  }
  const compactHeight = regions.reduce((sum, region) => sum + region.height + 32, 0);
  if (compactHeight >= height * 0.78) {
    source.width = source.height = 1;
    return null;
  }
  const compact = document.createElement('canvas');
  compact.width = width;
  compact.height = compactHeight;
  const output = compact.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!output) { source.width = source.height = 1; return null; }
  output.fillStyle = '#fff';
  output.fillRect(0, 0, compact.width, compact.height);
  let top = 16;
  for (const region of regions) {
    output.drawImage(source, 0, region.y, width, region.height, 0, top, width, region.height);
    // The badge and product photo create English OCR noise. Their rectangles
    // stop before the location and before the SKU/name/metadata text column.
    output.fillRect(0, top, Math.round(width * 0.12), Math.round(width * 0.055));
    output.fillRect(0, top + Math.round(width * 0.045), Math.round(width * 0.205),
      region.height - Math.round(width * 0.045));
    top += region.height + 32;
  }
  source.width = source.height = 1;
  const monochrome = output.getImageData(0, 0, compact.width, compact.height);
  for (let index = 0; index < monochrome.data.length; index += 4) {
    const shade = (monochrome.data[index] + monochrome.data[index + 1] + monochrome.data[index + 2]) / 3 < 185 ? 0 : 255;
    monochrome.data[index] = monochrome.data[index + 1] = monochrome.data[index + 2] = shade;
  }
  output.putImageData(monochrome, 0, 0);
  const blob = await wait(new Promise(resolve => compact.toBlob(resolve, 'image/png')));
  compact.width = compact.height = 1;
  return blob;
}

function disposeResident(entry = resident) {
  if (!entry) return Promise.resolve();
  entry.disposed = true;
  if (resident === entry) {
    clearTimeout(idleTimer);
    resident = null;
  }
  if (entry.worker && !entry.termination) entry.termination = entry.worker.terminate().catch(() => {});
  return entry.termination || Promise.resolve();
}

function compatibleWorker(entry, language) {
  return entry && !entry.disposed && (entry.language === language || entry.language === 'full');
}

function idleRelease(entry) {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!activeJob && resident === entry) void disposeResident(entry);
  }, WORKER_IDLE_MS);
}

function createResident(language, runtime) {
  const entry = { worker: null, promise: null, language, disposed: false, termination: null, recognizing: false, assetProgress: null };
  resident = entry;
  // Publish the promise before loading the runtime. Foreground OCR can attach
  // to an initializer already started while the image picker was open.
  entry.promise = ensureAssetCache().then(() => Promise.all([
    runtime ? Promise.resolve(runtime) : loadRuntime(),
    prepareOcrAssets({ mode: language, onProgress: message => {
      entry.assetProgress = message;
      const current = activeJob;
      if (current?.entry === entry && !current.stopped) current.report(message.status, 0.12 + message.progress * 0.30);
    } }),
  ])).then(([Tesseract, assets]) => Tesseract.createWorker(language === 'location' ? ['eng_codes'] : ['chi_sim', 'eng'], 1, {
    workerPath: new URL('worker.min.js', ASSET_ROOT).href,
    corePath: assets.coreUrl,
    langPath: new URL('lang/', ASSET_ROOT).href.replace(/\/$/, ''),
    workerBlobURL: false,
    legacyCore: false,
    legacyLang: false,
    gzip: true,
    // Only public language models are cached. No images or recognized text.
    cachePath: 'kuwei-tessdata-fast-v1',
    cacheMethod: 'write',
    logger: message => {
      const current = activeJob;
      if (!current || current.entry !== entry || current.stopped) return;
      const part = Math.min(1, Math.max(0, message.progress || 0));
      if (message.status === 'recognizing text') {
        const range = current.recognitionRange || [0.48, 0.98];
        current.report(current.mode === 'location' ? '正在快速识别库位' : '正在识别截图中的中文和编码', range[0] + part * (range[1] - range[0]));
      } else if (message.status === 'loading language traineddata') {
        current.report(language === 'location' ? '正在加载库位识别数据，首次使用需要稍等' : '正在加载中文和英文识别数据，首次使用需要稍等', 0.24 + part * 0.18);
      } else if (message.status === 'initializing api') {
        current.report('正在初始化本地识别', 0.42 + part * 0.05);
      } else {
        current.report('正在加载本地识别组件', 0.12 + part * 0.1);
      }
    },
    errorHandler: () => {
      if (activeJob?.entry === entry) activeJob.stop(new Error('本地识别组件运行失败，请刷新页面或更换清晰截图重试。'));
      else void disposeResident(entry);
    },
  })).then(worker => {
    entry.worker = worker;
    const recognize = worker.recognize.bind(worker);
    worker.recognize = (...args) => {
      entry.recognizing = true;
      let result;
      try { result = recognize(...args); }
      catch (error) { entry.recognizing = false; throw error; }
      return Promise.resolve(result).finally(() => { entry.recognizing = false; });
    };
    if (entry.disposed || resident !== entry) {
      void disposeResident(entry);
      throw abortError();
    }
    return worker;
  }).catch(error => {
    if (resident === entry) resident = null;
    throw error;
  });
  // Initializers survive an input-edit cancellation; explicit release and
  // failed initialization still dispose them before they can replace a job.
  entry.promise.catch(() => {});
  return entry;
}

async function acquireWorker(Tesseract, language, job, wait, report) {
  clearTimeout(idleTimer);
  // A bilingual worker also reads locations, so do not reload it just to use
  // the faster crop. Reuse pending initialization as well as ready workers.
  let entry = resident;
  if (!compatibleWorker(entry, language)) {
    await wait(disposeResident(entry));
    entry = createResident(language, Tesseract);
  }
  job.entry = entry;
  if (entry.worker) report('识别组件已就绪，正在读取截图', 0.47);
  else if (entry.assetProgress) report(entry.assetProgress.status, 0.12 + entry.assetProgress.progress * 0.30);
  job.worker = await wait(entry.promise);
  return job.worker;
}

/** Start public OCR asset loading on page open or an image action, without reading a file.
 * Returns false on failure; foreground recognition can retry normally.
 */
export function warmupRecognition({ mode = 'location' } = {}) {
  if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') return Promise.resolve(false);
  const language = mode === 'full' ? 'full' : 'location';
  let entry = resident;
  if (activeJob && !compatibleWorker(entry, language)) return Promise.resolve(false);
  clearTimeout(idleTimer);
  if (!compatibleWorker(entry, language)) {
    void disposeResident(entry);
    entry = createResident(language);
  }
  // Bound idle initializers too. A very slow initializer may finish after
  // release, in which case its worker is immediately terminated above.
  if (!activeJob) idleRelease(entry);
  return entry.promise.then(() => {
    if (resident !== entry || entry.disposed) return false;
    if (!activeJob) idleRelease(entry);
    return true;
  }, () => false);
}

/** Release warm/idle memory; an active recognition is cancelled safely. */
export function releaseRecognition() {
  clearTimeout(idleTimer);
  if (activeJob) activeJob.stop(abortError());
  return disposeResident();
}

/** Prepare public resources on page open. Full dictionaries load in the
 * background without replacing the already usable coding worker. */
export async function preloadRecognitionResources({ onProgress } = {}) {
  const notify = value => { try { onProgress?.(value); } catch {} };
  notify({stage:'codes',progress:0,status:'正在提前准备图片识别资源…'});
  const assets = prepareOcrAssets({mode:'location',onProgress:message=>notify({
    stage:'codes',progress:message.progress*.6,status:'正在提前准备库位和编码识别…',
  })});
  const ready = await warmupRecognition({mode:'location'});
  await assets;
  if (!ready) return {codesReady:false,fullReady:false};
  notify({stage:'codes-ready',progress:.6,status:'库位和编码识别已准备，中文字库在后台加载…'});
  const full = await prepareOcrAssets({mode:'full',onProgress:message=>notify({
    stage:'dictionaries',progress:.6+message.progress*.4,status:'常用识别已准备，中文字库在后台加载…',
  })});
  if (!full.prefetched) return {codesReady:true,fullReady:false};
  notify({stage:'ready',progress:1,status:'图片识别资源和中文字库已准备'});
  return {codesReady:true,fullReady:true};
}

function locationCandidates(text) {
  // Do not guess O/0 or I/1, splice partial values, or accept arbitrary English
  // OCR noise as a location. Unusual layouts/codes go through the full pass.
  const candidates = [];
  for (const line of String(text || '').replace(/[‐‑‒–—−﹣－]/g, '-').split(/\r?\n/)) {
    // Chinese labels may appear as English OCR noise on the same line. Include
    // their independent codes too, or a conflicting card could be overlooked
    // while the cleaner search-box line was accepted on its own.
    const pattern = /(?:^|[^A-Za-z0-9-])([A-Za-z]{1,4}[ \t]*\d{1,4}(?:[ \t]*-[ \t]*[A-Za-z0-9]{1,4}){2,4})(?=$|[^A-Za-z0-9-])/g;
    for (const match of line.matchAll(pattern)) candidates.push(match[1].replace(/[ \t]/g, '').toUpperCase());
  }
  return candidates;
}

function fastLocation(text) {
  const candidates = locationCandidates(text);
  const unique = [...new Set(candidates)];
  // Normal inventory screenshots repeat the location in the search box and
  // product card. Require agreement before skipping the full Chinese pass.
  return unique.length === 1 && candidates.length >= 2 ? unique[0] : '';
}

/**
 * @param {File|Blob} file PNG/JPEG/WebP, at most 15 MB.
 * @param {{onProgress?: (value: {status: string, progress: number}) => void,
 * signal?: AbortSignal, mode?: 'full'|'location',
 * product?: {sku?: string, name?: string, spec?: string}, targetSku?: string}} [options]
 * @returns {Promise<{text: string, mode: 'full'|'location', scope?: 'image'|'cards'|'target', language?: 'full'|'location'|'templates'}>}
 * Full OCR text or a normalized, repeated location field; identifiers are never
 * substituted. `scope: 'image'` means all visible cards were read, so the text
 * may be reused when matching a different product in the same screenshot.
 * `scope: 'cards'` contains detected card headers, not the complete image;
 * reuse it only after matching the new product's identity again.
 * `scope: 'target'` must only be reused for the original target SKU.
 */
export async function recognizeScreenshot(file, { onProgress, signal, mode = 'full', product, targetSku } = {}) {
  if (signal?.aborted) throw abortError();
  validateFile(file);
  if (activeJob) throw new Error('已有图片正在识别，请先取消或等待完成。');
  // A pasted product identifies which card matters. A crop near the top cannot
  // establish that association: its location might belong to a different SKU.
  // Read the complete screenshot and match the target SKU before accepting a
  // location. An English pass can establish this without loading Chinese
  // models; names alone still require the complete bilingual pass.
  const hasTarget = [targetSku, product?.sku, product?.name]
    .some(value => typeof value === 'string' && value.trim().length > 0);
  const matchingProduct = { ...product, sku: typeof targetSku === 'string' && targetSku.trim() ? targetSku.trim() : product?.sku };
  const targetedFastPass = mode === 'location' && typeof matchingProduct.sku === 'string' && /^\d{10,64}$/.test(matchingProduct.sku);
  const job = { worker: null, entry: null, stopped: false, completed: false, mode: mode === 'location' && (!hasTarget || targetedFastPass) ? 'location' : 'full', stage: '准备图片' };
  activeJob = job;
  clearTimeout(idleTimer);
  let rejectStopped;
  let progress = 0;
  const stopped = new Promise((resolve, reject) => { rejectStopped = reject; });
  stopped.catch(() => {});
  const report = (status, value) => {
    if (job.stopped) return;
    progress = Math.max(progress, Math.min(1, Number(value) || 0));
    try { onProgress?.({ status, progress }); } catch { /* UI callbacks cannot break OCR. */ }
  };
  const stop = error => {
    if (job.stopped) return;
    job.stopped = true;
    job.cancelled = error?.name === 'AbortError';
    rejectStopped(error);
    // Editing the product while assets are loading must not discard that
    // shared initializer. A running OCR operation still requires termination.
    if (job.entry && (!job.cancelled || job.entry.recognizing)) void disposeResident(job.entry);
  };
  const cancel = () => stop(abortError());
  const wait = promise => Promise.race([promise, stopped]);
  job.report = report;
  job.stop = stop;
  signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(() => stop(new Error('本地识别耗时过长，请裁剪截图后重试。')), 180_000);
  try {
    report('正在准备截图', 0.02);
    if (targetedFastPass && !resident?.worker && !templateAttempted) {
      templateAttempted = true;
      // Preparation is shared with subsequent products, including locations
      // that cannot use the optional lightweight first-picture shortcut.
      void warmupRecognition({ mode: 'location' });
      report('正在快速核对截图中的库位和 SKU', 0.04);
      let fast = null;
      try { fast = await wait(recognizeLocationFast(file, { sku: matchingProduct.sku, signal })); }
      catch (error) { if (error?.name === 'AbortError' || job.stopped) throw error; }
      if (job.stopped || signal?.aborted) throw abortError();
      if (fast) {
        const matched = parseScreenshotText(fast.text, { product: matchingProduct });
        if (!matched.matchError && matched.matchedBy === 'sku' && matched.loc === fast.loc) {
          job.completed = true;
          report('库位与 SKU 匹配完成，请核对', 1);
          // The lightweight result is valid for this target only. Other card
          // locations have not passed its target-specific ambiguity checks.
          return { text: fast.text, mode: 'full', scope: 'target', language: 'templates' };
        }
      }
    }
    if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') {
      throw new Error('当前浏览器不支持本地识别，请使用新版 Safari 或 Chrome。');
    }
    if (targetedFastPass) {
      let metadata = null;
      try { metadata = await wait(prepareMetadataSheet(file, { signal })); }
      catch (error) { if (error?.name === 'AbortError' || job.stopped) throw error; }
      let image = metadata?.blob || await prepareImage(file, signal, wait, 'location', true);
      job.stage = '加载组件';
      report('正在准备图片识别，组件会在换商品后继续复用', 0.08);
      const Tesseract = await wait(loadRuntime());
      await acquireWorker(Tesseract, 'location', job, wait, report);
      job.stage = '识别文字';
      await wait(job.worker.setParameters({
        tessedit_pageseg_mode: metadata ? (Tesseract.PSM.SINGLE_BLOCK ?? 6) : Tesseract.PSM.SPARSE_TEXT,
        tessedit_char_whitelist: '', preserve_interword_spaces: '1', user_defined_dpi: '150',
      }));
      job.recognitionRange = [0.48, 0.76];
      let result = await wait(job.worker.recognize(image, {}, { text: true, blocks: true }));
      let matched = metadata
        ? validateMetadataCardsResult(result.data, matchingProduct.sku, metadata, parseScreenshotText)
        : validateSpatialSkuResult(result.data, matchingProduct.sku, parseScreenshotText);
      if (!matched && metadata) {
        // A second pass retains native glyph size for low-resolution images.
        // It uses this same small coding model and never loads Chinese data.
        report('正在用原始文字尺寸核对库位和编码', 0.76);
        let native = null;
        try { native = await wait(prepareMetadataSheet(file, { signal, normalizeHeight: 0 })); }
        catch (error) { if (error?.name === 'AbortError' || job.stopped) throw error; }
        image = native?.blob || await prepareImage(file, signal, wait, 'location', true);
        await wait(job.worker.setParameters({tessedit_pageseg_mode: native ? (Tesseract.PSM.SINGLE_BLOCK ?? 6) : Tesseract.PSM.SPARSE_TEXT}));
        job.recognitionRange = [0.76, 0.98];
        result = await wait(job.worker.recognize(image, {}, { text: true, blocks: true }));
        matched = native
          ? validateMetadataCardsResult(result.data, matchingProduct.sku, native, parseScreenshotText)
          : validateSpatialSkuResult(result.data, matchingProduct.sku, parseScreenshotText);
      }
      if (!matched && metadata) {
        // Optional geometry is only a shortcut. Unknown layouts continue with
        // the complete image and spatial SKU/location evidence automatically.
        report('正在识别完整图片，按 SKU 查找对应库位', 0.78);
        image = await prepareImage(file, signal, wait, 'location', true);
        await wait(job.worker.setParameters({tessedit_pageseg_mode:Tesseract.PSM.SPARSE_TEXT}));
        job.recognitionRange = [0.78, 0.84];
        result = await wait(job.worker.recognize(image, {}, {text:true,blocks:true}));
        matched = validateSpatialSkuResult(result.data, matchingProduct.sku, parseScreenshotText);
      }
      if (!matched) {
        // Native pixels and automatic page segmentation are a second general
        // read; this does not assume a badge, sidebar, aspect ratio or card size.
        report('正在用原图重新核对编码与库位位置', 0.84);
        await wait(job.worker.setParameters({tessedit_pageseg_mode:Tesseract.PSM.AUTO ?? 3}));
        job.recognitionRange = [0.84, 0.90];
        result = await wait(job.worker.recognize(file, {}, {text:true,blocks:true}));
        matched = validateSpatialSkuResult(result.data, matchingProduct.sku, parseScreenshotText);
      }
      if (!matched) {
        // Difficult text is retried with the existing bilingual engine. Public
        // assets may already be downloaded by the background preloader.
        job.mode = 'full';job.stage = '加载组件';
        report('正在切换完整文字识别，继续核对商品与库位', 0.90);
        await acquireWorker(Tesseract, 'full', job, wait, report);
        job.stage = '识别文字';
        for (const psm of [Tesseract.PSM.SPARSE_TEXT, Tesseract.PSM.AUTO ?? 3]) {
          await wait(job.worker.setParameters({tessedit_pageseg_mode:psm,tessedit_char_whitelist:'',preserve_interword_spaces:'1',user_defined_dpi:'150'}));
          job.recognitionRange = [0.90, 0.98];
          result = await wait(job.worker.recognize(file, {}, {text:true,blocks:true}));
          matched = validateSpatialSkuResult(result.data, matchingProduct.sku, parseScreenshotText);
          if (matched) break;
        }
      }
      if (job.stopped || signal?.aborted) throw abortError();
      if (!matched) {
        // Unreadable identity is an input failure, not an engine failure.
        // Keep the initialized worker for a replacement screenshot or SKU.
        job.keepWorker = true;
        throw new Error('无法唯一对应这段文字的 SKU 和库位。请使用包含商品库位及 SKU 的清晰截图；不会选取其他商品。');
      }
      job.completed = true;
      report('库位与 SKU 匹配完成，请核对', 1);
      return { text: matched.ocrText, mode: 'full', scope: 'target', language: job.entry.language };
    }
    let image = await prepareImage(file, signal, wait, job.mode);
    job.stage = '加载组件';
    report('正在加载本地识别组件，首次使用需要稍等', 0.08);
    await wait(ensureAssetCache());
    const Tesseract = await wait(loadRuntime());
    await acquireWorker(Tesseract, job.mode, job, wait, report);
    job.stage = '识别文字';
    await wait(job.worker.setParameters({
      tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT,
      preserve_interword_spaces: '1',
      user_defined_dpi: '150',
    }));
    job.recognitionRange = [0.48, 0.90];
    let result = await wait(job.worker.recognize(image, {}, { text: true }));
    if (job.stopped || signal?.aborted) throw abortError();
    if (job.mode === 'location') {
      const location = fastLocation(result.data?.text);
      if (location) {
        job.completed = true;
        report('库位识别完成，请核对', 1);
        return { text: `库位：${location}`, mode: 'location' };
      }
      // A crop that did not produce one unambiguous complete location must not
      // produce a label from guesses. Retry with the original screenshot.
      report('正在核对库位，继续识别完整截图', 0.5);
      job.mode = 'full';
      image = await prepareImage(file, signal, wait, 'full');
      job.stage = '加载组件';
      await acquireWorker(Tesseract, 'full', job, wait, report);
      job.stage = '识别文字';
      await wait(job.worker.setParameters({
        tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT,
        preserve_interword_spaces: '1',
        user_defined_dpi: '150',
      }));
      job.recognitionRange = [0.86, 0.98];
      result = await wait(job.worker.recognize(image, {}, { text: true }));
    }
    if (job.stopped || signal?.aborted) throw abortError();
    const text = String(result.data?.text || '').replace(/\r\n?/g, '\n').trim();
    if (!text) throw new Error('没有识别到文字，请裁剪到商品信息区域并使用清晰截图。');
    if (mode === 'location' && !hasTarget && new Set(locationCandidates(text)).size > 1) {
      throw new Error('截图中识别到多个不同库位，请裁剪到单个商品，或在整段文字中补充准确“库位：…”后重试。');
    }
    job.completed = true;
    report('识别完成，请核对名称、库位和编码', 1);
    return { text, mode: 'full', scope: 'image', language: 'full' };
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    // Deliberate validation errors are already user-readable Chinese.
    if (error instanceof Error && /[\u4e00-\u9fff]/.test(error.message)) throw error;
    throw new Error(job.stage === '加载组件'
      ? '识别数据加载失败，请检查网络后重试。截图不会上传。'
      : '本地识别未完成，请裁剪到商品信息区域后重试。');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
    job.stopped = true;
    if (!job.completed && !job.keepWorker && job.entry && (!job.cancelled || job.entry.recognizing)) await disposeResident(job.entry);
    else if (resident) idleRelease(resident);
    if (activeJob === job) activeJob = null;
  }
}

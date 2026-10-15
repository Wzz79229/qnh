/** Browser-only OCR. Images stay in memory; only bundled OCR assets are loaded. */
import { parseScreenshotText } from './label.js?v=20261015-3';
import { ensureAssetCache } from './asset-cache.js?v=20261015-5';
import { recognizeLocationFast } from './lightweight-location-ocr.js?v=20261015-5';

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
  const entry = { worker: null, promise: null, language, disposed: false, termination: null };
  resident = entry;
  // Publish the promise before loading the runtime. Foreground OCR can attach
  // to an initializer already started while the image picker was open.
  entry.promise = (runtime ? Promise.resolve(runtime) : loadRuntime()).then(Tesseract => Tesseract.createWorker(language === 'location' ? ['eng_codes'] : ['chi_sim', 'eng'], 1, {
    workerPath: new URL('worker.min.js', ASSET_ROOT).href,
    corePath: new URL('core/', ASSET_ROOT).href.replace(/\/$/, ''),
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
    if (entry.disposed || resident !== entry) {
      void disposeResident(entry);
      throw abortError();
    }
    return worker;
  }).catch(error => {
    if (resident === entry) resident = null;
    throw error;
  });
  // Initialization itself cannot be interrupted by Tesseract. A cancelled
  // initializer is discarded when it resolves and never replaces a new job.
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
  job.worker = await wait(entry.promise);
  return job.worker;
}

/** Start public OCR asset loading after an image action, without reading a file.
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
    rejectStopped(error);
    if (job.entry) void disposeResident(job.entry);
  };
  const cancel = () => stop(abortError());
  const wait = promise => Promise.race([promise, stopped]);
  job.report = report;
  job.stop = stop;
  signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(() => stop(new Error('本地识别耗时过长，请裁剪截图后重试。')), 180_000);
  try {
    report('正在准备截图', 0.02);
    if (targetedFastPass) {
      report('正在快速核对截图中的库位和 SKU', 0.04);
      const fast = await wait(recognizeLocationFast(file, { sku: matchingProduct.sku, signal }));
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
    const compact = targetedFastPass ? await prepareCompactCards(file, signal, wait) : null;
    let image = compact || await prepareImage(file, signal, wait, job.mode, targetedFastPass);
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
    job.recognitionRange = compact ? [0.48, 0.70] : [0.48, 0.90];
    let result = await wait(job.worker.recognize(image, {}, { text: true }));
    if (job.stopped || signal?.aborted) throw abortError();
    if (job.mode === 'location') {
      if (targetedFastPass) {
        const text = String(result.data?.text || '').replace(/\r\n?/g, '\n').trim();
        const matched = parseScreenshotText(text, { product: matchingProduct });
        // The parser requires a unique, sufficiently long visible SKU match;
        // partial/missing card boundaries and contradictory data fall back.
        if (!matched.matchError && matched.matchedBy === 'sku' && matched.loc) {
          job.completed = true;
          report('库位与 SKU 匹配完成，请核对', 1);
          return { text, mode: 'full', scope: compact ? 'cards' : 'image', language: job.entry.language };
        }
        if (compact) {
          // The smaller pass may omit wrapped or unfamiliar card layouts.
          // Retry the complete original before loading the bilingual model.
          report('正在核对原图中的商品和库位', 0.70);
          image = await prepareImage(file, signal, wait, 'location', true);
          job.recognitionRange = [0.70, 0.86];
          result = await wait(job.worker.recognize(image, {}, { text: true }));
          const originalText = String(result.data?.text || '').replace(/\r\n?/g, '\n').trim();
          const originalMatch = parseScreenshotText(originalText, { product: matchingProduct });
          if (!originalMatch.matchError && originalMatch.matchedBy === 'sku' && originalMatch.loc) {
            job.completed = true;
            report('库位与 SKU 匹配完成，请核对', 1);
            return { text: originalText, mode: 'full', scope: 'image', language: job.entry.language };
          }
        }
      }
      const location = targetedFastPass ? '' : fastLocation(result.data?.text);
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
    if (!job.completed) await disposeResident(job.entry || resident);
    else if (resident) idleRelease(resident);
    if (activeJob === job) activeJob = null;
  }
}

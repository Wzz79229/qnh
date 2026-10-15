/** Browser-only OCR. Images stay in memory; only bundled OCR assets are loaded. */
const ASSET_ROOT = new URL('./vendor/tesseract/', import.meta.url);
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const MAX_EDGE = 2400;
const ACCEPTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
let runtimePromise;
let activeJob = null;

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

async function prepareImage(file, signal, wait) {
  const image = await wait(decodeImage(file, signal));
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (width < 64 || height < 64) throw new Error('图片过小，请使用原始清晰截图。');
  if (width * height > MAX_PIXELS || width > 20_000 || height > 20_000) {
    throw new Error('图片尺寸过大，请裁剪到商品信息区域后再试。');
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  if (scale < 1 && canvas.width < 400) {
    throw new Error('长截图缩小后文字太小，请裁剪到商品名称、库位和编码所在区域。');
  }
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('当前浏览器无法处理图片，请使用 Safari 或 Chrome 打开。');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await wait(new Promise((resolve, reject) => {
    canvas.toBlob(result => result ? resolve(result)
      : reject(new Error('图片处理失败，请裁剪截图后再试。')), 'image/png');
  }));
  canvas.width = 1;
  canvas.height = 1;
  return blob;
}

/**
 * @param {File|Blob} file PNG/JPEG/WebP, at most 15 MB.
 * @param {{onProgress?: (value: {status: string, progress: number}) => void,
 * signal?: AbortSignal}} [options]
 * @returns {Promise<{text: string}>} Verbatim OCR text, without code substitution.
 */
export async function recognizeScreenshot(file, { onProgress, signal } = {}) {
  if (signal?.aborted) throw abortError();
  validateFile(file);
  if (activeJob) throw new Error('已有图片正在识别，请先取消或等待完成。');
  if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') {
    throw new Error('当前浏览器不支持本地识别，请使用新版 Safari 或 Chrome。');
  }
  const job = { worker: null, stopped: false, stage: '准备图片' };
  activeJob = job;
  let workerPromise;
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
    if (job.worker) void job.worker.terminate().catch(() => {});
  };
  const cancel = () => stop(abortError());
  const wait = promise => Promise.race([promise, stopped]);
  signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(() => stop(new Error('本地识别耗时过长，请裁剪截图后重试。')), 180_000);
  try {
    report('正在准备截图', 0.02);
    const image = await prepareImage(file, signal, wait);
    job.stage = '加载组件';
    report('正在加载本地识别组件，首次使用需要稍等', 0.08);
    const Tesseract = await wait(loadRuntime());
    workerPromise = Tesseract.createWorker(['chi_sim', 'eng'], 1, {
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
        const part = Math.min(1, Math.max(0, message.progress || 0));
        if (message.status === 'recognizing text') {
          report('正在识别截图中的中文和编码', 0.48 + part * 0.5);
        } else if (message.status === 'loading language traineddata') {
          report('正在加载中文和英文识别数据，首次使用需要稍等', 0.24 + part * 0.18);
        } else if (message.status === 'initializing api') {
          report('正在初始化本地识别', 0.42 + part * 0.05);
        } else {
          report('正在加载本地识别组件', 0.12 + part * 0.1);
        }
      },
      errorHandler: () => stop(new Error('本地识别组件运行失败，请刷新页面或更换清晰截图重试。')),
    });
    // createWorker exposes terminate only after initialization. If cancelled
    // while models load, never start OCR and dispose as soon as it becomes ready.
    workerPromise.then(worker => {
      if (job.stopped) void worker.terminate().catch(() => {});
    }).catch(() => {});
    job.worker = await wait(workerPromise);
    job.stage = '识别文字';
    await wait(job.worker.setParameters({
      tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT,
      preserve_interword_spaces: '1',
      user_defined_dpi: '150',
    }));
    const result = await wait(job.worker.recognize(image, {}, { text: true }));
    if (job.stopped || signal?.aborted) throw abortError();
    const text = String(result.data?.text || '').replace(/\r\n?/g, '\n').trim();
    if (!text) throw new Error('没有识别到文字，请裁剪到商品信息区域并使用清晰截图。');
    report('识别完成，请核对名称、库位和编码', 1);
    return { text };
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
    if (job.worker) await job.worker.terminate().catch(() => {});
    if (activeJob === job) activeJob = null;
  }
}

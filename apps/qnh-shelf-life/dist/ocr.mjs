/** Device-local packaging OCR. Photos and recognized text stay in memory. */
export const MAX_PHOTOS = 3;
export const MAX_INPUT_BYTES = 10 * 1024 * 1024;
export const MAX_DIMENSION = 1600;
export const MAX_PREVIEW_BYTES = 300 * 1024;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const OCR_TIMEOUT_MS = 180_000;
let busy = false;

function abortError() { return new DOMException('已取消照片识别', 'AbortError'); }
function checkAbort(signal) { if (signal?.aborted) throw abortError(); }

export function validatePhotos(input) {
  let files;
  try { files = Array.from(input || []); } catch { throw new TypeError('请选择包装照片。'); }
  if (!files.length) throw new TypeError('请先拍摄或选择包装照片。');
  if (files.length > MAX_PHOTOS) throw new TypeError(`每次最多识别 ${MAX_PHOTOS} 张包装照片。`);
  files.forEach((file, index) => {
    if (!file || !ALLOWED_TYPES.has(String(file.type || '').toLowerCase())) {
      throw new TypeError(`第 ${index + 1} 张不是支持的照片，请选择 JPG、PNG、WebP，或手机拍摄的 HEIC 照片。`);
    }
    if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new TypeError(`第 ${index + 1} 张照片为空或无法读取，请重新拍摄。`);
    if (file.size > MAX_INPUT_BYTES) throw new TypeError(`第 ${index + 1} 张照片超过 10 MB，请缩小照片或重新拍摄。`);
  });
  return files;
}

export function fitDimensions(width, height, maximum = MAX_DIMENSION) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1
      || !Number.isSafeInteger(maximum) || maximum < 1) throw new TypeError('照片尺寸无效，请重新拍摄。');
  const ratio = Math.min(1, maximum / Math.max(width, height));
  return { width: Math.max(1, Math.floor(width * ratio)), height: Math.max(1, Math.floor(height * ratio)) };
}

/** Decoded JPEG size, rather than the larger base64 string length. */
export function previewByteLength(dataUrl) {
  if (typeof dataUrl !== 'string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]*={0,2}$/.test(dataUrl)) return null;
  const encoded = dataUrl.slice('data:image/jpeg;base64,'.length);
  if (encoded.length % 4 !== 0) return null;
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  return encoded.length / 4 * 3 - padding;
}

async function decodePhoto(file, signal) {
  checkAbort(signal);
  if (typeof createImageBitmap === 'function') {
    try {
      // Browser decoding applies EXIF orientation before the canvas draw.
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      if (signal?.aborted) { bitmap.close(); throw abortError(); }
      return { image: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      // Some mobile browsers decode HEIC through <img> but not createImageBitmap.
    }
  }
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    const cleanup = () => { image.onload = null; image.onerror = null; signal?.removeEventListener('abort', cancel); };
    const cancel = () => {
      cleanup(); image.src = ''; URL.revokeObjectURL(url); reject(abortError());
    };
    image.onload = () => {
      cleanup();
      resolve({ image, width: image.naturalWidth, height: image.naturalHeight, release: () => { image.src = ''; URL.revokeObjectURL(url); } });
    };
    image.onerror = () => {
      cleanup(); URL.revokeObjectURL(url);
      reject(new Error('无法打开这张照片，请重新拍摄，或转换为 JPG / PNG 后再试。'));
    };
    signal?.addEventListener('abort', cancel, { once: true });
    image.src = url;
    if (signal?.aborted) cancel();
  });
}

function canvasBlob(canvas, type, quality, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (signal?.aborted) return reject(abortError());
      if (!blob || blob.type !== type) return reject(new Error('手机无法处理这张照片，请改用 JPG 照片，或重新拍摄。'));
      resolve(blob);
    }, type, quality);
  });
}

async function jpegPreview(canvas, signal) {
  // Keep the OCR image lossless; only the archive preview is compressed further.
  for (let pass = 0; pass < 9; pass += 1) {
    for (const quality of [0.82, 0.68, 0.52, 0.36, 0.22]) {
      const blob = await canvasBlob(canvas, 'image/jpeg', quality, signal);
      if (blob.size <= MAX_PREVIEW_BYTES) return { blob, width: canvas.width, height: canvas.height };
    }
    const smaller = fitDimensions(canvas.width, canvas.height, Math.max(128, Math.floor(Math.max(canvas.width, canvas.height) * 0.8)));
    if (smaller.width === canvas.width && smaller.height === canvas.height) break;
    const copy = document.createElement('canvas');
    copy.width = smaller.width; copy.height = smaller.height;
    const context = copy.getContext('2d');
    if (!context) throw new Error('当前浏览器无法处理照片，请使用新版 Safari 或 Chrome。');
    context.drawImage(canvas, 0, 0, copy.width, copy.height);
    canvas.width = copy.width; canvas.height = copy.height;
    canvas.getContext('2d').drawImage(copy, 0, 0);
    copy.width = 1; copy.height = 1;
  }
  throw new Error('照片细节过多，无法压缩，请靠近包装文字重新拍摄。');
}

async function blobDataUrl(blob, signal) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  checkAbort(signal);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:image/jpeg;base64,${btoa(binary)}`;
}

export async function preprocessPhoto(file, { signal } = {}) {
  validatePhotos([file]);
  checkAbort(signal);
  if (typeof document === 'undefined') throw new Error('照片识别需要在手机浏览器中打开应用。');
  let decoded;
  let canvas;
  try {
    decoded = await decodePhoto(file, signal);
    checkAbort(signal);
    if (decoded.width * decoded.height > 100_000_000) throw new Error('照片像素过大，请关闭超高像素模式后重新拍摄。');
    const size = fitDimensions(decoded.width, decoded.height);
    canvas = document.createElement('canvas');
    canvas.width = size.width; canvas.height = size.height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('当前浏览器无法处理照片，请使用新版 Safari 或 Chrome。');
    context.fillStyle = '#fff'; context.fillRect(0, 0, size.width, size.height);
    context.drawImage(decoded.image, 0, 0, size.width, size.height);
    decoded.release(); decoded = null;
    const blob = await canvasBlob(canvas, 'image/png', undefined, signal);
    const compressed = await jpegPreview(canvas, signal);
    const dataUrl = await blobDataUrl(compressed.blob, signal);
    return {
      blob,
      preview: { id: crypto.randomUUID(), dataUrl, width: compressed.width, height: compressed.height, bytes: compressed.blob.size },
    };
  } finally {
    decoded?.release();
    if (canvas) { canvas.width = 1; canvas.height = 1; }
  }
}

function localWorker(signal) {
  if (typeof Worker !== 'function' || typeof WebAssembly !== 'object') {
    throw new Error('当前浏览器不支持本机照片识别，请使用新版 Safari 或 Chrome。');
  }
  const worker = new Worker(new URL('./vendor/tesseract/recognize.worker.js', import.meta.url), { name: '鲜期包装识别' });
  let pending;
  let closed = false;
  function terminate(error) {
    if (closed) return;
    closed = true;
    worker.terminate();
    worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
    signal?.removeEventListener('abort', cancel);
    if (pending) { clearTimeout(pending.timer); pending.reject(error || abortError()); pending = null; }
  }
  const cancel = () => terminate(abortError());
  signal?.addEventListener('abort', cancel, { once: true });
  worker.onmessage = ({ data }) => {
    if (!pending || !data) return;
    if (data.type === 'progress') { pending.progress(data); return; }
    if (data.type === 'result') {
      const current = pending; pending = null; clearTimeout(current.timer); current.resolve(data); return;
    }
    if (data.type === 'error') terminate(new Error('本机识别未能完成，请联网重新打开应用，确认识别资源已下载，再对准清晰、朝上的包装文字重拍。'));
  };
  worker.onerror = (event) => {
    event.preventDefault?.();
    terminate(new Error('无法启动本机识别，请联网刷新应用后重试；如果仍失败，请使用新版 Safari 或 Chrome。'));
  };
  worker.onmessageerror = () => terminate(new Error('照片读取中断，请重新选择照片。'));
  return {
    terminate,
    recognize(blob, progress) {
      checkAbort(signal);
      if (closed) return Promise.reject(new Error('识别已结束，请重新选择照片。'));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => terminate(new Error('识别用时过长，请取消后靠近包装文字重拍，并确认网络可加载本机识别资源。')), OCR_TIMEOUT_MS);
        pending = { resolve, reject, progress, timer };
        try { worker.postMessage({ type: 'recognize', blob }); } catch {
          terminate(new Error('这张照片无法读取，请重新拍摄。'));
        }
      });
    },
  };
}

/** onProgress receives { progress: 0..1, status, photoIndex: 1..total, total }. */
export async function recognizePhotos(input, { onProgress, signal } = {}) {
  const files = validatePhotos(input);
  checkAbort(signal);
  if (busy) throw new Error('已有照片正在识别，请等待完成或先取消。');
  busy = true;
  let engine;
  let maximumProgress = 0;
  const previews = [], photoTexts = [];
  const emit = (progress, status, photoIndex) => {
    maximumProgress = Math.max(maximumProgress, Math.min(1, progress));
    try { onProgress?.({ progress: maximumProgress, status, photoIndex, total: files.length }); } catch { /* UI callbacks must not leak a worker. */ }
  };
  try {
    for (let index = 0; index < files.length; index += 1) {
      checkAbort(signal);
      emit(index / files.length, '正在处理包装照片', index + 1);
      const processed = await preprocessPhoto(files[index], { signal });
      checkAbort(signal);
      previews.push(processed.preview);
      if (!engine) engine = localWorker(signal);
      const result = await engine.recognize(processed.blob, (message) => {
        const recognizing = message.status === 'recognizing text';
        const fraction = recognizing ? 0.25 + 0.7 * (Number(message.progress) || 0) : 0.15;
        emit((index + fraction) / files.length, recognizing ? '正在识别包装文字' : '正在准备本机识别', index + 1);
      });
      photoTexts.push({ id: processed.preview.id, text: String(result.text || '').trim(), confidence: Number(result.confidence) || 0 });
      emit((index + 1) / files.length, '包装照片识别完成', index + 1);
    }
    checkAbort(signal);
    const text = photoTexts.map((photo) => photo.text).filter(Boolean).join('\n\n');
    if (!text) throw new Error('没有识别到清晰文字，请靠近商品名称、生产日期或保质期，避免反光，让文字朝上后重新拍摄。');
    return { text, previews, photoTexts, confidence: photoTexts.reduce((sum, photo) => sum + photo.confidence, 0) / photoTexts.length };
  } finally {
    engine?.terminate();
    busy = false;
  }
}

/**
 * Local-only PNG actions. Generate/cache the PNG before enabling these buttons.
 * Call shareLabelImage/openLabelImage directly from a later user click: do not
 * await image generation first, because that can consume user activation.
 * A download request or resolved share does not confirm that a photo was saved
 * or a label was printed. The receiving browser/app controls the final action.
 */
const objectUrls = new Set();
let preparedImages = new WeakMap();
let imageDataUrls = new WeakMap();
let sharing = false;

function filenameFor(value) {
  const name = typeof value === 'string' ? value : '标签.png';
  const safe = name.replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, '-').trim()
    .replace(/^\.+/, '').slice(0, 120) || '标签';
  return /\.png$/i.test(safe) ? safe : `${safe}.png`;
}

function checkPng(blob) {
  if (typeof Blob === 'undefined' || !(blob instanceof Blob) || !blob.size) {
    throw new TypeError('请先生成标签图片。');
  }
  if (blob.type && blob.type.toLowerCase() !== 'image/png') {
    throw new TypeError('需要 PNG 图片，无法直接转换其他文件格式。');
  }
}

function imageUrl(blob) {
  const existing = preparedImages.get(blob);
  if (existing) return existing;
  const url = URL.createObjectURL(blob);
  objectUrls.add(url);
  preparedImages.set(blob, url);
  return url;
}

function failed(message, extra = {}) {
  return { status: 'failed', message, ...extra };
}

/** Feature availability, not a promise that the device has a share target. */
export function capabilities() {
  const dom = typeof document !== 'undefined' && typeof window !== 'undefined';
  const urls = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
  const secureContext = typeof window !== 'undefined' && window.isSecureContext === true;
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  // iPad Safari can identify itself as a Mac. Download support alone cannot
  // tell us whether a browser can save an image to the phone's photo library.
  const ios = /iPad|iPhone|iPod/i.test(ua)
    || (typeof navigator !== 'undefined' && navigator.platform === 'MacIntel'
      && navigator.maxTouchPoints > 1);
  const inApp = /MicroMessenger|\bQQ\/|MQQBrowser|AlipayClient|DingTalk|FBAN|FBAV|Instagram|; wv\)/i.test(ua);
  const download = dom && urls && 'download' in document.createElement('a');
  return {
    download,
    fileShare: secureContext && typeof File === 'function'
      && typeof navigator !== 'undefined' && typeof navigator.canShare === 'function'
      && typeof navigator.share === 'function',
    openImage: dom && urls && typeof window.open === 'function',
    secureContext,
    // A UI hint, not a promise of browser or system save behavior. Always keep
    // the real PNG <img> available as a long-press/save fallback in the page.
    saveMode: ios || inApp || !download ? 'image' : 'download',
    ios,
    inApp,
  };
}

/**
 * Prepare the image before enabling save buttons. Use imageUrl for a real <img>
 * in the page and downloadUrl for <a download>. The data URL lets image menus in
 * mobile embedded browsers see the PNG without resolving a temporary Blob URL.
 * FileReader preserves the final PNG bytes, including its physical-size metadata.
 * No image conversion, upload or popup occurs. Repeated calls reuse both URLs.
 */
export async function prepareLabelImage(blob, filename) {
  checkPng(blob);
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error('当前浏览器无法准备图片，请使用系统浏览器重新打开页面。');
  }
  const url = imageUrl(blob);
  let dataUrl = imageDataUrls.get(blob);
  if (!dataUrl) {
    dataUrl = new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('图片保存准备失败，请重新生成标签。'));
      reader.onabort = () => reject(new Error('图片保存准备已中断，请重新生成标签。'));
      reader.readAsDataURL(blob.type ? blob : new Blob([blob], { type: 'image/png' }));
    });
    imageDataUrls.set(blob, dataUrl);
  }
  let original;
  try { original = await dataUrl; }
  catch (error) { imageDataUrls.delete(blob); throw error; }
  return { url, downloadUrl: url, imageUrl: original,
    filename: filenameFor(filename), type: 'image/png' };
}

/**
 * Request a browser download. The URL remains usable until cleanup().
 * @param {Blob} blob A nonempty PNG Blob created by the label renderer.
 * @param {string} filename Suggested filename; platform save UI may change it.
 * @param {{title?: string}} [options] Optional accessible link description.
 */
export function saveLabelImage(blob, filename, options = {}) {
  const safeName = filenameFor(filename);
  try {
    checkPng(blob);
    if (!capabilities().download) {
      return { status: 'unsupported', filename: safeName,
        message: '当前浏览器不支持直接下载，请使用“打开图片”后长按保存。' };
    }
    const url = imageUrl(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = safeName;
    anchor.title = options.title || '保存标签图片';
    anchor.setAttribute('aria-label', anchor.title);
    anchor.style.display = 'none';
    (document.body || document.documentElement).appendChild(anchor);
    try {
      anchor.click();
    } finally {
      // Some mobile browsers process the activated link after the current
      // stack. Keep the link attached briefly and keep its Blob URL alive.
      setTimeout(() => anchor.remove(), 1000);
    }
    return { status: 'download-requested', filename: safeName, url,
      message: '已请求保存 PNG，请查看浏览器下载或保存菜单。' };
  } catch (error) {
    return failed(error instanceof TypeError ? error.message : '下载未能启动，请使用“打开图片”。',
      { filename: safeName });
  }
}

/** Share only a local PNG file. No text, URL or label data is uploaded here. */
export async function shareLabelImage(blob, filename) {
  const safeName = filenameFor(filename);
  if (sharing) {
    return { status: 'blocked', filename: safeName, message: '请先完成或取消当前分享。' };
  }
  try {
    checkPng(blob);
    if (!capabilities().fileShare) {
      return { status: 'unsupported', filename: safeName,
        message: '当前浏览器不支持分享图片文件，请下载或打开图片。' };
    }
    const file = new File([blob], safeName, { type: 'image/png' });
    const data = { files: [file] };
    if (!navigator.canShare(data)) {
      return { status: 'unsupported', filename: safeName,
        message: '此浏览器无法分享这张 PNG，请下载或打开图片。' };
    }
    // Keep every step before this native call synchronous to retain the click.
    sharing = true;
    await navigator.share(data);
    return { status: 'shared', filename: safeName,
      message: '已完成系统分享；是否保存或打印由所选应用处理。' };
  } catch (error) {
    if (error?.name === 'AbortError') {
      return { status: 'cancelled', filename: safeName, message: '分享已取消。' };
    }
    if (error?.name === 'NotAllowedError' || error?.name === 'InvalidStateError') {
      return { status: 'blocked', filename: safeName,
        message: '分享未能打开，请直接点击分享按钮重试，或改用下载图片。' };
    }
    return failed(error instanceof TypeError ? error.message : '分享未成功，请下载或打开图片。',
      { filename: safeName });
  } finally {
    sharing = false;
  }
}

/**
 * Open the full PNG in a tab for long-press/save. If a popup is blocked, return
 * its URL so the UI can present an explicit link (href=url, target=_blank).
 */
export function openLabelImage(blob) {
  let url;
  try {
    checkPng(blob);
    if (!capabilities().openImage) {
      return { status: 'unsupported', message: '当前环境无法打开图片，请下载 PNG。' };
    }
    url = imageUrl(blob);
    // Do not pass noopener as a feature: some browsers then return null even
    // after opening a tab, making successful opens look like blocked popups.
    const popup = window.open('about:blank', '_blank');
    if (!popup) {
      return { status: 'blocked', url,
        message: '浏览器拦截了新窗口，请点击图片链接后长按保存。' };
    }
    popup.opener = null;
    popup.location.replace(url);
    return { status: 'opened', url, message: '已打开完整图片，可长按保存或使用系统分享。' };
  } catch (error) {
    return failed(error instanceof TypeError ? error.message : '图片未能打开，请点击图片链接或下载 PNG。',
      url ? { url } : {});
  }
}

/**
 * Revoke retained local URLs when the page is truly discarded (pagehide with
 * persisted=false), or when the UI no longer needs any returned image links.
 * Do not call immediately after click/load: users still need save/long-press.
 */
export function cleanup() {
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls.clear();
  preparedImages = new WeakMap();
  imageDataUrls = new WeakMap();
}

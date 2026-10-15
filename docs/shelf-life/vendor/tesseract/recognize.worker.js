/* Local bridge keeps the native worker handle cancellable throughout initialization. */
'use strict';
let engine;
let working = false;

self.onmessage = async ({ data }) => {
  if (data?.type !== 'recognize' || working) return;
  working = true;
  try {
    if (!engine) {
      importScripts('./tesseract.min.js');
      engine = await Tesseract.createWorker(['chi_sim', 'eng'], 1, {
        workerPath: new URL('./worker.min.js', self.location.href).href,
        corePath: new URL('./core/', self.location.href).href,
        langPath: new URL('./lang/', self.location.href).href,
        workerBlobURL: false, legacyCore: false, legacyLang: false,
        gzip: false, cacheMethod: 'none',
        logger: ({ status, progress }) => self.postMessage({ type: 'progress', status, progress }),
      });
      await engine.setParameters({ tessedit_pageseg_mode: '11', preserve_interword_spaces: '1', user_defined_dpi: '300' });
    }
    const result = await engine.recognize(data.blob, { rotateAuto: true }, { text: true });
    self.postMessage({ type: 'result', text: result.data.text, confidence: result.data.confidence });
  } catch {
    if (engine) { try { await engine.terminate(); } catch { /* Outer native worker also terminates the worker tree. */ } }
    engine = null;
    self.postMessage({ type: 'error' });
  } finally {
    working = false;
  }
};

import { parseBatchDates, createBatchDraft, scanSkuValue } from './batch-domain.mjs';
Object.defineProperty(window, '__xianqiBatch', { value: Object.freeze({
  parse: text => parseBatchDates(text),
  draft: value => { try { return { ok: true, draft: createBatchDraft(value) }; } catch (error) { return { ok: false, message: error.message }; } },
  scan: text => { try { return { ok: true, sku: scanSkuValue(text) }; } catch { return { ok: false }; } },
}) });

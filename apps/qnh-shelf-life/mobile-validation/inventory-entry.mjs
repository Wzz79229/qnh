import { createInventoryRuntime } from './inventory-query.mjs';
if (location.origin === 'https://qnh.meituan.com' && !window.__kuguanInventory) {
  Object.defineProperty(window, '__kuguanInventory', { value: createInventoryRuntime(), configurable: true });
}

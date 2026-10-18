import { createInventorySearch } from './inventory-search.mjs';
if (location.origin === 'https://qnh.meituan.com' && !window.__kuguanInventory) {
  Object.defineProperty(window, '__kuguanInventory', { value: createInventorySearch(), configurable: true });
}

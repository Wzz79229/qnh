import { createPhoneRuntime } from './phone-runtime.mjs';

// This is a local WebView helper only. It never grants backend authorization.
if (location.origin === 'https://qnh.meituan.com' && !window.__xianqiPhoneValidation) {
  Object.defineProperty(window, '__xianqiPhoneValidation', { value: createPhoneRuntime(), configurable: true });
}

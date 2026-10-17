import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { browserConfiguration, acquireProfileLock } from './browser.mjs';
import { createVisibleQnhAdapter, normalizeSku, sanitizeProduct, QNH_PRODUCT_URL } from './extract.mjs';

const RESULT_MESSAGES = {
  not_found: '牵牛花中没有这个精确 SKU，请核对标签。',
  ambiguous: '这个 SKU 对应多个不同商品，请在牵牛花核对。',
  login_required: '商品页登录已失效，请在浏览器中重新登录并进入商品主档。',
  error: '本次查询未确认完成，请检查商品页后重试。',
};

/** Local interactive session: no bridge, fetch client, output file or credential input. */
export async function runLocalConnection({ adapter, ask, write, signal }) {
  write('此入口仅验证本机牵牛花商品页，不代表手机 App 已登录或已连接。');
  write('账号密码和验证码请只在独立浏览器中输入；本终端只接收 SKU。输入 :q 可退出。');
  let announced = false;
  const answer = async prompt => {
    try { return await ask(prompt, { signal }); }
    catch { if (signal?.aborted) return ':q'; throw new Error('INPUT_UNAVAILABLE'); }
  };
  while (!signal?.aborted) {
    let ready = false;
    try { ready = await adapter.checkLogin(); } catch {}
    if (!ready) {
      announced = false;
      write('尚未识别到可操作的商品主档。请在浏览器亲自登录，然后进入“商品 → 商品主档”。');
      const input = await answer('完成后按回车重新检查，或输入 :q 退出：');
      if (typeof input !== 'string' || input.trim() === ':q') return;
      continue;
    }
    if (!announced) {
      write('已识别牵牛花商品主档。可以试查 SKU；这不是手机 App 的身份授权。');
      announced = true;
    }
    const input = await answer('输入牵牛花 SKU（:q 退出）：');
    if (typeof input !== 'string' || input.trim() === ':q') return;
    if (!input.trim()) continue;
    let sku;
    try { sku = normalizeSku(input); }
    catch { write('SKU 格式无效：请粘贴标签上的 SKU 编码，最多 64 个英文字母、数字或 . _ -。'); continue; }
    if (signal?.aborted) return;
    let result;
    try { result = await adapter.lookup(sku, { deadline: Date.now() + 35000, signal }); }
    catch { result = { status: 'error' }; }
    if (signal?.aborted) return;
    if (result?.status === 'found') {
      try {
        const product = sanitizeProduct(result.product, sku);
        if (!product.imageUrl) throw new Error('MISSING_IMAGE');
        write(`SKU：${product.sku}`);
        write(`名称：${product.name}`);
        write(`规格：${product.spec || '牵牛花未提供规格'}`);
        write(`图片：${product.imageUrl}`);
        write('请在浏览器的当前商品行核对图片；以上结果仅显示在本机，未发送到手机或云端。');
        continue;
      } catch { write(RESULT_MESSAGES.error); continue; }
    }
    if (result?.status === 'login_required') announced = false;
    const missingImage = result?.status === 'error' && result.message === '此 SKU 的商品主图缺失，请在牵牛花核对后重试。';
    write(missingImage ? result.message : RESULT_MESSAGES[result?.status] || RESULT_MESSAGES.error);
  }
}

export async function connectMain({
  env = process.env,
  loadPlaywright = () => import('playwright'),
  lockProfile = acquireProfileLock,
  makeAdapter = createVisibleQnhAdapter,
  makeTerminal = () => createInterface({ input: process.stdin, output: process.stdout }),
  write = line => console.log(line),
} = {}) {
  let config;
  try { config = browserConfiguration(env); }
  catch { write('浏览器配置无效。QNH_BROWSER 只能是 msedge 或 chrome。'); return 1; }
  let chromium;
  try { ({ chromium } = await loadPlaywright()); }
  catch { write('尚未安装固定版本 Playwright，请先按 local-query/README 完成依赖安装。'); return 1; }
  const controller = new AbortController();
  let terminal;
  let context;
  let lock;
  const stop = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    terminal?.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    lock = await lockProfile(config.profile);
    context = await chromium.launchPersistentContext(config.profile, { channel: config.channel, headless: false, viewport: null });
    context.once('close', stop);
    const page = context.pages().find(value => value.url().startsWith('https://qnh.meituan.com/')) || context.pages()[0] || await context.newPage();
    if (page.url() !== QNH_PRODUCT_URL) await page.goto(QNH_PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    terminal = makeTerminal();
    // EOF/terminal Ctrl+C must abort question(), which otherwise can remain pending
    // after readline emits close and retain the browser/profile mutex indefinitely.
    terminal.once('close', stop);
    terminal.once('SIGINT', stop);
    terminal.once('error', stop);
    terminal.input?.once('error', stop);
    await runLocalConnection({
      adapter: makeAdapter(page), signal: controller.signal,
      ask: (prompt, options) => terminal.question(prompt, options), write,
    });
    return 0;
  } catch (error) {
    if (controller.signal.aborted) return 0;
    if (error?.code === 'PROFILE_IN_USE') write('连接牵牛花或启动查询程序已经运行。请先关闭正在使用的程序和它的独立浏览器，再打开此入口。');
    else if (error?.code === 'WINDOWS_REQUIRED') write('此启动入口目前用于 Windows 本机。');
    else write('本机牵牛花连接未能继续。请检查 Edge/Chrome 是否安装，以及独立浏览器是否已被其他程序占用。');
    return 1;
  } finally {
    controller.abort();
    terminal?.close();
    terminal?.removeListener('close', stop);
    terminal?.removeListener('SIGINT', stop);
    terminal?.removeListener('error', stop);
    terminal?.input?.removeListener('error', stop);
    if (context) await context.close().catch(() => {});
    if (lock) await lock.release().catch(() => {});
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await connectMain();

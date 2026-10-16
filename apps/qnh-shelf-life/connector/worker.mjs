import { ADMIN_HTML, ADMIN_SCRIPT, ADMIN_STYLE } from './ui.mjs';
export { QnhConnectorSession } from './session.mjs';

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store, private',
  'Pragma': 'no-cache',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

function response(body, status = 200, type = 'application/json; charset=utf-8') {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status, headers: { ...SECURITY_HEADERS, 'Content-Type': type },
  });
}

async function ownerIdentity(ctx) {
  if (!ctx?.access || typeof ctx.access.getIdentity !== 'function') return null;
  try {
    const identity = await ctx.access.getIdentity();
    const email = identity?.email;
    const audience = ctx.access.aud;
    if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email)) return null;
    if (typeof audience !== 'string' || audience.length < 1 || audience.length > 512) return null;
    const bytes = new TextEncoder().encode(`${audience}\0${email.toLowerCase()}`);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(hash, (value) => value.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

function configured(env) {
  return !!env?.CONNECTOR_SESSIONS
    && typeof env.CONNECTOR_SESSIONS.idFromName === 'function'
    && typeof env.CONNECTOR_SESSIONS.get === 'function'
    && ['acquire', 'getSession', 'getLiveView', 'connectSession', 'closeSession'].every((name) => typeof env.BROWSER?.[name] === 'function')
    && typeof env.BROWSER?.devtools?.newTarget === 'function';
}

export default {
  async fetch(request, env, ctx) {
    const owner = await ownerIdentity(ctx);
    if (!owner) return response({ code: 'ACCESS_REQUIRED', message: '请使用已获准的 Cloudflare 管理员身份登录。' }, 403);
    if (!configured(env)) return response({ code: 'SETUP_REQUIRED', message: '管理员连接服务尚未完成配置。' }, 503);

    const url = new URL(request.url);
    if (url.search || url.hash) return response({ code: 'INVALID_REQUEST' }, 400);
    const resource = {
      '/': [ADMIN_HTML, 'text/html; charset=utf-8'],
      '/admin.mjs': [ADMIN_SCRIPT, 'text/javascript; charset=utf-8'],
      '/admin.css': [ADMIN_STYLE, 'text/css; charset=utf-8'],
    }[url.pathname];
    if (resource && request.method === 'GET') return response(resource[0], 200, resource[1]);

    const expectedMethod = {
      '/session/start': 'POST', '/session/status': 'GET',
      '/session/live-view': 'POST', '/session/stop': 'POST',
    }[url.pathname];
    if (!expectedMethod) return response({ code: 'NOT_FOUND' }, 404);
    if (request.method !== expectedMethod) return response({ code: 'METHOD_NOT_ALLOWED' }, 405);

    // Even status invokes a remote browser command: require a same-origin fetch.
    const origin = request.headers.get('Origin');
    const fetchSite = request.headers.get('Sec-Fetch-Site');
    if (fetchSite !== 'same-origin' || (expectedMethod === 'POST' && origin !== url.origin)
      || (origin !== null && origin !== url.origin)) {
      return response({ code: 'SAME_ORIGIN_REQUIRED' }, 403);
    }
    if (request.headers.get('X-Qnh-Connector') !== '1') return response({ code: 'SAME_ORIGIN_REQUIRED' }, 403);
    if (request.body !== null) return response({ code: 'BODY_NOT_ALLOWED' }, 400);

    const objectId = env.CONNECTOR_SESSIONS.idFromName('qnh-login-test-v1');
    const object = env.CONNECTOR_SESSIONS.get(objectId);
    try {
      // Construct a fresh request: caller-supplied owner/session/URL headers never reach the DO.
      const internal = new Request(`https://connector.internal${url.pathname}`, {
        method: expectedMethod, headers: { 'X-Connector-Owner': owner },
      });
      const result = await object.fetch(internal);
      const headers = new Headers(result.headers);
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
      return new Response(result.body, { status: result.status, headers });
    } catch {
      // Errors can contain browser URLs; never reflect or log upstream exceptions.
      return response({ code: 'SERVICE_UNAVAILABLE', message: '连接服务暂时不可用，请稍后查看状态。' }, 502);
    }
  },
};

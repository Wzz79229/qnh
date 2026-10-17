const ROOT = 'https://api.github.com';
const REPOSITORY = 'Wzz79229/bzq';
const FIELDS = ['GITHUB_APP_ID', 'GITHUB_APP_INSTALLATION_ID', 'GITHUB_APP_PRIVATE_KEY'];
const encoder = new TextEncoder();

export class GitHubAuthorizationError extends Error {
  constructor(code = 'GITHUB_APP_AUTH_FAILED', status = 502) {
    super(code === 'SETUP_REQUIRED' ? 'GitHub App 后台授权配置未完成，请联系管理员。' : 'GitHub App 仓库授权未通过，请管理员检查安装范围、权限和私钥。');
    this.name = 'GitHubAuthorizationError';
    this.code = code;
    this.status = status;
  }
}

function config(env = {}) {
  if (FIELDS.some(field => env[field] !== undefined)) {
    if (!FIELDS.slice(0, 2).every(field => typeof env[field] === 'string' && /^[1-9]\d{0,15}$/.test(env[field]))
      || typeof env.GITHUB_APP_PRIVATE_KEY !== 'string' || env.GITHUB_APP_PRIVATE_KEY.length > 32768
      || !/^-----BEGIN (RSA )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END (RSA )?PRIVATE KEY-----\s*$/.test(env.GITHUB_APP_PRIVATE_KEY)) {
      throw new GitHubAuthorizationError('SETUP_REQUIRED', 503);
    }
    return { mode: 'app', appId: env.GITHUB_APP_ID, installationId: env.GITHUB_APP_INSTALLATION_ID, pem: env.GITHUB_APP_PRIVATE_KEY };
  }
  if (typeof env.GITHUB_TOKEN !== 'string' || !env.GITHUB_TOKEN.trim() || /[\s\x00-\x1f\x7f]/.test(env.GITHUB_TOKEN.trim())) {
    throw new GitHubAuthorizationError('SETUP_REQUIRED', 503);
  }
  return { mode: 'pat', token: env.GITHUB_TOKEN.trim() };
}

export function validateGitHubAuthorization(env) {
  return { mode: config(env).mode };
}

function base64url(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function concatenate(...arrays) {
  const result = new Uint8Array(arrays.reduce((sum, bytes) => sum + bytes.length, 0));
  let offset = 0;
  for (const bytes of arrays) { result.set(bytes, offset); offset += bytes.length; }
  return result;
}

function der(tag, value) {
  const sizes = [];
  let length = value.length;
  if (length < 128) sizes.push(length);
  else {
    while (length) { sizes.unshift(length & 255); length = Math.floor(length / 256); }
    sizes.unshift(128 | sizes.length);
  }
  return concatenate(Uint8Array.of(tag, ...sizes), value);
}

async function privateKey(pem, cryptoImpl) {
  try {
    const match = /^-----BEGIN (RSA )?PRIVATE KEY-----\r?\n([A-Za-z0-9+/=\r\n]+)\r?\n-----END (RSA )?PRIVATE KEY-----\s*$/.exec(pem);
    if (!match || match[1] !== match[3]) throw new Error();
    let bytes = Uint8Array.from(atob(match[2].replace(/[\r\n]/g, '')), char => char.charCodeAt(0));
    if (match[1]) {
      // GitHub downloads PKCS#1; WebCrypto imports PKCS#8. Wrap without inspecting RSA integers.
      bytes = der(0x30, concatenate(Uint8Array.of(2, 1, 0), Uint8Array.of(0x30, 0x0d, 6, 9, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 1, 1, 1, 5, 0), der(4, bytes)));
    }
    const key = await cryptoImpl.subtle.importKey('pkcs8', bytes, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    if (key.algorithm.modulusLength < 2048 || key.algorithm.modulusLength > 8192) throw new Error();
    return key;
  } catch { throw new GitHubAuthorizationError('GITHUB_APP_INVALID_KEY', 503); }
}

async function readJSON(response) {
  const declared = response.headers.get('Content-Length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 65536) || !response.body) throw new GitHubAuthorizationError();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65536) throw new GitHubAuthorizationError();
      chunks.push(value);
    }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(concatenate(...chunks)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new GitHubAuthorizationError(); }
  finally { reader.cancel().catch(() => {}); }
}

/** Secrets and short-lived tokens stay in Worker memory. No client-controlled repository or endpoint. */
export function createGitHubAuthorization({ fetchImpl = globalThis.fetch, now = () => Date.now(), cryptoImpl = globalThis.crypto } = {}) {
  let current = null;

  async function request(path, jwt, body) {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([(async () => {
        const response = await fetchImpl(ROOT + path, {
          method: body ? 'POST' : 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal,
          headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${jwt}`, 'User-Agent': 'qnh-shelf-life-github-app',
            'X-GitHub-Api-Version': '2026-03-10', ...(body ? { 'Content-Type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (!response.ok || response.redirected || response.url && new URL(response.url).origin !== ROOT) throw new GitHubAuthorizationError();
        return await readJSON(response);
      })(), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new GitHubAuthorizationError('GITHUB_APP_TIMEOUT', 504)); }, 10000); })]);
    } catch (error) {
      if (error instanceof GitHubAuthorizationError) throw error;
      throw new GitHubAuthorizationError();
    } finally { clearTimeout(timer); }
  }

  async function refresh(settings, entry) {
    const key = await privateKey(settings.pem, cryptoImpl);
    const seconds = Math.floor(now() / 1000);
    const message = base64url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))) + '.'
      + base64url(encoder.encode(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: settings.appId })));
    const jwt = message + '.' + base64url(new Uint8Array(await cryptoImpl.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(message))));
    const installation = await request(`/repos/${REPOSITORY}/installation`, jwt);
    if (String(installation.id) !== settings.installationId || String(installation.app_id) !== settings.appId
      || installation.account?.login?.toLowerCase() !== 'wzz79229' || installation.permissions?.contents !== 'write'
      || installation.suspended_at !== null) throw new GitHubAuthorizationError();
    const result = await request(`/app/installations/${settings.installationId}/access_tokens`, jwt, { repositories: ['bzq'], permissions: { contents: 'write' } });
    const expires = Date.parse(result.expires_at);
    if (typeof result.token !== 'string' || !result.token || result.token.length > 32768 || /[\s\x00-\x1f\x7f]/.test(result.token)
      || !Number.isFinite(expires) || expires <= now() + 90000 || expires > now() + 3660000
      || result.permissions?.contents !== 'write' || Object.entries(result.permissions).some(([name, level]) => !['contents', 'metadata'].includes(name) && level !== 'none')
      || result.permissions.metadata !== undefined && result.permissions.metadata !== 'read'
      || !Array.isArray(result.repositories) || result.repositories.length !== 1 || result.repositories[0]?.full_name?.toLowerCase() !== REPOSITORY.toLowerCase()) {
      throw new GitHubAuthorizationError();
    }
    entry.value = result.token;
    entry.expires = expires;
    return result.token;
  }

  const token = async env => {
    let settings;
    try { settings = config(env); }
    catch (error) { current = null; throw error; }
    if (settings.mode === 'pat') { current = null; return settings.token; }
    const digest = base64url(new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', encoder.encode(settings.pem))));
    const identity = `${settings.appId}:${settings.installationId}:${digest}`;
    if (current?.identity !== identity) current = { identity, value: null, expires: 0, pending: null };
    const entry = current;
    if (entry.value && entry.expires > now() + 90000) return entry.value;
    if (!entry.pending) {
      entry.pending = refresh(settings, entry).catch(error => {
        entry.value = null; entry.expires = 0;
        if (error instanceof GitHubAuthorizationError) throw error;
        throw new GitHubAuthorizationError();
      }).finally(() => { entry.pending = null; });
    }
    return entry.pending;
  };
  token.invalidate = () => { current = null; };
  return token;
}

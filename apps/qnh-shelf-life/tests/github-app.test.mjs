import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify, webcrypto } from 'node:crypto';
import { createGitHubAuthorization, validateGitHubAuthorization, GitHubAuthorizationError } from '../backend/github-app.mjs';
import { createWorker } from '../backend/worker.mjs';

// Ephemeral test-only RSA key; never connects to GitHub or a real installation.
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
const PKCS1 = keys.privateKey.export({ type: 'pkcs1', format: 'pem' });
const START = Date.parse('2026-10-17T06:00:00Z');
const APP = { GITHUB_APP_ID: '123', GITHUB_APP_INSTALLATION_ID: '456', GITHUB_APP_PRIVATE_KEY: PEM };
const installation = () => ({ id: 456, app_id: 123, account: { login: 'Wzz79229' }, permissions: { contents: 'write' }, suspended_at: null });
const issued = (time, extra = {}) => ({ token: 'ghs_synthetic_' + 'x'.repeat(2000), expires_at: new Date(time + 3600000).toISOString(),
  permissions: { contents: 'write', metadata: 'read' }, repositories: [{ full_name: 'Wzz79229/bzq' }], ...extra });

function fixture({ changeInstallation = value => value, changeToken = value => value, fail = () => false } = {}) {
  let time = START;
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (fail(calls.length)) throw new Error('PRIVATE_EXCEPTION_DO_NOT_REFLECT');
    const jwt = options.headers.Authorization.slice(7);
    const [header, payload, signature] = jwt.split('.');
    assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'RS256');
    const claims = JSON.parse(Buffer.from(payload, 'base64url'));
    assert.equal(claims.iss, '123');
    assert.equal(claims.iat, Math.floor(time / 1000) - 60);
    assert.ok(claims.exp <= Math.floor(time / 1000) + 600);
    assert.equal(verify('RSA-SHA256', Buffer.from(header + '.' + payload), keys.publicKey, Buffer.from(signature, 'base64url')), true);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.cache, 'no-store');
    assert.equal(Object.hasOwn(options, 'credentials'), false);
    assert.equal(new Headers(options.headers).has('Cookie'), false);
    if (options.method === 'GET') {
      assert.equal(url, 'https://api.github.com/repos/Wzz79229/bzq/installation');
      return Response.json(changeInstallation(installation()));
    }
    assert.equal(url, 'https://api.github.com/app/installations/456/access_tokens');
    assert.deepEqual(JSON.parse(options.body), { repositories: ['bzq'], permissions: { contents: 'write' } });
    return Response.json(changeToken(issued(time)));
  };
  const token = createGitHubAuthorization({ fetchImpl, now: () => time, cryptoImpl: webcrypto });
  return { calls, token, advance: value => { time += value; } };
}

test('App configuration is complete and never falls back to PAT when partially filled', () => {
  assert.deepEqual(validateGitHubAuthorization(APP), { mode: 'app' });
  assert.deepEqual(validateGitHubAuthorization({ GITHUB_TOKEN: 'synthetic_pat' }), { mode: 'pat' });
  for (const bad of [{}, { GITHUB_TOKEN: '' }, { GITHUB_TOKEN: 'bad token' }, { ...APP, GITHUB_APP_ID: '1/path' },
    { GITHUB_TOKEN: 'synthetic_pat', GITHUB_APP_ID: '123' }, { ...APP, GITHUB_APP_PRIVATE_KEY: '' }]) {
    assert.throws(() => validateGitHubAuthorization(bad), error => error.code === 'SETUP_REQUIRED');
  }
});

test('PAT compatibility stays server-only and performs no App network request', async () => {
  const token = createGitHubAuthorization({ fetchImpl: () => { throw new Error('unexpected'); } });
  assert.equal(await token({ GITHUB_TOKEN: ' synthetic_pat ' }), 'synthetic_pat');
});

for (const [kind, pem] of [['PKCS8', PEM], ['PKCS1', PKCS1]]) {
  for (const [format, value] of [['LF', pem], ['CRLF', pem.replace(/\n/g, '\r\n')],
    ['dashboard single line', pem.replace(/[\r\n]/g, '')], ['ASCII whitespace', pem.replace(/\n/g, ' \t')]]) {
    test(`real RSA signature and restricted installation token with ${kind} ${format}`, async () => {
      const f = fixture();
      const token = await f.token({ ...APP, GITHUB_APP_PRIVATE_KEY: value });
      assert.equal(token, issued(START).token);
      assert.ok(token.length > 512);
      assert.equal(f.calls.length, 2);
    });
  }
}

test('PEM normalization rejects mismatched labels, missing armor and non-base64 content before network access', async () => {
  for (const value of [PEM.replace('END PRIVATE KEY', 'END RSA PRIVATE KEY'), PKCS1.replace('END RSA PRIVATE KEY', 'END PRIVATE KEY'),
    PEM.replace(/^-----BEGIN PRIVATE KEY-----\n/, ''), PEM.replace(/\n/g, '\\n'), PEM.replace('\n', '\u00a0'),
    '-----BEGIN PRIVATE KEY----- \t\r\n-----END PRIVATE KEY-----', 'x'.repeat(32769)]) {
    const f = fixture();
    await assert.rejects(f.token({ ...APP, GITHUB_APP_PRIVATE_KEY: value }), error => error.code === 'SETUP_REQUIRED');
    assert.equal(f.calls.length, 0);
  }
});

test('PEM formatting differences preserve the existing installation-token cache', async () => {
  const f = fixture();
  await f.token(APP);
  await f.token({ ...APP, GITHUB_APP_PRIVATE_KEY: PEM.replace(/[\r\n]/g, '') });
  assert.equal(f.calls.length, 2);
});

test('concurrent requests share minting; expiry margin refreshes and explicit invalidation works', async () => {
  const f = fixture();
  const values = await Promise.all(Array.from({ length: 8 }, () => f.token(APP)));
  assert.ok(values.every(value => value === values[0]));
  assert.equal(f.calls.length, 2);
  await f.token(APP); assert.equal(f.calls.length, 2);
  f.advance(3600000 - 90000);
  await f.token(APP); assert.equal(f.calls.length, 4);
  f.token.invalidate();
  await f.token(APP); assert.equal(f.calls.length, 6);
});

test('private-key configuration rotation cannot reuse the previous cache', async () => {
  const f = fixture();
  await f.token(APP);
  await f.token({ ...APP, GITHUB_APP_PRIVATE_KEY: PKCS1 });
  assert.equal(f.calls.length, 4);
});

test('wrong account, app, installation, permission or suspension is denied before minting', async () => {
  for (const patch of [{ id: 789 }, { app_id: 789 }, { account: { login: 'other' } }, { permissions: { contents: 'read' } }, { suspended_at: '2026-10-17T00:00:00Z' }]) {
    const f = fixture({ changeInstallation: value => ({ ...value, ...patch }) });
    await assert.rejects(f.token(APP), error => error instanceof GitHubAuthorizationError && error.code === 'GITHUB_APP_SCOPE_INVALID');
    assert.equal(f.calls.length, 1);
  }
});

test('token response cannot widen scope or return missing, expired, oversized or invalid credentials', async () => {
  for (const patch of [{ repositories: [{ full_name: 'other/repo' }] }, { repositories: [{ full_name: 'Wzz79229/bzq' }, { full_name: 'Wzz79229/qnh' }] },
    { permissions: { contents: 'read' } }, { permissions: { contents: 'write', issues: 'write' } }, { permissions: { contents: 'write', metadata: 'write' } },
    { token: 'bad token' }, { token: '' }, { token: 'x'.repeat(32769) }, { expires_at: new Date(START + 10000).toISOString() },
    { expires_at: new Date(START + 7200000).toISOString() }]) {
    const f = fixture({ changeToken: value => ({ ...value, ...patch }) });
    await assert.rejects(f.token(APP), error => error instanceof GitHubAuthorizationError && error.code === 'GITHUB_APP_SCOPE_INVALID');
  }
});

test('a failed refresh is not cached or reflected; subsequent attempt can recover', async () => {
  const f = fixture({ fail: call => call === 1 });
  await assert.rejects(f.token(APP), error => error instanceof GitHubAuthorizationError
    && error.code === 'GITHUB_APP_INSTALLATION_FAILED' && !error.message.includes('PRIVATE_EXCEPTION'));
  assert.equal(await f.token(APP), issued(START).token);
  assert.equal(f.calls.length, 3);
});

test('invalid DER never makes a network request or exposes private-key material', async () => {
  const f = fixture();
  await assert.rejects(f.token({ ...APP, GITHUB_APP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nYQ==\n-----END PRIVATE KEY-----\n' }), error => error.code === 'GITHUB_APP_INVALID_KEY');
  assert.equal(f.calls.length, 0);
});

test('redirects, malformed JSON and bounded response overflow fail closed', async () => {
  for (const response of [new Response('', { status: 302, headers: { Location: 'https://other.example' } }), new Response('not json'),
    new Response('{}', { headers: { 'Content-Length': '65537' } }), new Response('x'.repeat(65537))]) {
    const token = createGitHubAuthorization({ fetchImpl: async () => response, now: () => START, cryptoImpl: webcrypto });
    await assert.rejects(token(APP), GitHubAuthorizationError);
  }
});

function phaseFixture(phase, reply) {
  const calls = [];
  const token = createGitHubAuthorization({ now: () => START, cryptoImpl: webcrypto, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    const [header, payload, signature] = options.headers.Authorization.slice(7).split('.');
    assert.equal(verify('RSA-SHA256', Buffer.from(header + '.' + payload), keys.publicKey, Buffer.from(signature, 'base64url')), true);
    assert.equal(options.redirect, 'manual');
    assert.equal(Object.hasOwn(options, 'credentials'), false);
    assert.equal(new Headers(options.headers).has('Cookie'), false);
    if (options.method === 'GET') {
      assert.equal(url, 'https://api.github.com/repos/Wzz79229/bzq/installation');
      if (phase === 'installation') return reply();
      return Response.json(installation());
    }
    assert.equal(url, 'https://api.github.com/app/installations/456/access_tokens');
    assert.deepEqual(JSON.parse(options.body), { repositories: ['bzq'], permissions: { contents: 'write' } });
    return reply();
  } });
  return { token, calls };
}

const PRIVATE_DIAGNOSTIC = 'PRIVATE_BODY_HEADER_AND_EXCEPTION_DO_NOT_REFLECT';

for (const phase of ['installation', 'token']) {
  const expectedCode = phase === 'installation' ? 'GITHUB_APP_INSTALLATION_FAILED' : 'GITHUB_APP_TOKEN_FAILED';
  test(`${phase} never follows redirect status, redirected response or foreign-origin response with App credentials`, async () => {
    const redirects = [301, 302, 307, 308].map(status => () => new Response(PRIVATE_DIAGNOSTIC, {
      status, headers: { Location: `https://untrusted.example/${PRIVATE_DIAGNOSTIC}` },
    }));
    const successfulBody = () => Response.json(phase === 'installation' ? installation() : issued(START));
    redirects.push(() => {
      const response = successfulBody();
      Object.defineProperty(response, 'redirected', { value: true });
      return response;
    }, () => {
      const response = successfulBody();
      Object.defineProperty(response, 'url', { value: `https://untrusted.example/${PRIVATE_DIAGNOSTIC}` });
      return response;
    });
    for (const reply of redirects) {
      const f = phaseFixture(phase, reply);
      await assert.rejects(f.token(APP), error => error.code === expectedCode && !Object.hasOwn(error, 'upstreamStatus'));
      assert.equal(f.calls.length, phase === 'installation' ? 1 : 2);
      assert.equal(f.calls.filter(call => call.options.method === 'POST').length, phase === 'installation' ? 0 : 1);
      assert.ok(f.calls.every(call => new URL(call.url).origin === 'https://api.github.com'));
    }
  });

  test(`${phase} HTTP, network and invalid responses receive a fixed phase code without sensitive reflection`, async () => {
    const cases = [
      ...[400, 401, 403, 404, 422, 429, 500, 599].map(status => [() => new Response(PRIVATE_DIAGNOSTIC, {
        status, headers: { 'X-Private-Diagnostic': PRIVATE_DIAGNOSTIC },
      }), status]),
      [() => new Response(PRIVATE_DIAGNOSTIC, { status: 302, headers: { Location: `https://untrusted.example/${PRIVATE_DIAGNOSTIC}` } })],
      [() => new Response(PRIVATE_DIAGNOSTIC)],
      [() => new Response('[]')],
      [() => new Response('{}', { headers: { 'Content-Length': '65537' } })],
      [() => new Response('x'.repeat(65537))],
      [() => { throw Object.assign(new Error(PRIVATE_DIAGNOSTIC), { code: PRIVATE_DIAGNOSTIC, upstreamStatus: 403 }); }],
    ];
    for (const [reply, upstreamStatus] of cases) {
      const f = phaseFixture(phase, reply);
      await assert.rejects(f.token(APP), error => {
        assert.ok(error instanceof GitHubAuthorizationError);
        assert.equal(error.code, expectedCode);
        assert.equal(error.status, 502);
        assert.equal(error.upstreamStatus, upstreamStatus);
        if (upstreamStatus === undefined) assert.equal(Object.hasOwn(error, 'upstreamStatus'), false);
        const diagnostic = JSON.stringify({ ...error, message: error.message });
        for (const secret of [PRIVATE_DIAGNOSTIC, PEM, PKCS1, issued(START).token,
          ...f.calls.map(call => call.options.headers.Authorization.slice(7))]) {
          assert.equal(diagnostic.includes(secret), false);
        }
        return true;
      });
      assert.equal(f.calls.length, phase === 'installation' ? 1 : 2);
    }
  });

  test(`${phase} timeout retains TIMEOUT without an upstream HTTP status`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let started;
    const waiting = new Promise(resolve => { started = resolve; });
    const f = phaseFixture(phase, () => { started(); return new Promise(() => {}); });
    const rejected = assert.rejects(f.token(APP), error => {
      assert.equal(error.code, 'GITHUB_APP_TIMEOUT');
      assert.equal(error.status, 504);
      assert.equal(Object.hasOwn(error, 'upstreamStatus'), false);
      return true;
    });
    await waiting;
    t.mock.timers.tick(10000);
    await rejected;
  });
}

test('malformed installation and token scope fields cannot escape classification as generic exceptions', async () => {
  for (const patch of [{ id: { toString: 'not-a-function' } }, { account: { login: 123 } }]) {
    const f = fixture({ changeInstallation: value => ({ ...value, ...patch }) });
    await assert.rejects(f.token(APP), error => error.code === 'GITHUB_APP_SCOPE_INVALID' && !Object.hasOwn(error, 'upstreamStatus'));
    assert.equal(f.calls.length, 1);
  }
  for (const patch of [{ expires_at: { toString: 'not-a-function' } }, { repositories: [{ full_name: 123 }] }]) {
    const f = fixture({ changeToken: value => ({ ...value, ...patch }) });
    await assert.rejects(f.token(APP), error => error.code === 'GITHUB_APP_SCOPE_INVALID' && !Object.hasOwn(error, 'upstreamStatus'));
  }
});

test('App authorization succeeds with real RSA JWTs on a Worker fetch that rejects browser-only request options', async () => {
  const calls = [];
  const workerCompatibleFetch = async (url, options) => {
    if (options.redirect === 'error') throw new TypeError('Unsupported redirect mode');
    if (Object.hasOwn(options, 'credentials')) throw new TypeError('Unsupported credentials option');
    calls.push({ url, options });
    assert.equal(options.redirect, 'manual');
    assert.equal(new Headers(options.headers).has('Cookie'), false);
    const [header, payload, signature] = options.headers.Authorization.slice(7).split('.');
    assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'RS256');
    assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).iss, APP.GITHUB_APP_ID);
    assert.equal(verify('RSA-SHA256', Buffer.from(header + '.' + payload), keys.publicKey, Buffer.from(signature, 'base64url')), true);
    if (options.method === 'GET') {
      assert.equal(url, 'https://api.github.com/repos/Wzz79229/bzq/installation');
      return Response.json(installation());
    }
    assert.equal(url, 'https://api.github.com/app/installations/456/access_tokens');
    assert.deepEqual(JSON.parse(options.body), { repositories: ['bzq'], permissions: { contents: 'write' } });
    return Response.json(issued(START));
  };
  await assert.rejects(workerCompatibleFetch('https://api.github.com/test', { redirect: 'error' }), /Unsupported redirect mode/);
  await assert.rejects(workerCompatibleFetch('https://api.github.com/test', { redirect: 'manual', credentials: 'omit' }), /Unsupported credentials option/);
  const token = createGitHubAuthorization({ fetchImpl: workerCompatibleFetch, now: () => START, cryptoImpl: webcrypto });
  assert.equal(await token(APP), issued(START).token);
  assert.equal(calls.length, 2);
});

test('Worker authenticates members before minting, then uses App token for fixed state reads', async () => {
  const environment = { ...APP, MEMBER_AUTH_MODE: 'legacy', TEAM_PASSWORD: 'synthetic-admin-password', SESSION_SECRET: 'synthetic-independent-session-secret-0123456789', ALLOWED_ORIGIN: 'https://wzz79229.github.io' };
  const data = { schemaVersion: 1, records: [], settings: { urgentDays: 7, warningDays: 30 }, updatedAt: '2026-10-17T06:00:00.000Z' };
  let repositoryCalls = 0;
  const worker = createWorker({ now: () => START, cryptoImpl: webcrypto, fetchImpl: async (url, options) => {
    if (url.endsWith('/installation') || url.endsWith('/access_tokens')) {
      // Use the same strict signing assertions as the isolated provider fixtures.
      const jwt = options.headers.Authorization.slice(7).split('.');
      assert.equal(verify('RSA-SHA256', Buffer.from(jwt[0] + '.' + jwt[1]), keys.publicKey, Buffer.from(jwt[2], 'base64url')), true);
      return Response.json(url.endsWith('/installation') ? installation() : issued(START));
    }
    repositoryCalls++;
    assert.equal(url, 'https://api.github.com/repos/Wzz79229/bzq/contents/data/shelf-life.json?ref=main');
    assert.equal(options.headers.Authorization, 'Bearer ' + issued(START).token);
    return Response.json({ type: 'file', sha: 'a'.repeat(40), encoding: 'base64', content: Buffer.from(JSON.stringify(data)).toString('base64') });
  } });
  const request = (path, options = {}) => worker.fetch(new Request('https://example.workers.dev/api/' + path, { headers: { Origin: environment.ALLOWED_ORIGIN, ...options.headers }, ...options, ...(options.headers ? { headers: { Origin: environment.ALLOWED_ORIGIN, ...options.headers } } : {}) }), environment);
  assert.equal((await request('state')).status, 401);
  assert.equal(repositoryCalls, 0);
  const login = await request('login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: environment.TEAM_PASSWORD }) });
  const cookie = login.headers.get('Set-Cookie').split(';')[0];
  const result = await request('state', { headers: { Cookie: cookie } });
  assert.equal(result.status, 200);
  assert.deepEqual((await result.json()).data, data);
  assert.equal(repositoryCalls, 1);
});

const ORIGIN = 'https://wzz79229.github.io';

function readinessFixture({ fail = () => false, changeInstallation = value => value, changeToken = value => value,
  beforeFetch = async () => {}, responseFor = () => null } = {}) {
  let time = START;
  const calls = [];
  const installations = new Map([['123', '456'], ['124', '456']]);
  const environment = { ...APP, ALLOWED_ORIGIN: ORIGIN };
  const worker = createWorker({ now: () => time, cryptoImpl: webcrypto, fetchImpl: async (url, options) => {
    const call = { url, options };
    calls.push(call);
    const jwt = options.headers.Authorization.slice(7);
    const [header, payload, signature] = jwt.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url'));
    assert.equal(verify('RSA-SHA256', Buffer.from(header + '.' + payload), keys.publicKey, Buffer.from(signature, 'base64url')), true);
    assert.equal(options.redirect, 'manual');
    assert.equal(Object.hasOwn(options, 'credentials'), false);
    assert.equal(new Headers(options.headers).has('Cookie'), false);
    await beforeFetch(call, calls.length);
    if (fail(call, calls.length)) throw new Error('PRIVATE_UPSTREAM_EXCEPTION_DO_NOT_REFLECT');
    const override = responseFor(call, calls.length);
    if (override) return override;
    const installationId = installations.get(claims.iss);
    assert.ok(installationId, 'The test only permits synthetic known app IDs');
    if (options.method === 'GET') {
      assert.equal(url, 'https://api.github.com/repos/Wzz79229/bzq/installation');
      return Response.json(changeInstallation({ ...installation(), app_id: Number(claims.iss), id: Number(installationId) }));
    }
    assert.equal(options.method, 'POST');
    assert.equal(url, `https://api.github.com/app/installations/${installationId}/access_tokens`);
    assert.deepEqual(JSON.parse(options.body), { repositories: ['bzq'], permissions: { contents: 'write' } });
    return Response.json(changeToken(issued(time)));
  } });
  const request = (path = 'session', options = {}, env = environment) => {
    const { origin = ORIGIN, headers = {}, ...init } = options;
    return worker.fetch(new Request('https://example.workers.dev/api/' + path, {
      ...init, headers: { ...(origin === null ? {} : { Origin: origin }), 'Content-Type': 'application/json', ...headers },
    }), env);
  };
  return { calls, environment, request, advance: value => { time += value; }, setInstallation: (app, id) => installations.set(app, id) };
}

function assertPendingIdentity(body, githubAuthorization) {
  assert.equal(body.configured, true);
  assert.equal(body.authorized, false);
  assert.equal(body.loginMethod, 'qnh_pending');
  assert.equal(body.githubAuthorization, githubAuthorization);
}

function assertNoAuthorizationDisclosure(body, calls) {
  const serialized = JSON.stringify(body);
  for (const secret of [PEM, PKCS1, issued(START).token, 'PRIVATE_UPSTREAM_EXCEPTION_DO_NOT_REFLECT',
    ...calls.map(call => call.options.headers.Authorization.slice(7))]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.doesNotMatch(serialized, /BEGIN (?:RSA )?PRIVATE KEY|ghs_synthetic_|"(?:token|jwt|pem|privateKey|installation)"/u);
}

test('QNH session verifies only fixed App installation and scoped minting without granting identity or disclosing credentials', async () => {
  const f = readinessFixture();
  const response = await f.request();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.match(response.headers.get('Cache-Control'), /no-store/);
  const body = await response.json();
  assertPendingIdentity(body, 'ready');
  assertNoAuthorizationDisclosure(body, f.calls);
  assert.deepEqual(f.calls.map(call => [call.options.method, call.url]), [
    ['GET', 'https://api.github.com/repos/Wzz79229/bzq/installation'],
    ['POST', 'https://api.github.com/app/installations/456/access_tokens'],
  ]);
  await f.request();
  f.advance(29999);
  await f.request();
  assert.equal(f.calls.length, 2);
  f.advance(1);
  assertPendingIdentity(await (await f.request()).json(), 'ready');
  assert.equal(f.calls.length, 2, 'Health cache expiry must preserve the provider installation-token cache');
});

test('QNH session failure is generic, backs off for 30 seconds and recovers without exposing upstream details', async () => {
  let unavailable = true;
  const f = readinessFixture({ fail: () => unavailable });
  const first = await f.request();
  assert.equal(first.status, 503);
  assert.equal(first.headers.get('Retry-After'), '30');
  assert.equal(first.headers.get('Set-Cookie'), null);
  const failure = await first.json();
  assertPendingIdentity(failure, 'unavailable');
  assert.equal(failure.code, 'GITHUB_APP_AUTH_FAILED');
  assert.equal(failure.githubAuthorizationDetail, 'GITHUB_APP_INSTALLATION_FAILED');
  assert.equal(Object.hasOwn(failure, 'githubAuthorizationStatus'), false);
  assertNoAuthorizationDisclosure(failure, f.calls);
  assert.equal(f.calls.length, 1);
  unavailable = false;
  f.advance(29999);
  const cached = await f.request();
  assert.equal(cached.status, 503);
  assert.deepEqual(await cached.json(), failure);
  assert.equal(f.calls.length, 1);
  f.advance(1);
  const recovered = await f.request();
  assert.equal(recovered.status, 200);
  assertPendingIdentity(await recovered.json(), 'ready');
  assert.equal(f.calls.length, 3);
});

test('concurrent QNH readiness checks share one pending installation and token request', async () => {
  let release;
  let started;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { started = resolve; });
  const f = readinessFixture({ beforeFetch: async (_call, count) => { if (count === 1) { started(); await gate; } } });
  const pending = Array.from({ length: 8 }, () => f.request());
  await waiting;
  assert.equal(f.calls.length, 1);
  release();
  const responses = await Promise.all(pending);
  for (const response of responses) {
    assert.equal(response.status, 200);
    assertPendingIdentity(await response.json(), 'ready');
  }
  assert.equal(f.calls.length, 2);
});

test('each App configuration field invalidates readiness immediately instead of reusing a prior success', async () => {
  for (const patch of [{ GITHUB_APP_ID: '124' }, { GITHUB_APP_INSTALLATION_ID: '789' }, { GITHUB_APP_PRIVATE_KEY: PKCS1 }]) {
    const f = readinessFixture();
    assert.equal((await f.request()).status, 200);
    if (patch.GITHUB_APP_INSTALLATION_ID) f.setInstallation('123', patch.GITHUB_APP_INSTALLATION_ID);
    assert.equal((await f.request('session', {}, { ...f.environment, ...patch })).status, 200);
    assert.equal(f.calls.length, 4);
  }
});

test('configuration rotation also bypasses a cached failure and incomplete configuration never reuses ready', async () => {
  let unavailable = true;
  const f = readinessFixture({ fail: () => unavailable });
  assert.equal((await f.request()).status, 503);
  unavailable = false;
  assert.equal((await f.request('session', {}, { ...f.environment, GITHUB_APP_ID: '124' })).status, 200);
  assert.equal(f.calls.length, 3);
  const incomplete = await f.request('session', {}, { ...f.environment, GITHUB_APP_PRIVATE_KEY: '' });
  assert.equal(incomplete.status, 503);
  assert.equal((await incomplete.json()).code, 'SETUP_REQUIRED');
  assert.equal(f.calls.length, 3);
});

test('bad DER, denied installation and widened minted token never appear ready', async () => {
  const malformed = readinessFixture();
  const response = await malformed.request('session', {}, { ...malformed.environment,
    GITHUB_APP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----YQ==-----END PRIVATE KEY-----' });
  assert.equal(response.status, 503);
  const malformedBody = await response.json();
  assertPendingIdentity(malformedBody, 'unavailable');
  assert.equal(malformedBody.githubAuthorizationDetail, 'GITHUB_APP_INVALID_KEY');
  assert.equal(Object.hasOwn(malformedBody, 'githubAuthorizationStatus'), false);
  assert.equal(malformed.calls.length, 0);
  for (const options of [{ changeInstallation: value => ({ ...value, account: { login: 'other' } }) },
    { changeToken: value => ({ ...value, repositories: [{ full_name: 'Wzz79229/qnh' }] }) }]) {
    const f = readinessFixture(options);
    const denied = await f.request();
    assert.equal(denied.status, 503);
    const body = await denied.json();
    assertPendingIdentity(body, 'unavailable');
    assert.equal(body.githubAuthorizationDetail, 'GITHUB_APP_SCOPE_INVALID');
    assert.equal(Object.hasOwn(body, 'githubAuthorizationStatus'), false);
    assertNoAuthorizationDisclosure(body, f.calls);
  }
});

test('readiness exposes only fixed phase and numeric HTTP diagnostics while keeping the main error code unchanged', async () => {
  for (const [method, status, detail] of [['GET', 401, 'GITHUB_APP_INSTALLATION_FAILED'], ['POST', 403, 'GITHUB_APP_TOKEN_FAILED']]) {
    const f = readinessFixture({ responseFor: call => call.options.method === method
      ? new Response(PRIVATE_DIAGNOSTIC, { status, headers: { 'X-Private': PRIVATE_DIAGNOSTIC } }) : null });
    const response = await f.request();
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.code, 'GITHUB_APP_AUTH_FAILED');
    assert.equal(body.githubAuthorizationDetail, detail);
    assert.equal(body.githubAuthorizationStatus, status);
    assertPendingIdentity(body, 'unavailable');
    assertNoAuthorizationDisclosure(body, f.calls);
    assert.equal(JSON.stringify(body).includes(PRIVATE_DIAGNOSTIC), false);
    assert.equal(response.headers.get('X-Private'), null);
    const previousCalls = f.calls.length;
    assert.deepEqual(await (await f.request()).json(), body);
    assert.equal(f.calls.length, previousCalls);
  }
});

test('readiness maps unknown provider exceptions to AUTH_FAILED without an invented HTTP status', async () => {
  const worker = createWorker({ now: () => START, cryptoImpl: { subtle: { digest: async () => {
    throw Object.assign(new Error(PRIVATE_DIAGNOSTIC), { code: 'PRIVATE_UNTRUSTED_ERROR_CODE', upstreamStatus: 401 });
  } } }, fetchImpl: async () => { throw new Error('No network request expected'); } });
  const response = await worker.fetch(new Request('https://example.workers.dev/api/session', { headers: { Origin: ORIGIN } }), { ...APP, ALLOWED_ORIGIN: ORIGIN });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, 'GITHUB_APP_AUTH_FAILED');
  assert.equal(body.githubAuthorizationDetail, 'GITHUB_APP_AUTH_FAILED');
  assert.equal(Object.hasOwn(body, 'githubAuthorizationStatus'), false);
  assertPendingIdentity(body, 'unavailable');
  assert.equal(JSON.stringify(body).includes(PRIVATE_DIAGNOSTIC), false);
  assert.equal(JSON.stringify(body).includes('PRIVATE_UNTRUSTED_ERROR_CODE'), false);
});

test('invalid origins, preflight and unauthenticated member routes do not trigger any App probe', async () => {
  const f = readinessFixture();
  assert.equal((await f.request('session', { origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await f.request('session', { origin: null, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const preflight = await f.request('session', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'GET' } });
  assert.equal(preflight.status, 204);
  assert.equal((await f.request('session', { method: 'POST' })).status, 405);
  for (const [path, options = {}] of [['state'], ['catalog'], ['catalog/pages/0'],
    ['photos/12345678-1234-4234-8234-123456789abc'], ['photos', { method: 'POST', body: '{}' }],
    ['qnh/queries', { method: 'POST', body: JSON.stringify({ sku: 'synthetic' }) }]]) {
    const response = await f.request(path, options);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'QNH_LOGIN_NOT_CONNECTED');
  }
  const login = await f.request('login', { method: 'POST', body: JSON.stringify({ password: 'must-not-grant-access' }) });
  assert.equal((await login.json()).code, 'QNH_LOGIN_NOT_CONNECTED');
  assert.equal(f.calls.length, 0);
});

test('App readiness does not let a legacy cookie or password stand in for QNH employee identity', async () => {
  const f = readinessFixture();
  const legacyEnv = { ...f.environment, MEMBER_AUTH_MODE: 'legacy', TEAM_PASSWORD: 'synthetic-legacy-password', SESSION_SECRET: 'synthetic-legacy-session-secret-0123456789' };
  const login = await f.request('login', { method: 'POST', body: JSON.stringify({ password: legacyEnv.TEAM_PASSWORD }) }, legacyEnv);
  assert.equal(login.status, 200);
  const oldCookie = login.headers.get('Set-Cookie').split(';')[0];
  assert.equal(f.calls.length, 0);
  assertPendingIdentity(await (await f.request('session', { headers: { Cookie: oldCookie } })).json(), 'ready');
  for (const path of ['state', 'catalog', 'qnh/queries/12345678-1234-4234-8234-123456789abc']) {
    assert.equal((await f.request(path, { headers: { Cookie: oldCookie } })).status, 503);
  }
  assert.equal(f.calls.length, 2);
});

test('legacy App sessions and QNH PAT sessions keep their previous behavior without readiness probes', async () => {
  const f = readinessFixture();
  const legacyEnv = { ...f.environment, MEMBER_AUTH_MODE: 'legacy', TEAM_PASSWORD: 'synthetic-legacy-password', SESSION_SECRET: 'synthetic-legacy-session-secret-0123456789' };
  assert.deepEqual(await (await f.request('session', {}, legacyEnv)).json(), { configured: true, authorized: false });
  const login = await f.request('login', { method: 'POST', body: JSON.stringify({ password: legacyEnv.TEAM_PASSWORD }) }, legacyEnv);
  const oldCookie = login.headers.get('Set-Cookie').split(';')[0];
  assert.deepEqual(await (await f.request('session', { headers: { Cookie: oldCookie } }, legacyEnv)).json(), { configured: true, authorized: true });
  const patEnv = { GITHUB_TOKEN: 'synthetic_pat', MEMBER_AUTH_MODE: 'qnh', ALLOWED_ORIGIN: ORIGIN };
  const body = await (await f.request('session', {}, patEnv)).json();
  assertPendingIdentity(body, undefined);
  assert.equal(f.calls.length, 0);
});

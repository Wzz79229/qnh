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
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.credentials, 'omit');
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

for (const pem of [PEM, PKCS1]) {
  test(`real RSA signature and restricted installation token with ${pem.includes('RSA PRIVATE') ? 'PKCS1' : 'PKCS8'}`, async () => {
    const f = fixture();
    const value = await f.token({ ...APP, GITHUB_APP_PRIVATE_KEY: pem });
    assert.equal(value, issued(START).token);
    assert.ok(value.length > 512);
    assert.equal(f.calls.length, 2);
  });
}

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
    await assert.rejects(f.token(APP), GitHubAuthorizationError);
    assert.equal(f.calls.length, 1);
  }
});

test('token response cannot widen scope or return missing, expired, oversized or invalid credentials', async () => {
  for (const patch of [{ repositories: [{ full_name: 'other/repo' }] }, { repositories: [{ full_name: 'Wzz79229/bzq' }, { full_name: 'Wzz79229/qnh' }] },
    { permissions: { contents: 'read' } }, { permissions: { contents: 'write', issues: 'write' } }, { permissions: { contents: 'write', metadata: 'write' } },
    { token: 'bad token' }, { token: '' }, { token: 'x'.repeat(32769) }, { expires_at: new Date(START + 10000).toISOString() },
    { expires_at: new Date(START + 7200000).toISOString() }]) {
    const f = fixture({ changeToken: value => ({ ...value, ...patch }) });
    await assert.rejects(f.token(APP), GitHubAuthorizationError);
  }
});

test('a failed refresh is not cached or reflected; subsequent attempt can recover', async () => {
  const f = fixture({ fail: call => call === 1 });
  await assert.rejects(f.token(APP), error => error instanceof GitHubAuthorizationError && !error.message.includes('PRIVATE_EXCEPTION'));
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

test('App defaults to QNH identity mode, does not require a team password and cannot grant data access', async () => {
  let requests = 0;
  const worker = createWorker({ now: () => START, cryptoImpl: webcrypto, fetchImpl: async () => { requests++; throw new Error('unexpected'); } });
  const environment = { ...APP, ALLOWED_ORIGIN: 'https://wzz79229.github.io' };
  const request = (path, options = {}) => worker.fetch(new Request('https://example.workers.dev/api/' + path, {
    ...options, headers: { Origin: environment.ALLOWED_ORIGIN, 'Content-Type': 'application/json', ...options.headers },
  }), environment);
  const session = await (await request('session')).json();
  assert.equal(session.authorized, false);
  assert.equal(session.loginMethod, 'qnh_pending');
  assert.equal((await request('state')).status, 503);
  assert.equal((await request('qnh/queries', { method: 'POST', body: JSON.stringify({ sku: 'synthetic' }) })).status, 503);
  const login = await request('login', { method: 'POST', body: JSON.stringify({ password: 'must-not-grant-access' }) });
  assert.equal((await login.json()).code, 'QNH_LOGIN_NOT_CONNECTED');
  const legacyEnv = { ...environment, MEMBER_AUTH_MODE: 'legacy', TEAM_PASSWORD: 'synthetic-legacy-password', SESSION_SECRET: 'synthetic-legacy-session-secret-0123456789' };
  const legacyLogin = await worker.fetch(new Request('https://example.workers.dev/api/login', {
    method: 'POST', headers: { Origin: environment.ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: legacyEnv.TEAM_PASSWORD }),
  }), legacyEnv);
  const oldCookie = legacyLogin.headers.get('Set-Cookie').split(';')[0];
  assert.equal((await request('session', { headers: { Cookie: oldCookie } }).then(value => value.json())).authorized, false);
  assert.equal((await request('state', { headers: { Cookie: oldCookie } })).status, 503);
  assert.equal(requests, 0);
});

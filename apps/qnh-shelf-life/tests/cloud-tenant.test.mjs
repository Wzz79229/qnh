import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudStore } from '../dist/cloud.mjs';

const TENANT = '1012619';
const BASE = 'https://team.example';
const ready = tenantId => ({ configured: true, authorized: true, loginMethod: 'qnh_browser', tenantId });
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function setup() {
  const calls = [];
  const responses = [];
  const store = new CloudStore(BASE, async (url, options) => {
    calls.push({ url, options, tenant: new Headers(options.headers).get('X-QNH-Tenant') });
    return responses.shift() || reply({});
  });
  return { store, calls, respond(body, status = 200) { responses.push(reply(body, status)); } };
}

test('the same CloudStore binds a verified server tenant before its first business read and carries it on every business route', async () => {
  const h = setup();
  h.respond(ready(TENANT));
  await h.store.session();
  const operations = [() => h.store.read(), () => h.store.write({ records: [] }, null), () => h.store.createSkuQuery('0001'),
    () => h.store.skuQuery('query-id'), () => h.store.catalog(), () => h.store.catalogPage(0),
    () => h.store.uploadPhoto('photo-id', 'data:image/jpeg;base64,AA=='), () => h.store.photo('photo-id')];
  for (const operation of operations) await operation();
  assert.equal(h.calls[0].tenant, null);
  assert.ok(h.calls.slice(1).every(value => value.tenant === TENANT));
  assert.equal(h.calls.find(value => value.url.endsWith('/api/state') && value.options.method === 'PUT').options.headers['Content-Type'], 'application/json');
});

test('tenant assertions never come from record fields or client-provided business payloads', async () => {
  const h = setup();
  await h.store.write({ tenantId: TENANT, records: [] }, null);
  assert.equal(h.calls[0].tenant, null);
  h.respond(ready(TENANT));
  await h.store.session();
  await h.store.write({ tenantId: '97654321', records: [] }, null);
  assert.equal(h.calls.at(-1).tenant, TENANT);
});

test('session, login and logout carry no tenant assertion and logout clears the old binding', async () => {
  const h = setup();
  h.respond(ready(TENANT));
  await h.store.session();
  await h.store.logout();
  await h.store.read();
  await h.store.login('synthetic-test-password');
  assert.ok(h.calls.every(value => value.tenant === null));
});

test('unverified, malformed or legacy sessions do not bind a tenant from their response', async () => {
  const sessions = [
    { authorized: false, loginMethod: 'qnh_browser', tenantId: TENANT },
    { authorized: 'true', loginMethod: 'qnh_browser', tenantId: TENANT },
    { authorized: true, loginMethod: 'legacy', tenantId: TENANT },
    ...[undefined, '', '0', 1012619, '../1012619', '9'.repeat(21)].map(tenantId => ready(tenantId)),
  ];
  for (const session of sessions) {
    const h = setup();
    h.respond(session);
    await h.store.session();
    await h.store.read();
    assert.equal(h.calls.at(-1).tenant, null);
  }
});

test('reauthentication failure and tenant-change errors erase the previous assertion until a fresh session is verified', async () => {
  for (const code of ['TENANT_CHANGED', 'AUTH_REQUIRED']) {
    const h = setup();
    h.respond(ready(TENANT));
    await h.store.session();
    h.respond({ code, message: '请重新登录。' }, 401);
    await assert.rejects(h.store.read(), error => error.code === code);
    assert.equal(h.calls.at(-1).tenant, TENANT);
    await h.store.read();
    assert.equal(h.calls.at(-1).tenant, null);
    h.respond(ready('97654321'));
    await h.store.session();
    await h.store.read();
    assert.equal(h.calls.at(-1).tenant, '97654321');
  }
});

test('legacy clients retain their existing header-free business behavior', async () => {
  const h = setup();
  h.respond({ configured: true, authorized: true, loginMethod: 'legacy' });
  await h.store.session();
  await h.store.read();
  await h.store.write({ records: [] }, null);
  await h.store.createSkuQuery('0001');
  assert.ok(h.calls.every(value => value.tenant === null));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudStore } from '../dist/cloud.mjs';
import { GitHubStore } from '../dist/github.mjs';
import { CatalogStore } from '../backend/catalog-store.mjs';

// Browser fetch checks its receiver; Node's fetch and arrow mocks do not.
function browserFetch(response) {
  return function () {
    assert.equal(this, globalThis, 'native fetch must keep its global receiver');
    return Promise.resolve(response);
  };
}

test('CloudStore preserves the native fetch receiver for team sessions', async () => {
  const store = new CloudStore('https://qa.example', browserFetch(Response.json({ configured: true, authorized: true })));
  assert.deepEqual(await store.session(), { configured: true, authorized: true });
});

test('GitHubStore preserves the native fetch receiver for repository reads', async () => {
  const doc = { schemaVersion: 1, records: [] };
  const response = Response.json({ type: 'file', encoding: 'base64', size: Buffer.byteLength(JSON.stringify(doc)), content: Buffer.from(JSON.stringify(doc)).toString('base64'), sha: 'a'.repeat(40) });
  const store = new GitHubStore({ owner: 'qa', repo: 'fixture' }, browserFetch(response));
  assert.deepEqual((await store.read()).data, doc);
});

test('CatalogStore preserves the native fetch receiver without exposing provider errors', async () => {
  const store = new CatalogStore({ token: 'test-only-placeholder' }, browserFetch(Response.json({}, { status: 404 })));
  await assert.rejects(store.read(), error => error.code === 'CATALOG_NOT_READY');
});

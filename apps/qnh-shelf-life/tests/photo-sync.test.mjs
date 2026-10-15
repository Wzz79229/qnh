import test from 'node:test';
import assert from 'node:assert/strict';
import { syncPhotoState } from '../dist/photo-sync.mjs';
import { sanitizeState } from '../dist/core.mjs';
import { ConflictError, GitHubError } from '../dist/github.mjs';

const NOW = '2026-10-15T10:00:00.000Z';
const id = index => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const ref = index => ({ id: id(index), path: `photos/${id(index)}.jpg` });
const photoRecord = (name, indices = [], extra = {}) => ({
  id: name, name, productionDate: '', shelfLife: null, shelfUnit: 'day', expiryDate: '2026-11-01',
  quantity: 1, unit: '批', status: 'active', updatedAt: NOW, photoRefs: indices.map(ref), ...extra,
});
const state = (records = [], extra = {}) => sanitizeState({ schemaVersion: 1, records, settings: { urgentDays: 7, warningDays: 30 }, updatedAt: NOW, ...extra });
const pending = indices => new Map(indices.map(index => [id(index), { id: id(index), dataUrl: `data:image/jpeg;base64,photo-${index}` }]));
const allRefs = value => new Set(value.records.flatMap(record => (record.photoRefs || []).map(photo => photo.id)));

function mockStore(baseline = state(), startingSha = 'sha-0') {
  let cloud = structuredClone(baseline), sha = startingSha;
  const events = [], writes = [], uploads = [];
  let writeNumber = 0;
  const store = {
    events, writes, uploads,
    failWrite: null, failUpload: null,
    async read() { events.push(['read', sha]); return { data: structuredClone(cloud), sha }; },
    async uploadPhoto(id, dataUrl) {
      events.push(['upload', id]); uploads.push({ id, dataUrl });
      if (store.failUpload?.(id)) throw new GitHubError('模拟网络中断', 'NETWORK_ERROR');
      return { id, path: `photos/${id}.jpg` };
    },
    async write(data, expectedSha) {
      writeNumber += 1;
      events.push(['write', expectedSha]);
      if (expectedSha !== sha || store.failWrite?.(writeNumber)) throw new ConflictError();
      const previousRefs = cloud === null ? new Set() : allRefs(cloud);
      const additions = [...allRefs(data)].filter(id => !previousRefs.has(id));
      assert.ok(additions.length <= 12, `backend would reject ${additions.length} new refs`);
      for (const record of data.records) assert.ok((record.photoRefs || []).length <= 3);
      cloud = structuredClone(data); sha = `sha-${writeNumber}`;
      writes.push({ data: structuredClone(data), expectedSha, sha, additions });
      return { data: structuredClone(cloud), sha };
    },
    externalUpdate(next, nextSha = 'external-sha') { cloud = structuredClone(next); sha = nextSha; },
  };
  return store;
}

test('15 accumulated photos save as two valid snapshots after all uploads', async () => {
  const desired = state(Array.from({ length: 5 }, (_, i) => photoRecord(`record-${i}`, [i * 3 + 1, i * 3 + 2, i * 3 + 3])));
  const drafts = pending(Array.from({ length: 15 }, (_, i) => i + 1));
  const store = mockStore();
  const shas = [];
  const result = await syncPhotoState(store, desired, 'sha-0', drafts, { onSha: sha => { shas.push(sha); store.events.push(['sha', sha]); } });
  assert.deepEqual(result, { data: desired, sha: 'sha-2' });
  assert.equal(store.writes.length, 2);
  assert.equal(store.writes[0].data.records.length, 4);
  assert.equal(store.writes[0].additions.length, 12);
  assert.equal(store.writes[1].additions.length, 3);
  assert.deepEqual(shas, ['sha-1', 'sha-2']);
  assert.equal(store.uploads.length, 15);
  const firstWrite = store.events.findIndex(event => event[0] === 'write');
  assert.equal(store.events.slice(0, firstWrite).filter(event => event[0] === 'upload').length, 15);
  assert.deepEqual(store.events.slice(firstWrite), [['write', 'sha-0'], ['sha', 'sha-1'], ['write', 'sha-1'], ['sha', 'sha-2']]);
  assert.equal(drafts.size, 15, 'caller owns the pending-photo lifecycle');
});

test('unused pending images are ignored and needed shared refs are uploaded once', async () => {
  const desired = state([photoRecord('A', [1]), photoRecord('B', [1])]);
  const drafts = pending([1, 99]);
  drafts.set(id(100), null);
  const store = mockStore();
  const result = await syncPhotoState(store, desired, 'sha-0', drafts);
  assert.deepEqual(store.uploads.map(photo => photo.id), [id(1)]);
  assert.equal(store.writes.length, 1);
  assert.equal(store.writes[0].additions.length, 1);
  assert.deepEqual(result.data, desired);
});

test('stale baseline SHA stops before uploads, writes or version callbacks', async () => {
  const store = mockStore(state(), 'other-sha');
  let callbacks = 0;
  await assert.rejects(syncPhotoState(store, state([photoRecord('A', [1])]), 'sha-0', pending([1]), { onSha: () => { callbacks += 1; } }), ConflictError);
  assert.deepEqual(store.events, [['read', 'other-sha']]);
  assert.equal(callbacks, 0);
});

test('failure during second commit preserves the latest confirmed SHA and full caller draft', async () => {
  const desired = state(Array.from({ length: 5 }, (_, i) => photoRecord(`record-${i}`, [i * 3 + 1, i * 3 + 2, i * 3 + 3])));
  const drafts = pending(Array.from({ length: 15 }, (_, i) => i + 1));
  const before = structuredClone(desired);
  const store = mockStore(); store.failWrite = number => number === 2;
  const versions = [];
  await assert.rejects(syncPhotoState(store, desired, 'sha-0', drafts, { onSha: sha => versions.push(sha) }), ConflictError);
  assert.deepEqual(versions, ['sha-1']);
  assert.equal(store.writes.length, 1);
  assert.deepEqual(desired, before);
  assert.equal(drafts.size, 15);
  store.failWrite = null;
  const retried = await syncPhotoState(store, desired, versions.at(-1), drafts, { onSha: sha => versions.push(sha) });
  assert.deepEqual(retried.data, desired);
  assert.equal(store.writes.at(-1).additions.length, 3);
});

test('deferred replacement keeps original row until its whole photo group fits', async () => {
  const old = photoRecord('existing', [90, 91], { note: '旧说明', quantity: 2 });
  const editedPlain = photoRecord('plain', [], { note: '旧备注' });
  const removed = photoRecord('removed', [92]);
  const tombstone = photoRecord('tombstone', [93]);
  const baseline = state([old, editedPlain, removed, tombstone]);
  const newRows = Array.from({ length: 4 }, (_, i) => photoRecord(`new-${i}`, [i * 3 + 1, i * 3 + 2, i * 3 + 3]));
  const desired = state([
    ...newRows, { ...old, photoRefs: [ref(13), ref(14), ref(15)], note: '新说明', quantity: 9 },
    { ...editedPlain, note: '已经修改备注' }, { ...tombstone, deletedAt: NOW },
  ], { settings: { urgentDays: 3, warningDays: 14 } });
  const store = mockStore(baseline);
  await syncPhotoState(store, desired, 'sha-0', pending(Array.from({ length: 15 }, (_, i) => i + 1)));
  const first = store.writes[0].data;
  assert.deepEqual(first.records.find(record => record.id === 'existing'), baseline.records.find(record => record.id === 'existing'));
  assert.deepEqual(first.settings, desired.settings);
  assert.equal(first.records.find(record => record.id === 'plain').note, '已经修改备注');
  assert.equal(first.records.find(record => record.id === 'tombstone').deletedAt, NOW);
  assert.ok(!first.records.some(record => record.id === 'removed'));
  assert.deepEqual(store.writes[1].data, desired);
});

test('another member changing data between chunks causes conflict without re-reading or merging', async () => {
  const desired = state(Array.from({ length: 5 }, (_, i) => photoRecord(`record-${i}`, [i * 3 + 1, i * 3 + 2, i * 3 + 3])));
  const store = mockStore();
  const latest = [];
  await assert.rejects(syncPhotoState(store, desired, 'sha-0', pending(Array.from({ length: 15 }, (_, i) => i + 1)), {
    onSha: sha => { latest.push(sha); store.externalUpdate(state([photoRecord('同事刚添加', [])])); },
  }), ConflictError);
  assert.deepEqual(latest, ['sha-1']);
  assert.equal(store.events.filter(event => event[0] === 'read').length, 1);
  assert.equal(store.writes.length, 1);
});

test('a deferred photo replacement never temporarily resurrects a tombstoned batch', async () => {
  const baseline = state([photoRecord('removed-later', [90])]);
  const rows = Array.from({ length: 4 }, (_, i) => photoRecord(`new-${i}`, [i * 3 + 1, i * 3 + 2, i * 3 + 3]));
  const desired = state([...rows, photoRecord('removed-later', [13, 14, 15], { deletedAt: NOW })]);
  const store = mockStore(baseline);
  await syncPhotoState(store, desired, 'sha-0', pending(Array.from({ length: 15 }, (_, i) => i + 1)));
  const intermediate = store.writes[0].data.records.find(record => record.id === 'removed-later');
  assert.equal(intermediate.deletedAt, NOW);
  assert.deepEqual(intermediate.photoRefs, [ref(90)]);
  assert.deepEqual(store.writes.at(-1).data, desired);
});

test('references moved from removed rows are counted against each actual preceding snapshot', async () => {
  const baseline = state([photoRecord('old-carrier', [90, 91])]);
  const rows = Array.from({ length: 4 }, (_, i) => photoRecord(`new-${i}`, [i * 3 + 1, i * 3 + 2, i * 3 + 3]));
  const desired = state([...rows, photoRecord('moved', [90, 91, 13])]);
  const store = mockStore(baseline);
  await syncPhotoState(store, desired, 'sha-0', pending(Array.from({ length: 13 }, (_, i) => i + 1)));
  assert.equal(store.writes[0].additions.length, 12);
  assert.equal(store.writes[1].additions.length, 3, 'reintroduced references count even when the images were already uploaded');
  assert.ok(store.writes[0].data.records.every(record => record.id !== 'old-carrier'));
  assert.deepEqual(store.writes[1].data, desired);
});

test('an upload failure leaves the state file unchanged', async () => {
  const store = mockStore(); store.failUpload = idValue => idValue === id(2);
  await assert.rejects(syncPhotoState(store, state([photoRecord('A', [1, 2, 3])]), 'sha-0', pending([1, 2, 3])), error => error.code === 'NETWORK_ERROR');
  assert.equal(store.writes.length, 0);
  assert.deepEqual(store.uploads.map(photo => photo.id), [id(1), id(2)]);
});

test('already matching snapshots do not create unnecessary state commits', async () => {
  const baseline = state([photoRecord('A', [1])]);
  const store = mockStore(baseline);
  const result = await syncPhotoState(store, baseline, 'sha-0', new Map());
  assert.deepEqual(result, { data: baseline, sha: 'sha-0' });
  assert.equal(store.writes.length, 0);
});

test('null initialization snapshots and ordinary non-photo changes remain supported', async () => {
  const store = mockStore(null, null);
  const desired = state([photoRecord('A', [])]);
  const result = await syncPhotoState(store, desired, null, new Map());
  assert.deepEqual(result.data, desired);
  assert.equal(store.writes.length, 1);
  assert.equal(store.writes[0].expectedSha, null);
});

test('unconfirmed upload receipts cannot publish references', async () => {
  const store = mockStore();
  store.uploadPhoto = async () => ({ id: id(99), path: `photos/${id(99)}.jpg` });
  await assert.rejects(syncPhotoState(store, state([photoRecord('A', [1])]), 'sha-0', pending([1])), error => error.code === 'SAVE_UNCONFIRMED');
  assert.equal(store.writes.length, 0);
});

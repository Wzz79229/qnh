import test from 'node:test';
import assert from 'node:assert/strict';
import { ConflictError, GitHubError, GitHubStore, MAX_DOCUMENT_BYTES } from '../dist/github.mjs';

const config = { owner: 'qnh-team', repo: 'shelf-life', token: 'github_pat_test_secret' };
const oldSha = 'a'.repeat(40);
const newSha = 'b'.repeat(40);
const file = (data, sha = oldSha) => ({ type: 'file', encoding: 'base64', sha, content: Buffer.from(JSON.stringify(data), 'utf8').toString('base64') });
const response = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers });

function queue(...responses) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    assert.ok(responses.length, 'unexpected extra request');
    const next = responses.shift();
    if (typeof next === 'function') return next(url, options);
    return next;
  };
  return { fetch, calls, remaining: () => responses.length };
}

test('reads Chinese and emoji JSON as UTF-8 with a snapshot SHA and no browser cache', async () => {
  const data = { products: [{ name: '牵牛花鲜牛奶 🥛', note: '冷藏\n待盘点' }] };
  const mock = queue(response(200, file(data)));
  const store = new GitHubStore(config, mock.fetch);
  assert.deepEqual(await store.read(), { data, sha: oldSha });
  const { url, options } = mock.calls[0];
  assert.equal(url, 'https://api.github.com/repos/qnh-team/shelf-life/contents/data/shelf-life.json?ref=main');
  assert.equal(options.cache, 'no-store');
  assert.equal(options.redirect, 'error');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.referrerPolicy, 'no-referrer');
  assert.equal(options.headers.Authorization, `Bearer ${config.token}`);
  assert.ok(!url.includes(config.token));
  assert.equal(JSON.stringify(store), '{}', 'credentials must not be serializable');
  assert.deepEqual(Object.keys(store), []);
});

test('saves large Chinese payload without stack overflow and supplies expected SHA', async () => {
  const data = { note: '牵牛花保质期🥛'.repeat(20_000), products: [] };
  const mock = queue(response(200, file({ products: [] })), response(200, { content: { sha: newSha } }));
  const store = new GitHubStore(config, mock.fetch);
  assert.deepEqual(await store.write(data, oldSha), { data, sha: newSha });
  const body = JSON.parse(mock.calls[1].options.body);
  assert.equal(mock.calls[1].options.method, 'PUT');
  assert.equal(body.sha, oldSha);
  assert.equal(body.branch, 'main');
  assert.deepEqual(JSON.parse(Buffer.from(body.content, 'base64').toString('utf8')), data);
  assert.ok(!mock.calls[1].options.body.includes(config.token));
});

test('missing data returns an initialization snapshot only after repository and branch probes', async () => {
  const mock = queue(response(404, {}), response(200, { name: config.repo }), response(200, { commit: { sha: oldSha } }));
  assert.deepEqual(await new GitHubStore(config, mock.fetch).read(), { data: null, sha: null });
  assert.equal(mock.calls[1].url, 'https://api.github.com/repos/qnh-team/shelf-life');
  assert.equal(mock.calls[2].url, 'https://api.github.com/repos/qnh-team/shelf-life/branches/main');
});

test('creates missing data only with explicitly null expected SHA', async () => {
  const mock = queue(response(404, {}), response(200, {}), response(200, { commit: { sha: oldSha } }), response(201, { content: { sha: newSha } }));
  assert.equal((await new GitHubStore(config, mock.fetch).write({ products: [] }, null)).sha, newSha);
  const body = JSON.parse(mock.calls[3].options.body);
  assert.ok(!('sha' in body));
  assert.equal(body.branch, 'main');
});

test('inaccessible repository cannot be mistaken for missing data', async () => {
  const mock = queue(response(404, {}), response(404, { message: 'Not Found' }));
  await assert.rejects(new GitHubStore(config, mock.fetch).read(), error => error.code === 'REPOSITORY_NOT_FOUND' && /无权访问/.test(error.message));
  assert.equal(mock.calls.length, 2);
});

test('missing branch and empty repository never permit initialization', async () => {
  for (const status of [404, 409]) {
    const mock = queue(response(404, {}), response(200, {}), response(status, {}));
    await assert.rejects(new GitHubStore(config, mock.fetch).write({ products: [] }, null), error => error.code === 'BRANCH_NOT_FOUND');
    assert.ok(mock.calls.every(call => call.options.method === 'GET'));
  }
});

test('stale local SHA refuses the write before a PUT is sent', async () => {
  const mock = queue(response(200, file({ products: [{ name: '同事刚添加' }] }, newSha)));
  await assert.rejects(new GitHubStore(config, mock.fetch).write({ products: [] }, oldSha), error => error instanceof ConflictError && error.code === 'CONFLICT');
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].options.method, 'GET');
});

test('initialization cannot overwrite an existing file', async () => {
  const mock = queue(response(200, file({ products: [] })));
  await assert.rejects(new GitHubStore(config, mock.fetch).write({ products: [] }, null), ConflictError);
  assert.equal(mock.calls.length, 1);
});

test('server 409 and 422 are surfaced as conflicts with no automatic retry', async () => {
  for (const status of [409, 422]) {
    const mock = queue(response(200, file({ products: [] })), response(status, { message: 'sha does not match' }));
    await assert.rejects(new GitHubStore(config, mock.fetch).write({ products: [] }, oldSha), error => error instanceof ConflictError && error.status === status);
    assert.equal(mock.calls.length, 2);
    assert.equal(mock.remaining(), 0);
  }
});

test('401, permission 403 and rate limits have actionable Chinese errors without echoing secrets', async () => {
  for (const [status, headers, message, code] of [
    [401, {}, config.token, 'UNAUTHORIZED'],
    [403, {}, `Resource inaccessible ${config.token}`, 'FORBIDDEN'],
    [403, { 'x-ratelimit-remaining': '0' }, config.token, 'RATE_LIMITED'],
    [403, {}, 'API rate limit exceeded', 'RATE_LIMITED'],
    [429, { 'retry-after': '60' }, config.token, 'RATE_LIMITED'],
  ]) {
    const mock = queue(response(status, { message }, headers));
    await assert.rejects(new GitHubStore(config, mock.fetch).read(), error => error instanceof GitHubError && error.code === code && !error.message.includes(config.token) && /[\u4e00-\u9fa5]/.test(error.message));
  }
});

test('redirects are blocked without following a download URL or leaking a token', async () => {
  const mock = queue(response(302, { download_url: 'https://evil.example/file' }, { location: 'https://evil.example/file' }));
  await assert.rejects(new GitHubStore(config, mock.fetch).read(), error => error.code === 'UNSAFE_REDIRECT');
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].options.redirect, 'error');
  const rejected = queue(() => { throw new Error(`Redirect blocked: ${config.token}`); });
  await assert.rejects(new GitHubStore(config, rejected.fetch).read(), error => error.code === 'NETWORK_ERROR' && !error.message.includes(config.token));
});

test('request timeout aborts the request and reports uncertain saves safely', async () => {
  let observedSignal;
  const store = new GitHubStore({ ...config, timeoutMs: 10 }, async (_, { signal }) => {
    observedSignal = signal;
    return new Promise(() => {});
  });
  await assert.rejects(store.read(), error => error.code === 'TIMEOUT' && /确认结果/.test(error.message));
  assert.equal(observedSignal.aborted, true);
});

test('a fetch that rejects immediately on abort still reports a timeout', async () => {
  const store = new GitHubStore({ ...config, timeoutMs: 10 }, async (_, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  }));
  await assert.rejects(store.read(), error => error.code === 'TIMEOUT');
});

test('valid Unicode branch and path are encoded, including branch slashes', async () => {
  const mock = queue(response(404, {}), response(200, {}), response(200, { commit: { sha: oldSha } }));
  const store = new GitHubStore({ ...config, branch: 'feature/保质期', path: '门店/批次 数据.json' }, mock.fetch);
  await store.read();
  assert.ok(mock.calls[0].url.includes('/contents/%E9%97%A8%E5%BA%97/%E6%89%B9%E6%AC%A1%20%E6%95%B0%E6%8D%AE.json?ref=feature%2F'));
  assert.ok(mock.calls[2].url.includes('/branches/feature%2F'));
  assert.ok(mock.calls.every(call => new URL(call.url).origin === 'https://api.github.com'));
});

test('invalid owner, repo, branch and traversal paths fail before network requests', () => {
  assert.throws(() => new GitHubStore(null), error => error.code === 'INVALID_CONFIG');
  for (const overrides of [
    { owner: 'https://github.com' }, { repo: '../repo' }, { repo: '..' },
    ...['', '../main', 'main..x', 'foo.lock', 'main\\evil', 'a b', 'a//b', '/main', 'main/', 'main@{x}', '@', 'main?x=1', '.hidden'].map(branch => ({ branch })),
    ...['', '../data.json', '/data.json', 'a//data.json', './data.json', 'a\\data.json', 'data.json?x=1', '%2e%2e/data.json', 'data.yaml', '.git/data.json'].map(path => ({ path })),
    { token: 'bad\nsecret' }, { token: 'bad secret' }, { timeoutMs: -1 },
  ]) {
    assert.throws(() => new GitHubStore({ ...config, ...overrides }, () => assert.fail('must not fetch')), error => error.code === 'INVALID_CONFIG');
  }
});

test('missing expected SHA and absent token cannot issue a write', async () => {
  const store = new GitHubStore(config, () => assert.fail('must not fetch'));
  await assert.rejects(store.write({ products: [] }), error => error.code === 'EXPECTED_SHA_REQUIRED');
  await assert.rejects(new GitHubStore({ ...config, token: '' }, () => assert.fail('must not fetch')).write({ products: [] }, null), error => error.code === 'AUTH_REQUIRED');
});

test('invalid remote JSON and directory responses are never converted to empty data', async () => {
  for (const body of [
    { ...file({}), content: Buffer.from('{ broken JSON').toString('base64') },
    { ...file({}), content: '!!!!' },
    file(null), file([]), { type: 'dir', entries: [] }, { ...file({}), sha: '' },
  ]) {
    await assert.rejects(new GitHubStore(config, queue(response(200, body)).fetch).read(), error => error.code === 'DATA_FORMAT');
  }
});

test('oversized data is blocked before writing and oversized remote files are preserved', async () => {
  const store = new GitHubStore(config, () => assert.fail('must not fetch'));
  await assert.rejects(store.write({ note: '中'.repeat(MAX_DOCUMENT_BYTES) }, null), error => error.code === 'DATA_TOO_LARGE');
  for (const body of [{ ...file({}), size: MAX_DOCUMENT_BYTES + 1 }, { ...file({}), encoding: 'none' }]) {
    const mock = queue(response(200, body));
    await assert.rejects(new GitHubStore(config, mock.fetch).write({}, oldSha), error => error.code === 'DATA_TOO_LARGE');
    assert.equal(mock.calls.length, 1);
  }
});

test('concurrent writes through one instance are rejected and lock resets after failures', async () => {
  let resolveFirst;
  const mock = queue(() => new Promise(resolve => { resolveFirst = resolve; }), response(200, file({})), response(200, { content: { sha: newSha } }));
  const store = new GitHubStore(config, mock.fetch);
  const firstWrite = store.write({}, oldSha);
  await assert.rejects(store.write({}, oldSha), error => error.code === 'WRITE_IN_PROGRESS');
  resolveFirst(response(500, {}));
  await assert.rejects(firstWrite, error => error.status === 500);
  assert.equal((await store.write({}, oldSha)).sha, newSha);
});

test('a success response without a content SHA is not presented as confirmed saved', async () => {
  const mock = queue(response(200, file({})), response(200, { commit: { sha: newSha } }));
  await assert.rejects(new GitHubStore(config, mock.fetch).write({}, oldSha), error => error.code === 'SAVE_UNCONFIRMED');
});

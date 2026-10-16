// Credentials live only in this instance. Never persist this instance or request headers.
const API_ROOT = 'https://api.github.com';
export const MAX_DOCUMENT_BYTES = 1_000_000;

export class GitHubError extends Error {
  constructor(message, code = 'GITHUB_ERROR', status = 0) {
    super(message);
    this.name = 'GitHubError';
    this.code = code;
    this.status = status;
  }
}

export class ConflictError extends GitHubError {
  constructor(message = '其他成员已修改数据。本次保存没有覆盖云端；请先导出本机草稿，再重新拉取最新数据后修改。', status = 409) {
    super(message, 'CONFLICT', status);
    this.name = 'ConflictError';
  }
}

function settingError(message) {
  return new GitHubError(message, 'INVALID_CONFIG');
}

function validateConfig(config) {
  const owner = typeof config.owner === 'string' ? config.owner.trim() : '';
  const repo = typeof config.repo === 'string' ? config.repo.trim() : '';
  const branch = config.branch === undefined ? 'main' : config.branch;
  const path = config.path === undefined ? 'data/shelf-life.json' : config.path;
  const token = config.token === undefined ? '' : config.token;
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner)) {
    throw settingError('请填写正确的 GitHub 仓库所有者名称，不要填写网址。');
  }
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(repo) || repo === '.' || repo === '..') {
    throw settingError('请填写正确的 GitHub 仓库名称，不要填写网址或斜杠。');
  }
  if (typeof branch !== 'string' || !branch || branch.length > 255 || branch === '@'
    || /[\x00-\x20\x7f~^:?*\[\\]/.test(branch) || branch.includes('..') || branch.includes('@{')
    || branch.startsWith('/') || branch.endsWith('/') || branch.endsWith('.')
    || branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'))) {
    throw settingError('分支名称无效，请填写 main 或已存在的有效分支名称。');
  }
  if (typeof path !== 'string' || !path || path.length > 1024 || !/\.json$/i.test(path)
    || /[\x00-\x1f\x7f\\?#%]/.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
    throw settingError('数据路径必须是仓库内的相对 JSON 文件路径，例如 data/shelf-life.json；不能包含 .. 或反斜杠。');
  }
  if (typeof token !== 'string' || /[\x00-\x20\x7f]/.test(token.trim())) {
    throw settingError('GitHub 令牌格式无效，请重新粘贴，不能包含空格或换行。');
  }
  return { owner, repo, branch, path, token: token.trim() };
}

function encodeBase64(bytes) {
  // A bounded chunk avoids argument-count / call-stack overflow on long Chinese documents.
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decodeDocument(content) {
  const binary = atob(content.replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new GitHubError('数据文件超过 1 MB，请先备份并归档旧批次，再继续使用。', 'DATA_TOO_LARGE');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''));
}

function isDocument(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * GitHub Contents API optimistic-concurrency adapter.
 * read(): { data, sha }, or { data: null, sha: null } after repo + branch checks.
 * write(data, expectedSha): { data, sha }; never retries or merges a conflicting write.
 * Optional injected fetch is the second constructor argument (or config.fetch).
 */
export class GitHubStore {
  #owner;
  #repo;
  #branch;
  #path;
  #token;
  #fetch;
  #timeoutMs;
  #writing = false;

  constructor(config = {}, fetchImpl) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw settingError('GitHub 连接设置无效。');
    fetchImpl ??= config.fetch ?? globalThis.fetch;
    const validated = validateConfig(config);
    this.#owner = validated.owner;
    this.#repo = validated.repo;
    this.#branch = validated.branch;
    this.#path = validated.path;
    this.#token = validated.token;
    if (typeof fetchImpl !== 'function') throw settingError('当前浏览器不支持网络请求，请使用新版手机浏览器。');
    this.#fetch = fetchImpl.bind(globalThis);
    this.#timeoutMs = config.timeoutMs ?? 20_000;
    if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 120_000) {
      throw settingError('网络超时设置无效。');
    }
  }

  get #repoPath() {
    return `/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repo)}`;
  }

  get #contentsPath() {
    const encodedPath = this.#path.split('/').map(encodeURIComponent).join('/');
    return `${this.#repoPath}/contents/${encodedPath}`;
  }

  async #request(path, { method = 'GET', body } = {}) {
    const controller = new AbortController();
    const headers = {
      Accept: 'application/vnd.github.object+json',
      'X-GitHub-Api-Version': '2026-03-10',
    };
    if (this.#token) headers.Authorization = `Bearer ${this.#token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let timer;
    let timedOut = false;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new GitHubError('连接 GitHub 超时，请检查网络后重试。本机草稿仍保留；若刚刚保存，请先拉取云端确认结果。', 'TIMEOUT'));
      }, this.#timeoutMs);
    });
    try {
      return await Promise.race([
        (async () => {
          const response = await this.#fetch(`${API_ROOT}${path}`, {
            method, headers, body: body === undefined ? undefined : JSON.stringify(body),
            cache: 'no-store', credentials: 'omit', redirect: 'error',
            referrerPolicy: 'no-referrer', signal: controller.signal,
          });
          // Do not follow API-provided download URLs or renamed-repository redirects.
          if (response.redirected || (response.status >= 300 && response.status < 400)
            || (response.url && new URL(response.url).origin !== API_ROOT)) {
            throw new GitHubError('GitHub 返回了重定向，为保护令牌已停止请求。请确认仓库所有者、名称和分支仍然正确。', 'UNSAFE_REDIRECT', response.status);
          }
          let payload;
          try { payload = await response.json(); } catch { payload = null; }
          return { response, payload };
        })(),
        timeout,
      ]);
    } catch (error) {
      if (error instanceof GitHubError) throw error;
      if (timedOut) throw new GitHubError('连接 GitHub 超时，请检查网络后重试。若刚刚保存，请先拉取云端确认结果。', 'TIMEOUT');
      // Never expose an exception message or GitHub response body: either could contain credentials.
      throw new GitHubError('无法连接 GitHub，请检查网络、仓库名称与令牌后重试。保存中断时，请先拉取云端确认是否已保存。', 'NETWORK_ERROR');
    } finally {
      clearTimeout(timer);
    }
  }

  #httpError(response, payload, operation = 'read') {
    const status = response.status;
    if (status === 401) return new GitHubError('GitHub 令牌无效或已过期，请在连接设置中重新输入有效令牌。', 'UNAUTHORIZED', status);
    if (status === 403 || status === 429) {
      const message = typeof payload?.message === 'string' ? payload.message.toLowerCase() : '';
      if (status === 429 || response.headers?.get('x-ratelimit-remaining') === '0'
        || response.headers?.get('retry-after') || /rate limit|abuse/.test(message)) {
        return new GitHubError('GitHub 请求次数暂时受限，请稍后再同步，避免连续点击保存。', 'RATE_LIMITED', status);
      }
      return new GitHubError('GitHub 拒绝访问。请确认你是仓库协作者，令牌已选择这个仓库，并授予 Contents（内容）读写权限；组织仓库还可能需要管理员批准。', 'FORBIDDEN', status);
    }
    if (operation === 'write' && status === 409) return new ConflictError(undefined, status);
    if (operation === 'write' && status === 422) {
      return new ConflictError('GitHub 拒绝了本次保存，可能是版本冲突或分支规则限制。本次没有自动重试；请先导出本机草稿，再拉取最新数据，并检查仓库分支规则。', status);
    }
    if (status === 404) return new GitHubError('找不到 GitHub 仓库或当前令牌无权访问。请核对仓库所有者、仓库名称以及令牌授权范围。', 'REPOSITORY_NOT_FOUND', status);
    return new GitHubError(status >= 500 ? 'GitHub 服务暂时不可用，请稍后重试；本机草稿仍保留。' : `GitHub 请求失败（HTTP ${status}），请检查仓库设置后重试。`, 'HTTP_ERROR', status);
  }

  async #confirmRepositoryAndBranch() {
    const repository = await this.#request(this.#repoPath);
    if (!repository.response.ok) throw this.#httpError(repository.response, repository.payload);
    const branch = await this.#request(`${this.#repoPath}/branches/${encodeURIComponent(this.#branch)}`);
    if (branch.response.status === 404 || branch.response.status === 409) {
      throw new GitHubError('目标分支不存在或仓库尚未初始化。请先在 GitHub 创建 README 和目标分支，再连接应用。', 'BRANCH_NOT_FOUND', branch.response.status);
    }
    if (!branch.response.ok) throw this.#httpError(branch.response, branch.payload);
    if (!branch.payload?.commit?.sha) {
      throw new GitHubError('GitHub 未返回有效分支，请确认仓库已初始化后重试。', 'BRANCH_NOT_FOUND');
    }
  }

  async read() {
    const { response, payload } = await this.#request(`${this.#contentsPath}?ref=${encodeURIComponent(this.#branch)}`);
    if (response.status === 404) {
      await this.#confirmRepositoryAndBranch();
      return { data: null, sha: null };
    }
    if (!response.ok) throw this.#httpError(response, payload);
    if (payload?.size > MAX_DOCUMENT_BYTES || payload?.encoding === 'none') {
      throw new GitHubError('GitHub 数据文件超过 1 MB，请先备份并归档旧批次。当前应用不会覆盖此文件。', 'DATA_TOO_LARGE');
    }
    if (payload?.type !== 'file' || payload.encoding !== 'base64' || typeof payload.content !== 'string'
      || typeof payload.sha !== 'string' || !payload.sha) {
      throw new GitHubError('GitHub 数据路径没有返回有效 JSON 文件，请检查数据文件路径。为保护原数据，已停止同步。', 'DATA_FORMAT');
    }
    let data;
    try { data = decodeDocument(payload.content); } catch (error) {
      if (error instanceof GitHubError) throw error;
      throw new GitHubError('GitHub 数据文件不是有效的 UTF-8 JSON，请先备份并修复文件。为保护原数据，已停止同步。', 'DATA_FORMAT');
    }
    if (!isDocument(data)) throw new GitHubError('GitHub 数据文件必须是 JSON 对象，请检查文件格式。为保护原数据，已停止同步。', 'DATA_FORMAT');
    return { data, sha: payload.sha };
  }

  async write(data, expectedSha) {
    if (!this.#token) throw new GitHubError('保存到 GitHub 需要令牌。请在连接设置中输入有仓库内容读写权限的令牌。', 'AUTH_REQUIRED');
    if (expectedSha !== null && (typeof expectedSha !== 'string' || !expectedSha)) {
      throw new GitHubError('缺少云端数据版本，请先拉取最新数据再保存。', 'EXPECTED_SHA_REQUIRED');
    }
    if (this.#writing) throw new GitHubError('已有一次保存正在进行，请等待完成后再保存。', 'WRITE_IN_PROGRESS');
    if (!isDocument(data)) throw new GitHubError('保存内容必须是 JSON 对象，已停止同步。', 'DATA_FORMAT');
    let serialized;
    let snapshotData;
    try {
      serialized = `${JSON.stringify(data, null, 2)}\n`;
      snapshotData = JSON.parse(serialized);
      if (!isDocument(snapshotData)) throw new Error();
    } catch {
      throw new GitHubError('数据无法转换为 JSON，已停止同步。请导出草稿后检查数据。', 'DATA_FORMAT');
    }
    const bytes = new TextEncoder().encode(serialized);
    if (bytes.length > MAX_DOCUMENT_BYTES) throw new GitHubError('保存内容超过 1 MB，请先导出备份并归档旧批次，再保存。', 'DATA_TOO_LARGE');
    this.#writing = true;
    try {
      const current = await this.read();
      if (current.sha !== expectedSha) throw new ConflictError();
      const body = { message: '更新牵牛花商品保质期数据', content: encodeBase64(bytes), branch: this.#branch };
      if (expectedSha !== null) body.sha = expectedSha;
      const { response, payload } = await this.#request(this.#contentsPath, { method: 'PUT', body });
      if (!response.ok) throw this.#httpError(response, payload, 'write');
      if (typeof payload?.content?.sha !== 'string' || !payload.content.sha) {
        throw new GitHubError('GitHub 未返回保存后的版本号，无法确认保存结果。请保留本机草稿并先拉取云端核对。', 'SAVE_UNCONFIRMED');
      }
      return { data: snapshotData, sha: payload.content.sha };
    } finally {
      this.#writing = false;
    }
  }
}

import { sanitizeState } from './core.mjs';
import { ConflictError, GitHubError } from './github.mjs';

// Keep this in agreement with backend/worker.mjs's per-state photo verification bound.
const NEW_REFS_PER_COMMIT = 12;

function refs(state) {
  return new Set((state?.records || []).flatMap(record => (record.photoRefs || []).map(ref => ref.id)));
}

function sameState(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Save an accumulated photo draft without exceeding the backend's 12-new-ref bound.
 * pendingPhotos is a Map<UUID, {dataUrl:string}> and is never mutated here.
 * Every confirmed commit reports its SHA immediately, including intermediate commits.
 * A later failure leaves the desired draft and pending photos with the caller for retry/export.
 */
export async function syncPhotoState(store, desired, expectedSha, pendingPhotos = new Map(), { onSha } = {}) {
  if (!store || typeof store.read !== 'function' || typeof store.write !== 'function' || typeof store.uploadPhoto !== 'function') {
    throw new GitHubError('团队数据连接无效，请重新连接后保存。', 'INVALID_CONFIG');
  }
  if (expectedSha !== null && (typeof expectedSha !== 'string' || !expectedSha)) {
    throw new GitHubError('缺少云端数据版本，请先拉取最新数据再保存。', 'EXPECTED_SHA_REQUIRED');
  }
  if (!(pendingPhotos instanceof Map) || onSha !== undefined && typeof onSha !== 'function') {
    throw new GitHubError('照片同步参数无效，请保留本页草稿并重试。', 'INVALID_CONFIG');
  }
  const target = sanitizeState(desired);
  const snapshot = await store.read();
  if (!snapshot || snapshot.sha !== expectedSha) throw new ConflictError();
  if (snapshot.data === null && snapshot.sha !== null) {
    throw new GitHubError('云端数据与版本不一致，请保留草稿并重新连接。', 'DATA_FORMAT');
  }
  const baseline = snapshot.data === null ? null : sanitizeState(snapshot.data);
  const baselineById = new Map((baseline?.records || []).map(record => [record.id, record]));
  const needed = refs(target);

  // Complete every needed pending upload before changing the state file. Same-ID retries
  // are idempotent on the backend; unused drafts do not create orphan files.
  for (const [id, photo] of pendingPhotos) {
    if (!needed.has(id)) continue;
    if (!photo || typeof photo.dataUrl !== 'string' || !photo.dataUrl.startsWith('data:image/jpeg;base64,')
      || photo.id !== undefined && photo.id !== id) {
      throw new GitHubError('本页照片草稿无效，请重新选择照片或导出备份。', 'INVALID_PHOTO');
    }
    const uploaded = await store.uploadPhoto(id, photo.dataUrl);
    if (uploaded?.id !== id || uploaded.path !== `photos/${id}.jpg`) {
      throw new GitHubError('无法确认照片上传结果，本次没有保存商品数据。请保留照片草稿并重试。', 'SAVE_UNCONFIRMED');
    }
  }

  let current = baseline;
  let sha = snapshot.sha;
  while (!sameState(current, target)) {
    const currentRefs = refs(current);
    const added = new Set();
    const records = [];
    let deferred = false;
    for (const record of target.records) {
      const additions = [...new Set((record.photoRefs || []).map(ref => ref.id))]
        .filter(id => !currentRefs.has(id) && !added.has(id));
      if (added.size + additions.length <= NEW_REFS_PER_COMMIT) {
        records.push(record);
        for (const id of additions) added.add(id);
      } else {
        deferred = true;
        const old = baselineById.get(record.id);
        if (old) {
          // Never split a record's photo group. Retain its original valid record until
          // the entire replacement fits, while honoring an explicit removal immediately.
          records.push(record.deletedAt ? { ...old, deletedAt: record.deletedAt, updatedAt: record.updatedAt } : old);
        }
      }
    }
    const next = deferred ? { ...target, records } : target;
    if (sameState(next, current)) {
      throw new GitHubError('照片草稿无法分批保存，请先导出备份并联系管理员。', 'SYNC_NO_PROGRESS');
    }
    const saved = await store.write(next, sha);
    if (typeof saved?.sha !== 'string' || !saved.sha) {
      throw new GitHubError('无法确认本批数据保存结果，请保留草稿并拉取云端核对。', 'SAVE_UNCONFIRMED');
    }
    // The caller must learn the confirmed version before another upload/save can fail.
    sha = saved.sha;
    onSha?.(sha);
    current = sanitizeState(saved.data === undefined ? next : saved.data);
    if (!sameState(current, next)) {
      throw new GitHubError('云端返回的保存内容与本批草稿不一致，请保留草稿并重新拉取核对。', 'SAVE_UNCONFIRMED');
    }
  }
  return { data: target, sha };
}

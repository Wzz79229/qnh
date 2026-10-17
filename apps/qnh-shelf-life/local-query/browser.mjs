import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';

/** Browser settings are intentionally independent of every remote-service credential. */
export function browserConfiguration(env = process.env) {
  const channel = env.QNH_BROWSER || 'msedge';
  if (!['msedge', 'chrome'].includes(channel)) throw new Error('INVALID_BROWSER');
  const profile = resolve(join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'QnhShelfLife', `QueryBrowser-${channel}`));
  return { channel, profile };
}

export function profileMutexName(profile) {
  if (typeof profile !== 'string' || !profile) throw new Error('INVALID_PROFILE');
  const key = createHash('sha256').update(resolve(profile).toLowerCase()).digest('hex').slice(0, 32);
  return `\\\\.\\pipe\\qnh-shelf-life-profile-${key}`;
}

/** Windows IPC mutex: no TCP listener, no file, no request body or credential. */
export async function acquireProfileLock(profile, { makeServer = createServer, platform = process.platform } = {}) {
  if (platform !== 'win32') throw Object.assign(new Error('WINDOWS_REQUIRED'), { code: 'WINDOWS_REQUIRED' });
  const server = makeServer(socket => socket.destroy());
  let released = false;
  await new Promise((resolve, reject) => {
    const failed = error => {
      server.removeListener('listening', ready);
      reject(Object.assign(new Error(error?.code === 'EADDRINUSE' ? 'PROFILE_IN_USE' : 'PROFILE_LOCK_UNAVAILABLE'), {
        code: error?.code === 'EADDRINUSE' ? 'PROFILE_IN_USE' : 'PROFILE_LOCK_UNAVAILABLE',
      }));
    };
    const ready = () => {
      server.removeListener('error', failed);
      // Never echo an IPC error or payload. This server has no protocol to expose.
      server.on('error', () => {});
      resolve();
    };
    server.once('error', failed);
    server.once('listening', ready);
    try { server.listen({ path: profileMutexName(profile), exclusive: true, readableAll: false, writableAll: false }); }
    catch (error) { failed(error); }
  });
  return {
    async release() {
      if (released) return;
      released = true;
      await new Promise(resolve => {
        try { server.close(() => resolve()); } catch { resolve(); }
      });
    },
  };
}

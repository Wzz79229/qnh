'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = fs.realpathSync(path.join(__dirname, 'dist'));
const port = Number(process.env.PORT || 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT 必须是 1 至 65535 的整数。');
}
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.wasm': 'application/wasm',
  '.traineddata': 'application/octet-stream',
};

function insideRoot(filename) {
  const relative = path.relative(root, filename);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end('Method not allowed');
  }
  let pathname;
  try {
    pathname = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }
  if (pathname.includes('\0') || pathname.includes('\\')) {
    res.writeHead(400);
    return res.end('Bad request');
  }
  const target = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!insideRoot(target)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const realTarget = await fs.promises.realpath(target);
    if (!insideRoot(realTarget)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    const stat = await fs.promises.stat(realTarget);
    if (!stat.isFile()) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': types[path.extname(realTarget).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(realTarget);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } catch (error) {
    res.writeHead(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 500);
    res.end(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'Not found' : 'Unable to read file');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`鲜期预览：http://127.0.0.1:${port}`);
  console.log('按 Ctrl+C 停止。GitHub Pages 部署文件位于 dist/。');
});
server.on('error', (error) => {
  console.error(`无法启动预览：${error.message}`);
  process.exitCode = 1;
});

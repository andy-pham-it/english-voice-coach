#!/usr/bin/env node
// Dev server cho spike: phục vụ file tĩnh + nhận log từ trình duyệt.
// Chạy: node tools/dev-server.mjs [port]
// Log ghi vào .data/logs/events-YYYY-MM-DD.jsonl
// Đọc log: node tools/logs.mjs list | show <id> | events <id> | summary

import { createServer } from 'node:http';
import { readFile, appendFile, mkdir, stat } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SPIKE_DIR = join(ROOT, 'spike');
const LOG_DIR = join(ROOT, '.data', 'logs');
const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const MAX_BODY = 8 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json'
};

const day = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'POST' && url.pathname === '/__log') {
    try {
      const raw = await readBody(req);
      const parsed = JSON.parse(raw);
      const line = JSON.stringify({ ...parsed, received_at: new Date().toISOString() });
      await mkdir(LOG_DIR, { recursive: true });
      await appendFile(join(LOG_DIR, `events-${day()}.jsonl`), line + '\n', 'utf8');
      res.writeHead(204, { 'access-control-allow-origin': '*' });
      res.end();
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, GET, OPTIONS',
      'access-control-allow-headers': 'content-type'
    });
    res.end();
    return;
  }

  if (url.pathname === '/__health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, logDir: LOG_DIR }));
    return;
  }

  // static
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const target = normalize(join(SPIKE_DIR, rel));
  if (!target.startsWith(SPIKE_DIR + sep)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  try {
    const s = await stat(target);
    if (!s.isFile()) throw new Error('not a file');
    const buf = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target)] || 'application/octet-stream',
      'cache-control': 'no-store'
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
});

server.listen(PORT, () => {
  console.log(`spike:  http://localhost:${PORT}`);
  console.log(`logs:   ${LOG_DIR}`);
  console.log(`query:  node tools/logs.mjs list`);
});

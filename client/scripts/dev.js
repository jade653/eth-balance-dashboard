/**
 * 개발용 서버. 배포에서는 쓰지 않는다 (배포 때는 nginx 가 같은 일을 한다).
 *
 * 하는 일 두 가지 — 나중에 nginx 설정에서 그대로 다시 보게 된다:
 *   1) /api/*  → API 서버(API_URL)로 그대로 넘긴다   = nginx 의 proxy_pass
 *   2) 그 외   → public/ 의 파일을 돌려준다          = nginx 의 root + try_files
 *
 *   npm run dev                       # http://127.0.0.1:5173, API 는 127.0.0.1:8787
 *   API_URL=http://host:8787 npm run dev
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT ?? 5173);
const API_URL = new URL(process.env.API_URL ?? 'http://127.0.0.1:8787');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function proxy(req, res) {
  const upstream = http.request(
    {
      hostname: API_URL.hostname,
      port: API_URL.port,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: API_URL.host },
    },
    (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    // nginx 도 upstream 에 못 닿으면 502 Bad Gateway 를 준다
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad_gateway' }));
  });
  req.pipe(upstream);
}

async function serveStatic(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  let rel;
  try {
    rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).slice(1);
  } catch {
    res.writeHead(400).end(); // %E0 같은 깨진 인코딩. 그냥 두면 예외로 프로세스가 죽는다
    return;
  }
  const file = path.resolve(ROOT, rel);
  // ../../etc/passwd 같은 경로로 public 밖을 읽지 못하게 한다
  if (!file.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  }
}

http
  .createServer((req, res) => (req.url.startsWith('/api/') ? proxy(req, res) : serveStatic(req, res)))
  .listen(PORT, '127.0.0.1', () => {
    console.log(`client dev server http://127.0.0.1:${PORT}  (/api → ${API_URL.origin})`);
  });

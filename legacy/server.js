'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { RpcClient } = require('./rpc.js');
const { Store } = require('./storage.js');
const { isAddress, rangeSeconds } = require('./validate.js');

// ── 설정 ────────────────────────────────────────────────────────────────────
// 잘못된 값은 조용히 넘어가지 않고 부팅 시 바로 죽인다. (POLL_MS=abc → NaN →
// setInterval이 1ms로 돌아 RPC를 초당 수백 번 때리는 사고를 막기 위해서다)
const CONFIG_PATH = path.join(__dirname, 'config.json');
const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

function fatal(msg) { console.error(`[config] ${msg}`); process.exit(1); }

function num(name, raw, fallback, min, max) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) fatal(`${name}=${raw} 는 ${min}~${max} 사이의 숫자여야 한다`);
  return n;
}

// RPC_HTTP_URL=a,b,c 처럼 쉼표로 여러 개 → 앞의 것이 죽으면 다음 것으로 넘어간다
const RPC_URLS = (process.env.RPC_HTTP_URL
  ? process.env.RPC_HTTP_URL.split(',')
  : [].concat(CONFIG.rpcUrls ?? CONFIG.rpcUrl ?? [])
).map((s) => String(s).trim()).filter(Boolean);
if (RPC_URLS.length === 0) fatal('RPC_HTTP_URL 또는 config.json의 rpcUrl/rpcUrls 가 필요하다');
for (const u of RPC_URLS) {
  let ok = false;
  try { ok = /^https?:$/.test(new URL(u).protocol); } catch { /* fall through */ }
  if (!ok) fatal(`RPC URL 형식이 잘못됐다: ${u}`);
}

const POLL_MS = num('POLL_MS', process.env.POLL_MS ?? CONFIG.pollIntervalMs, 5000, 1000, 600_000);
let HISTORY = num('historyLength', CONFIG.historyLength, 60, 2, 10_000);   // SIGHUP으로 바뀔 수 있다
const PORT = num('PORT', process.env.PORT, 8787, 1, 65535);
const HOST = process.env.HOST || '127.0.0.1';  // 리버스 프록시 뒤가 기본. 컨테이너/PaaS는 HOST=0.0.0.0
const MAX_SUBSCRIBERS = num('MAX_SUBSCRIBERS', process.env.MAX_SUBSCRIBERS, 500, 1, 100_000);
// 전역 상한만 있으면 한 사람이 슬롯을 전부 차지해 정상 사용자를 밀어낼 수 있다
const MAX_PER_IP = num('MAX_SSE_PER_IP', process.env.MAX_SSE_PER_IP, 10, 1, 100_000);
// 있으면 /api/health?token=... 로 상세를 볼 수 있다. 없으면 로컬 직접 호출만 상세를 본다
const HEALTH_TOKEN = process.env.HEALTH_TOKEN || null;
// 프록시가 넣어준 클라이언트 IP 헤더를 믿을지. 기본(null)은 "loopback에서 온 요청만"
const TRUST_PROXY = process.env.TRUST_PROXY === undefined
  ? null
  : /^(1|true|yes)$/i.test(process.env.TRUST_PROXY);
const SSE_MAX_BUFFER = 1 << 20;          // 이만큼(1MB) 읽어가지 않은 SSE 클라이언트는 끊는다
const STALE_AFTER_MS = POLL_MS * 6;      // 이만큼 성공한 폴링이 없으면 헬스체크가 503을 낸다

// 데이터는 APP_DIR 밖에 둔다. deploy.sh 의 rsync --delete 가 닿지 않는 자리라
// 배포할 때마다 기록이 날아가는 사고가 구조적으로 불가능해진다.
// systemd 에 StateDirectory= 를 주면 STATE_DIRECTORY 로 경로를 알려준다.
const DATA_DIR = process.env.DATA_DIR || process.env.STATE_DIRECTORY || path.join(__dirname, 'data');
// 여기서 실패해도 죽지 않는다. Store 가 열지 못한 채로 뜨고, 대시보드는 계속 돈다.
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* Store 가 이어서 실패한다 */ }
const store = new Store({ path: path.join(DATA_DIR, 'balances.db') });

// 부팅과 SIGHUP 리로드가 같은 규칙을 쓰도록 검증을 한 곳에 모은다.
// 부팅 때는 실패가 곧 종료지만, 리로드 때는 던져서 "기존 설정 유지"로 흡수한다.
function validateAddresses(list) {
  if (!Array.isArray(list) || list.length === 0) throw new Error('addresses 가 비어 있다');
  const seen = new Set();
  for (const a of list) {
    if (!isAddress(a?.address)) throw new Error(`주소 형식이 잘못됐다: ${a?.label ?? '?'} ${a?.address}`);
    // 라벨이 없으면 프론트의 정렬(localeCompare)이 TypeError로 죽어 화면 전체가 멈춘다
    if (typeof a.label !== 'string' || a.label.trim() === '') throw new Error(`label 이 비어 있다: ${a.address}`);
    // 주소가 겹치면 프론트가 주소를 키로 행을 관리하므로 한 줄만 그려진다
    const key = a.address.toLowerCase();
    if (seen.has(key)) throw new Error(`주소가 중복됐다: ${a.address}`);
    seen.add(key);
  }
  return list;
}

try { validateAddresses(CONFIG.addresses); } catch (err) { fatal(`config.json: ${err.message}`); }

const rpc = new RpcClient(RPC_URLS);

// ── 상태 (백엔드가 들고 있는 "진실". 프론트는 이걸 그대로 그리기만 한다) ──────
const state = {
  status: 'starting',        // starting | live | degraded | error
  lastError: null,
  chainId: null,
  block: null,               // { number, hash, timestamp, gasUsed, baseFeePerGas }
  updatedAt: null,           // 마지막으로 노드와 성공적으로 통신한 시각. 실패 시엔 갱신하지 않는다
  pollIntervalMs: POLL_MS,
  latencyMs: null,
  accounts: CONFIG.addresses.map(makeAccount),
};

function makeAccount(a) {
  return {
    label: a.label,
    address: a.address,
    tag: a.tag ?? null,
    balanceWei: null,        // 10진 문자열 (JSON에 BigInt를 담을 수 없어서)
    deltaWei: '0',           // 직전 갱신 대비 증감
    lastChangedBlock: null,
    history: [],             // [{ block, balanceWei }]
  };
}

function safeHost(u) { try { return new URL(u).host; } catch { return u; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 폴링 루프 ───────────────────────────────────────────────────────────────
// 핵심: eth_blockNumber로 "새 블록이 생겼는지"만 먼저 싸게 확인하고,
// 새 블록일 때만 잔액을 다시 읽는다. 그리고 잔액 조회는 'latest'가 아니라
// 방금 확인한 블록 번호를 고정해서 넘긴다 -> 모든 주소가 같은 블록 기준이 된다.
let polling = false;
// 리로드로 주소가 바뀌면 '블록이 같아도' 다음 tick에서 잔액을 다시 읽어야 한다.
// 안 그러면 새로 추가한 주소가 다음 블록이 나올 때까지 빈칸으로 남는다.
let forceRefresh = false;

function markAlive() {
  state.updatedAt = Date.now();
  state.latencyMs = rpc.stats.lastLatencyMs;
  invalidateSnapshot();
}

// 뒤처진 노드에 "header not found"를 받는 식의 일시적 실패는 한 번 더 시도한다
async function retryOnce(fn) {
  try {
    return await fn();
  } catch (err) {
    log(`재시도: ${err.message}`);
    await sleep(1000);
    return fn();
  }
}

async function tick() {
  if (polling) return;
  polling = true;
  try {
    const blockHex = await rpc.call('eth_blockNumber');
    const blockNumber = Number(BigInt(blockHex));

    // 공용 RPC는 요청을 여러 노드에 분산하므로, 뒤처진 노드가 응답하면 블록 번호가
    // 직전보다 *작게* 올 수 있다. 그걸 "새 블록"으로 처리하면 과거 기준 잔액을 다시
    // 읽어 있지도 않은 변동이 화면에 뜬다. 앞으로 간 경우에만 갱신한다.
    const behind = state.block !== null && blockNumber < state.block.number;
    const same = state.block !== null && blockNumber === state.block.number;
    if (behind || (same && state.status === 'live' && !forceRefresh)) {
      if (behind) log(`block ${blockNumber} < ${state.block.number} 무시 (뒤처진 노드 응답)`);
      markAlive();
      broadcast({ type: 'heartbeat', updatedAt: state.updatedAt, latencyMs: state.latencyMs });
      return;
    }

    // 배치를 만든 시점의 계정 배열을 붙잡아 둔다. await 하는 동안 SIGHUP 리로드가
    // 들어오면 balances[i] 와 state.accounts[i] 의 짝이 어긋나 엉뚱한 주소에 엉뚱한
    // 잔액이 들어간다. 배열이 교체됐으면 이번 결과는 버리고 다음 tick에서 다시 읽는다.
    const accounts = state.accounts;
    const calls = [
      { method: 'eth_getBlockByNumber', params: [blockHex, false] },
      ...accounts.map((a) => ({ method: 'eth_getBalance', params: [a.address, blockHex] })),
    ];
    const [block, ...balances] = await retryOnce(() => rpc.batch(calls));
    if (state.accounts !== accounts) { log('폴링 중 리로드됨 -> 이번 배치 결과는 버린다'); return; }

    state.block = {
      number: blockNumber,
      hash: block?.hash ?? null,
      timestamp: block?.timestamp ? Number(BigInt(block.timestamp)) : null,
      gasUsed: block?.gasUsed ? BigInt(block.gasUsed).toString() : null,
      baseFeePerGas: block?.baseFeePerGas ? BigInt(block.baseFeePerGas).toString() : null,
      txCount: Array.isArray(block?.transactions) ? block.transactions.length : null,
    };

    // 블록 시각을 시간축으로 쓴다. 노드가 안 주면 지금 시각으로 대신한다.
    const blockTs = state.block.timestamp ?? Math.floor(Date.now() / 1000);
    const records = [];

    accounts.forEach((acct, i) => {
      const next = BigInt(balances[i]);
      const first = acct.balanceWei === null;
      const prev = first ? next : BigInt(acct.balanceWei);
      const delta = next - prev;
      if (delta !== 0n) acct.lastChangedBlock = blockNumber;
      acct.balanceWei = next.toString();
      acct.deltaWei = delta.toString();
      // 같은 블록을 강제로 다시 읽은 경우(forceRefresh) 히스토리에 점을 두 번 찍지 않는다
      const last = acct.history[acct.history.length - 1];
      if (last && last.block === blockNumber) last.balanceWei = acct.balanceWei;
      else acct.history.push({ block: blockNumber, balanceWei: acct.balanceWei });
      // shift 가 아니라 splice: HISTORY 가 리로드로 줄어들면 한 번에 잘라내야 한다
      if (acct.history.length > HISTORY) acct.history.splice(0, acct.history.length - HISTORY);

      // 변한 순간과 처음 본 순간만 남긴다. 잔액은 계단 함수라 그것만으로 무손실이고,
      // 처음 본 기록이 없으면 오래 안 움직인 주소는 그래프에 점이 하나도 안 생긴다.
      if (first || delta !== 0n) {
        records.push({
          address: acct.address.toLowerCase(),
          block: blockNumber,
          ts: blockTs,
          wei: acct.balanceWei,
        });
      }
    });

    // 저장이 실패해도 던지지 않는다. 잔액 표시는 저장과 무관하게 계속되어야 한다.
    if (records.length) store.append(records);

    state.status = 'live';
    state.lastError = null;
    forceRefresh = false;
    markAlive();
    broadcast({ type: 'snapshot', ...snapshot() });
    log(`block ${blockNumber} · ${state.accounts.length} accounts · ${state.latencyMs}ms · ${safeHost(rpc.url)}`);
  } catch (err) {
    state.status = state.block ? 'degraded' : 'error';
    state.lastError = err.message;
    invalidateSnapshot();
    broadcast({ type: 'snapshot', ...snapshot() });
    log(`ERROR ${err.message}`);
  } finally {
    polling = false;
  }
}

// /api/snapshot 은 인증이 없어 얼마든지 두드릴 수 있다. 매 요청마다 전체 상태를
// 직렬화하면(주소 N개 x 히스토리 HISTORY개) 이벤트 루프가 CPU에 묶여 SSE 푸시까지
// 밀린다. 상태가 바뀔 때만 다시 만들고 그 사이 요청은 같은 버퍼를 재사용한다.
let snapshotCache = null;
let streamHelloCache = null;

function invalidateSnapshot() { snapshotCache = null; streamHelloCache = null; }

function snapshotBuffer() {
  if (snapshotCache === null) snapshotCache = Buffer.from(JSON.stringify(snapshot()));
  return snapshotCache;
}

// 새 구독자에게 즉시 보내는 첫 프레임. 같은 이유로 캐시한다
function streamHello() {
  if (streamHelloCache === null) {
    streamHelloCache = `data: ${JSON.stringify({ type: 'snapshot', ...snapshot() })}\n\n`;
  }
  return streamHelloCache;
}

function snapshot() {
  return {
    status: state.status,
    lastError: state.lastError,
    rpcHost: safeHost(rpc.url),
    chainId: state.chainId,
    block: state.block,
    updatedAt: state.updatedAt,
    latencyMs: state.latencyMs,
    pollIntervalMs: state.pollIntervalMs,
    accounts: state.accounts,
  };
}

// ── SSE (Server-Sent Events) ───────────────────────────────────────────────
// WebSocket을 쓸 수도 있지만, 서버 -> 브라우저 단방향 푸시만 필요하므로
// 재연결이 브라우저 기본 기능으로 들어있는 SSE가 더 단순하고 견고하다.
const clients = new Set();
const perIp = new Map();   // ip -> 열려 있는 SSE 개수

// nginx 뒤에서는 소켓의 remoteAddress 가 전부 127.0.0.1 이라 IP당 제한이 무의미하다.
// 그래서 프록시가 넣어준 헤더를 보는데, 그 헤더는 클라이언트도 보낼 수 있으므로
// "신뢰할 수 있는 프록시를 거쳐 왔을 때만" 믿어야 한다.
//   - X-Real-IP: proxy_set_header 가 통째로 '덮어쓰므로' 위조가 통하지 않는다
//   - X-Forwarded-For: $proxy_add_x_forwarded_for 는 클라이언트가 보낸 값 뒤에 실제
//     peer 를 '덧붙인다' -> 맨 앞은 공격자가 채울 수 있고, 맨 뒤가 진짜다
function isLoopback(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function clientIp(req) {
  const peer = req.socket.remoteAddress || 'unknown';
  const trusted = TRUST_PROXY === null ? isLoopback(peer) : TRUST_PROXY;
  if (!trusted) return peer;

  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real.trim()) return real.trim();

  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    const parts = xff.split(',');
    return parts[parts.length - 1].trim() || peer;
  }
  return peer;
}

function addClient(res, ip) {
  res._ip = ip;
  clients.add(res);
  perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
}

// close 와 error 가 둘 다 날아올 수 있으므로 여러 번 불려도 안전해야 한다
function removeClient(res, { destroy = false } = {}) {
  if (clients.delete(res)) {
    const n = perIp.get(res._ip);
    if (n !== undefined) {
      if (n <= 1) perIp.delete(res._ip);
      else perIp.set(res._ip, n - 1);
    }
  }
  if (destroy && !res.destroyed) res.destroy();
}

function broadcast(payload) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    // 읽어가지 않는 느린 클라이언트에게 계속 쓰면 그 버퍼가 우리 메모리에 쌓인다
    if (res.destroyed || res.writableLength > SSE_MAX_BUFFER) { removeClient(res, { destroy: true }); continue; }
    // destroyed 검사와 write 사이에 소켓이 죽을 수 있다. 여기서 새는 예외는 setInterval
    // 콜백(ping)을 타고 uncaughtException 이 되어 프로세스를 통째로 끊어먹는다.
    try { res.write(frame); } catch { removeClient(res, { destroy: true }); }
  }
}

// ── HTTP 서버 ───────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const BASE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};
// 외부 리소스를 하나도 안 쓰므로 self로 잠근다. 파비콘만 data: URL이다.
const CSP = "default-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

const server = http.createServer((req, res) => {
  try {
    handle(req, res);
  } catch (err) {
    // 핸들러에서 새는 예외는 프로세스 전체를 죽인다 — 요청 하나로 서버가 내려가면 안 된다
    log(`ERROR ${req.method} ${req.url}: ${err.message}`);
    if (res.headersSent) res.destroy();
    else json(res, 500, { error: 'internal error' });
  }
});

function handle(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return json(res, 405, { error: 'method not allowed' }, { allow: 'GET, HEAD' });
  }

  // Host 헤더는 클라이언트 마음대로라 URL로 파싱 불가능할 수 있다 ("Host: a b" 한 번에
  // 서버가 죽었다). 경로만 필요하므로 base는 고정한다.
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/snapshot') {
    return json(res, 200, snapshotBuffer());
  }

  if (url.pathname === '/api/health') {
    // 첫 블록을 못 받은 경우뿐 아니라, 운영 중 RPC가 죽어 값이 낡은 경우도 503이어야
    // 업타임 모니터/로드밸런서가 알아챈다.
    const stale = state.updatedAt === null || Date.now() - state.updatedAt > STALE_AFTER_MS;
    const ok = state.status === 'live' && !stale;
    const body = {
      ok,
      status: state.status,
      stale,
      block: state.block?.number ?? null,
      updatedAt: state.updatedAt,
    };
    // 상세는 공개하지 않는다. 특히 subscribers 가 보이면 공격자가 자기 부하가
    // 먹히는지 실시간으로 확인하며 조절할 수 있다.
    if (isAdmin(req, url)) {
      body.lastError = state.lastError;
      body.rpc = { active: safeHost(rpc.url), endpoints: rpc.urls.length, batch: rpc.batchSupported, ...rpc.stats };
      body.subscribers = clients.size;
      body.uniqueIps = perIp.size;
      body.addresses = state.accounts.length;
      // 저장이 조용히 실패하고 있으면 여기서만 보인다. notify.js 의 status 메일이
      // 로컬로 이 엔드포인트를 읽으므로 그 경로로 눈에 띈다.
      body.storage = store.status;
    }
    return json(res, ok ? 200 : 503, body);
  }

  if (url.pathname === '/api/history') {
    // 1층 방어. 이상한 값은 여기서 걸러져 SQL 근처에도 가지 못한다.
    // range 는 검증이 아니라 '치환'이다 -- 목록에 있으면 우리가 정한 숫자를 쓰고,
    // 없으면 400 이다. 사용자가 보낸 문자열 자체는 어디로도 흘러가지 않는다.
    const range = url.searchParams.get('range');
    const seconds = rangeSeconds(range);
    if (seconds === null) return json(res, 400, { error: 'bad range' });

    const raw = url.searchParams.get('address');
    let wanted = state.accounts;
    if (raw !== null) {
      if (!isAddress(raw)) return json(res, 400, { error: 'bad address' });
      const key = raw.toLowerCase();
      wanted = state.accounts.filter((a) => a.address.toLowerCase() === key);
      // 형식은 맞지만 감시 목록에 없는 주소. 빈 배열로 답하면 '기록이 없다'와
      // '아예 안 보는 주소다'가 구분되지 않는다.
      if (wanted.length === 0) return json(res, 404, { error: 'unknown address' });
    }

    const since = Math.floor(Date.now() / 1000) - seconds;
    return json(res, 200, {
      range,
      since,
      accounts: wanted.map((a) => ({
        address: a.address,
        label: a.label,
        // 2층 방어는 storage.js 안에 있다. 값은 전부 ? 로 바인딩된다.
        records: store.history(a.address.toLowerCase(), since),
      })),
    });
  }

  if (url.pathname === '/api/stream') {
    if (clients.size >= MAX_SUBSCRIBERS) {
      return json(res, 503, { error: 'too many subscribers' }, { 'retry-after': '30' });
    }
    // 전역 상한만 있으면 한 사람이 MAX_SUBSCRIBERS 개를 열어 나머지 전원을 밀어낼 수 있다
    const ip = clientIp(req);
    if ((perIp.get(ip) ?? 0) >= MAX_PER_IP) {
      return json(res, 429, { error: 'too many connections' }, { 'retry-after': '60' });
    }
    res.writeHead(200, {
      ...BASE_HEADERS,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`retry: 3000\n\n`);
    res.write(streamHello());
    addClient(res, ip);
    res.on('error', () => removeClient(res, { destroy: true }));
    req.on('close', () => removeClient(res));
    return;
  }

  // 정적 파일
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const root = path.join(__dirname, 'public');
  const file = path.resolve(root, '.' + rel);
  if (file !== root && !file.startsWith(root + path.sep)) return json(res, 403, { error: 'forbidden' });

  fs.readFile(file, (err, buf) => {
    if (err) return json(res, 404, { error: 'not found' });
    const ext = path.extname(file);
    const html = ext === '.html';
    res.writeHead(200, {
      ...BASE_HEADERS,
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': buf.length,
      'cache-control': html ? 'no-cache' : 'public, max-age=60',
      ...(html ? { 'content-security-policy': CSP, 'x-frame-options': 'DENY' } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

function json(res, code, body, extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    ...BASE_HEADERS,
    ...extra,
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-store',
  });
  res.end(res.req?.method === 'HEAD' ? undefined : buf);
}

// 상세 헬스체크를 볼 자격. HEALTH_TOKEN 을 주면 그것만 인정하고, 없으면
// "프록시를 거치지 않은 로컬 직접 호출"만 인정한다 (= 서버에 들어와 있는 운영자).
function isAdmin(req, url) {
  if (HEALTH_TOKEN) return tokenMatches(url.searchParams.get('token'));
  return isLoopback(req.socket.remoteAddress || '')
    && !req.headers['x-real-ip']
    && !req.headers['x-forwarded-for'];
}

// 길이가 다르면 timingSafeEqual 이 던지므로 먼저 비교한다. 길이 노출은 감수한다
function tokenMatches(given) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(HEALTH_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ── 설정 리로드 (SIGHUP) ────────────────────────────────────────────────────
// 재시작하면 SSE가 전부 끊기고 히스토리가 통째로 날아간다. 주소 목록만 바뀌는 흔한
// 경우에 그 비용을 치를 이유가 없다. 그리고 더 중요한 건 실패했을 때인데, 부팅은
// 잘못된 config 를 만나면 죽고 systemd 가 3초마다 되살리다 결국 서비스가 내려간다.
// 리로드는 검증에 실패하면 아무것도 바꾸지 않고 그냥 계속 서빙한다.
function reload() {
  let next;
  try {
    next = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    validateAddresses(next.addresses);
    if (next.historyLength !== undefined) {
      const h = Number(next.historyLength);
      if (!Number.isFinite(h) || h < 2 || h > 10_000) {
        throw new Error(`historyLength=${next.historyLength} 는 2~10000 사이여야 한다`);
      }
      next.historyLength = h;
    }
  } catch (err) {
    log(`reload 거부: ${err.message} — 기존 설정(${state.accounts.length} addresses)을 유지한다`);
    return false;
  }

  if (next.historyLength !== undefined) HISTORY = next.historyLength;

  // 남아 있는 주소는 계정 '객체를 그대로' 재사용한다 -> 잔액·히스토리·delta 가 보존되고
  // 화면도 깜빡이지 않는다. 새 주소만 balanceWei=null 로 들어가 다음 tick에서 채워진다.
  const before = new Map(state.accounts.map((a) => [a.address.toLowerCase(), a]));
  let added = 0;
  state.accounts = next.addresses.map((a) => {
    const key = a.address.toLowerCase();
    const kept = before.get(key);
    if (!kept) { added += 1; return makeAccount(a); }
    before.delete(key);
    kept.label = a.label;                 // 라벨/태그는 갈아끼운다
    kept.tag = a.tag ?? null;
    if (kept.history.length > HISTORY) kept.history.splice(0, kept.history.length - HISTORY);
    return kept;
  });

  // 나머지 키는 타이머·소켓·RPC 클라이언트에 이미 묶여 있어 갈아끼울 수 없다.
  // 조용히 무시하면 "바꿨는데 왜 그대로냐"가 되므로 로그로 알린다.
  for (const k of ['rpcUrl', 'rpcUrls', 'pollIntervalMs']) {
    if (JSON.stringify(next[k]) !== JSON.stringify(CONFIG[k])) {
      log(`reload: ${k} 변경은 재시작이 필요하다 (이번엔 무시됨)`);
    }
  }

  forceRefresh = true;          // 새 주소의 잔액을 다음 블록까지 기다리지 않는다
  invalidateSnapshot();
  broadcast({ type: 'snapshot', ...snapshot() });
  log(`reload 완료 · ${state.accounts.length} addresses (추가 ${added} · 제거 ${before.size})`);
  return true;
}
process.on('SIGHUP', () => reload());

// ── 마지막 방어선 ───────────────────────────────────────────────────────────
// 읽기 전용 대시보드에서 예외 하나로 프로세스를 죽이면 재시작에 3초가 들고 히스토리가
// 전부 사라진다. 소켓이 끊기는 순간의 write 실패 같은 건 로그만 남기고 계속 서빙하는
// 편이 낫다. 다만 영원히 삼키면 망가진 프로세스가 계속 잘못된 값을 내보내므로,
// 짧은 시간에 반복되면 복구 불가로 보고 systemd 에 재시작을 맡긴다.
const CRASH_WINDOW_MS = 60_000;
const CRASH_LIMIT = 10;
let crashes = [];

function survive(kind, err) {
  const now = Date.now();
  crashes = crashes.filter((t) => now - t < CRASH_WINDOW_MS);
  crashes.push(now);
  log(`${kind} ${err && err.stack ? err.stack : err}`);
  if (crashes.length >= CRASH_LIMIT) {
    log(`${CRASH_WINDOW_MS / 1000}초 안에 ${crashes.length}회 -> 복구 불가로 판단하고 종료한다`);
    process.exit(1);
  }
}
process.on('uncaughtException', (err) => survive('uncaughtException', err));
process.on('unhandledRejection', (err) => survive('unhandledRejection', err));

// ── 부팅 / 종료 ─────────────────────────────────────────────────────────────
// 재시작하면 지금까지는 히스토리가 통째로 사라지고 첫 tick 의 delta 가 전부 0 이 됐다.
// 비교할 이전 값이 없어서다. 저장해 둔 마지막 기록으로 그 기준점을 되살린다.
function restore() {
  const latest = store.latest();
  let restored = 0;

  for (const acct of state.accounts) {
    const key = acct.address.toLowerCase();
    const last = latest.get(key);
    if (!last) continue;
    acct.balanceWei = last.wei;
    acct.lastChangedBlock = last.block;
    // 저장된 건 '변한 순간'뿐이라 이것만으로 계단이 그대로 복원된다.
    acct.history = store
      .history(key, 0)
      .slice(-HISTORY)
      .map((r) => ({ block: r.block, balanceWei: r.wei }));
    restored += 1;
  }

  log(`storage    ${DATA_DIR} (복원 ${restored}/${state.accounts.length} addresses)`);
  if (!store.status.ok) log(`storage 경고: ${store.status.error} -- 기록 없이 계속 서빙한다`);
  invalidateSnapshot();
}

let pollTimer = null;
let pingTimer = null;

function shutdown(signal) {
  log(`${signal} 수신 · 종료 중 (구독자 ${clients.size})`);
  clearInterval(pollTimer);
  clearInterval(pingTimer);
  for (const res of clients) res.end();   // 브라우저 EventSource가 알아서 재연결한다
  clients.clear();
  perIp.clear();
  store.close();
  server.close(() => process.exit(0));
  server.closeAllConnections?.();
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

(async () => {
  // 헤더를 조금씩 흘려보내며 연결만 붙잡아 두는 요청(slowloris)을 오래 두지 않는다.
  // 응답 시간이 아니라 '헤더 수신' 타이머라 장시간 열려 있는 SSE 응답과는 무관하다.
  server.headersTimeout = 15_000;

  server.listen(PORT, HOST, () => {
    log(`dashboard  http://${HOST}:${PORT}`);
    // URL에 API 키가 들어 있을 수 있으므로 호스트만 남긴다
    log(`rpc        ${RPC_URLS.map(safeHost).join(', ')}`);
    log(`polling    every ${POLL_MS}ms · ${state.accounts.length} addresses`);
    log(`limits     max ${MAX_SUBSCRIBERS} subscribers · ${MAX_PER_IP} per ip · trust-proxy ${TRUST_PROXY === null ? 'loopback' : TRUST_PROXY}`);
  });

  try {
    state.chainId = Number(BigInt(await rpc.call('eth_chainId')));
    invalidateSnapshot();
    log(`chainId    ${state.chainId}`);
  } catch (err) {
    log(`chainId 조회 실패: ${err.message}`);
  }

  restore();
  await tick();
  pollTimer = setInterval(tick, POLL_MS);
  pingTimer = setInterval(() => broadcast({ type: 'ping' }), 25_000); // 프록시가 유휴 연결을 끊지 않도록
})();

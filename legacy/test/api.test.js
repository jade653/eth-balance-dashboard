'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// config.json 에 실제로 들어 있는 주소
const WATCHED = '0x6d93f35603783fb9c1ac061b1349bed7a31386c4';
// 형식은 멀쩡하지만 감시 목록에 없는 주소
const UNWATCHED = '0x1111111111111111111111111111111111111111';

let child;
let base;

// 서버를 진짜로 띄운다. 라우트 검증은 함수 단위로 흉내내면 정작 라우팅·파싱
// 단계에서 새는 걸 못 잡으므로, 실제 HTTP 요청으로 확인한다.
before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ethdash-api-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = `http://127.0.0.1:${port}`;

  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      // 즉시 연결이 거부되는 주소. 테스트가 외부 네트워크에 기대지 않게 한다.
      RPC_HTTP_URL: 'http://127.0.0.1:1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${base}/api/health`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('서버가 뜨지 않았다');
});

after(() => child?.kill());

const get = (q) => fetch(`${base}/api/history${q}`);

/* ── 정상 경로 ─────────────────────────────────────────────────────────── */

test('감시 중인 주소의 기록을 준다', async () => {
  const res = await get(`?address=${WATCHED}&range=24h`);
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.range, '24h');
  assert.equal(body.accounts.length, 1);
  assert.equal(body.accounts[0].address, WATCHED);
  assert.ok(Array.isArray(body.accounts[0].records));
});

test('address 를 빼면 전 주소를 준다', async () => {
  const res = await get('?range=24h');
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.accounts.length, 9);   // config.json 의 주소 수
});

/* ── 1층 방어: 이상한 입력은 SQL 근처에도 못 간다 ──────────────────────── */

test('range 가 없으면 400', async () => {
  const res = await get(`?address=${WATCHED}`);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'bad range');
});

test('허용 목록에 없는 range 는 400', async () => {
  for (const bad of ['all', '30d', '1h%27--', 'constructor']) {
    const res = await get(`?range=${bad}`);
    assert.equal(res.status, 400, `거절해야 한다: ${bad}`);
  }
});

test('주소 형식이 아니면 400', async () => {
  for (const bad of [
    "0x%27%20OR%20%271%27%3D%271",          // 0x' OR '1'='1
    "%27%3B%20DROP%20TABLE%20balances%3B--", // '; DROP TABLE balances;--
    '0x123',
    'notanaddress',
  ]) {
    const res = await get(`?address=${bad}&range=24h`);
    assert.equal(res.status, 400, `거절해야 한다: ${bad}`);
    assert.equal((await res.json()).error, 'bad address');
  }
});

test('형식은 맞지만 감시하지 않는 주소는 404', async () => {
  const res = await get(`?address=${UNWATCHED}&range=24h`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'unknown address');
});

test('injection 을 시도한 뒤에도 서버는 멀쩡하다', async () => {
  await get("?address=%27%3B%20DROP%20TABLE%20balances%3B--&range=24h");

  const res = await get(`?address=${WATCHED}&range=24h`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).accounts.length, 1);
});

/* ── 헬스체크 ──────────────────────────────────────────────────────────── */

test('health 상세에 저장소 상태가 들어 있다', async () => {
  const body = await (await fetch(`${base}/api/health`)).json();
  assert.equal(body.storage.ok, true);
});

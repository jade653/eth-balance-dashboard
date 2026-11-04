/**
 * app.js 를 진짜 HTTP 로 두드린다. 다만 RPC 는 가짜다.
 *
 * - 진짜 HTTP: 라우팅·메서드·헤더·상태코드는 함수 호출로 흉내내면 정작 거기서 새는 걸 못 잡는다.
 * - 가짜 RPC: CI 가 메인넷/무료 RPC 상태에 따라 깨지면 "코드가 틀렸다"는 신호가 아니게 된다.
 *   외부 RPC 와 실제로 붙는지는 테스트가 아니라 배포 후 헬스체크가 확인할 일이다.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';

// 테스트마다 응답을 바꿀 수 있는 가짜 rpc
const fakeRpc = {
  responses: {},
  async call(method) {
    const r = this.responses[method];
    if (r instanceof Error) throw r;
    if (r === undefined) throw new Error(`unexpected method ${method}`);
    return r;
  },
};

let server;
let base;

before(async () => {
  server = http.createServer(createApp({ rpc: fakeRpc }));
  // 포트 0 = OS 가 빈 포트를 골라준다. 고정 포트는 CI 에서 충돌한다.
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('GET /api/v1/health — RPC 가 살아 있으면 200 과 체인 정보', async () => {
  fakeRpc.responses = { eth_chainId: '0x1', eth_blockNumber: '0x1631c5f' };

  const res = await fetch(`${base}/api/v1/health`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^application\/json/);
  assert.deepEqual(await res.json(), { ok: true, chainId: 1, block: '23272543' });
});

test('GET /api/v1/health — RPC 가 죽으면 503, 에러 원문은 숨긴다', async () => {
  // 실제 에러 메시지에 RPC URL(API 키)이 섞이는 상황을 흉내낸다
  fakeRpc.responses = {
    eth_chainId: new Error('connect failed https://mainnet.example/SECRET_KEY'),
    eth_blockNumber: '0x1',
  };

  const res = await fetch(`${base}/api/v1/health`);
  assert.equal(res.status, 503);
  const text = await res.text();
  assert.doesNotMatch(text, /SECRET_KEY/);
  assert.deepEqual(JSON.parse(text), { ok: false, error: 'rpc_unavailable' });
});

test('허용하지 않는 메서드는 405 + Allow 헤더', async () => {
  const res = await fetch(`${base}/api/v1/health`, { method: 'POST' });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'GET');
});

test('없는 경로는 JSON 404', async () => {
  for (const path of ['/', '/api/health', '/api/v1/nope', '/api/v1/health/extra']) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 404, path);
    assert.deepEqual(await res.json(), { error: 'not_found' });
  }
});

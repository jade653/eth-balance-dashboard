/**
 * app.js 를 진짜 HTTP 로 두드리되, RPC 는 가짜 노드 응답(fixture)을 쓴다.
 * CI 가 메인넷 상태에 따라 깨지지 않게 하기 위해서다.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';

const TX = '0x' + 'aa'.repeat(32);
const ADDR = '0x' + '11'.repeat(20);
const TO = '0x' + '22'.repeat(20);

// 메서드 → (params) => 결과. Error 를 돌려주면 그 호출이 실패한다.
let node = {};

const fakeRpc = {
  async call(method, params = []) {
    const fn = node[method];
    if (!fn) throw new Error(`unexpected method ${method}`);
    const r = fn(...params);
    if (r instanceof Error) throw r;
    return r;
  },
  async batch(calls) {
    return Promise.all(calls.map((c) => this.call(c.method, c.params)));
  },
};

let server;
let base;
const get = (path, init) => fetch(`${base}${path}`, init);

before(async () => {
  server = http.createServer(createApp({ rpc: fakeRpc }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => { node = {}; });

/* ── health ─────────────────────────────────────────────────────────────── */

test('GET /api/v1/health → 200', async () => {
  node = { eth_chainId: () => '0x1', eth_blockNumber: () => '0x1631c5f' };
  const res = await get('/api/v1/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, chainId: 1, block: '23272543' });
});

test('RPC 가 죽으면 503, 에러 원문(API 키)은 숨긴다', async () => {
  node = {
    eth_chainId: () => new Error('connect failed https://mainnet.example/SECRET_KEY'),
    eth_blockNumber: () => '0x1',
  };
  const res = await get('/api/v1/health');
  assert.equal(res.status, 503);
  const text = await res.text();
  assert.doesNotMatch(text, /SECRET_KEY/);
  assert.deepEqual(JSON.parse(text), { error: 'rpc_unavailable' });
});

/* ── txs ────────────────────────────────────────────────────────────────── */

const minedTx = {
  hash: TX, from: ADDR, to: TO, value: '0xde0b6b3a7640000', // 1 ETH
  nonce: '0x5', gas: '0x5208', gasPrice: '0x3b9aca00', type: '0x2',
  input: '0x', blockNumber: '0x10',
};
const receipt = {
  status: '0x1', gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', // 21000 × 1 gwei
  contractAddress: null, logs: [],
};

test('GET /txs/{hash} → 채굴된 tx 의 정보 (숫자는 10진수 문자열)', async () => {
  node = {
    eth_getTransactionByHash: () => minedTx,
    eth_getTransactionReceipt: () => receipt,
    eth_getBlockByNumber: (n) => (n === '0x10' ? { timestamp: '0x6553f100' } : null),
  };
  const res = await get(`/api/v1/txs/${TX}`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    hash: TX,
    status: 'success',
    blockNumber: '16',
    timestamp: '2023-11-14T22:13:20.000Z',
    from: ADDR,
    to: TO,
    contractCreated: null,
    valueWei: '1000000000000000000',
    feeWei: '21000000000000',
    gasUsed: '21000',
    gasLimit: '21000',
    gasPriceWei: '1000000000',
    nonce: '5',
    type: 2,
    input: '0x',
    logCount: 0,
  });
});

test('실패한 tx 는 status=failed', async () => {
  node = {
    eth_getTransactionByHash: () => minedTx,
    eth_getTransactionReceipt: () => ({ ...receipt, status: '0x0' }),
    eth_getBlockByNumber: () => ({ timestamp: '0x0' }),
  };
  const body = await (await get(`/api/v1/txs/${TX}`)).json();
  assert.equal(body.status, 'failed');
});

test('아직 블록에 안 들어간 tx 는 status=pending', async () => {
  node = {
    eth_getTransactionByHash: () => ({ ...minedTx, blockNumber: null }),
    eth_getTransactionReceipt: () => null,
  };
  const res = await get(`/api/v1/txs/${TX}`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'pending');
});

test('없는 tx → 404, 형식이 틀린 해시 → 400 (노드에 묻지도 않는다)', async () => {
  node = { eth_getTransactionByHash: () => null, eth_getTransactionReceipt: () => null };
  assert.equal((await get(`/api/v1/txs/${TX}`)).status, 404);

  node = {}; // 노드 호출이 일어나면 unexpected method 로 500 이 된다
  const res = await get('/api/v1/txs/0x1234');
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'invalid_tx_hash' });
});

/* ── blocks ─────────────────────────────────────────────────────────────── */

const block = {
  number: '0x10', hash: '0x' + 'bb'.repeat(32), parentHash: '0x' + 'cc'.repeat(32),
  timestamp: '0x6553f100', miner: ADDR, gasUsed: '0x5208', gasLimit: '0x1c9c380',
  baseFeePerGas: '0x7', transactions: [TX],
};

test('GET /blocks/{number} 는 10진수를 16진수로 바꿔 노드에 묻는다', async () => {
  node = { eth_getBlockByNumber: (tag) => (tag === '0x10' ? block : null) };
  const res = await get('/api/v1/blocks/16');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.number, '16');
  assert.equal(body.txCount, 1);
  assert.deepEqual(body.transactions, [TX]);
});

test('GET /blocks/latest', async () => {
  node = { eth_getBlockByNumber: (tag) => (tag === 'latest' ? block : null) };
  assert.equal((await get('/api/v1/blocks/latest')).status, 200);
});

test('블록 id 검증: 아직 없는 번호 404, 형식 오류 400', async () => {
  node = { eth_getBlockByNumber: () => null };
  assert.equal((await get('/api/v1/blocks/999999999')).status, 404);
  for (const bad of ['0x10', '-1', '01', '1.5', 'earliest', '9'.repeat(16)]) {
    assert.equal((await get(`/api/v1/blocks/${bad}`)).status, 400, bad);
  }
});

/* ── addresses ──────────────────────────────────────────────────────────── */

test('GET /addresses/{address} → 잔액·nonce·EOA/컨트랙트 구분', async () => {
  node = {
    eth_getBalance: () => '0xde0b6b3a7640000',
    eth_getTransactionCount: () => '0x3',
    eth_getCode: () => '0x',
  };
  assert.deepEqual(await (await get(`/api/v1/addresses/${ADDR}`)).json(), {
    address: ADDR, balanceWei: '1000000000000000000', nonce: '3', type: 'eoa',
  });

  node.eth_getCode = () => '0x6080604052';
  assert.equal((await (await get(`/api/v1/addresses/${ADDR}`)).json()).type, 'contract');
});

test('형식이 틀린 주소 → 400', async () => {
  assert.equal((await get('/api/v1/addresses/0x1234')).status, 400);
});

/* ── 공통 ───────────────────────────────────────────────────────────────── */

test('없는 경로 → 404, 있는 경로에 틀린 메서드 → 405 + Allow', async () => {
  for (const path of ['/', '/api/health', '/api/v1/nope', '/api/v1/txs', `/api/v1/txs/${TX}/extra`]) {
    assert.equal((await get(path)).status, 404, path);
  }
  const res = await get(`/api/v1/txs/${TX}`, { method: 'DELETE' });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'GET');
});

test('우리 코드의 버그는 503 이 아니라 500', async () => {
  // receipt.logs 가 없는 비정상 응답 → explorer.js 에서 TypeError
  node = {
    eth_getTransactionByHash: () => minedTx,
    eth_getTransactionReceipt: () => ({ ...receipt, logs: undefined }),
    eth_getBlockByNumber: () => ({ timestamp: '0x0' }),
  };
  assert.equal((await get(`/api/v1/txs/${TX}`)).status, 500);
});

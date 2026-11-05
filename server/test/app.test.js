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

// 가짜 DB. 테스트마다 함수를 바꿔 끼운다.
let store = {};
const fakeStore = {
  latestBlock: (...a) => store.latestBlock(...a),
  coverage: (...a) => (store.coverage ?? (async () => null))(...a),
  listAddressTxs: (...a) => store.listAddressTxs(...a),
  latestBlocks: (...a) => store.latestBlocks(...a),
  latestTxs: (...a) => store.latestTxs(...a),
  listBlockTxs: (...a) => store.listBlockTxs(...a),
  stats: (...a) => store.stats(...a),
};

let server;
let base;
const get = (path, init) => fetch(`${base}${path}`, init);

before(async () => {
  server = http.createServer(createApp({ rpc: fakeRpc, store: fakeStore }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => { node = {}; store = {}; });

/* ── health ─────────────────────────────────────────────────────────────── */

test('GET /api/v1/health → 200', async () => {
  node = { eth_chainId: () => '0x1', eth_blockNumber: () => '0x1631c5f' };
  const res = await get('/api/v1/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, chainId: 1, block: '23272543', indexer: null });
});

test('health 에 인덱서 범위와 지연(lag)이 붙는다. DB 가 죽어도 health 는 200', async () => {
  node = { eth_chainId: () => '0x1', eth_blockNumber: () => '0x64' }; // 100
  store.coverage = async () => ({ fromBlock: '1', toBlock: '97', fromTime: 'a', toTime: 'b' });
  assert.equal((await (await get('/api/v1/health')).json()).indexer.lag, '3');

  store.coverage = async () => { throw new Error('ECONNREFUSED'); };
  const res = await get('/api/v1/health');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).indexer, null);
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
    position: null,
    type: 2,
    maxFeePerGasWei: null,
    maxPriorityFeePerGasWei: null,
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

/* ── addresses/{address}/txs (DB) ───────────────────────────────────────── */

test('GET /addresses/{a}/txs → DB 결과 + 커버리지, 쿼리 파라미터 해석', async () => {
  let seen;
  store.listAddressTxs = async (addr, opts) => {
    seen = { addr, opts };
    return { items: [{ hash: TX }], nextCursor: '16-0' };
  };
  store.coverage = async () => ({ fromBlock: '10', toBlock: '20', fromTime: 'x', toTime: 'y' });

  const res = await get(`/api/v1/addresses/${ADDR}/txs?limit=10&cursor=17-3`);
  assert.equal(res.status, 200);
  assert.deepEqual(seen, { addr: ADDR, opts: { limit: 10, before: ['17', 3] } });
  const body = await res.json();
  assert.equal(body.nextCursor, '16-0');
  assert.equal(body.coverage.toBlock, '20');

  await get(`/api/v1/addresses/${ADDR}/txs`);
  assert.deepEqual(seen.opts, { limit: 25, before: undefined }); // 기본값
});

test('목록 파라미터가 틀리면 400 (DB 에 묻지 않는다)', async () => {
  store.listAddressTxs = async () => { throw new Error('호출되면 안 됨'); };
  for (const [q, code] of [
    ['limit=0', 'invalid_limit'], ['limit=101', 'invalid_limit'], ['limit=abc', 'invalid_limit'],
    ['cursor=abc', 'invalid_cursor'], ['cursor=1-', 'invalid_cursor'], ["cursor=1-1'", 'invalid_cursor'],
  ]) {
    const res = await get(`/api/v1/addresses/${ADDR}/txs?${q}`);
    assert.equal(res.status, 400, q);
    assert.equal((await res.json()).error, code, q);
  }
  assert.equal((await get('/api/v1/addresses/0x12/txs')).status, 400);
});

test('DB 가 죽으면 503 db_unavailable (RPC 장애와 구분된다)', async () => {
  store.listAddressTxs = async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:5432'); };
  store.coverage = async () => null;
  const res = await get(`/api/v1/addresses/${ADDR}/txs`);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'db_unavailable' });
});

/* ── 체인 정보 ──────────────────────────────────────────────────────────── */

test('GET /chain → 이름·단위 기본값: chainId 1 이면 Ethereum/ETH, 아니면 Chain <id>/ETH', async () => {
  node = { eth_chainId: () => '0x1' };
  assert.deepEqual(await (await get('/api/v1/chain')).json(), { chainId: 1, name: 'Ethereum', symbol: 'ETH' });
  node = { eth_chainId: () => '0x1db1' };
  assert.deepEqual(await (await get('/api/v1/chain')).json(), { chainId: 7601, name: 'Chain 7601', symbol: 'ETH' });
});

test('GET /chain → 설정(CHAIN_NAME, NATIVE_SYMBOL)이 있으면 그 값', async () => {
  const s2 = http.createServer(createApp({ rpc: fakeRpc, store: fakeStore, chain: { name: 'Mustsem', symbol: 'MST' } }));
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  try {
    node = { eth_chainId: () => '0x1db1' };
    const body = await (await fetch(`http://127.0.0.1:${s2.address().port}/api/v1/chain`)).json();
    assert.deepEqual(body, { chainId: 7601, name: 'Mustsem', symbol: 'MST' });
  } finally {
    s2.close();
  }
});

/* ── 홈 화면용 목록·통계 (DB) ─────────────────────────────────────────────── */

test('GET /blocks, /txs → 최신 목록. limit 기본 10, 최대 25', async () => {
  const seen = [];
  store.latestBlocks = async (n) => { seen.push(['blocks', n]); return [{ number: '9' }]; };
  store.latestTxs = async (n) => { seen.push(['txs', n]); return [{ hash: TX }]; };

  assert.deepEqual(await (await get('/api/v1/blocks')).json(), { items: [{ number: '9' }] });
  assert.deepEqual(await (await get('/api/v1/txs?limit=6')).json(), { items: [{ hash: TX }] });
  assert.deepEqual(seen, [['blocks', 10], ['txs', 6]]);

  assert.equal((await get('/api/v1/blocks?limit=26')).status, 400);
  assert.equal((await get('/api/v1/txs?limit=0')).status, 400);
});

test('GET /stats → 통계 + 보관 범위', async () => {
  store.stats = async () => ({ txs24h: '1500000', blocks24h: '7200', avgBlockTimeSec: 12 });
  store.coverage = async () => ({ fromBlock: '1', toBlock: '2', fromTime: 'a', toTime: 'b' });
  const body = await (await get('/api/v1/stats')).json();
  assert.equal(body.txs24h, '1500000');
  assert.equal(body.coverage.toBlock, '2');
});

test('GET /blocks/{n}/txs → 블록 안 목록, 커서는 블록 안 순서', async () => {
  let seen;
  store.listBlockTxs = async (n, opts) => { seen = [n, opts]; return { items: [], nextCursor: null }; };
  const res = await get('/api/v1/blocks/16/txs?limit=5&cursor=40');
  assert.equal(res.status, 200);
  assert.deepEqual(seen, ['16', { limit: 5, before: 40 }]);
  assert.equal((await res.json()).blockNumber, '16');

  for (const bad of ['/api/v1/blocks/latest/txs', '/api/v1/blocks/0x10/txs', '/api/v1/blocks/16/txs?cursor=1-2']) {
    assert.equal((await get(bad)).status, 400, bad);
  }
});

/* ── 공통 ───────────────────────────────────────────────────────────────── */

test('없는 경로 → 404, 있는 경로에 틀린 메서드 → 405 + Allow', async () => {
  for (const path of ['/', '/api/health', '/api/v1/nope', '/api/v1/tx', `/api/v1/txs/${TX}/extra`]) {
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

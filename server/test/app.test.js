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
  listTokens: (...a) => store.listTokens(...a),
  getToken: (...a) => store.getToken(...a),
  tokenHolders: (...a) => store.tokenHolders(...a),
  allTokenHolders: (...a) => store.allTokenHolders(...a),
  tokenHolderSummary: (...a) => store.tokenHolderSummary(...a),
  tokenBalanceOf: (...a) => store.tokenBalanceOf(...a),
  listTokenTransfers: (...a) => store.listTokenTransfers(...a),
  addressTokenBalances: (...a) => store.addressTokenBalances(...a),
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
    authorizationList: null,
    baseFeePerGasWei: null,
    burntFeeWei: null,
    savingsFeeWei: null,
    blobGasUsed: null,
    blobGasPriceWei: null,
    logCount: 0,
    logs: [],
    tokenTransfers: [],
    tokens: {},
    contracts: [],
  });
});

test('수수료 내역: 소각(base fee × gas) 과 절약(maxFee − 실제 가격) × gas, 블록의 base fee', async () => {
  node = {
    // maxFee 3 gwei 까지 낼 각오, 실제 1 gwei. base fee 0.4 gwei
    eth_getTransactionByHash: () => ({ ...minedTx, maxFeePerGas: '0xb2d05e00', maxPriorityFeePerGas: '0x3b9aca00' }),
    eth_getTransactionReceipt: () => receipt,
    eth_getBlockByNumber: () => ({ timestamp: '0x0', baseFeePerGas: '0x17d78400' }),
    eth_getCode: (a) => (a === TO ? '0x6080' : '0x'),
  };
  const body = await (await get(`/api/v1/txs/${TX}`)).json();
  assert.equal(body.baseFeePerGasWei, '400000000');
  assert.equal(body.burntFeeWei, String(400000000n * 21000n));
  assert.equal(body.savingsFeeWei, String((3000000000n - 1000000000n) * 21000n));
  assert.deepEqual(body.contracts, [TO]); // to 만 코드가 있다
});

test('EIP-7702 tx 의 authorizationList 를 10진수로', async () => {
  node = {
    eth_getTransactionByHash: () => ({ ...minedTx, type: '0x4', authorizationList: [{ chainId: '0x1', address: TO, nonce: '0x3', yParity: '0x0', r: '0x1', s: '0x2' }] }),
    eth_getTransactionReceipt: () => receipt,
    eth_getBlockByNumber: () => ({ timestamp: '0x0' }),
  };
  const body = await (await get(`/api/v1/txs/${TX}`)).json();
  assert.equal(body.type, 4);
  assert.deepEqual(body.authorizationList, [{ chainId: '1', address: TO, nonce: '3' }]);
});

test('토큰 송금 tx: to 는 토큰 컨트랙트, 실제 받는 사람은 Transfer 로그에서', async () => {
  const TOKEN = '0x' + '33'.repeat(20);
  const OTHER = '0x' + '44'.repeat(20);
  const RECIPIENT = '0x92d0a3c5d5f086db2c94ded1cfac0e0c1798fb16';
  const pad = (a) => '0x' + '0'.repeat(24) + a.slice(2);
  const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const word = (n) => '0x' + n.toString(16).padStart(64, '0');
  const logs = [
    { address: TOKEN, topics: [TRANSFER, pad(ADDR), pad(RECIPIENT)], data: word(1500000n) },     // ERC-20
    { address: OTHER, topics: [TRANSFER, pad(ADDR), pad(TO), word(7n)], data: '0x' },          // ERC-721 → 제외
    { address: OTHER, topics: ['0x' + '00'.repeat(32)], data: '0x' },                          // 다른 이벤트 → 제외
  ];
  // symbol() 은 ABI string "USDT", name() 은 "Tether USD", decimals() 는 6
  const abiStr = (s) => '0x' + word(32n).slice(2) + word(BigInt(s.length)).slice(2) + Buffer.from(s).toString('hex').padEnd(64, '0');
  node = {
    eth_getTransactionByHash: () => ({ ...minedTx, to: TOKEN, value: '0x0', input: '0xa9059cbb' + pad(RECIPIENT).slice(2) + word(1500000n).slice(2) }),
    eth_getTransactionReceipt: () => ({ ...receipt, logs: logs.map((l, i) => ({ ...l, logIndex: '0x' + i.toString(16) })) }),
    eth_getBlockByNumber: () => ({ timestamp: '0x0' }),
    eth_call: ({ to, data }) => (to !== TOKEN ? new Error('revert')
      : data === '0x95d89b41' ? abiStr('USDT') : data === '0x06fdde03' ? abiStr('Tether USD') : word(6n)),
  };
  const body = await (await get(`/api/v1/txs/${TX}`)).json();
  assert.equal(body.to, TOKEN);
  assert.equal(body.logCount, 3);
  assert.deepEqual(body.tokenTransfers, [{ token: TOKEN, from: ADDR, to: RECIPIENT, amount: '1500000', name: 'Tether USD', symbol: 'USDT', decimals: 6 }]);
  // 로그는 원문 그대로 (화면이 이벤트 이름을 붙여 해석한다), 토큰 이름표는 토큰인 주소에만
  assert.deepEqual(body.logs[0], { address: TOKEN, topics: logs[0].topics, data: logs[0].data, logIndex: '0' });
  assert.deepEqual(body.tokens, { [TOKEN]: { name: 'Tether USD', symbol: 'USDT', decimals: 6 } });
});

test('symbol()/decimals() 가 실패하는 토큰도 전송 자체는 보여준다', async () => {
  const TOKEN = '0x' + '33'.repeat(20);
  const pad = (a) => '0x' + '0'.repeat(24) + a.slice(2);
  const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  node = {
    eth_getTransactionByHash: () => minedTx,
    eth_getTransactionReceipt: () => ({ ...receipt, logs: [{ address: TOKEN, topics: [TRANSFER, pad(ADDR), pad(TO)], data: '0x' + '0'.repeat(63) + '9' }] }),
    eth_getBlockByNumber: () => ({ timestamp: '0x0' }),
    eth_call: () => new Error('execution reverted'),
  };
  const body = await (await get(`/api/v1/txs/${TX}`)).json();
  assert.deepEqual(body.tokenTransfers, [{ token: TOKEN, from: ADDR, to: TO, amount: '9', name: null, symbol: null, decimals: null }]);
  assert.deepEqual(body.tokens, {});
});

/* ── trace / state ──────────────────────────────────────────────────────── */

test('GET /txs/{h}/trace → callTracer 를 펼친 내부 호출 목록 (깊이·위치)', async () => {
  node = {
    debug_traceTransaction: (h, opts) => {
      assert.equal(opts.tracer, 'callTracer');
      return {
        type: 'CALL', from: ADDR, to: TO, value: '0x0',
        calls: [
          { type: 'CALL', from: TO, to: ADDR, value: '0x64', gas: '0x10', gasUsed: '0x5' },
          { type: 'STATICCALL', from: TO, to: TO, calls: [{ type: 'DELEGATECALL', from: TO, to: ADDR, error: 'execution reverted' }] },
        ],
      };
    },
  };
  const body = await (await get(`/api/v1/txs/${TX}/trace`)).json();
  assert.deepEqual(body.calls.map((c) => [c.type, c.depth, c.path, c.valueWei, c.error]), [
    ['CALL', 1, '0', '100', null],
    ['STATICCALL', 1, '1', '0', null],
    ['DELEGATECALL', 2, '1_0', '0', 'execution reverted'],
  ]);
});

test('노드가 debug API 를 막아 두면 501 trace_unsupported (503 이 아니다)', async () => {
  const err = Object.assign(new Error('debug_traceTransaction: the method debug_traceTransaction does not exist/is not available'), { rpcCode: -32601 });
  node = { debug_traceTransaction: () => err };
  for (const p of ['trace', 'state']) {
    const res = await get(`/api/v1/txs/${TX}/${p}`);
    assert.equal(res.status, 501, p);
    assert.deepEqual(await res.json(), { error: 'trace_unsupported' });
  }
});

test('GET /txs/{h}/state → 주소별 잔액·nonce 전후, 바뀐 저장소 칸', async () => {
  const S = '0x' + '00'.repeat(31) + '01';
  node = {
    debug_traceTransaction: () => ({
      pre: { [ADDR]: { balance: '0x64', nonce: 5 }, [TO]: { balance: '0x0', storage: { [S]: '0x' + '00'.repeat(31) + '07' } } },
      post: { [ADDR]: { balance: '0x32', nonce: 6 }, [TO]: { storage: { [S]: '0x' + '00'.repeat(31) + '09' } } },
    }),
  };
  const { items } = await (await get(`/api/v1/txs/${TX}/state`)).json();
  assert.deepEqual(items[0], { address: ADDR, balanceBefore: '100', balanceAfter: '50', nonceBefore: 5, nonceAfter: 6, storage: [] });
  // post 에 balance 가 없으면 안 바뀐 것
  assert.equal(items[1].balanceAfter, '0');
  assert.deepEqual(items[1].storage, [{ slot: S, before: '0x' + '00'.repeat(31) + '07', after: '0x' + '00'.repeat(31) + '09' }]);
});

/* ── 토큰 ───────────────────────────────────────────────────────────────── */

const TOKEN_ROW = {
  address: '0x' + '33'.repeat(20), name: 'Stable', symbol: 'STB', decimals: 6,
  startBlock: '100', syncedBlock: '200', holders: 120, transfers: '999', updatedAt: null,
};

test('GET /tokens/{a} → 노드의 현재 값(총발행량) + DB 의 홀더 수·수집 진행', async () => {
  const word = (n) => '0x' + n.toString(16).padStart(64, '0');
  node = {
    eth_getCode: () => '0x6080',
    eth_blockNumber: () => '0xd2', // 210
    eth_call: ({ data }) => ({ '0x313ce567': word(6n), '0x18160ddd': word(5_000_000n) })[data] ?? new Error('revert'),
  };
  store.getToken = async () => TOKEN_ROW;
  const body = await (await get(`/api/v1/tokens/${TOKEN_ROW.address}`)).json();
  assert.equal(body.totalSupply, '5000000');
  assert.equal(body.decimals, 6);
  assert.equal(body.name, 'Stable'); // 노드가 name() 을 못 주면 DB 의 값
  assert.equal(body.tracked, true);
  assert.equal(body.holders, 120);
  assert.equal(body.head, '210');
});

test('추적하지 않는 ERC-20 도 개요는 준다 (tracked=false). 토큰이 아닌 주소는 404', async () => {
  const word = (n) => '0x' + n.toString(16).padStart(64, '0');
  node = { eth_getCode: () => '0x6080', eth_blockNumber: () => '0x1', eth_call: () => word(18n) };
  store.getToken = async () => null;
  const body = await (await get(`/api/v1/tokens/${ADDR}`)).json();
  assert.equal(body.tracked, false);
  assert.equal(body.holders, null);

  node = { eth_getCode: () => '0x', eth_blockNumber: () => '0x1', eth_call: () => new Error('x') };
  assert.equal((await get(`/api/v1/tokens/${ADDR}`)).status, 404);
});

test('GET /tokens/{a}/holders → 페이지 번호, 전체 페이지 수, 컨트랙트 표시', async () => {
  let asked;
  store.getToken = async () => TOKEN_ROW;
  store.tokenHolders = async (t, opts) => {
    asked = opts;
    return [{ rank: 51, address: ADDR, balance: '10' }, { rank: 52, address: TO, balance: '5' }];
  };
  node = { eth_getCode: (a) => (a === TO ? '0x60' : '0x') };
  const body = await (await get(`/api/v1/tokens/${TOKEN_ROW.address}/holders?page=2&limit=50`)).json();
  assert.deepEqual(asked, { limit: 50, offset: 50 });
  assert.equal(body.totalPages, 3); // 120 명 / 50
  assert.deepEqual(body.items.map((x) => x.isContract), [false, true]);

  assert.equal((await get(`/api/v1/tokens/${TOKEN_ROW.address}/holders?page=0`)).status, 400);
  store.getToken = async () => null;
  const res = await get(`/api/v1/tokens/${TOKEN_ROW.address}/holders`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not_tracked' });
});

test('GET /tokens/{a}/holders.csv → 소수점을 적용한 잔액까지 CSV 로', async () => {
  store.getToken = async () => TOKEN_ROW;
  store.allTokenHolders = async () => [{ rank: 1, address: ADDR, balance: '1500000' }, { rank: 2, address: TO, balance: '7' }];
  const res = await get(`/api/v1/tokens/${TOKEN_ROW.address}/holders.csv`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /STB-holders-200\.csv/);
  assert.equal(await res.text(), `rank,address,balance_raw,balance\n1,${ADDR},1500000,1.5\n2,${TO},7,0.000007\n`);
});

test('GET /tokens/{a}/transfers?holder= → 그 주소의 전송 + 잔액, 형식 검사', async () => {
  let asked;
  store.getToken = async () => TOKEN_ROW;
  store.listTokenTransfers = async (opts) => { asked = opts; return { items: [], nextCursor: null }; };
  store.tokenBalanceOf = async () => '42';
  const body = await (await get(`/api/v1/tokens/${TOKEN_ROW.address}/transfers?holder=${ADDR}&cursor=150-3`)).json();
  assert.deepEqual(asked, { token: TOKEN_ROW.address, holder: ADDR, limit: 25, before: ['150', 3] });
  assert.equal(body.holderBalance, '42');
  assert.equal((await get(`/api/v1/tokens/${TOKEN_ROW.address}/transfers?holder=0x12`)).status, 400);
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
    address: ADDR, balanceWei: '1000000000000000000', nonce: '3', type: 'eoa', delegatedTo: null,
  });

  node.eth_getCode = () => '0x6080604052';
  assert.equal((await (await get(`/api/v1/addresses/${ADDR}`)).json()).type, 'contract');

  // EIP-7702 로 코드를 맡긴 지갑: 코드 자리에 0xef0100 + 위임 대상. 컨트랙트가 아니다
  node.eth_getCode = () => '0xef0100' + TO.slice(2);
  const body = await (await get(`/api/v1/addresses/${ADDR}`)).json();
  assert.equal(body.type, 'eoa');
  assert.equal(body.delegatedTo, TO);
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

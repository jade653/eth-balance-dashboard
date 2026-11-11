/**
 * 진짜 Postgres 로 인덱서·쿼리를 확인한다. SQL 은 가짜로는 검증이 안 되기 때문이다.
 *
 * TEST_DATABASE_URL 이 있을 때만 돈다 (CI 는 Postgres 컨테이너를 붙여서 준다).
 * 테이블을 지우고 시작하므로 일부러 DATABASE_URL 과 다른 이름을 쓴다 — 실수로 운영 DB 를 날리지 않게.
 *
 *   docker run -d --rm -p 5432:5432 -e POSTGRES_PASSWORD=test postgres:17-alpine
 *   TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:5432/postgres npm test
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPool, createStore, migrate } from '../src/db.js';
import { syncOnce, checkChain } from '../src/indexer.js';
import { syncTokenOnce, TRANSFER_TOPIC } from '../src/tokens.js';

const URL = process.env.TEST_DATABASE_URL;
const skip = !URL && 'TEST_DATABASE_URL 없음';

let pool;
let store;

before(async () => {
  if (skip) return;
  pool = createPool(URL);
  await pool.query('DROP TABLE IF EXISTS token_balances, token_transfers, tokens, txs, blocks, meta, schema_migrations');
  await migrate(pool, () => {});
  store = createStore(pool);
});
after(() => pool?.end());

const A = '0x' + 'aa'.repeat(20);
const B = '0x' + 'bb'.repeat(20);
const hex = (n) => '0x' + BigInt(n).toString(16);
const h32 = (tag, n) => '0x' + (tag + BigInt(n).toString(16)).padStart(64, '0');

/** 가짜 체인: 블록 n 의 tx 들은 txsOf(n) 이 정한다. fork 문자로 갈라진 체인을 만든다 */
function chain({ head, fork = 'a', forkFrom = Infinity, txsOf = () => [] }) {
  const hashOf = (n) => h32(n >= forkFrom ? fork : 'a', n);
  const blockOf = (n) =>
    n > head ? null : {
      number: hex(n),
      hash: hashOf(n),
      parentHash: hashOf(n - 1),
      timestamp: hex(1_700_000_000 + n * 12),
      miner: '0x' + 'Cc'.repeat(20),
      gasUsed: hex(21000 * 3),
      gasLimit: hex(30_000_000),
      baseFeePerGas: hex(7_000_000_000),
      transactions: txsOf(n).map((t, i) => ({ hash: h32(`${fork}f`, n * 1000 + i), transactionIndex: hex(i), ...t })),
    };
  return {
    async call(method) {
      if (method === 'eth_blockNumber') return hex(head);
      throw new Error(method);
    },
    async batch(calls) {
      return calls.map((c) => blockOf(Number(BigInt(c.params[0]))));
    },
  };
}

const syncAll = async (rpc, opts) => {
  for (;;) {
    const r = await syncOnce(rpc, store, { retentionBlocks: 10, batchSize: 3, ...opts });
    if (r.indexed === 0 && !r.reorg) return;
  }
};

test('migrate 는 여러 번 돌려도 같다', { skip }, async () => {
  await migrate(pool, () => {});
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM schema_migrations');
  assert.equal(rows[0].n, 4); // 001_init, 002_explorer_columns, 003_meta, 004_tokens
});

test('처음 켜면 보관 범위의 시작부터, 이후엔 이어서 쌓는다', { skip }, async () => {
  await syncAll(chain({ head: 100 }));
  assert.deepEqual(await store.coverage().then((c) => [c.fromBlock, c.toBlock]), ['91', '100']);

  await syncAll(chain({ head: 104 }));
  assert.equal((await store.latestBlock()).number, '104');
});

test('리오그: 끝의 블록들이 바뀌면 되감고 새 체인으로 다시 쌓는다', { skip }, async () => {
  // 103, 104 가 다른 블록으로 바뀐 체인. 105 까지 진행됨.
  await syncAll(chain({ head: 105, fork: 'b', forkFrom: 103 }));
  const { rows } = await pool.query('SELECT number, hash FROM blocks WHERE number >= 102 ORDER BY number');
  assert.deepEqual(rows.map((r) => r.number), ['102', '103', '104', '105']);
  assert.equal(rows[0].hash, h32('a', 102)); // 갈라지기 전은 그대로
  assert.ok(rows.slice(1).every((r) => r.hash.startsWith('0x000') && r.hash.includes('b')), '새 체인의 블록');
});

test('주소별 목록: 보낸·받은·자기 자신, 최신순, 커서로 페이지, wei 정확', { skip }, async () => {
  await pool.query('TRUNCATE blocks CASCADE');
  const BIG = '115792089237316195423570985008687907853269984665640564039457584007913129639935'; // 2^256-1
  await syncAll(chain({
    head: 300,
    txsOf: (n) => [
      { from: A.toUpperCase().replace('0X', '0x'), to: B, value: hex(n) }, // A → B (대문자 주소도 소문자로 저장)
      { from: B, to: A, value: n === 300 ? hex(BIG) : '0x1' },              // B → A
      { from: A, to: A, value: '0x0' },                                    // A → A
      { from: B, to: null, value: '0x0' },                                 // 컨트랙트 생성 (A 와 무관)
    ],
  }), { retentionBlocks: 5 });

  const p1 = await store.listAddressTxs(A, { limit: 4 });
  assert.deepEqual(p1.items.map((t) => [t.blockNumber, t.txIndex, t.direction]), [
    ['300', 2, 'self'], ['300', 1, 'in'], ['300', 0, 'out'], ['299', 2, 'self'],
  ]);
  assert.equal(p1.items[1].valueWei, BIG);
  assert.equal(p1.nextCursor, '299-2');

  const p2 = await store.listAddressTxs(A, { limit: 100, before: ['299', 2] });
  assert.equal(p2.items.length, 5 * 3 - 4); // 5블록 × A 관련 3건 - 앞 페이지 4건
  assert.equal(p2.nextCursor, null);
  assert.deepEqual(p2.items[0].blockNumber, '299');
  assert.equal(p2.items[0].txIndex, 1);
});

test('홈 화면용: 최신 블록·최신 tx·블록 안 tx·통계, 새 칸(miner·gas·method) 채움', { skip }, async () => {
  await pool.query('TRUNCATE blocks CASCADE');
  await syncAll(chain({
    head: 50,
    txsOf: (n) => [
      { from: A, to: B, value: '0x1', input: '0x' },                          // 송금
      { from: A, to: B, value: '0x0', input: '0xA9059CBB' + '00'.repeat(64) }, // transfer(…) 호출
    ],
  }), { retentionBlocks: 5 });

  const blocks = await store.latestBlocks(2);
  assert.deepEqual(blocks.map((b) => b.number), ['50', '49']);
  assert.equal(blocks[0].miner, '0x' + 'cc'.repeat(20)); // 소문자로 저장
  assert.equal(blocks[0].gasUsed, '63000');
  assert.equal(blocks[0].baseFeePerGasWei, '7000000000');
  assert.equal(blocks[0].txCount, 2);

  const txs = await store.latestTxs(3);
  assert.deepEqual(txs.map((t) => [t.blockNumber, t.txIndex, t.method]), [['50', 1, '0xa9059cbb'], ['50', 0, '0x'], ['49', 1, '0xa9059cbb']]);

  const p1 = await store.listBlockTxs('50', { limit: 1 });
  assert.deepEqual([p1.items[0].txIndex, p1.nextCursor], [1, '1']);
  const p2 = await store.listBlockTxs('50', { limit: 1, before: 1 });
  assert.deepEqual([p2.items[0].txIndex, p2.nextCursor], [0, null]);
  assert.deepEqual((await store.listBlockTxs('999', { limit: 5 })).items, []);

  // 테스트 블록 시각은 2023년이라 "최근 24시간" 통계는 0, 평균 블록 시간은 12초
  assert.deepEqual(await store.stats(), { txs24h: '0', blocks24h: '0', avgBlockTimeSec: 12 });
});

test('블록 번호로 tx 를 찾을 때 색인(txs_block)을 쓴다 — 롤링 삭제가 전체를 훑지 않는다', { skip }, async () => {
  // 통계가 갱신돼야 계획(plan)이 현실을 반영한다
  await pool.query('ANALYZE txs');
  await pool.query('SET enable_seqscan = off'); // 행이 적으면 원래 전체 훑기가 더 싸므로, "쓸 수 있는가"만 본다
  try {
    const { rows } = await pool.query("EXPLAIN SELECT 1 FROM txs WHERE block_number = 50");
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
    assert.match(plan, /txs_block/, plan);
  } finally {
    await pool.query('RESET enable_seqscan');
  }
});

test('체인 확인: 빈 DB → 기록 / 같은 체인 → ok / 다른 체인 → mismatch', { skip }, async () => {
  await store.resetAll();
  const rpcA = Object.assign(chain({ head: 30 }), {
    async call(method, params) {
      if (method === 'eth_chainId') return '0x1';
      if (method === 'eth_blockNumber') return hex(30);
      if (method === 'eth_getBlockByNumber') return (await this.batch([{ params }]))[0];
      throw new Error(method);
    },
  });
  assert.deepEqual(await checkChain(rpcA, store), { status: 'empty', chainId: '1' });
  assert.equal(await store.getMeta('chain_id'), '1');

  await syncAll(rpcA, { retentionBlocks: 5 });
  assert.equal((await checkChain(rpcA, store)).status, 'ok');

  // RPC 를 다른 체인(7601)으로 바꿈
  const rpcB = { ...rpcA, call: async (m, p) => (m === 'eth_chainId' ? '0x1db1' : rpcA.call(m, p)) };
  assert.deepEqual(await checkChain(rpcB, store), { status: 'mismatch', chainId: '7601', saved: '1' });
});

test('체인 확인: 기록이 없던 옛 데이터는 블록 해시로 판단한다', { skip }, async () => {
  // 003 이전에 쌓인 상황: 데이터는 있는데 chain_id 기록이 없다
  await pool.query('DELETE FROM meta');
  const same = Object.assign(chain({ head: 30 }), {
    async call(method, params) {
      if (method === 'eth_chainId') return '0x1';
      if (method === 'eth_getBlockByNumber') return (await this.batch([{ params }]))[0];
      throw new Error(method);
    },
  });
  assert.equal((await checkChain(same, store)).status, 'ok');
  assert.equal(await store.getMeta('chain_id'), '1'); // 이제 기록됨

  await pool.query('DELETE FROM meta');
  // 같은 번호의 블록이 있지만 해시가 다른 체인 (fork 문자 'z')
  const other = Object.assign(chain({ head: 30, fork: 'z', forkFrom: 0 }), {
    async call(method, params) {
      if (method === 'eth_chainId') return '0x1db1';
      if (method === 'eth_getBlockByNumber') return (await this.batch([{ params }]))[0];
      throw new Error(method);
    },
  });
  assert.equal((await checkChain(other, store)).status, 'mismatch');

  // 새 체인에 그 번호가 아직 없음 (지금 상황: 메인넷 2,634만 vs 7601 의 1,390만)
  const shorter = Object.assign(chain({ head: 3 }), {
    async call(method, params) {
      if (method === 'eth_chainId') return '0x1db1';
      if (method === 'eth_getBlockByNumber') return (await this.batch([{ params }]))[0];
      throw new Error(method);
    },
  });
  assert.equal((await checkChain(shorter, store)).status, 'mismatch');

  await store.resetAll();
  assert.equal(await store.latestBlock(), null);
});

test('prune: 보관 시간이 지난 블록과 그 tx 를 지운다', { skip }, async () => {
  // 앞 테스트에 기대지 않고 직접 쌓는다 (블록 시각이 2023년이라 전부 "오래된" 블록)
  await syncAll(chain({ head: 20, txsOf: () => [{ from: A, to: B, value: '0x1' }] }), { retentionBlocks: 5 });
  // 위 테스트의 블록 시각은 2023년이라 전부 24시간보다 오래됐다
  assert.equal(await store.prune(24 * 365 * 100), 0); // 100년 보관 → 지울 것 없음
  const removed = await store.prune(0.5);  // 소수 시간도 받는다 (실제로 0.1 에서 깨졌었다)
  assert.ok(removed > 0);
  const { rows } = await pool.query('SELECT (SELECT count(*) FROM blocks)::int AS b, (SELECT count(*) FROM txs)::int AS t');
  assert.deepEqual(rows[0], { b: 0, t: 0 });
});

/* ── 토큰 홀더 인덱서 ───────────────────────────────────────────────────── */

const TOKEN = '0x' + '70'.repeat(20);
const ZERO = '0x' + '00'.repeat(20);
const C = '0x' + 'cc'.repeat(20);
const D = '0x' + 'dd'.repeat(20);

/**
 * 가짜 노드: transfers = [[블록, from, to, 금액], …]. eth_getLogs 는 구간 안의 Transfer 로그만 준다.
 * maxRange 를 넘는 구간은 공개 RPC 처럼 거절한다.
 */
function tokenNode(transfers, { head, maxRange = Infinity } = {}) {
  const pad = (a) => '0x' + '0'.repeat(24) + a.slice(2);
  const logs = transfers.map(([b, from, to, amount], i) => ({
    address: TOKEN,
    topics: [TRANSFER_TOPIC, pad(from), pad(to)],
    data: '0x' + BigInt(amount).toString(16).padStart(64, '0'),
    blockNumber: hex(b),
    logIndex: hex(i),
    transactionHash: h32('e', i),
    transactionIndex: '0x0',
  }));
  const calls = { getLogs: 0 };
  return {
    calls,
    async call(method, params) {
      if (method !== 'eth_getLogs') throw new Error(method);
      calls.getLogs++;
      const from = Number(BigInt(params[0].fromBlock));
      const to = Number(BigInt(params[0].toBlock));
      if (to - from + 1 > maxRange) throw new Error('eth_getLogs: block range too large');
      return logs.filter((l) => Number(BigInt(l.blockNumber)) >= from && Number(BigInt(l.blockNumber)) <= to);
    },
    async batch(cs) {
      return cs.map((c) => (c.method === 'eth_getBlockByNumber'
        ? { timestamp: hex(1_700_000_000 + Number(BigInt(c.params[0])) * 12) }
        : { input: '0xa9059cbb' + '00'.repeat(64) }));
    },
  };
}

async function syncToken(rpc, tok, head) {
  for (let i = 0; i < 100; i++) {
    const r = await syncTokenOnce(rpc, store, tok, { head, confirmations: 2 });
    if (!r.progressed && !r.retry) return;
  }
  throw new Error('끝나지 않음');
}

test('토큰: 발행·전송·소각을 더해 홀더 잔액과 홀더 수를 맞춘다 (0 주소는 홀더가 아니다)', { skip }, async () => {
  await store.upsertToken({ address: TOKEN, name: 'Stable', symbol: 'STB', decimals: 6, startBlock: 10 });
  const rpc = tokenNode([
    [10, ZERO, A, 1000],  // 발행
    [12, A, B, 300],
    [15, B, C, 300],      // B 는 0 이 되어 홀더에서 빠진다
    [20, C, ZERO, 100],   // 소각
    [40, A, D, 1],        // head(41) − confirmations(2) = 39 보다 뒤 → 아직 안 모은다
  ]);
  const tok = { address: TOKEN, startBlock: '10', syncedBlock: null };
  await syncToken(rpc, tok, 41n);

  const t = await store.getToken(TOKEN);
  assert.equal(t.syncedBlock, '39');
  assert.equal(t.holders, 2);
  assert.equal(t.transfers, '4');
  assert.deepEqual(await store.tokenHolders(TOKEN, { limit: 10, offset: 0 }), [
    { rank: 1, address: A, balance: '700' },
    { rank: 2, address: C, balance: '200' },
  ]);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM token_balances WHERE holder IN ($1, $2)', [ZERO, B]);
  assert.equal(rows[0].n, 0);

  // 이어서: 새 블록이 생기면 남은 것만 더한다 (두 번 더하지 않는다)
  await syncToken(rpc, tok, 50n);
  const t2 = await store.getToken(TOKEN);
  assert.equal(t2.holders, 3);
  assert.equal(t2.transfers, '5');
  assert.equal(await store.tokenBalanceOf(TOKEN, A), '699');
});

test('토큰: 노드가 넓은 구간을 거절하면 줄여서 다시, 시각·Method 도 채운다', { skip }, async () => {
  const T2 = '0x' + '71'.repeat(20);
  await store.upsertToken({ address: T2, name: null, symbol: 'T2', decimals: 0, startBlock: 0 });
  const rpc = tokenNode([[5, ZERO, A, 10], [900, A, B, 4]], { maxRange: 100 });
  // tokenNode 는 TOKEN 주소로 로그를 만들지만 거르는 건 getLogs 의 일이라 여기선 상관없다
  const tok = { address: T2, startBlock: '0', syncedBlock: null };
  await syncToken(rpc, tok, 1002n);
  assert.equal((await store.getToken(T2)).syncedBlock, '1000');
  assert.ok(tok.range <= 100);
  const { items } = await store.listTokenTransfers({ token: T2, limit: 10 });
  assert.equal(items.length, 2);
  assert.equal(items[0].method, '0xa9059cbb');
  assert.equal(items[0].timestamp, new Date((1_700_000_000 + 900 * 12) * 1000).toISOString());
});

test('토큰: 홀더 순위 페이지, 분포 요약, 주소별 전송(방향)·보유', { skip }, async () => {
  const T3 = '0x' + '72'.repeat(20);
  await store.upsertToken({ address: T3, name: 'Three', symbol: 'TRI', decimals: 2, startBlock: 1 });
  // A 600, B 300, C 100 (같은 잔액이면 주소 순) — 총 1000
  const rpc = tokenNode([[1, ZERO, A, 1000], [2, A, B, 300], [3, A, C, 100], [4, C, C, 5]]);
  await syncToken(rpc, { address: T3, startBlock: '1', syncedBlock: null }, 10n);

  assert.deepEqual((await store.tokenHolders(T3, { limit: 2, offset: 1 })).map((x) => [x.rank, x.address]), [[2, B], [3, C]]);

  const s = await store.tokenHolderSummary(T3);
  assert.equal(s.holders, 3);
  assert.equal(s.totalHeld, '1000');
  assert.equal(s.top5, '1000');
  // 순위 × 잔액 = 1×600 + 2×300 + 3×100 = 1500 → 지니 = (n+1)/n − 2·1500/(n·1000) = 4/3 − 1 = 1/3
  assert.equal(s.weighted, '1500');
  assert.equal(s.over1pct, 3);
  assert.deepEqual(s.magnitudes, [{ magnitude: 2, count: 3 }]); // 100~999

  const c = await store.listTokenTransfers({ token: T3, holder: C, limit: 10 });
  assert.deepEqual(c.items.map((x) => x.direction), ['self', 'in']);
  const page1 = await store.listTokenTransfers({ token: T3, limit: 2 });
  assert.equal(page1.items.length, 2);
  assert.ok(page1.nextCursor);
  const [b, l] = page1.nextCursor.split('-');
  const page2 = await store.listTokenTransfers({ token: T3, limit: 2, before: [b, Number(l)] });
  assert.equal(page2.items.length, 2);
  assert.equal(page2.nextCursor, null);

  const held = await store.addressTokenBalances(B);
  assert.ok(held.some((x) => x.token === T3 && x.balance === '300' && x.symbol === 'TRI'));
  // 주소 페이지: 토큰을 지정하지 않으면 추적 중인 모든 토큰에서
  const all = await store.listTokenTransfers({ holder: A, limit: 50 });
  assert.ok(new Set(all.items.map((x) => x.token)).size >= 2);
});

test('체인을 바꾸면 토큰 데이터도 같이 지운다', { skip }, async () => {
  await store.resetAll();
  assert.deepEqual(await store.listTokens(), []);
});

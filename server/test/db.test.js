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
import { syncOnce } from '../src/indexer.js';

const URL = process.env.TEST_DATABASE_URL;
const skip = !URL && 'TEST_DATABASE_URL 없음';

let pool;
let store;

before(async () => {
  if (skip) return;
  pool = createPool(URL);
  await pool.query('DROP TABLE IF EXISTS txs, blocks, schema_migrations');
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
  assert.equal(rows[0].n, 2); // 001_init, 002_explorer_columns
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

test('prune: 보관 시간이 지난 블록과 그 tx 를 지운다', { skip }, async () => {
  // 위 테스트의 블록 시각은 2023년이라 전부 24시간보다 오래됐다
  assert.equal(await store.prune(24 * 365 * 100), 0); // 100년 보관 → 지울 것 없음
  const removed = await store.prune(0.5);  // 소수 시간도 받는다 (실제로 0.1 에서 깨졌었다)
  assert.ok(removed > 0);
  const { rows } = await pool.query('SELECT (SELECT count(*) FROM blocks)::int AS b, (SELECT count(*) FROM txs)::int AS t');
  assert.deepEqual(rows[0], { b: 0, t: 0 });
});

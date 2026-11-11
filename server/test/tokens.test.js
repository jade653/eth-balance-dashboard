import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TRANSFER_TOPIC, DISCOVERY_KEY, parseDiscovery, discoveryOn, discoverTokensOnce,
} from '../src/tokens.js';

const hex = (n) => '0x' + BigInt(n).toString(16);
const pad = (a) => '0x' + '0'.repeat(24) + a.slice(2);
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const ZERO = '0x' + '00'.repeat(20);
const A = '0x' + 'aa'.repeat(20);
const B = '0x' + 'bb'.repeat(20);
const T1 = '0x' + '11'.repeat(20); // ERC-20
const T2 = '0x' + '22'.repeat(20); // ERC-20, 나중에 생김
const NFT = '0x' + '33'.repeat(20); // ERC-721: Transfer 에 topic 이 4개
const FAKE = '0x' + '44'.repeat(20); // Transfer 모양 이벤트만 내고 토큰 함수가 없다

// ABI string 반환값
const abiString = (s) => {
  const h = Buffer.from(s).toString('hex');
  return '0x' + word(32).slice(2) + word(s.length).slice(2) + h.padEnd(64, '0');
};

/**
 * 가짜 노드. logs = [[블록, 컨트랙트, topic 개수]]. 주소 조건 없는 getLogs 만 답한다.
 * maxRange 를 넘는 구간은 공개 RPC 처럼 거절한다.
 */
function chain(entries, { maxRange = Infinity } = {}) {
  const logs = entries.map(([b, address, topics = 3], i) => ({
    address,
    topics: topics === 3 ? [TRANSFER_TOPIC, pad(ZERO), pad(A)] : [TRANSFER_TOPIC, pad(ZERO), pad(A), word(1)],
    data: topics === 3 ? word(100) : '0x',
    blockNumber: hex(b),
    logIndex: hex(i),
  }));
  const meta = {
    [T1]: { '0x06fdde03': abiString('One'), '0x95d89b41': abiString('ONE'), '0x313ce567': word(6), '0x18160ddd': word(1000) },
    [T2]: { '0x95d89b41': abiString('TWO'), '0x313ce567': word(0), '0x18160ddd': word(5) },
  };
  const calls = { getLogs: [] };
  return {
    calls,
    async call(method, params) {
      if (method === 'eth_getLogs') {
        const { fromBlock, toBlock, address, topics } = params[0];
        assert.equal(address, undefined, '자동 인식은 주소 조건 없이 묻는다');
        assert.deepEqual(topics, [TRANSFER_TOPIC]);
        const from = Number(BigInt(fromBlock));
        const to = Number(BigInt(toBlock));
        calls.getLogs.push([from, to]);
        if (to - from + 1 > maxRange) throw new Error('block range too large');
        return logs.filter((l) => Number(BigInt(l.blockNumber)) >= from && Number(BigInt(l.blockNumber)) <= to);
      }
      if (method === 'eth_call') {
        const r = meta[params[0].to]?.[params[0].data];
        if (!r) throw new Error('execution reverted');
        return r;
      }
      throw new Error(method);
    },
  };
}

function memStore() {
  const tokens = new Map();
  const meta = new Map();
  return {
    tokens,
    meta,
    async getToken(a) { return tokens.get(a) ?? null; },
    async upsertToken(t) { tokens.set(t.address, { ...t }); },
    async getMeta(k) { return meta.get(k) ?? null; },
    async setMeta(k, v) { meta.set(k, String(v)); },
  };
}

async function discoverAll(rpc, store, state, opts) {
  const found = [];
  for (let i = 0; i < 200; i++) {
    const d = await discoverTokensOnce(rpc, store, state, { confirmations: 2, ...opts });
    found.push(...d.found);
    if (d.full) return { found, full: true };
    if (!d.progressed && !d.retry) return { found };
  }
  throw new Error('끝나지 않음');
}

test('TOKEN_DISCOVERY: auto 는 공개 체인에서만 끈다', () => {
  assert.equal(parseDiscovery(undefined), 'auto');
  assert.equal(parseDiscovery(''), 'auto');
  assert.equal(parseDiscovery(' ON '), 'on');
  assert.throws(() => parseDiscovery('yes'), /auto \/ on \/ off/);
  assert.equal(discoveryOn('auto', 7601), true); // 자체 체인
  assert.equal(discoveryOn('auto', 1), false); // 이더리움 메인넷
  assert.equal(discoveryOn('auto', 11155111), false); // Sepolia
  assert.equal(discoveryOn('on', 1), true);
  assert.equal(discoveryOn('off', 7601), false);
});

test('자동 인식: ERC-20 만 첫 Transfer 블록부터 등록하고, 훑은 곳을 meta 에 남긴다', async () => {
  const rpc = chain([
    [5, NFT, 4], // ERC-721 은 건너뛴다
    [7, FAKE],
    [12, T1],
    [13, T1],
    [4_000, T2],
    [4_001, T1],
  ]);
  const store = memStore();
  const state = { cursor: null, from: 0, range: null };
  const { found } = await discoverAll(rpc, store, state, { head: 5_000n });

  assert.deepEqual(found.map((f) => [f.address, f.symbol, f.startBlock]), [[T1, 'ONE', '12'], [T2, 'TWO', '4000']]);
  assert.deepEqual([...store.tokens.keys()].sort(), [T1, T2]);
  assert.deepEqual(store.tokens.get(T1), { address: T1, name: 'One', symbol: 'ONE', decimals: 6, startBlock: '12' });
  assert.equal(store.tokens.get(T2).name, null);
  assert.equal(store.meta.get(DISCOVERY_KEY), '4998'); // head 5000 - confirmations 2
  assert.ok(state.rejected.has(FAKE));

  // 새 블록이 나오면 이어서: 이미 아는 토큰은 다시 등록하지 않는다
  const again = await discoverAll(rpc, store, state, { head: 5_010n });
  assert.deepEqual(again.found, []);
  assert.deepEqual(rpc.calls.getLogs.at(-1), [4_999, 5_008]);
});

test('자동 인식: 다시 띄우면 meta 의 커서부터 이어서 훑는다', async () => {
  const rpc = chain([[12, T1], [300, T2]]);
  const store = memStore();
  await store.setMeta(DISCOVERY_KEY, '100');
  const state = { cursor: await store.getMeta(DISCOVERY_KEY), from: 0, range: null };
  const { found } = await discoverAll(rpc, store, state, { head: 400n });
  assert.deepEqual(found.map((f) => f.address), [T2]); // 100 블록 전의 T1 은 이미 훑은 구간
  assert.equal(rpc.calls.getLogs[0][0], 101);
});

test('자동 인식: 노드가 넓은 구간을 거절하면 줄여서 다시 묻는다', async () => {
  const rpc = chain([[12, T1], [9_000, T2]], { maxRange: 500 });
  const store = memStore();
  const state = { cursor: null, from: 0, range: null };
  const { found } = await discoverAll(rpc, store, state, { head: 10_000n });
  assert.deepEqual(found.map((f) => f.address), [T1, T2]);
  assert.ok(state.range <= 500);
  assert.equal(store.meta.get(DISCOVERY_KEY), '9998');
});

test('자동 인식: 상한에 닿으면 멈추고 커서를 그 구간 앞에 둔다 (상한을 올리면 이어서)', async () => {
  const rpc = chain([[12, T1], [13, T2]]);
  const store = memStore();
  const state = { cursor: null, from: 0, range: null };
  const r = await discoverAll(rpc, store, state, { head: 100n, limit: 1 });
  assert.equal(r.full, true);
  assert.deepEqual([...store.tokens.keys()], [T1]);
  assert.equal(store.meta.get(DISCOVERY_KEY), undefined);

  const more = await discoverAll(rpc, store, { cursor: null, from: 0, range: null }, { head: 100n, limit: 5 });
  assert.deepEqual(more.found.map((f) => f.address), [T2]);
  assert.equal(store.meta.get(DISCOVERY_KEY), '98');
});

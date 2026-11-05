import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureBlockTime } from '../src/indexer.js';

/** head 와 블록 간격(초)으로 만든 가짜 노드 */
const chainOf = (head, interval) => ({
  async call(method) {
    if (method === 'eth_blockNumber') return '0x' + head.toString(16);
    throw new Error(method);
  },
  async batch(calls) {
    return calls.map((c) => {
      const n = Number(BigInt(c.params[0]));
      return n > head ? null : { number: c.params[0], timestamp: '0x' + (1_700_000_000 + n * interval).toString(16) };
    });
  },
});

test('블록 간격을 잰다: 이더리움 12초, PoA 체인 2초', async () => {
  assert.equal(await measureBlockTime(chainOf(26_000_000, 12)), 12);
  assert.equal(await measureBlockTime(chainOf(13_907_307, 2)), 2);
});

test('블록이 sample 보다 적은 새 체인도 잴 수 있다', async () => {
  assert.equal(await measureBlockTime(chainOf(10, 5)), 5);
  assert.equal(await measureBlockTime(chainOf(0, 5)), null); // 블록이 하나뿐이면 못 잼
});

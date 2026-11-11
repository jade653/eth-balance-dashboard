import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeInput, decodeLog, netTransfers, sharePercent, formatUtc, giniFromSummary, walletDepth, titleCase, methodLabel, hexToUtf8,
} from '../public/js/format.js';

const pad = (a) => '0'.repeat(24) + a.slice(2);
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const A = '0x2132f0d0f4648e8128b67f07fc4f62776a78c0a9';
const B = '0x4b742ad5ca91969e82aefb80072ae59121a3d72a';
const C = '0x47ac0fb4f2d84898e4d9e7b4dab3c24507a6d503';
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';

test('decodeInput: 아는 함수는 서명과 인자, 32바이트 칸 목록', () => {
  const d = decodeInput('0xa9059cbb' + pad(B) + word(75554));
  assert.equal(d.signature, 'transfer(address _to, uint256 _value)');
  assert.deepEqual(d.params, [
    { name: '_to', type: 'address', value: B },
    { name: '_value', type: 'uint256', value: '75554' },
  ]);
  assert.equal(d.words.length, 2);
});

test('decodeInput: 동적 인자(address[]), 모르는 선택자, 모자란 데이터', () => {
  // freezeBatch(address[] accounts, bytes32 reason): [offset=0x40][reason][len=2][A][B]
  const reason = 'ab'.repeat(32);
  const d = decodeInput('0x12345678' + word(1));
  assert.equal(d.name, null); // 사전에 없는 선택자
  assert.equal(d.selector, '0x12345678');
  const batch = decodeInput(findSelector('freezeBatch') + word(64) + reason + word(2) + pad(A) + pad(B));
  assert.deepEqual(batch.params[0].value, [A, B]);
  assert.equal(batch.params[1].value, '0x' + reason);
  // 데이터가 짧으면 서명만 있고 인자는 null
  assert.equal(decodeInput('0xa9059cbb' + pad(B)).params, null);
  assert.equal(decodeInput('0x'), null);
});

import { FUNCTIONS } from '../public/js/signatures.js';
function findSelector(name) {
  return Object.entries(FUNCTIONS).find(([, f]) => f[0] === name)[0];
}

test('decodeLog: Transfer 는 indexed 주소 두 개 + 금액, ERC-721 모양은 이름을 붙이지 않는다', () => {
  const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const d = decodeLog({ topics: [TRANSFER, '0x' + pad(A), '0x' + pad(C)], data: '0x' + word(2000000) });
  assert.equal(d.signature, 'Transfer (index_topic_1 address from, index_topic_2 address to, uint256 value)');
  assert.deepEqual(d.topics.slice(1).map((t) => [t.name, t.value]), [['from', A], ['to', C]]);
  assert.deepEqual(d.data, [{ name: 'value', type: 'uint256', value: '2000000' }]);

  const nft = decodeLog({ topics: [TRANSFER, '0x' + pad(A), '0x' + pad(C), '0x' + word(7)], data: '0x' });
  assert.equal(nft.name, null);
  assert.equal(nft.topics.length, 4);

  const unknown = decodeLog({ topics: ['0x' + '12'.repeat(32)], data: '0x' + word(1) + word(2) });
  assert.equal(unknown.name, null);
  assert.equal(unknown.words.length, 2);
});

test('netTransfers: Etherscan 의 Net Transfers (주소·토큰별 순증감)', () => {
  const t = (from, to, amount) => ({ token: USDT, symbol: 'USDT', decimals: 6, from, to, amount });
  // Etherscan 예시 tx: A 가 C 에 2, B 에 0.075554 USDT
  assert.deepEqual(netTransfers([t(A, C, '2000000'), t(A, B, '75554')]).map((n) => [n.address, n.direction, n.amount]), [
    [A, 'sent', '2075554'],
    [C, 'received', '2000000'],
    [B, 'received', '75554'],
  ]);
  // 거쳐 가기만 한 주소는 0 이라 빠진다
  assert.deepEqual(netTransfers([t(A, B, '5'), t(B, C, '5')]).map((n) => n.address), [A, C]);
});

test('sharePercent: 큰 정수도 정확하게, 소수 4자리', () => {
  assert.equal(sharePercent('14000000000000700000', '84296691994493958000'), '16.6080%');
  assert.equal(sharePercent('1', '3'), '33.3333%');
  assert.equal(sharePercent('5', '0'), '-');
});

test('formatUtc: Etherscan 식 UTC 표기', () => {
  assert.equal(formatUtc('2026-07-28T11:01:47Z'), 'Jul-28-2026 11:01:47 AM +UTC');
  assert.equal(formatUtc('2026-01-02T00:05:09Z'), 'Jan-02-2026 12:05:09 AM +UTC');
  assert.equal(formatUtc('2026-12-31T23:00:00Z'), 'Dec-31-2026 11:00:00 PM +UTC');
});

test('giniFromSummary: 모두 같으면 0, 한 명이 거의 다 가지면 1 에 가깝다', () => {
  // 600/300/100 → 1/3 (서버 DB 테스트와 같은 예)
  assert.ok(Math.abs(giniFromSummary({ holders: 3, totalHeld: '1000', weighted: '1500' }) - 1 / 3) < 1e-6);
  // 4명이 똑같이 25: Σ순위×잔액 = 25×(1+2+3+4) = 250
  assert.equal(giniFromSummary({ holders: 4, totalHeld: '100', weighted: '250' }), 0);
  assert.equal(giniFromSummary({ holders: 0, totalHeld: '0', weighted: '0' }), null);
});

test('walletDepth: 원시 자릿수 → 토큰 단위 "N 개 이상" 누적 지갑 수', () => {
  // decimals 6: 원시 10^6 = 1 토큰. 1~9 토큰 2명, 100~999 토큰 1명, 0.5 토큰 1명
  const mags = [{ magnitude: 5, count: 1 }, { magnitude: 6, count: 2 }, { magnitude: 8, count: 1 }];
  assert.deepEqual(walletDepth(mags, 6), [
    { threshold: '1', count: 3 },
    { threshold: '10', count: 1 },
    { threshold: '100', count: 1 },
  ]);
  assert.deepEqual(walletDepth([], 6), []);
});

test('methodLabel/titleCase: 사전의 함수 이름을 Etherscan 식 제목으로', () => {
  assert.equal(titleCase('swapExactETHForTokens'), 'Swap Exact ETH For Tokens');
  assert.equal(methodLabel('0x23b872dd'), 'Transfer From');
  assert.equal(methodLabel(findSelector('wipeFrozen')), 'Wipe Frozen');
});

test('hexToUtf8: 글자면 문자열, 바이너리면 null', () => {
  assert.equal(hexToUtf8('0x' + Buffer.from('hello 안녕').toString('hex')), 'hello 안녕');
  assert.equal(hexToUtf8('0x00ff10'), null);
});

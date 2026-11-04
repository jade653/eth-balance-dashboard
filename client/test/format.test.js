import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatInteger, weiToEth, shortHex, routeForQuery } from '../public/js/format.js';

test('routeForQuery: 입력 모양으로 화면을 고른다', () => {
  const tx = '0x' + 'ab'.repeat(32);
  const addr = '0x' + 'cd'.repeat(20);
  assert.equal(routeForQuery(` ${tx} `), `#/tx/${tx}`);
  assert.equal(routeForQuery(addr), `#/address/${addr}`);
  assert.equal(routeForQuery('23,272,543'), '#/block/23272543');
  assert.equal(routeForQuery('007'), '#/block/7');
  assert.equal(routeForQuery('latest'), '#/block/latest');
  for (const bad of ['', 'hello', '0x1234', '-1', null]) assert.equal(routeForQuery(bad), null, String(bad));
});

test('formatInteger: 세 자리마다 쉼표', () => {
  assert.equal(formatInteger('0'), '0');
  assert.equal(formatInteger('999'), '999');
  assert.equal(formatInteger('1000'), '1,000');
  assert.equal(formatInteger('23272543'), '23,272,543');
});

test('formatInteger: 정수 문자열이 아니면 던진다', () => {
  for (const bad of ['', '-1', '1.5', '0x10', 'abc']) {
    assert.throws(() => formatInteger(bad), TypeError, bad);
  }
});

test('weiToEth: 기본 변환과 꼬리 0 제거', () => {
  assert.equal(weiToEth('0'), '0');
  assert.equal(weiToEth('1000000000000000000'), '1');
  assert.equal(weiToEth('1500000000000000000'), '1.5');
  assert.equal(weiToEth('1'), '0');                 // 1 wei 는 소수 6자리 아래라 0
  assert.equal(weiToEth('1', 18), '0.000000000000000001');
});

test('weiToEth: Number 로는 뭉개지는 큰 값도 정확하다', () => {
  // WETH 컨트랙트 수준의 잔액. Number(…)/1e18 로 계산하면 끝자리가 틀어진다.
  assert.equal(weiToEth('2841337123456789012345678', 18), '2,841,337.123456789012345678');
});

test('weiToEth: 반올림하지 않고 자른다', () => {
  assert.equal(weiToEth('1999999999999999999'), '1.999999'); // 반올림이면 2 가 된다
});

test('shortHex: 앞뒤만 남긴다', () => {
  const tx = '0x' + 'ab'.repeat(32);
  assert.equal(shortHex(tx), '0xababab…ababab');
  assert.equal(shortHex('0x1234'), '0x1234');      // 짧으면 그대로
});

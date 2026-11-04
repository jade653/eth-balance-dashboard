import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAddress, isTxHash, isBlockId } from '../src/validate.js';

test('블록 id: latest 또는 앞자리 0 없는 10진수만', () => {
  for (const ok of ['latest', '0', '1', '23272543', '9'.repeat(15)]) assert.equal(isBlockId(ok), true, ok);
  for (const bad of ['', 'Latest', '0x10', '01', '-1', '1.0', '9'.repeat(16), null]) {
    assert.equal(isBlockId(bad), false, String(bad));
  }
});

const ADDR = '0x6d93f35603783fb9c1ac061b1349bed7a31386c4';
const TX = '0x' + 'ab'.repeat(32);

test('정상 주소를 받아들인다 (대소문자 혼용 포함)', () => {
  assert.equal(isAddress(ADDR), true);
  assert.equal(isAddress('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'), true);
});

test('주소 형식이 아니면 거절한다', () => {
  for (const bad of [
    "0x' OR '1'='1",
    ADDR.slice(0, -1),       // 39자리
    ADDR + 'a',              // 41자리
    ADDR.slice(2),           // 0x 없음
    TX,                      // tx 해시는 주소가 아니다
    '', null, undefined, 123, {},
  ]) {
    assert.equal(isAddress(bad), false, `통과하면 안 됨: ${String(bad)}`);
  }
});

test('정상 tx 해시를 받아들인다', () => {
  assert.equal(isTxHash(TX), true);
  assert.equal(isTxHash(TX.toUpperCase().replace('0X', '0x')), true);
});

test('tx 해시 형식이 아니면 거절한다', () => {
  for (const bad of [
    TX.slice(0, -1),         // 63자리
    TX + '0',                // 65자리
    ADDR,                    // 주소는 tx 해시가 아니다
    '0x' + 'zz'.repeat(32),  // 16진수 아님
    `${TX}\n`,               // 줄바꿈 꼬리 — 정규식에 $ 만 있고 m 플래그가 없으니 막힌다
    '', null, undefined,
  ]) {
    assert.equal(isTxHash(bad), false, `통과하면 안 됨: ${JSON.stringify(bad)}`);
  }
});

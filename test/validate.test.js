'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isAddress, rangeSeconds } = require('../validate.js');

const A = '0x6d93f35603783fb9c1ac061b1349bed7a31386c4';

/* ── 1층 방어: 이상한 값은 SQL 근처에도 못 간다 ────────────────────────── */

test('정상 주소를 받아들인다', () => {
  assert.equal(isAddress(A), true);
});

test('대문자가 섞인 주소도 받아들인다', () => {
  assert.equal(isAddress('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'), true);
});

test('주소 형식이 아니면 거절한다', () => {
  for (const bad of [
    "0x' OR '1'='1",
    "'; DROP TABLE balances;--",
    '0x6d93f35603783fb9c1ac061b1349bed7a31386c',    // 39자리
    '0x6d93f35603783fb9c1ac061b1349bed7a31386c4x',  // 41자리
    '6d93f35603783fb9c1ac061b1349bed7a31386c4',     // 0x 없음
    '0xZZZZf35603783fb9c1ac061b1349bed7a31386c4',   // 16진수 아님
    '',
    null,
    undefined,
    123,
  ]) {
    assert.equal(isAddress(bad), false, `거절해야 한다: ${String(bad)}`);
  }
});

test('허용된 range 만 초로 바꿔 준다', () => {
  assert.equal(rangeSeconds('1h'), 3600);
  assert.equal(rangeSeconds('24h'), 86400);
  assert.equal(rangeSeconds('7d'), 604800);
});

// 화이트리스트라 '검증'이 아니라 '치환'이다. 목록에 없으면 값 자체가 통과하지 못하므로
// 사용자 입력이 SQL 로 흘러갈 경로가 아예 없다.
test('허용 목록에 없는 range 는 null 이다', () => {
  // constructor / __proto__ 는 평범한 객체의 상속 체인에 실재하는 키다.
  // in 이나 [] 로만 확인하면 함수나 프로토타입이 값으로 튀어나온다.
  for (const bad of ['all', '30d', '24h OR 1=1', "1h'--", '', null, undefined, 3600,
                     'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(rangeSeconds(bad), null, `거절해야 한다: ${String(bad)}`);
  }
});

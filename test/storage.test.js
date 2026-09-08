'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../storage.js');

// config.json 에 실제로 들어 있는 주소를 쓴다. 길이/형식이 진짜와 같아야
// 나중에 검증 계층을 붙일 때 테스트가 같이 의미를 갖는다.
const A = '0x6d93f35603783fb9c1ac061b1349bed7a31386c4';
const B = '0x299e421dec65933ed64e38ce16f536fe2271a2ac';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ethdash-test-'));
  return path.join(dir, 'balances.db');
}

test('저장한 변화를 그대로 읽어낸다', () => {
  const store = new Store({ path: tmpDb() });

  store.append([{ address: A, block: 100, ts: 1000, wei: '5' }]);

  assert.deepEqual(store.history(A, 0), [{ block: 100, ts: 1000, wei: '5' }]);
  store.close();
});

test('다른 주소의 기록은 섞이지 않는다', () => {
  const store = new Store({ path: tmpDb() });

  store.append([
    { address: A, block: 100, ts: 1000, wei: '5' },
    { address: B, block: 100, ts: 1000, wei: '7' },
  ]);

  assert.deepEqual(store.history(A, 0), [{ block: 100, ts: 1000, wei: '5' }]);
  store.close();
});

test('sinceTs 이전 기록은 빼고 준다', () => {
  const store = new Store({ path: tmpDb() });

  store.append([
    { address: A, block: 100, ts: 1000, wei: '5' },
    { address: A, block: 200, ts: 2000, wei: '9' },
  ]);

  assert.deepEqual(store.history(A, 1500), [{ block: 200, ts: 2000, wei: '9' }]);
  store.close();
});

// 같은 블록을 두 번 처리하는 일이 실제로 있다. server.js 의 forceRefresh 가
// 리로드 직후 같은 블록을 다시 읽고, 재시작 직후에도 마지막 블록을 다시 본다.
test('같은 블록을 두 번 저장해도 중복되지 않고 던지지도 않는다', () => {
  const store = new Store({ path: tmpDb() });

  store.append([{ address: A, block: 100, ts: 1000, wei: '5' }]);
  store.append([{ address: A, block: 100, ts: 1000, wei: '5' }]);

  assert.equal(store.history(A, 0).length, 1);
  store.close();
});

// 이 값은 SQLite INTEGER 상한(약 9.2e18)을 한참 넘는다. config.json 의 WETH
// 컨트랙트가 실제로 이 규모를 들고 있으므로, 가상의 극단값이 아니라 운영 데이터다.
test('WETH 규모의 wei 도 자릿수 하나 잃지 않는다', () => {
  const store = new Store({ path: tmpDb() });
  const huge = '2841337000000000000000000';   // 약 284만 ETH

  store.append([{ address: A, block: 100, ts: 1000, wei: huge }]);

  assert.equal(store.history(A, 0)[0].wei, huge);
  store.close();
});

/* ── SQL injection ────────────────────────────────────────────────────────
   값은 전부 ? 로 바인딩된다. 아래 문자열들은 SQL 문법이 아니라 '찾을 주소'
   라는 데이터로만 취급되므로, 그런 주소가 없어서 빈 결과가 나와야 한다.     */

test('injection: OR 1=1 을 넣어도 남의 기록이 새지 않는다', () => {
  const store = new Store({ path: tmpDb() });
  store.append([
    { address: A, block: 100, ts: 1000, wei: '5' },
    { address: B, block: 100, ts: 1000, wei: '7' },
  ]);

  assert.deepEqual(store.history("' OR '1'='1", 0), []);
  store.close();
});

// 숫자가 들어가는 자리는 따옴표가 없어 방어를 빠뜨리기 가장 쉽다.
// 'DROP TABLE 을 넣어봤다' 류의 테스트는 node:sqlite 가 prepare 에서 문장 하나만
// 컴파일해 주는 덕에 취약한 구현에서도 통과해 버린다. 실패할 수 없는 테스트는
// 헛된 안심만 주므로, 실제로 취약 구현을 잡아내는 것만 남긴다.
test('injection: 숫자 자리로도 남의 기록이 새지 않는다', () => {
  const store = new Store({ path: tmpDb() });
  store.append([
    { address: A, block: 100, ts: 1000, wei: '5' },
    { address: A, block: 200, ts: 9000, wei: '9' },
  ]);

  assert.deepEqual(store.history(A, '0 OR 1=1'), []);
  store.close();
});

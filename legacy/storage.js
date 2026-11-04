'use strict';

const { DatabaseSync } = require('node:sqlite');

/**
 * 잔액 변화를 SQLite 에 쌓고 되읽는다.
 *
 * 잔액은 계단 함수다. 값이 매 블록 바뀌는 게 아니라 실제로 돈이 움직인 블록에서만
 * 바뀌고 그 사이는 완전히 평평하다. 그래서 '변한 순간만' 적어도 손실이 없다.
 *   블록 N 시점의 잔액 = N 이하에서 마지막으로 기록된 값
 * 매 블록 적으면 하루 7,200행 x 주소 수가 되지만, 변화만 적으면 하루 수십 행이다.
 *
 * SQL 은 이 파일에만 있고, 값은 전부 ? 로만 들어간다. 문자열을 이어붙여 만든
 * SQL 은 여기 한 줄도 없다.
 *
 * 그리고 이 클래스는 어떤 경우에도 던지지 않는다. 대시보드의 본업은 잔액을
 * 보여주는 것이지 기록을 남기는 것이 아니다. 디스크가 차거나 파일이 깨져서
 * 저장이 안 되더라도 화면은 계속 나와야 한다.
 */
class Store {
  constructor({ path }) {
    this.error = null;      // 마지막으로 실패한 이유. 성공하면 지워진다
    this.db = null;

    try {
      this.db = new DatabaseSync(path);

      // wei 가 TEXT 인 이유: SQLite 의 INTEGER 는 부호 있는 64비트라 최대 약 9.2e18 이다.
      // 1 ETH = 1e18 wei 이므로 9 ETH 만 넘어도 넘친다. config.json 의 WETH 컨트랙트는
      // 수백만 ETH(약 1e24 wei)를 들고 있어 INTEGER 로는 확실히 깨진다. INTEGER 로 바꾸면
      // 2841337000000000000000000 이 2.841337e+24 라는 부동소수점이 되어 돌아온다.
      // 서버가 BigInt 로 계산해 10진 문자열로 넘기는 것과 같은 이유다.
      //
      // (address, block) 을 기본키로 두면 같은 블록을 두 번 처리해도 행이 늘지 않는다.
      // server.js 의 forceRefresh 가 리로드 직후 같은 블록을 다시 읽으므로 실제로 생긴다.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS balances (
          address TEXT    NOT NULL,
          block   INTEGER NOT NULL,
          ts      INTEGER NOT NULL,
          wei     TEXT    NOT NULL,
          PRIMARY KEY (address, block)
        ) WITHOUT ROWID
      `);

      this.stInsert = this.db.prepare(
        'INSERT OR IGNORE INTO balances (address, block, ts, wei) VALUES (?, ?, ?, ?)'
      );
      this.stHistory = this.db.prepare(
        'SELECT block, ts, wei FROM balances WHERE address = ? AND ts >= ? ORDER BY block'
      );
      // MAX() 를 쓴 집계 질의에서 나머지 컬럼은 그 최댓값을 낸 행의 값이 온다.
      // SQLite 가 문서로 보장하는 동작이다.
      this.stLatest = this.db.prepare(
        'SELECT address, MAX(block) AS block, ts, wei FROM balances GROUP BY address'
      );
    } catch (err) {
      // 저장소를 못 열어도 서버는 떠야 한다. 이 뒤의 append/history/latest 는
      // 준비되지 않은 statement 를 만나 각자의 catch 로 떨어진다.
      this.error = err.message;
      this.db = null;
    }
  }

  // 이미 있는 (address, block) 은 조용히 무시된다.
  //
  // 어떤 이유로든 던지지 않는다. 디스크가 차서 저장이 안 된다고 폴링 루프까지
  // 멈추면, 고장 하나가 고장 둘이 된다.
  append(records) {
    try {
      for (const r of records) this.stInsert.run(r.address, r.block, r.ts, r.wei);
      this.error = null;
    } catch (err) {
      this.error = err.message;
    }
  }

  // node:sqlite 는 프로토타입이 null 인 객체를 돌려준다. 그대로 흘려보내면 부르는 쪽이
  // SQLite 의 구현 세부를 떠안게 되므로 평범한 객체로 바꿔서 넘긴다.
  history(address, sinceTs) {
    try {
      return this.stHistory
        .all(address, sinceTs)
        .map((r) => ({ block: r.block, ts: r.ts, wei: r.wei }));
    } catch (err) {
      this.error = err.message;
      return [];
    }
  }

  // 주소별 마지막 기록. 부팅 시 delta 의 기준점을 되살리는 데 쓴다.
  latest() {
    const out = new Map();
    try {
      for (const r of this.stLatest.all()) {
        out.set(r.address, { block: r.block, ts: r.ts, wei: r.wei });
      }
    } catch (err) {
      this.error = err.message;
    }
    return out;
  }

  get status() {
    return { ok: this.error === null, error: this.error };
  }

  close() {
    try {
      if (this.db) this.db.close();
    } catch (err) {
      this.error = err.message;
    }
  }
}

module.exports = { Store };

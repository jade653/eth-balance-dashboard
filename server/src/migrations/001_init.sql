-- 인덱서가 쌓는 데이터. "블록 → 그 안의 tx" 두 단계뿐이다.
--
-- 숫자 타입 메모
--   BIGINT        : 블록 번호. pg 드라이버가 JS 로 넘길 때 문자열로 준다 (Number 범위 문제 없음)
--   NUMERIC(78,0) : wei. uint256 최대값이 78자리라 정확히 담긴다. 이것도 문자열로 넘어온다.
--   legacy 에서 SQLite INTEGER 에 wei 를 넣었다가 9 ETH 에서 넘친 일을 여기선 타입으로 막는다.

CREATE TABLE blocks (
  number      BIGINT      PRIMARY KEY,
  hash        TEXT        NOT NULL,
  parent_hash TEXT        NOT NULL,     -- 리오그 감지용: 다음 블록의 parent_hash 와 맞춰 본다
  ts          TIMESTAMPTZ NOT NULL,
  tx_count    INT         NOT NULL
);

-- 오래된 블록 삭제(롤링 보관)를 시각 기준으로 하므로
CREATE INDEX blocks_ts ON blocks (ts);

CREATE TABLE txs (
  hash         TEXT          PRIMARY KEY,
  -- 블록을 지우면 그 블록의 tx 도 같이 지워진다 (리오그 되감기, 롤링 삭제 모두 이걸로 끝)
  block_number BIGINT        NOT NULL REFERENCES blocks (number) ON DELETE CASCADE,
  tx_index     INT           NOT NULL,  -- 블록 안에서의 순서
  from_addr    TEXT          NOT NULL,  -- 소문자로 저장한다 (주소는 대소문자 구분이 없다)
  to_addr      TEXT,                    -- NULL = 컨트랙트 생성 tx
  value_wei    NUMERIC(78,0) NOT NULL,
  ts           TIMESTAMPTZ   NOT NULL
);

-- "이 주소의 tx 목록, 최신순" 을 빠르게 찾기 위한 색인 두 개.
-- 보낸 쪽/받은 쪽을 각각 찾아서 합친다 (db.js 의 listAddressTxs 참고).
CREATE INDEX txs_from ON txs (from_addr, block_number DESC, tx_index DESC);
CREATE INDEX txs_to   ON txs (to_addr,   block_number DESC, tx_index DESC);

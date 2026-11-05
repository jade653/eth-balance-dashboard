-- explorer 형식의 화면(최신 블록 목록, tx 목록의 Method 칸)에 필요한 칸을 더한다.
--
-- 이미 쌓인 행은 이 칸들이 NULL 로 남는다 (화면에는 "-" 로 보인다).
-- 보관 기간이 24시간이라 하루 지나면 전부 새 형식의 행으로 바뀐다 — 과거 행을 다시 채우는
-- 작업(backfill)을 따로 하지 않아도 되는 이유다.
--
-- NULL 허용 + 기본값 없음으로 칸을 더하는 건 Postgres 에서 표의 크기와 무관하게 즉시 끝난다
-- (기존 행을 다시 쓰지 않는다). 운영 중인 표에 칸을 더할 때 지켜야 할 규칙이다.

ALTER TABLE blocks
  ADD COLUMN miner      TEXT,
  ADD COLUMN gas_used   BIGINT,
  ADD COLUMN gas_limit  BIGINT,
  ADD COLUMN base_fee   NUMERIC(78,0);   -- wei

ALTER TABLE txs
  -- input 의 앞 4바이트("0x" + 8자리) = 호출한 컨트랙트 함수의 선택자. 단순 송금이면 '0x'.
  ADD COLUMN method     TEXT;

-- 블록 번호로 tx 를 찾는 색인. 001 에서 빠져 있었다.
-- txs.block_number 는 blocks 를 가리키는 외래키지만, Postgres 는 외래키에 색인을 "자동으로 만들지 않는다".
-- 그래서 블록 하나를 지울 때(롤링 삭제·리오그) 따라 지워질 tx 를 찾으려고 txs 전체(하루 약 150만 행)를
-- 블록마다 처음부터 훑고 있었다. 이 색인이 생기면 블록당 그 블록의 tx 만 바로 찾는다.
-- "최신 tx 목록"·"블록 안의 tx 목록"도 이 색인을 쓴다.
CREATE INDEX txs_block ON txs (block_number DESC, tx_index DESC);

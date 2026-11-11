-- ERC-20 토큰 홀더 추적 (Etherscan 의 토큰 페이지: 홀더 순위 · 전송 목록).
--
-- 블록 인덱서(blocks/txs)는 최근 24시간만 들고 있지만, "지금 누가 얼마를 갖고 있나"는
-- 토큰이 생긴 뒤의 Transfer 를 처음부터 전부 더해야 나온다. 그래서 추적할 토큰(TOKENS 설정)만
-- 골라서, 배포 블록부터 eth_getLogs 로 Transfer 이벤트를 모아 따로 쌓는다. 보관 기간 삭제(prune)도 없다.
--
--   tokens          추적하는 토큰과 "어디까지 모았나"(synced_block)
--   token_transfers Transfer 이벤트 한 건 = 한 행
--   token_balances  주소별 잔액 = 받은 합 − 보낸 합. 전송을 넣을 때 같은 트랜잭션으로 갱신한다

CREATE TABLE tokens (
  address        TEXT PRIMARY KEY,           -- 소문자
  name           TEXT,
  symbol         TEXT,
  decimals       INT,
  start_block    BIGINT NOT NULL,            -- 여기서부터 모은다 (보통 배포 블록)
  synced_block   BIGINT,                     -- 여기까지 모두 반영했다. NULL = 아직 시작 전
  holder_count   INT    NOT NULL DEFAULT 0,  -- 잔액 > 0 인 주소 수. 매번 count(*) 하지 않게 같이 갱신한다
  transfer_count BIGINT NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ
);

CREATE TABLE token_transfers (
  token        TEXT          NOT NULL REFERENCES tokens (address) ON DELETE CASCADE,
  block_number BIGINT        NOT NULL,
  log_index    INT           NOT NULL,       -- 블록 안 로그 순서. (블록, 로그 순서)가 이벤트 하나를 가리킨다
  tx_hash      TEXT          NOT NULL,
  tx_index     INT           NOT NULL,
  from_addr    TEXT          NOT NULL,       -- 0x000…0 이면 발행(mint)
  to_addr      TEXT          NOT NULL,       -- 0x000…0 이면 소각(burn)
  amount       NUMERIC(78,0) NOT NULL,       -- decimals 적용 전 정수
  ts           TIMESTAMPTZ,
  method       TEXT,                         -- 이 이벤트를 낳은 tx 의 함수 선택자 (Transfers 표의 Method 칸)
  PRIMARY KEY (token, block_number, log_index)
);
-- 토큰별 최신순은 기본키 색인을 거꾸로 읽는다. 주소별(보낸/받은) 목록은 색인 두 개를 합친다 (txs 와 같은 방식).
CREATE INDEX token_transfers_from ON token_transfers (from_addr, block_number DESC, log_index DESC);
CREATE INDEX token_transfers_to   ON token_transfers (to_addr,   block_number DESC, log_index DESC);

CREATE TABLE token_balances (
  token   TEXT          NOT NULL REFERENCES tokens (address) ON DELETE CASCADE,
  holder  TEXT          NOT NULL,
  balance NUMERIC(78,0) NOT NULL,            -- 0 이 되면 행을 지운다
  PRIMARY KEY (token, holder)
);
-- 홀더 순위표: 잔액 큰 순서. 잔액이 같으면 주소 순으로 순서를 고정한다 (페이지가 흔들리지 않게)
CREATE INDEX token_balances_rank ON token_balances (token, balance DESC, holder) WHERE balance > 0;
-- 주소 페이지의 "토큰 보유"
CREATE INDEX token_balances_holder ON token_balances (holder);

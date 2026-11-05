-- DB 가 "어느 체인의 데이터"인지 적어 두는 곳.
--
-- RPC 주소만 바꿔 다른 체인에 붙이면, DB 의 마지막 블록 번호가 새 체인의 최신 블록보다
-- 클 수 있다. 그러면 인덱서는 "아직 새 블록이 없다"고 보고 에러 없이 영원히 기다린다.
-- 시작할 때 이 값과 RPC 의 chainId 를 맞춰 보고, 다르면 멈추고 알린다 (worker.js).

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

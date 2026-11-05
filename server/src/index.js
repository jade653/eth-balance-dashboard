/**
 * 진입점. 환경변수를 읽고, 의존성을 만들어 app 에 넣고, 포트를 연다.
 * "조립"만 하고 로직은 없다 — 로직은 전부 테스트 가능한 app.js 쪽에 있다.
 */
import http from 'node:http';
import os from 'node:os';
import { createApp } from './app.js';
import { RpcClient } from './rpc.js';
import { createPool, createStore } from './db.js';

const PORT = Number(process.env.PORT ?? 8787);
// 컨테이너 안에서는 0.0.0.0 이어야 밖(nginx 컨테이너)에서 닿는다. 로컬 기본은 127.0.0.1.
const HOST = process.env.HOST ?? '127.0.0.1';
// 쉼표로 여러 개 주면 앞의 것이 죽었을 때 다음 것으로 넘어간다 (rpc.js 페일오버).
const RPC_URLS = (process.env.RPC_HTTP_URL ?? 'https://ethereum-rpc.publicnode.com')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const rpc = new RpcClient(RPC_URLS);

// DB 는 선택이다. 없으면 tx·블록·주소 조회(노드 직접)는 되고, 주소별 tx 목록만 503 이 된다.
const pool = process.env.DATABASE_URL ? createPool(process.env.DATABASE_URL) : null;
const noDb = async () => { throw new Error('DATABASE_URL not set'); };
const store = pool
  ? createStore(pool)
  : { latestBlock: noDb, coverage: noDb, listAddressTxs: noDb };

// 화면에 보일 체인 이름·잔액 단위. 비우면 chainId 1 → Ethereum/ETH, 그 외 → "Chain <id>"/ETH
const chain = {
  name: process.env.CHAIN_NAME || undefined,
  symbol: process.env.NATIVE_SYMBOL || undefined,
};

const app = createApp({ rpc, store, chain });

// 컨테이너 안에서 hostname 은 컨테이너 ID 다. 응답마다 붙여 두면
// nginx 가 요청을 여러 인스턴스에 나눠 주는 모습을 헤더로 직접 볼 수 있다.
const INSTANCE = os.hostname();
const server = http.createServer((req, res) => {
  res.setHeader('x-served-by', INSTANCE);
  app(req, res);
});

server.listen(PORT, HOST, () => {
  // URL 자체는 로그에 남기지 않는다. API 키가 들어 있을 수 있다.
  console.log(`server listening on http://${HOST}:${PORT} (rpc endpoints: ${RPC_URLS.length})`);
});

// docker stop 은 SIGTERM 을 보낸다. 받으면 새 연결을 그만 받고 깔끔하게 끝낸다.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`${sig} received, shutting down`);
    server.close(async () => {
      await pool?.end();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  });
}

/**
 * 진입점. 환경변수를 읽고, 의존성을 만들어 app 에 넣고, 포트를 연다.
 * "조립"만 하고 로직은 없다 — 로직은 전부 테스트 가능한 app.js 쪽에 있다.
 */
import http from 'node:http';
import { createApp } from './app.js';
import { RpcClient } from './rpc.js';

const PORT = Number(process.env.PORT ?? 8787);
// 컨테이너 안에서는 0.0.0.0 이어야 밖(nginx 컨테이너)에서 닿는다. 로컬 기본은 127.0.0.1.
const HOST = process.env.HOST ?? '127.0.0.1';
// 쉼표로 여러 개 주면 앞의 것이 죽었을 때 다음 것으로 넘어간다 (rpc.js 페일오버).
const RPC_URLS = (process.env.RPC_HTTP_URL ?? 'https://ethereum-rpc.publicnode.com')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const rpc = new RpcClient(RPC_URLS);
const server = http.createServer(createApp({ rpc }));

server.listen(PORT, HOST, () => {
  // URL 자체는 로그에 남기지 않는다. API 키가 들어 있을 수 있다.
  console.log(`server listening on http://${HOST}:${PORT} (rpc endpoints: ${RPC_URLS.length})`);
});

// docker stop 은 SIGTERM 을 보낸다. 받으면 새 연결을 그만 받고 깔끔하게 끝낸다.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`${sig} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}

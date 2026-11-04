/**
 * 인덱서 worker 진입점. api 와 같은 이미지로 띄우되 실행 명령만 다르다 (compose 의 command).
 *
 *   api    : 요청이 오면 대답한다. 여러 개 띄워도 된다 (읽기만 하므로).
 *   worker : 아무도 안 불러도 혼자 계속 돈다. 딱 하나만 띄운다.
 *            둘이면 같은 블록을 두 번 받고(RPC 낭비), 리오그 되감기가 서로 꼬인다.
 *
 * 하는 일
 *   1. DB 스키마를 최신으로 (migrate)
 *   2. 블록을 따라가며 DB 에 쌓기 (syncOnce 반복)
 *   3. 1시간마다 보관 기간이 지난 블록 지우기 (prune)
 */
import fs from 'node:fs';
import { RpcClient } from './rpc.js';
import { createPool, createStore, migrate } from './db.js';
import { syncOnce } from './indexer.js';

const RPC_URLS = (process.env.RPC_HTTP_URL ?? 'https://ethereum-rpc.publicnode.com').split(',').map((s) => s.trim()).filter(Boolean);
const DATABASE_URL = process.env.DATABASE_URL;
const RETENTION_HOURS = Number(process.env.RETENTION_HOURS ?? 24);
const BLOCK_TIME_S = Number(process.env.BLOCK_TIME_S ?? 12);    // 메인넷 12초
const BATCH_SIZE = Number(process.env.INDEX_BATCH_SIZE ?? 5);
const POLL_MS = Number(process.env.POLL_MS ?? 4000);
const PRUNE_EVERY_MS = 60 * 60 * 1000;

if (!DATABASE_URL) {
  console.error('DATABASE_URL 이 필요하다');
  process.exit(1);
}
// 잘못된 설정은 시작할 때 바로 죽는다. 돌다가 매 바퀴 같은 에러를 내는 것보다 낫다.
for (const [name, v] of Object.entries({ RETENTION_HOURS, BLOCK_TIME_S, INDEX_BATCH_SIZE: BATCH_SIZE, POLL_MS })) {
  if (!Number.isFinite(v) || v <= 0) {
    console.error(`${name} 는 양수여야 한다: ${v}`);
    process.exit(1);
  }
}

const log = (...a) => console.log(new Date().toISOString(), ...a);
// 종료 신호가 오면 쉬던 중이라도 바로 깨어난다 (docker stop 은 10초 뒤 강제 종료한다)
const stop = new AbortController();
const sleep = (ms) =>
  new Promise((r) => {
    const wake = () => { clearTimeout(t); r(); };
    const t = setTimeout(() => { stop.signal.removeEventListener('abort', wake); r(); }, ms);
    stop.signal.addEventListener('abort', wake, { once: true });
  });

// 살아 있다는 표시. 루프가 한 바퀴 돌 때마다 이 파일의 수정 시각을 갱신한다.
// worker 는 HTTP 를 열지 않으므로, 컨테이너 healthcheck 는 "이 파일이 최근에 갱신됐나"를 본다.
// 프로세스는 살아 있는데 어딘가에 멈춰 버린(hang) 경우도 이걸로 잡힌다.
const HEARTBEAT_FILE = process.env.HEARTBEAT_FILE ?? '/tmp/worker-heartbeat';
const beat = () => {
  try {
    fs.writeFileSync(HEARTBEAT_FILE, String(Date.now()));
  } catch {
    /* 표시 실패가 인덱싱을 막으면 안 된다 */
  }
};

const rpc = new RpcClient(RPC_URLS, { timeoutMs: 20_000 });
const pool = createPool(DATABASE_URL, { max: 2 });
const store = createStore(pool);
const retentionBlocks = Math.ceil((RETENTION_HOURS * 3600) / BLOCK_TIME_S);

let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log(`${sig} received, finishing current batch`);
    stopping = true;
    stop.abort();
  });
}

async function main() {
  // DB 가 막 뜨는 중일 수 있으므로 붙을 때까지 재시도
  for (let i = 1; ; i++) {
    beat();
    try {
      await migrate(pool, log);
      break;
    } catch (err) {
      if (i >= 30 || stopping) throw err;
      log(`DB 준비 대기 (${i}/30): ${err.message}`);
      await sleep(2000);
    }
  }

  log(`indexer start: 보관 ${RETENTION_HOURS}시간 ≈ ${retentionBlocks} 블록, batch ${BATCH_SIZE}`);
  let backoff = 1000;
  let lastPrune = 0;
  let total = 0;
  let lastReport = Date.now();

  while (!stopping) {
    beat();
    try {
      const r = await syncOnce(rpc, store, { retentionBlocks, batchSize: BATCH_SIZE, log });
      backoff = 1000;
      total += r.indexed;

      if (Date.now() - lastReport > 30_000) {
        const latest = await store.latestBlock();
        const lag = latest ? r.head - BigInt(latest.number) : null;
        log(`progress: +${total} blocks in 30s, latest ${latest?.number ?? '-'}, head ${r.head}, lag ${lag ?? '-'}`);
        total = 0;
        lastReport = Date.now();
      }

      if (Date.now() - lastPrune > PRUNE_EVERY_MS) {
        // 시도한 시각부터 적는다. 실패해도 매 바퀴 다시 시도하며 로그를 도배하지 않게.
        lastPrune = Date.now();
        const n = await store.prune(RETENTION_HOURS);
        if (n > 0) log(`prune: ${n} blocks older than ${RETENTION_HOURS}h removed`);
      }

      // 따라잡았으면 다음 블록이 나올 때까지 쉰다. 밀려 있으면 바로 다음 묶음.
      if (r.indexed === 0) await sleep(POLL_MS);
    } catch (err) {
      // RPC·DB 일시 장애. 점점 길게 쉬며 재시도한다 (최대 60초).
      log(`error (retry in ${backoff / 1000}s): ${err.message}`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60_000);
    }
  }
  await pool.end();
  log('stopped');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

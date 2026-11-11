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
 *   4. ERC-20 홀더 모으기 — 체인에서 토큰을 스스로 찾고(자동 인식), 토큰마다 Transfer 를 처음부터 (tokens.js)
 */
import fs from 'node:fs';
import { RpcClient } from './rpc.js';
import { createPool, createStore, migrate } from './db.js';
import { syncOnce, checkChain, measureBlockTime } from './indexer.js';
import {
  parseTokenSpec, tokenMeta, findDeployBlock, syncTokenOnce,
  parseDiscovery, discoveryOn, discoverTokensOnce, DISCOVERY_KEY,
} from './tokens.js';

const RPC_URLS = (process.env.RPC_HTTP_URL ?? 'https://ethereum-rpc.publicnode.com').split(',').map((s) => s.trim()).filter(Boolean);
const DATABASE_URL = process.env.DATABASE_URL;
const RETENTION_HOURS = Number(process.env.RETENTION_HOURS ?? 24);
// 비워 두면 체인에서 직접 잰다. 재는 데 실패하면 12초(이더리움)로 본다.
const BLOCK_TIME_S = process.env.BLOCK_TIME_S ? Number(process.env.BLOCK_TIME_S) : null;
// 1 이면 다른 체인의 데이터를 발견했을 때 지우고 새로 시작한다. 기본은 멈추고 알린다.
const RESET_ON_CHAIN_CHANGE = process.env.RESET_ON_CHAIN_CHANGE === '1';
const BATCH_SIZE = Number(process.env.INDEX_BATCH_SIZE ?? 5);
const POLL_MS = Number(process.env.POLL_MS ?? 4000);
const PRUNE_EVERY_MS = 60 * 60 * 1000;
// 홀더를 추적할 ERC-20 토큰들: "0xabc…@시작블록,0xdef…". 시작 블록을 빼면 배포 블록을 찾는다.
const TOKEN_CONFIRMATIONS = Number(process.env.TOKEN_CONFIRMATIONS ?? 5);
const TOKEN_LOG_RANGE = Number(process.env.TOKEN_LOG_RANGE ?? 50_000);
// 토큰 자동 인식: auto(기본) = 공개 체인(메인넷 등)이 아니면 켠다 / on / off
// 켜져 있으면 TOKENS 에 적지 않은 ERC-20 도 체인에서 찾아 추적한다 (tokens.js 의 discoverTokensOnce)
const TOKEN_DISCOVERY_FROM = Number(process.env.TOKEN_DISCOVERY_FROM || 0);
const TOKEN_DISCOVERY_MAX = Number(process.env.TOKEN_DISCOVERY_MAX || 100);
let TOKENS;
let TOKEN_DISCOVERY;
try {
  TOKENS = parseTokenSpec(process.env.TOKENS);
  TOKEN_DISCOVERY = parseDiscovery(process.env.TOKEN_DISCOVERY);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

if (!DATABASE_URL) {
  console.error('DATABASE_URL 이 필요하다');
  process.exit(1);
}
if (!Number.isInteger(TOKEN_CONFIRMATIONS) || TOKEN_CONFIRMATIONS < 0 || !(TOKEN_LOG_RANGE >= 1)) {
  console.error('TOKEN_CONFIRMATIONS 는 0 이상 정수, TOKEN_LOG_RANGE 는 1 이상이어야 한다');
  process.exit(1);
}
if (!Number.isSafeInteger(TOKEN_DISCOVERY_FROM) || TOKEN_DISCOVERY_FROM < 0 || !Number.isSafeInteger(TOKEN_DISCOVERY_MAX) || TOKEN_DISCOVERY_MAX < 1) {
  console.error('TOKEN_DISCOVERY_FROM 은 0 이상 정수, TOKEN_DISCOVERY_MAX 는 1 이상 정수여야 한다');
  process.exit(1);
}
// 잘못된 설정은 시작할 때 바로 죽는다. 돌다가 매 바퀴 같은 에러를 내는 것보다 낫다.
for (const [name, v] of Object.entries({ RETENTION_HOURS, BLOCK_TIME_S: BLOCK_TIME_S ?? 1, INDEX_BATCH_SIZE: BATCH_SIZE, POLL_MS })) {
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

let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log(`${sig} received, finishing current batch`);
    stopping = true;
    stop.abort();
  });
}

/** 토큰 하나를 이어서 모을 상태 (worker 메모리) */
const tokenState = ({ address, symbol, startBlock, syncedBlock }) => ({
  address, symbol, startBlock, syncedBlock, range: null, retryAt: 0, fails: 0, recent: 0, behind: null,
});

/**
 * TOKENS 의 토큰들을 DB 에 등록하고, DB 에 있는 토큰 전부(자동 인식으로 찾은 것 포함)의 상태를 만든다.
 * 이미 모으던 토큰은 synced_block 다음부터 이어서 간다 (처음부터 다시 하지 않는다).
 */
let tokens = [];
async function registerTokens() {
  await registerConfigured();
  const rows = await store.listTokens();
  for (const row of rows) {
    log(`token ${row.symbol ?? row.address}: ${row.startBlock} 블록부터, ${row.syncedBlock ?? '(처음)'} 까지 모음, 홀더 ${row.holders}`);
  }
  return rows.map(tokenState);
}

/** TOKENS 설정의 토큰 등록. 시작 블록: 설정값 → (이미 등록돼 있으면) 처음 정한 값 → 배포 블록 탐색 → 0 순서 */
async function registerConfigured() {
  if (TOKENS.length === 0) return;
  const head = BigInt(await rpc.call('eth_blockNumber'));
  const meta = await tokenMeta(rpc, TOKENS.map((t) => t.address));
  for (const spec of TOKENS) {
    const existing = await store.getToken(spec.address);
    let startBlock = existing?.startBlock ?? spec.startBlock;
    if (existing && spec.startBlock && spec.startBlock !== existing.startBlock) {
      log(`token ${spec.address}: 이미 ${existing.startBlock} 블록부터 모으는 중이라 설정의 @${spec.startBlock} 은 무시한다`);
    }
    if (startBlock == null) {
      log(`token ${spec.address}: 시작 블록이 없어 배포 블록을 찾는다 (아카이브 노드가 필요)`);
      startBlock = await findDeployBlock(rpc, spec.address, head);
      if (startBlock == null) log(`token ${spec.address}: 배포 블록을 못 찾아 0 부터 모은다. TOKENS 에 @시작블록 을 적으면 빨라진다`);
      startBlock ??= '0';
    }
    const m = meta.get(spec.address);
    if (m.decimals == null) log(`token ${spec.address}: decimals() 응답이 없다 — ERC-20 이 맞는지 확인할 것`);
    await store.upsertToken({ address: spec.address, ...m, startBlock });
  }
}

/**
 * 토큰 자동 인식 상태. 꺼져 있으면 null.
 * 어디까지 훑었는지는 DB(meta)에 있어서, 다시 띄워도 처음부터 다시 훑지 않는다.
 */
let discovery = null;
async function setupDiscovery(chainId) {
  if (!discoveryOn(TOKEN_DISCOVERY, chainId)) {
    const why = TOKEN_DISCOVERY === 'off' ? 'TOKEN_DISCOVERY=off' : `chainId ${chainId} 는 토큰이 너무 많은 공개 체인`;
    log(`token discovery: 꺼짐 (${why}) — 추적할 토큰은 TOKENS 에 적는다`);
    return null;
  }
  const cursor = await store.getMeta(DISCOVERY_KEY);
  const where = cursor ? `${cursor} 블록까지 훑었음, 이어서` : `${TOKEN_DISCOVERY_FROM} 블록부터 훑음`;
  log(`token discovery: 켜짐 — ${where} (최대 ${TOKEN_DISCOVERY_MAX}개)`);
  return { cursor, from: TOKEN_DISCOVERY_FROM, range: null, retryAt: 0, fails: 0, behind: null };
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

  // 체인 확인과 블록 간격 측정은 RPC 가 필요하다. RPC 가 아직 안 되면 될 때까지 기다린다.
  let retentionBlocks;
  for (let wait = 2000; !stopping; wait = Math.min(wait * 2, 60_000)) {
    beat();
    try {
      const chain = await checkChain(rpc, store);
      if (chain.status === 'mismatch') {
        if (!RESET_ON_CHAIN_CHANGE) {
          log(`!! DB 의 데이터가 지금 RPC 의 체인(chainId ${chain.chainId})과 다르다 (DB: ${chain.saved}).`);
          log('!! 그대로 두면 인덱서가 멈춘 것처럼 보인다. 체인을 바꾼 게 맞다면 둘 중 하나:');
          log('!!   1) .env 에 RESET_ON_CHAIN_CHANGE=1 을 넣고 다시 띄운다 (DB 를 비우고 새로 쌓음)');
          log('!!   2) RPC_HTTP_URL 을 원래 체인으로 되돌린다');
          process.exit(1);
        }
        log(`체인이 바뀌었다 (DB: ${chain.saved} → RPC: ${chain.chainId}). RESET_ON_CHAIN_CHANGE=1 이므로 DB 를 비운다.`);
        await store.resetAll();
        await store.setMeta('chain_id', chain.chainId);
      } else {
        log(`chainId ${chain.chainId} (${chain.status === 'empty' ? '빈 DB — 새로 시작' : 'DB 와 일치'})`);
      }

      const measured = BLOCK_TIME_S ?? (await measureBlockTime(rpc));
      const blockTime = measured ?? 12;
      retentionBlocks = Math.ceil((RETENTION_HOURS * 3600) / blockTime);
      log(`블록 간격 ${blockTime.toFixed(2)}초${BLOCK_TIME_S ? ' (설정값)' : measured ? ' (최근 1000블록 측정)' : ' (측정 실패, 기본값)'}`);
      tokens = await registerTokens();
      discovery = await setupDiscovery(chain.chainId);
      break;
    } catch (err) {
      log(`RPC 준비 대기 (${wait / 1000}s 후 재시도): ${err.message}`);
      await sleep(wait);
    }
  }
  if (stopping) return;

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
      let tokenProgress = false;

      // 토큰 자동 인식: 한 구간 훑어 새 토큰을 추적 목록에 넣는다
      if (discovery && Date.now() >= discovery.retryAt) {
        try {
          const d = await discoverTokensOnce(rpc, store, discovery, {
            head: r.head, confirmations: TOKEN_CONFIRMATIONS, maxRange: TOKEN_LOG_RANGE,
            limit: Math.max(0, TOKEN_DISCOVERY_MAX - tokens.length), log,
          });
          tokenProgress = d.progressed || !!d.retry;
          discovery.behind = d.behind;
          discovery.fails = 0;
          for (const f of d.found) {
            log(`token discovery: 새 토큰 ${f.symbol ?? '(이름 없음)'} ${f.address} — ${f.startBlock} 블록부터 모은다`);
            tokens.push(tokenState({ ...f, syncedBlock: null }));
          }
          if (d.full) {
            log(`token discovery: 토큰이 ${TOKEN_DISCOVERY_MAX}개에 닿아 더 찾지 않는다. 더 필요하면 TOKEN_DISCOVERY_MAX 를 올리고 다시 띄운다 (멈춘 곳부터 이어서 찾는다)`);
            discovery = null;
          }
        } catch (err) {
          discovery.fails += 1;
          const wait = Math.min(1000 * 2 ** discovery.fails, 60_000);
          discovery.retryAt = Date.now() + wait;
          log(`token discovery error (retry in ${wait / 1000}s): ${err.message}`);
        }
      }

      // 토큰 홀더: 토큰마다 한 구간씩. 실패해도 블록 인덱싱은 계속한다 (그 토큰만 잠시 쉰다)
      for (const tok of tokens) {
        if (Date.now() < tok.retryAt) continue;
        try {
          const t = await syncTokenOnce(rpc, store, tok, { head: r.head, confirmations: TOKEN_CONFIRMATIONS, maxRange: TOKEN_LOG_RANGE, log });
          tokenProgress ||= t.progressed || !!t.retry;
          tok.recent += t.count;
          tok.behind = t.behind;
          tok.fails = 0;
        } catch (err) {
          tok.fails += 1;
          const wait = Math.min(1000 * 2 ** tok.fails, 60_000);
          tok.retryAt = Date.now() + wait;
          log(`token ${tok.address} error (retry in ${wait / 1000}s): ${err.message}`);
        }
      }

      if (Date.now() - lastReport > 30_000) {
        const latest = await store.latestBlock();
        const lag = latest ? r.head - BigInt(latest.number) : null;
        log(`progress: +${total} blocks in 30s, latest ${latest?.number ?? '-'}, head ${r.head}, lag ${lag ?? '-'}`);
        if (discovery?.behind) log(`  token discovery: ${discovery.cursor ?? '-'} 블록까지 훑음, ${discovery.behind} 블록 남음 (range ${discovery.range ?? '-'})`);
        for (const tok of tokens) {
          log(`  token ${tok.symbol ?? tok.address}: +${tok.recent} transfers, synced ${tok.syncedBlock ?? '-'}, behind ${tok.behind ?? '-'} blocks (range ${tok.range ?? '-'})`);
          tok.recent = 0;
        }
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
      if (r.indexed === 0 && !tokenProgress) await sleep(POLL_MS);
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

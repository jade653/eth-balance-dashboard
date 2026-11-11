/**
 * 토큰 홀더 인덱서. 블록 인덱서(indexer.js)와 따로 돈다.
 *
 * 블록 인덱서는 "최근 24시간의 모든 tx" 를 쌓고, 이쪽은 "추적하는 토큰의 처음부터 모든 Transfer" 를 쌓는다.
 * 홀더 잔액은 토큰이 생긴 뒤의 Transfer 를 전부 더해야 나오기 때문이다 (Etherscan 도 같은 방식이다).
 *
 * 블록을 하나씩 받지 않고 eth_getLogs 로 "이 토큰의 Transfer 이벤트만" 구간 단위로 받는다.
 * 토큰 하나의 이벤트만 거르면 수십만 블록도 요청 몇 번이면 된다.
 *
 * 리오그: 최신 블록에서 confirmations 개 뒤까지만 모은다. 확정된 구간만 쌓으므로 되감을 일이 없다.
 */

const hex = (n) => '0x' + BigInt(n).toString(16);

/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * TOKENS 설정 해석. 쉼표로 여러 개, 주소 뒤에 @시작블록을 붙일 수 있다.
 *   "0xabc…,0xdef…@14155996"
 * 시작 블록을 모르면 null (배포 블록을 찾아서 쓴다). 형식이 틀리면 던진다 — 시작할 때 바로 알게.
 */
export function parseTokenSpec(spec) {
  if (!spec || !spec.trim()) return [];
  return spec.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = /^(0x[0-9a-fA-F]{40})(?:@(\d{1,15}))?$/.exec(s);
    if (!m) throw new Error(`TOKENS 형식 오류: "${s}" (예: 0xabc…@12345)`);
    return { address: m[1].toLowerCase(), startBlock: m[2] ?? null };
  });
}

/** ABI string 반환값 → 문자열. 옛 토큰(MKR 등)은 bytes32 로 준다. 해석 못 하면 null */
export function decodeAbiString(hex) {
  if (typeof hex !== 'string' || !hex.startsWith('0x') || hex.length < 66) return null;
  const body = hex.slice(2);
  const bytesToText = (h) => {
    const text = Buffer.from(h, 'hex').toString('utf8').replace(/\0+$/, '');
    return text && !/[\0�]/.test(text) ? text : null;
  };
  if (body.length === 64) return bytesToText(body); // bytes32
  const offset = Number(BigInt('0x' + body.slice(0, 64))) * 2;
  if (offset + 64 > body.length) return null;
  const len = Number(BigInt('0x' + body.slice(offset, offset + 64))) * 2;
  const start = offset + 64;
  if (start + len > body.length) return null;
  return bytesToText(body.slice(start, start + len));
}

/** eth_call 결과 uint256 → 10진 문자열. 아니면 null */
const uintOf = (v) => (typeof v === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(v) ? BigInt(v).toString() : null);

/**
 * 토큰마다 name()·symbol()·decimals() (+ 원하면 totalSupply()) 를 묻는다.
 * 표준을 안 지키는 토큰·토큰이 아닌 컨트랙트도 있어서 실패하면 null 로 둔다.
 * rpc.batch 는 하나만 실패해도 전체를 던지므로 호출마다 따로 실패를 삼킨다.
 */
export async function tokenMeta(rpc, tokens, { totalSupply = false } = {}) {
  const ask = (to, data) => rpc.call('eth_call', [{ to, data }, 'latest']).catch(() => null);
  const entries = await Promise.all(tokens.map(async (token) => {
    const [name, sym, dec, supply] = await Promise.all([
      ask(token, '0x06fdde03'), // name()
      ask(token, '0x95d89b41'), // symbol()
      ask(token, '0x313ce567'), // decimals()
      totalSupply ? ask(token, '0x18160ddd') : null, // totalSupply()
    ]);
    let decimals = uintOf(dec);
    decimals = decimals !== null && BigInt(decimals) <= 77n ? Number(decimals) : null; // uint256 최대 78자리. 그보다 크면 엉터리
    const meta = { name: decodeAbiString(name), symbol: decodeAbiString(sym), decimals };
    if (totalSupply) meta.totalSupply = uintOf(supply);
    return [token.toLowerCase(), meta];
  }));
  return new Map(entries);
}

/**
 * 컨트랙트가 배포된 블록을 이진 탐색으로 찾는다 (그 블록 시점에 코드가 있나?).
 * 과거 시점의 상태를 묻는 것이라 아카이브 노드가 필요하다. 못 찾으면 null.
 */
export async function findDeployBlock(rpc, address, head) {
  const hasCode = async (n) => {
    const code = await rpc.call('eth_getCode', [address, hex(n)]);
    return typeof code === 'string' && code !== '0x';
  };
  try {
    if (!(await hasCode(head))) return null;
    let lo = 0n;
    let hi = BigInt(head);
    while (lo < hi) {
      const mid = (lo + hi) / 2n;
      if (await hasCode(mid)) hi = mid;
      else lo = mid + 1n;
    }
    return lo.toString();
  } catch {
    return null; // 풀 노드: 오래된 상태가 없어 "missing trie node" 류 에러
  }
}

const topicAddr = (topic) => '0x' + topic.slice(26).toLowerCase();

/** ERC-20 Transfer 모양인가: topic 3개 + data 32바이트. ERC-721 은 tokenId 까지 topic 이라 4개다 */
const isErc20Transfer = (l) => !l.removed && l.topics?.length === 3 && l.topics[0]?.toLowerCase() === TRANSFER_TOPIC
  && /^0x[0-9a-fA-F]{64}$/.test(l.data ?? '');

/** eth_getLogs 결과 → 저장할 행. ERC-20 모양만 */
export function transferRows(logs) {
  return logs
    .filter(isErc20Transfer)
    .map((l) => ({
      blockNumber: BigInt(l.blockNumber).toString(),
      logIndex: Number(BigInt(l.logIndex)),
      txHash: l.transactionHash,
      txIndex: Number(BigInt(l.transactionIndex)),
      from: topicAddr(l.topics[1]),
      to: topicAddr(l.topics[2]),
      amount: BigInt(l.data).toString(),
      // 새 노드(geth 1.14+ 등)는 로그에 블록 시각을 같이 준다. 없으면 아래에서 블록을 물어 채운다
      blockTimestamp: l.blockTimestamp ?? null,
    }));
}

/** 호출 목록을 n 개씩 나눠 batch. 공개 RPC 는 한 번에 받는 호출 수에 상한이 있다 */
async function batchInChunks(rpc, calls, n = 50) {
  const out = [];
  for (let i = 0; i < calls.length; i += n) out.push(...(await rpc.batch(calls.slice(i, i + n))));
  return out;
}

/**
 * 토큰 하나를 한 구간만큼 앞으로 모은다.
 *
 * @param tok   { address, startBlock, syncedBlock, range } — range 는 이번에 물을 블록 수. 여기서 늘리고 줄인다
 * @param head  노드의 최신 블록 번호 (BigInt)
 * @returns { progressed, count, from, to, behind }
 *
 * 구간 크기는 노드에 맞춰 스스로 조절한다. 공개 RPC 는 "구간이 너무 넓다", "결과가 1만 건을 넘는다" 같은
 * 이유로 거절하므로, 실패하면 절반으로 줄여 다시, 결과가 적으면 두 배로 늘린다.
 */
export async function syncTokenOnce(rpc, store, tok, { head, confirmations = 5, maxRange = 50_000, log = () => {} }) {
  const safeHead = BigInt(head) - BigInt(confirmations);
  const from = tok.syncedBlock != null ? BigInt(tok.syncedBlock) + 1n : BigInt(tok.startBlock);
  if (from > safeHead) return { progressed: false, count: 0, behind: 0n };

  const got = await logsInRange(rpc, tok, { address: tok.address, topics: [TRANSFER_TOPIC] }, from, safeHead, { log, label: `token ${tok.address}` });
  if (got.retry) return { progressed: false, count: 0, behind: safeHead - from + 1n, retry: true };
  const { logs, to } = got;

  const rows = transferRows(logs);

  // 블록 시각: 로그에 없으면 블록 헤더를 묻는다 (tx 본문 없이)
  const needTs = [...new Set(rows.filter((r) => !r.blockTimestamp).map((r) => r.blockNumber))];
  const tsOf = new Map();
  if (needTs.length) {
    const blocks = await batchInChunks(rpc, needTs.map((n) => ({ method: 'eth_getBlockByNumber', params: [hex(n), false] })));
    needTs.forEach((n, i) => { if (blocks[i]) tsOf.set(n, blocks[i].timestamp); });
  }
  // Method 칸: 이 이벤트를 낳은 tx 의 함수 선택자 (input 앞 4바이트)
  const hashes = [...new Set(rows.map((r) => r.txHash))];
  const methodOf = new Map();
  if (hashes.length) {
    const txs = await batchInChunks(rpc, hashes.map((h) => ({ method: 'eth_getTransactionByHash', params: [h] })));
    hashes.forEach((h, i) => {
      const input = txs[i]?.input;
      if (typeof input === 'string') methodOf.set(h, input.length >= 10 ? input.slice(0, 10).toLowerCase() : '0x');
    });
  }

  const transfers = rows.map((r) => {
    const ts = r.blockTimestamp ?? tsOf.get(r.blockNumber);
    return {
      ...r,
      timestamp: ts ? new Date(Number(BigInt(ts)) * 1000) : null,
      method: methodOf.get(r.txHash) ?? null,
    };
  });
  await store.applyTokenTransfers(tok.address, transfers, to);
  tok.syncedBlock = to.toString();
  widen(tok, logs.length, maxRange);
  return { progressed: true, count: transfers.length, from, to, behind: safeHead - to };
}

/**
 * from 부터 state.range 블록(safeHead 를 넘지 않게)의 로그를 받는다.
 * 노드가 거절하면 구간을 절반으로 줄이고 { retry: true } — 다음 바퀴에 줄인 크기로 다시 묻는다.
 */
async function logsInRange(rpc, state, filter, from, safeHead, { log, label }) {
  state.range ??= 2_000;
  const end = from + BigInt(state.range) - 1n;
  const to = end < safeHead ? end : safeHead;
  try {
    const logs = await rpc.call('eth_getLogs', [{ ...filter, fromBlock: hex(from), toBlock: hex(to) }]);
    return { logs, to };
  } catch (err) {
    if (state.range <= 1) throw err;
    state.range = Math.max(1, Math.floor(state.range / 2));
    state.ceiling = state.range; // 거절당한 크기로 다시 키우지 않는다 (늘렸다 거절당하기를 반복하지 않게)
    log(`${label}: getLogs ${from}~${to} 실패 → 구간 ${state.range} 블록으로 줄임 (${err.message})`);
    return { retry: true };
  }
}

/** 결과가 적으면 구간을 넓힌다 (빈 구간을 빨리 지나가게) */
function widen(state, logCount, maxRange) {
  if (logCount < 1_000) state.range = Math.min(maxRange, state.ceiling ?? Infinity, state.range * 2);
}

/*
 * ── 토큰 자동 인식 ─────────────────────────────────────────────────────────
 * TOKENS 에 적지 않아도, 체인에서 ERC-20 Transfer 를 낸 컨트랙트를 찾아 추적 목록에 넣는다.
 * 주소 조건 없이 Transfer 로그를 체인 처음부터 앞으로 훑는다. 앞에서부터 훑으므로
 * 어떤 컨트랙트를 처음 본 블록 = 그 토큰의 첫 Transfer 다 → 거기서부터 모으면 빠짐이 없다.
 *
 * 공개 체인(이더리움 메인넷·테스트넷, L2 등)은 토큰이 수십만 개라 다 모을 수 없으므로 기본으로 끈다.
 */

/** 토큰이 너무 많은 공개 체인들 (chainId) */
export const PUBLIC_CHAINS = new Set([
  1, 11155111, 17000, 560048, // 이더리움 메인넷, Sepolia, Holesky, Hoodi
  10, 11155420, 8453, 84532, 42161, 421614, // Optimism, Base, Arbitrum (+ 테스트넷)
  137, 80002, 56, 97, 43114, 100, 250, 324, 59144, 534352, // Polygon, BNB, Avalanche, Gnosis, Fantom, zkSync, Linea, Scroll
]);

/** TOKEN_DISCOVERY 값 확인. auto(기본) / on / off. 틀리면 던진다 — 시작할 때 바로 알게 */
export function parseDiscovery(value) {
  const v = (value ?? '').trim().toLowerCase() || 'auto';
  if (!['auto', 'on', 'off'].includes(v)) throw new Error(`TOKEN_DISCOVERY 는 auto / on / off 중 하나여야 한다: "${value}"`);
  return v;
}

/** 이 체인에서 자동 인식을 켤까. auto 는 공개 체인이 아니면 켠다 */
export const discoveryOn = (mode, chainId) => (mode === 'auto' ? !PUBLIC_CHAINS.has(Number(chainId)) : mode === 'on');

/** meta 표에 "여기까지 훑었다"를 적는 키 */
export const DISCOVERY_KEY = 'token_discovery_block';

/**
 * 한 구간을 훑어 처음 보는 ERC-20 을 등록한다.
 *
 * @param state { cursor: 마지막으로 훑은 블록(없으면 null), from: 처음 시작 블록, range, rejected }
 * @param limit 이번에 더 등록해도 되는 토큰 수. 넘치면 넣을 수 있는 만큼만 넣고 { full: true } (커서는 그대로)
 * @returns { progressed, found: [{ address, symbol, startBlock }], skipped, full, behind, retry }
 */
export async function discoverTokensOnce(rpc, store, state, { head, confirmations = 5, maxRange = 50_000, limit = Infinity, log = () => {} }) {
  const safeHead = BigInt(head) - BigInt(confirmations);
  const from = state.cursor != null ? BigInt(state.cursor) + 1n : BigInt(state.from ?? 0);
  if (from > safeHead) return { progressed: false, found: [], skipped: 0, behind: 0n };

  const got = await logsInRange(rpc, state, { topics: [TRANSFER_TOPIC] }, from, safeHead, { log, label: 'token discovery' });
  if (got.retry) return { progressed: false, found: [], skipped: 0, behind: safeHead - from + 1n, retry: true };
  const { logs, to } = got;

  // 컨트랙트마다 이 구간에서 처음 나온 블록
  const first = new Map();
  for (const l of logs) {
    if (!isErc20Transfer(l)) continue;
    const a = l.address.toLowerCase();
    const b = BigInt(l.blockNumber);
    if (!first.has(a) || b < first.get(a)) first.set(a, b);
  }
  state.rejected ??= new Set();
  const candidates = [];
  for (const a of first.keys()) {
    if (!state.rejected.has(a) && !(await store.getToken(a))) candidates.push(a);
  }

  const found = [];
  let skipped = 0;
  if (candidates.length) {
    const meta = await tokenMeta(rpc, candidates, { totalSupply: true });
    for (const a of candidates) {
      const { totalSupply, ...m } = meta.get(a);
      // Transfer 모양의 이벤트를 내지만 토큰이 아닌 컨트랙트도 있다. decimals·totalSupply 둘 다 대답이 없으면 뺀다
      if (m.decimals == null && totalSupply == null) {
        state.rejected.add(a);
        log(`token discovery: ${a} 는 Transfer 를 냈지만 decimals()·totalSupply() 가 없어 토큰으로 보지 않는다`);
        continue;
      }
      if (found.length >= limit) {
        skipped++;
        continue;
      }
      const startBlock = first.get(a).toString();
      await store.upsertToken({ address: a, ...m, startBlock });
      found.push({ address: a, symbol: m.symbol, startBlock });
    }
  }
  // 상한에 걸려 못 넣은 게 있으면 커서를 그대로 둔다. 상한을 올리고 다시 띄우면 이 구간부터 이어서 넣는다
  if (skipped > 0) return { progressed: false, found, skipped, full: true, behind: safeHead - from + 1n };
  // 등록을 마친 뒤에 커서를 옮긴다. 그 사이에 죽으면 같은 구간을 다시 훑을 뿐이다 (이미 등록된 건 건너뜀)
  await store.setMeta(DISCOVERY_KEY, to.toString());
  state.cursor = to.toString();
  widen(state, logs.length, maxRange);
  return { progressed: true, found, skipped, behind: safeHead - to };
}

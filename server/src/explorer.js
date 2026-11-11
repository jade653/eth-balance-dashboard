/**
 * explorer 의 "업무 로직" 층. HTTP 를 모른다.
 *
 *   app.js (HTTP 층)      : URL·메서드·상태코드·JSON 을 다룬다
 *   explorer.js (이 파일) : "tx 하나를 보여주려면 노드에 무엇을 물어야 하나"를 다룬다
 *   rpc.js (통신 층)      : 노드와 JSON-RPC 로 말하는 법만 안다
 *
 * 함수들은 찾으면 객체, 없으면 null 을 돌려준다. "없음 → 404" 로 바꾸는 건 HTTP 층의 일이다.
 *
 * 숫자 규칙: 노드는 0x 16진수로 주고, 우리는 10진수 "문자열"로 내보낸다.
 * wei·가스비는 JS Number 범위를 쉽게 넘으므로 숫자 타입으로 바꾸는 순간 값이 틀어진다.
 */
import { TRANSFER_TOPIC, tokenMeta } from './tokens.js';

export { decodeAbiString } from './tokens.js';

/** "0x1b4" → "436". null/undefined 는 그대로 null. */
const dec = (hex) => (hex == null ? null : BigInt(hex).toString());

/** unix 초(16진수) → ISO 시각 문자열 */
const isoTime = (hex) => new Date(Number(BigInt(hex)) * 1000).toISOString();

/** 32바이트 topic → 주소 (앞 12바이트는 0 패딩) */
const topicAddr = (topic) => '0x' + topic.slice(26).toLowerCase();

/**
 * receipt.logs 에서 ERC-20 토큰 이동을 뽑는다.
 *
 * 토큰 송금 tx 의 to 는 토큰 컨트랙트라, "누가 누구에게 토큰을 보냈나"는 이벤트 로그에만 있다.
 * Etherscan 의 "ERC-20 Tokens Transferred" 와 같은 방식이다. calldata 가 아니라 로그를 보므로
 * 라우터·멀티콜을 거친 이동도 잡히고, 실패한 tx(로그가 없다)는 자연히 빠진다.
 * ERC-721 도 같은 서명이지만 tokenId 까지 indexed 라 topic 이 4개다 → topic 3개 + data 32바이트만 ERC-20 으로 본다.
 */
export function erc20Transfers(logs) {
  return logs
    .filter((l) => l.topics?.length === 3 && l.topics[0]?.toLowerCase() === TRANSFER_TOPIC && /^0x[0-9a-fA-F]{64}$/.test(l.data ?? ''))
    .map((l) => ({
      token: l.address.toLowerCase(),
      from: topicAddr(l.topics[1]),
      to: topicAddr(l.topics[2]),
      amount: BigInt(l.data).toString(), // 소수점 적용 전 정수. decimals 로 나눠 보여주는 건 화면의 일
    }));
}

/**
 * EIP-7702 로 코드를 맡긴 개인 지갑은 코드 자리에 "0xef0100 + 위임 대상 주소"(23바이트)가 들어 있다.
 * 코드가 있다고 컨트랙트가 아니다 — Etherscan 도 이런 주소는 EOA 로 보고 "위임 대상"을 따로 적는다.
 */
const delegationOf = (code) => (typeof code === 'string' && /^0xef0100[0-9a-fA-F]{40}$/.test(code) ? '0x' + code.slice(8).toLowerCase() : null);
const isContractCode = (code) => typeof code === 'string' && code !== '0x' && !delegationOf(code);

/** 주소들 중 컨트랙트인 것. 조회에 실패한 주소는 모르는 것으로 보고 뺀다 */
export async function contractsAmong(rpc, addresses) {
  const list = [...new Set(addresses.filter(Boolean).map((a) => a.toLowerCase()))];
  const codes = await Promise.all(list.map((a) => rpc.call('eth_getCode', [a, 'latest']).catch(() => null)));
  return list.filter((_, i) => isContractCode(codes[i]));
}

/**
 * tx 해시로 조회.
 * 노드에 세 가지를 묻는다:
 *   eth_getTransactionByHash   — 누가 누구에게 얼마를 보냈나 (보내기 전에 정해진 것)
 *   eth_getTransactionReceipt  — 실행 결과: 성공/실패, 실제 쓴 가스, 이벤트 로그 (실행 후에 정해진 것)
 *   eth_getBlockByNumber       — 언제, 그 블록의 기본 수수료 (tx 자체에는 시각이 없고 블록에 있다)
 * 그리고 로그를 남긴 컨트랙트·to 가 토큰이면 이름·심볼·소수점을 묻는다 (화면의 "Tether USD (USDT)").
 */
export async function getTx(rpc, hash) {
  // 앞의 둘은 서로 의존하지 않으므로 HTTP 요청 한 번(batch)으로 묶는다
  const [tx, receipt] = await rpc.batch([
    { method: 'eth_getTransactionByHash', params: [hash] },
    { method: 'eth_getTransactionReceipt', params: [hash] },
  ]);
  if (!tx) return null;

  const common = {
    hash: tx.hash,
    from: tx.from,
    // to 가 null 이면 컨트랙트 "생성" tx 다. 생긴 컨트랙트 주소는 receipt 에 있다.
    to: tx.to,
    valueWei: dec(tx.value),
    nonce: dec(tx.nonce),
    gasLimit: dec(tx.gas),
    type: Number(BigInt(tx.type ?? '0x0')),
    // EIP-1559(type 2) 이후 tx 만 있는 값. 보낸 사람이 "최대 이만큼까지 내겠다"고 정한 상한이다.
    maxFeePerGasWei: dec(tx.maxFeePerGas),
    maxPriorityFeePerGasWei: dec(tx.maxPriorityFeePerGas),
    // input 이 0x 뿐이면 단순 송금, 아니면 컨트랙트 함수 호출
    input: tx.input,
    // EIP-7702(type 4): "내 주소의 코드를 이 컨트랙트(address)에 맡긴다"는 서명 목록
    authorizationList: Array.isArray(tx.authorizationList)
      ? tx.authorizationList.map((a) => ({ chainId: dec(a.chainId), address: a.address, nonce: dec(a.nonce) }))
      : null,
  };

  // 아직 블록에 안 들어간 tx (mempool 에 대기 중)
  if (!tx.blockNumber || !receipt) {
    return { ...common, status: 'pending', gasPriceWei: dec(tx.gasPrice) };
  }

  const transfers = erc20Transfers(receipt.logs);
  // 토큰 메타는 로그를 남긴 컨트랙트 + 호출한 컨트랙트(to) 에 대해 묻는다. 토큰이 아니면 전부 null 로 온다.
  const metaTargets = [...new Set([...receipt.logs.map((l) => l.address.toLowerCase()), ...(tx.to ? [tx.to.toLowerCase()] : [])])];
  const [block, meta, contracts] = await Promise.all([
    rpc.call('eth_getBlockByNumber', [tx.blockNumber, false]),
    tokenMeta(rpc, metaTargets),
    contractsAmong(rpc, [tx.from, tx.to, ...transfers.flatMap((x) => [x.from, x.to])]),
  ]);
  const gasUsed = BigInt(receipt.gasUsed);
  const gasPrice = BigInt(receipt.effectiveGasPrice ?? tx.gasPrice);
  const baseFee = block?.baseFeePerGas != null ? BigInt(block.baseFeePerGas) : null;

  // 이름이나 심볼이 있는 것만 "토큰"으로 내려준다 (화면의 주소 옆 이름표)
  const tokens = {};
  for (const [addr, m] of meta) if (m.name || m.symbol) tokens[addr] = m;

  return {
    ...common,
    status: receipt.status === '0x1' ? 'success' : 'failed',
    blockNumber: dec(tx.blockNumber),
    timestamp: block ? isoTime(block.timestamp) : null,
    contractCreated: receipt.contractAddress ?? null,
    feeWei: (gasUsed * gasPrice).toString(),
    gasUsed: gasUsed.toString(),
    gasPriceWei: gasPrice.toString(),
    // 블록의 기본 수수료. 가스당 이만큼은 소각(burn)되고, 나머지(gasPrice − baseFee)가 블록 생성자 몫이다
    baseFeePerGasWei: baseFee?.toString() ?? null,
    burntFeeWei: baseFee != null ? (baseFee * gasUsed).toString() : null,
    // 상한(maxFee)까지 낼 각오였는데 실제로는 gasPrice 만 냈다 → 아낀 금액 (Etherscan 의 Txn Savings)
    savingsFeeWei: tx.maxFeePerGas != null ? ((BigInt(tx.maxFeePerGas) - gasPrice) * gasUsed).toString() : null,
    position: dec(tx.transactionIndex),           // 블록 안에서 몇 번째 tx 인가
    blobGasUsed: dec(receipt.blobGasUsed),
    blobGasPriceWei: dec(receipt.blobGasPrice),
    logCount: receipt.logs.length,
    logs: receipt.logs.map((l) => ({
      address: l.address.toLowerCase(),
      topics: l.topics,
      data: l.data,
      logIndex: dec(l.logIndex),
    })),
    // 이 tx 에서 일어난 ERC-20 토큰 이동 (이벤트 로그 기준). 받는 사람은 to 가 아니라 여기에 있다.
    tokenTransfers: transfers.map((x) => ({ ...x, ...meta.get(x.token) })),
    tokens,
    contracts, // 화면이 주소 앞에 컨트랙트 표시를 붙이는 데 쓴다
  };
}

/**
 * 노드가 debug_* (트레이스) API 를 안 열어 둔 경우. 공개 RPC 는 대부분 막혀 있다.
 * 에러 모양이 노드마다 달라서 코드(-32601 = method not found)와 문구를 같이 본다.
 */
export function isUnsupported(err) {
  const e = err?.cause ?? err;
  return e?.rpcCode === -32601
    || /method .*(not (found|available|supported|exist))|does not exist|not supported|unsupported|not allowed|not whitelisted|forbidden/i.test(e?.message ?? '');
}

/**
 * 내부 트랜잭션 (Etherscan 의 Internal Txns): 컨트랙트가 실행 중에 다른 주소를 부른 기록.
 * 영수증·로그에는 없고 실행을 다시 돌려 봐야(trace) 나온다 → debug_traceTransaction + callTracer.
 * tx 가 없으면 null. 노드가 트레이스를 지원하지 않으면 던진다 (isUnsupported 로 구분).
 */
export async function getTrace(rpc, hash) {
  const root = await rpc.call('debug_traceTransaction', [hash, { tracer: 'callTracer' }]);
  if (!root) return null;
  const calls = [];
  const walk = (c, depth, path) => {
    if (depth > 0) {
      calls.push({
        type: c.type,
        from: c.from?.toLowerCase() ?? null,
        to: c.to?.toLowerCase() ?? null,
        valueWei: c.value ? BigInt(c.value).toString() : '0',
        gasLimit: dec(c.gas),
        gasUsed: dec(c.gasUsed),
        error: c.error ?? null,
        depth,
        path, // "0_1_2" — Etherscan 의 call_0_1_2 같은 호출 위치
      });
    }
    (c.calls ?? []).forEach((child, i) => walk(child, depth + 1, depth === 0 ? String(i) : `${path}_${i}`));
  };
  walk(root, 0, '');
  return { error: root.error ?? null, revertReason: root.revertReason ?? null, calls };
}

/**
 * 상태 변화 (Etherscan 의 State 탭): 이 tx 로 잔액·nonce·저장소가 어떻게 바뀌었나.
 * prestateTracer 의 diffMode 는 바뀐 주소만 "전(pre) / 후(post)" 로 준다. post 에 빠진 칸은 안 바뀐 것이다.
 */
export async function getStateDiff(rpc, hash) {
  const r = await rpc.call('debug_traceTransaction', [hash, { tracer: 'prestateTracer', tracerConfig: { diffMode: true } }]);
  if (!r) return null;
  const pre = r.pre ?? {};
  const post = r.post ?? {};
  const ZERO = '0x' + '0'.repeat(64);
  const addrs = [...new Set([...Object.keys(pre), ...Object.keys(post)])];
  return {
    items: addrs.map((a) => {
      const b = pre[a] ?? {};
      const p = post[a] ?? {};
      const slots = [...new Set([...Object.keys(b.storage ?? {}), ...Object.keys(p.storage ?? {})])];
      return {
        address: a.toLowerCase(),
        balanceBefore: dec(b.balance ?? '0x0'),
        balanceAfter: dec(p.balance ?? b.balance ?? '0x0'),
        nonceBefore: b.nonce ?? 0,
        nonceAfter: p.nonce ?? b.nonce ?? 0,
        storage: slots
          .map((k) => ({ slot: k, before: b.storage?.[k] ?? ZERO, after: p.storage?.[k] ?? ZERO }))
          .filter((s) => s.before !== s.after),
      };
    }),
  };
}

/**
 * 토큰 정보 (노드에 지금 묻는 값): 이름·심볼·소수점·총발행량.
 * 컨트랙트가 아니거나 totalSupply·decimals 둘 다 못 주면 ERC-20 이 아닌 것으로 보고 null.
 */
export async function getTokenInfo(rpc, address) {
  const a = address.toLowerCase();
  const [code, meta] = await Promise.all([rpc.call('eth_getCode', [a, 'latest']), tokenMeta(rpc, [a], { totalSupply: true })]);
  const m = meta.get(a);
  if (!isContractCode(code) || (m.totalSupply == null && m.decimals == null)) return null;
  return { address: a, ...m };
}

/**
 * 블록 조회. id 는 "latest" 또는 10진수 블록 번호 문자열.
 */
export async function getBlock(rpc, id) {
  const tag = id === 'latest' ? 'latest' : '0x' + BigInt(id).toString(16);
  // false = tx 본문 대신 해시 목록만. 본문까지 받으면 메인넷 블록 하나가 수백 KB 다.
  const b = await rpc.call('eth_getBlockByNumber', [tag, false]);
  if (!b) return null;

  return {
    number: dec(b.number),
    hash: b.hash,
    parentHash: b.parentHash,
    timestamp: isoTime(b.timestamp),
    miner: b.miner,
    gasUsed: dec(b.gasUsed),
    gasLimit: dec(b.gasLimit),
    baseFeePerGasWei: dec(b.baseFeePerGas),
    txCount: b.transactions.length,
    transactions: b.transactions,
  };
}

/**
 * 주소 조회. 잔액·nonce·컨트랙트 여부만 준다.
 *
 * "이 주소의 tx 목록"은 여기에 없다. JSON-RPC 에는 그런 메서드가 없기 때문이다.
 * 블록을 처음부터 훑어 DB 에 쌓아 두는 인덱서가 있어야 가능하다 → DB 단계에서 만든다.
 */
export async function getAddress(rpc, address) {
  const [balance, nonce, code] = await rpc.batch([
    { method: 'eth_getBalance', params: [address, 'latest'] },
    { method: 'eth_getTransactionCount', params: [address, 'latest'] },
    { method: 'eth_getCode', params: [address, 'latest'] },
  ]);
  return {
    address,
    balanceWei: dec(balance),
    // EOA(개인 지갑)는 보낸 tx 수. 컨트랙트는 자신이 만든 컨트랙트 수라 의미가 다르다.
    nonce: dec(nonce),
    // 코드가 있으면 컨트랙트, 없으면 개인 지갑(EOA). EIP-7702 로 코드를 맡긴 지갑도 EOA 다
    type: isContractCode(code) ? 'contract' : 'eoa',
    delegatedTo: delegationOf(code), // EIP-7702 위임 대상 (없으면 null)
  };
}

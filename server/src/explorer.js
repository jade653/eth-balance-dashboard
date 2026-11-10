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

/** "0x1b4" → "436". null/undefined 는 그대로 null. */
const dec = (hex) => (hex == null ? null : BigInt(hex).toString());

/** unix 초(16진수) → ISO 시각 문자열 */
const isoTime = (hex) => new Date(Number(BigInt(hex)) * 1000).toISOString();

/**
 * ERC-20 Transfer(address indexed from, address indexed to, uint256 value) 이벤트의 topic0
 * = keccak256("Transfer(address,address,uint256)").
 * ERC-721 도 같은 서명이지만 tokenId 까지 indexed 라 topic 이 4개다 → topic 3개 + data 32바이트만 ERC-20 으로 본다.
 */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** 32바이트 topic → 주소 (앞 12바이트는 0 패딩) */
const topicAddr = (topic) => '0x' + topic.slice(26).toLowerCase();

/**
 * receipt.logs 에서 ERC-20 토큰 이동을 뽑는다.
 *
 * 토큰 송금 tx 의 to 는 토큰 컨트랙트라, "누가 누구에게 토큰을 보냈나"는 이벤트 로그에만 있다.
 * Etherscan 의 "ERC-20 Tokens Transferred" 와 같은 방식이다. calldata 가 아니라 로그를 보므로
 * 라우터·멀티콜을 거친 이동도 잡히고, 실패한 tx(로그가 없다)는 자연히 빠진다.
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
 * ABI 로 인코딩된 string 반환값 → JS 문자열. 옛 토큰(MKR 등)은 string 대신 bytes32 를 돌려준다.
 * 해석할 수 없으면 null.
 */
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

/**
 * 토큰마다 symbol()·decimals() 를 묻는다. 표준을 안 지키는 토큰도 있어서 실패하면 null 로 둔다.
 * rpc.batch 는 하나만 실패해도 전체를 던지므로, 호출마다 따로 실패를 삼킨다.
 */
async function tokenMeta(rpc, tokens) {
  const ask = (to, data) => rpc.call('eth_call', [{ to, data }, 'latest']).catch(() => null);
  const entries = await Promise.all(tokens.map(async (token) => {
    const [sym, dec] = await Promise.all([ask(token, '0x95d89b41'), ask(token, '0x313ce567')]); // symbol(), decimals()
    let decimals = null;
    if (typeof dec === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(dec)) {
      const d = BigInt(dec);
      if (d <= 77n) decimals = Number(d); // uint256 최대 자릿수. 그보다 크면 엉터리 값
    }
    return [token, { symbol: decodeAbiString(sym), decimals }];
  }));
  return new Map(entries);
}

/**
 * tx 해시로 조회.
 * 노드에 세 가지를 묻는다:
 *   eth_getTransactionByHash   — 누가 누구에게 얼마를 보냈나 (보내기 전에 정해진 것)
 *   eth_getTransactionReceipt  — 실행 결과: 성공/실패, 실제 쓴 가스 (실행 후에 정해진 것)
 *   eth_getBlockByNumber       — 언제 (tx 자체에는 시각이 없고 블록에 있다)
 */
export async function getTx(rpc, hash) {
  // 앞의 둘은 서로 의존하지 않으므로 HTTP 요청 한 번(batch)으로 묶는다
  const [tx, receipt] = await rpc.batch([
    { method: 'eth_getTransactionByHash', params: [hash] },
    { method: 'eth_getTransactionReceipt', params: [hash] },
  ]);
  if (!tx) return null;

  // 아직 블록에 안 들어간 tx (mempool 에 대기 중)
  if (!tx.blockNumber || !receipt) {
    return {
      hash: tx.hash,
      status: 'pending',
      from: tx.from,
      to: tx.to,
      valueWei: dec(tx.value),
      nonce: dec(tx.nonce),
    };
  }

  const transfers = erc20Transfers(receipt.logs);
  const [block, meta] = await Promise.all([
    rpc.call('eth_getBlockByNumber', [tx.blockNumber, false]),
    tokenMeta(rpc, [...new Set(transfers.map((x) => x.token))]),
  ]);
  const gasUsed = BigInt(receipt.gasUsed);
  const gasPrice = BigInt(receipt.effectiveGasPrice ?? tx.gasPrice);

  return {
    hash: tx.hash,
    status: receipt.status === '0x1' ? 'success' : 'failed',
    blockNumber: dec(tx.blockNumber),
    timestamp: block ? isoTime(block.timestamp) : null,
    from: tx.from,
    // to 가 null 이면 컨트랙트 "생성" tx 다. 생긴 컨트랙트 주소는 receipt 에 있다.
    to: tx.to,
    contractCreated: receipt.contractAddress ?? null,
    valueWei: dec(tx.value),
    feeWei: (gasUsed * gasPrice).toString(),
    gasUsed: gasUsed.toString(),
    gasLimit: dec(tx.gas),
    gasPriceWei: gasPrice.toString(),
    nonce: dec(tx.nonce),
    position: dec(tx.transactionIndex),           // 블록 안에서 몇 번째 tx 인가
    type: Number(BigInt(tx.type ?? '0x0')),
    // EIP-1559(type 2) tx 만 있는 값. 보낸 사람이 "최대 이만큼까지 내겠다"고 정한 상한이다.
    maxFeePerGasWei: dec(tx.maxFeePerGas),
    maxPriorityFeePerGasWei: dec(tx.maxPriorityFeePerGas),
    // input 이 0x 뿐이면 단순 송금, 아니면 컨트랙트 함수 호출
    input: tx.input,
    logCount: receipt.logs.length,
    // 이 tx 에서 일어난 ERC-20 토큰 이동 (이벤트 로그 기준). 받는 사람은 to 가 아니라 여기에 있다.
    tokenTransfers: transfers.map((x) => ({ ...x, ...meta.get(x.token) })),
  };
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
    // 코드가 있으면 컨트랙트, 없으면 개인 지갑(EOA)
    type: code && code !== '0x' ? 'contract' : 'eoa',
  };
}

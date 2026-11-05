/**
 * 화면 표시용 순수 함수. DOM 을 건드리지 않는다.
 *
 * DOM 과 분리해 둔 이유: 브라우저 없이 Node 테스트(node --test)로 바로 검증할 수 있다.
 * CI 에서 브라우저를 띄우지 않고도 "숫자가 맞게 찍히는지"를 확인하는 방법이다.
 *
 * 체인 숫자는 전부 문자열/BigInt 로 다룬다. JS Number 는 2^53 까지만 정확해서
 * wei 같은 값은 조용히 뭉개진다 (예: 1234567890123456789 → 1234567890123456800).
 */

/** "23272543" → "23,272,543" */
export function formatInteger(decimalString) {
  if (!/^\d+$/.test(decimalString)) throw new TypeError(`정수 문자열이 아님: ${decimalString}`);
  return decimalString.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * wei(10진 문자열 또는 BigInt) → ETH 문자열. 소수점 아래 불필요한 0 은 지운다.
 * 반올림하지 않고 자른다 — 잔액을 실제보다 크게 보여주는 쪽으로 틀리면 안 된다.
 */
export function weiToEth(wei, maxFraction = 6) {
  const v = BigInt(wei);
  if (v < 0n) throw new RangeError('음수 wei');
  const WEI = 10n ** 18n;
  const whole = v / WEI;
  const frac = (v % WEI).toString().padStart(18, '0').slice(0, maxFraction).replace(/0+$/, '');
  return frac ? `${formatInteger(whole.toString())}.${frac}` : formatInteger(whole.toString());
}

/**
 * 검색창 입력이 무엇인지 판별해 이동할 화면 경로를 돌려준다. 모르면 null.
 *   0x + 64자리 → tx,  0x + 40자리 → 주소,  숫자 → 블록
 */
export function routeForQuery(raw) {
  const q = String(raw ?? '').trim().replace(/,/g, '');
  if (/^0x[0-9a-fA-F]{64}$/.test(q)) return `#/tx/${q}`;
  if (/^0x[0-9a-fA-F]{40}$/.test(q)) return `#/address/${q}`;
  if (/^\d+$/.test(q)) return `#/block/${BigInt(q).toString()}`;
  if (q.toLowerCase() === 'latest') return '#/block/latest';
  return null;
}

/** 0x1234…cdef 처럼 앞뒤만 남긴다. 해시·주소 공용. */
export function shortHex(hex, keep = 6) {
  if (typeof hex !== 'string' || !hex.startsWith('0x')) return String(hex);
  if (hex.length <= 2 + keep * 2) return hex;
  return `${hex.slice(0, 2 + keep)}…${hex.slice(-keep)}`;
}

/** 몇 초/분/시간/일 전. now 를 넘길 수 있게 해서 테스트에서 시각을 고정한다. */
export function timeAgo(iso, now = Date.now()) {
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 ${Math.floor((s % 3600) / 60)}분 전`;
  return `${Math.floor(s / 86400)}일 전`;
}

/**
 * 함수 선택자(input 앞 4바이트) → 사람이 읽는 이름.
 * 선택자는 함수 서명의 keccak256 앞 4바이트라 이름을 거꾸로 구할 수 없다. 그래서 explorer 들은
 * "자주 보이는 서명 사전"을 들고 있다. 여기는 그 아주 작은 판이다. 모르면 선택자를 그대로 보여준다.
 */
const METHODS = new Map([
  ['0xa9059cbb', 'Transfer'],          // transfer(address,uint256)            ERC-20
  ['0x23b872dd', 'Transfer From'],     // transferFrom(address,address,uint256)
  ['0x095ea7b3', 'Approve'],           // approve(address,uint256)
  ['0xd0e30db0', 'Deposit'],           // deposit()                             WETH
  ['0x2e1a7d4d', 'Withdraw'],          // withdraw(uint256)                     WETH
  ['0x3593564c', 'Execute'],           // execute(bytes,bytes[],uint256)        Uniswap Universal Router
  ['0x7ff36ab5', 'Swap Exact ETH For…'],
  ['0x38ed1739', 'Swap Exact Tokens…'],
  ['0x18cbafe5', 'Swap Exact Tokens For ETH'],
  ['0x414bf389', 'Exact Input Single'],
  ['0xac9650d8', 'Multicall'],         // multicall(bytes[])
  ['0x5ae401dc', 'Multicall'],         // multicall(uint256,bytes[])
]);

export function methodLabel(method) {
  if (method == null) return '-';           // 이 정보가 생기기 전에 쌓인 행
  if (method === '0x') return 'Transfer';   // input 이 비어 있음 = 순수 ETH 송금
  return METHODS.get(method.toLowerCase()) ?? method;
}

/** a/b 를 퍼센트 문자열로. "45.23%" */
export function percent(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!y) return '-';
  return `${((x / y) * 100).toFixed(2)}%`;
}

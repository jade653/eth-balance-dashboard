/**
 * 화면 표시용 순수 함수. DOM 을 건드리지 않는다.
 *
 * DOM 과 분리해 둔 이유: 브라우저 없이 Node 테스트(node --test)로 바로 검증할 수 있다.
 * CI 에서 브라우저를 띄우지 않고도 "숫자가 맞게 찍히는지"를 확인하는 방법이다.
 *
 * 체인 숫자는 전부 문자열/BigInt 로 다룬다. JS Number 는 2^53 까지만 정확해서
 * wei 같은 값은 조용히 뭉개진다 (예: 1234567890123456789 → 1234567890123456800).
 */
import { FUNCTIONS, EVENTS } from './signatures.js';

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
  return formatUnits(wei, 18, maxFraction);
}

/**
 * 소수점 없는 정수 금액 → decimals 자리에 소수점을 찍은 문자열. 토큰마다 decimals 가 다르다
 * (ETH·대부분 토큰 18, USDT·USDC 6, WBTC 8). weiToEth 와 같은 규칙: 자르고, 꼬리 0 을 지운다.
 */
export function formatUnits(raw, decimals, maxFraction = 6) {
  const v = BigInt(raw);
  if (v < 0n) throw new RangeError('음수 금액');
  const unit = 10n ** BigInt(decimals);
  const whole = v / unit;
  const frac = decimals === 0 ? '' : (v % unit).toString().padStart(decimals, '0').slice(0, maxFraction).replace(/0+$/, '');
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
 * 함수 선택자(input 앞 4바이트) → 사람이 읽는 이름 (Etherscan 의 Method 칸: "Transfer From").
 * 선택자는 함수 서명의 keccak256 앞 4바이트라 이름을 거꾸로 구할 수 없다. 그래서 explorer 들은
 * "자주 보이는 서명 사전"을 들고 있다 (signatures.js). 모르면 선택자를 그대로 보여준다.
 */
export function methodLabel(method) {
  if (method == null) return '-';           // 이 정보가 생기기 전에 쌓인 행
  if (method === '0x') return 'Transfer';   // input 이 비어 있음 = 순수 ETH 송금
  const f = FUNCTIONS[method.toLowerCase()];
  return f ? titleCase(f[0]) : method;
}

/** "swapExactETHForTokens" → "Swap Exact ETH For Tokens" */
export function titleCase(name) {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** a/b 를 퍼센트 문자열로. "45.23%" */
export function percent(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!y) return '-';
  return `${((x / y) * 100).toFixed(2)}%`;
}

/**
 * 가스 가격(wei) 표시. 보통은 Gwei(= 10^9 wei) 로 보여주지만,
 * Gwei 로 바꾸면 "0" 으로 보이는데 실제로는 0 보다 큰 값이면 wei 로 보여준다.
 * 예) 이더리움 base fee 2.5 Gwei → "2.5 Gwei",  PoA 체인 base fee 7 wei → "7 wei" (Gwei 면 "0 Gwei")
 */
export function formatGasPrice(wei) {
  const v = BigInt(wei);
  const g = weiToEth(v * 10n ** 9n, 4); // wei → Gwei, 소수 4자리
  if (g === '0' && v > 0n) return `${formatInteger(v.toString())} wei`;
  return `${g} Gwei`;
}

/* ── 금액 · 비율 · 시각 ──────────────────────────────────────────────────── */

/**
 * part / whole 을 퍼센트 문자열로 (BigInt 로 계산해 큰 정수도 정확하게). "16.6080%"
 * Etherscan 홀더 표처럼 소수 4자리. whole 이 0 이거나 없으면 '-'.
 */
export function sharePercent(part, whole, digits = 4) {
  if (whole == null || BigInt(whole) === 0n) return '-';
  const scale = 10n ** BigInt(digits);
  const v = (BigInt(part) * 100n * scale) / BigInt(whole);
  const s = v.toString().padStart(digits + 1, '0');
  return `${s.slice(0, -digits)}.${s.slice(-digits)}%`;
}

/** part / whole 을 0~1 실수로 (막대 길이용. 표시용 숫자는 sharePercent) */
export function ratio(part, whole) {
  if (whole == null || BigInt(whole) === 0n) return 0;
  return Number((BigInt(part) * 1_000_000n) / BigInt(whole)) / 1_000_000;
}

/** Etherscan 식 UTC 시각: "Jul-28-2026 11:01:47 AM +UTC" */
export function formatUtc(iso) {
  const d = new Date(iso);
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  const p = (n) => String(n).padStart(2, '0');
  const h = d.getUTCHours();
  return `${M}-${p(d.getUTCDate())}-${d.getUTCFullYear()} ${p(h % 12 || 12)}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${h < 12 ? 'AM' : 'PM'} +UTC`;
}

/**
 * 지니 계수 (0 = 모두 똑같이 가짐, 1 에 가까울수록 한 곳에 몰림).
 * 서버가 준 Σ(순위 × 잔액) 로 계산: G = (n+1)/n − 2·weighted/(n·total), 순위는 큰 잔액부터 1.
 */
export function giniFromSummary({ holders, totalHeld, weighted }) {
  const n = holders;
  if (!n || BigInt(totalHeld) === 0n) return null;
  const w = Number((BigInt(weighted) * 1_000_000_000n) / BigInt(totalHeld)) / 1e9; // weighted / total
  return Math.max(0, Math.min(1, (n + 1) / n - (2 * w) / n));
}

/**
 * 잔액 자릿수 분포 → "N 개 이상 가진 지갑 수" (Etherscan 의 Wallet Depth 를 토큰 수량 기준으로).
 * magnitudes = [{ magnitude: 원시 정수의 자릿수-1, count }], decimals 를 빼면 토큰 단위 자릿수.
 * 결과: [{ threshold: '1', count }, { threshold: '10', … }, …] 큰 쪽으로 갈수록 줄어드는 누적 수.
 */
export function walletDepth(magnitudes, decimals) {
  if (!magnitudes.length) return [];
  const byMag = new Map(magnitudes.map((m) => [m.magnitude - (decimals ?? 0), m.count]));
  const mags = [...byMag.keys()];
  const lo = Math.max(0, Math.min(...mags));
  const hi = Math.max(...mags);
  const out = [];
  for (let k = lo; k <= hi; k++) {
    let count = 0;
    for (const [m, c] of byMag) if (m >= k) count += c;
    out.push({ threshold: formatInteger((10n ** BigInt(k)).toString()), count });
  }
  return out;
}

/* ── ERC-20 전송 ─────────────────────────────────────────────────────────── */

/**
 * Etherscan 의 "Net Transfers": 주소·토큰마다 이 tx 에서 순수하게 얼마가 들고 났나.
 * 결과는 [{ address, token, amount(절대값), direction: 'sent'|'received' }], 0 인 것은 뺀다.
 * 처음 나온 순서를 지킨다 (화면이 tx 흐름 순서로 보이게).
 */
export function netTransfers(transfers) {
  const net = new Map();
  const bump = (addr, x, v) => {
    const key = `${addr}|${x.token}`;
    const cur = net.get(key) ?? { address: addr, token: x.token, sum: 0n, x };
    cur.sum += v;
    net.set(key, cur);
  };
  for (const x of transfers) {
    const v = BigInt(x.amount);
    bump(x.from, x, -v);
    bump(x.to, x, v);
  }
  return [...net.values()]
    .filter((n) => n.sum !== 0n)
    .map((n) => ({
      address: n.address, token: n.token, symbol: n.x.symbol, name: n.x.name, decimals: n.x.decimals,
      amount: (n.sum < 0n ? -n.sum : n.sum).toString(), direction: n.sum < 0n ? 'sent' : 'received',
    }));
}

/* ── ABI 디코딩 (입력 데이터 · 이벤트 로그) ──────────────────────────────── */

const word = (hex, i) => hex.slice(i * 64, i * 64 + 64);
const isDynamic = (t) => t === 'bytes' || t === 'string' || t.endsWith('[]');

/** 32바이트 한 칸(16진 64자) → 타입에 맞는 표시 문자열 */
function decodeStatic(type, w) {
  if (w.length !== 64) throw new Error('데이터가 짧다');
  if (type === 'address') return '0x' + w.slice(24);
  if (type === 'bool') return BigInt('0x' + w) === 0n ? 'false' : 'true';
  if (/^uint\d*$/.test(type)) return BigInt('0x' + w).toString();
  if (/^int\d*$/.test(type)) {
    const v = BigInt('0x' + w);
    return (v >= 1n << 255n ? v - (1n << 256n) : v).toString();
  }
  const b = /^bytes(\d+)$/.exec(type);
  if (b) return '0x' + w.slice(0, Number(b[1]) * 2);
  throw new Error(`지원하지 않는 타입 ${type}`);
}

/** 오프셋 위치의 동적 값 (bytes, string, T[]) */
function decodeDynamic(type, body, offsetBytes) {
  const at = offsetBytes * 2;
  const len = Number(BigInt('0x' + body.slice(at, at + 64)));
  const rest = body.slice(at + 64);
  if (type === 'bytes' || type === 'string') {
    const hex = rest.slice(0, len * 2);
    if (hex.length !== len * 2) throw new Error('길이 초과');
    return type === 'string' ? hexToUtf8(hex) ?? '0x' + hex : '0x' + hex;
  }
  const inner = type.slice(0, -2);
  if (isDynamic(inner)) throw new Error('중첩 동적 배열은 풀지 않는다');
  if (rest.length < len * 64) throw new Error('길이 초과');
  return Array.from({ length: len }, (_, i) => decodeStatic(inner, word(rest, i)));
}

/**
 * ABI 인코딩된 값들(16진, 0x 없이)을 타입 목록대로 푼다. 못 풀면 던진다.
 * 정적 타입 + bytes·string·정적 원소의 배열(T[])까지. 튜플은 풀지 않는다.
 */
export function decodeAbi(types, body) {
  if (body.length < types.length * 64) throw new Error('데이터가 짧다');
  return types.map((t, i) => {
    const w = word(body, i);
    return isDynamic(t) ? decodeDynamic(t, body, Number(BigInt('0x' + w))) : decodeStatic(t, w);
  });
}

/** 16진 → UTF-8 문자열. 깨진 바이트·제어 문자가 섞이면 null */
export function hexToUtf8(hex) {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length % 2) return null;
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(h.substr(i * 2, 2), 16);
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return /[\u0000-\u0008\u000e-\u001f]/.test(text) ? null : text;
  } catch {
    return null;
  }
}

/**
 * tx 입력 데이터 해석 (Etherscan 의 Input Data → Default View / Decode Input Data).
 *   selector  : 앞 4바이트
 *   signature : "transfer(address _to, uint256 _value)" — 사전에 없으면 null
 *   params    : [{ name, type, value }] — 디코딩에 실패하거나 튜플이면 null
 *   words     : 인자 영역을 32바이트씩 자른 16진 목록 ([0]: …, [1]: …)
 */
export function decodeInput(input) {
  if (typeof input !== 'string' || input.length < 10) return null;
  const selector = input.slice(0, 10).toLowerCase();
  const body = input.slice(10);
  const words = body.match(/.{1,64}/g) ?? [];
  const f = FUNCTIONS[selector];
  if (!f) return { selector, name: null, signature: null, params: null, words };
  const [name, args, display] = f;
  const signature = display ?? `${name}(${args.map(([t, n]) => (n ? `${t} ${n}` : t)).join(', ')})`;
  let params = null;
  if (args) {
    try {
      const values = decodeAbi(args.map(([t]) => t), body);
      params = args.map(([type, n], i) => ({ name: n, type, value: values[i] }));
    } catch { /* 사전의 서명과 데이터가 맞지 않음 → 원문만 */ }
  }
  return { selector, name, signature, params, words };
}

/**
 * 이벤트 로그 해석 (Etherscan Logs 탭의 Name / Topics / Data).
 *   signature : "Transfer (index_topic_1 address from, index_topic_2 address to, uint256 value)"
 *   topics    : [{ index, name, type, value }] (topic0 은 이벤트 서명 해시라 name 없음)
 *   data      : [{ name, type, value }] — 못 풀면 null (화면은 원문을 32바이트씩)
 * indexed 인자 수가 topic 수와 다르면 (예: ERC-721 Transfer) 이름을 붙이지 않는다.
 */
export function decodeLog(log) {
  const topics = log.topics ?? [];
  const body = (log.data ?? '0x').slice(2);
  const ev = topics[0] ? EVENTS[topics[0].toLowerCase()] : null;
  const indexed = ev ? ev[1].filter((p) => p[2]) : [];
  const fits = ev && indexed.length === topics.length - 1;
  const raw = {
    name: null,
    signature: null,
    topics: topics.map((t, i) => ({ index: i, name: null, type: null, value: t })),
    data: null,
    words: body.match(/.{1,64}/g) ?? [],
  };
  if (!fits) return raw;
  const [name, args] = ev;
  let k = 0;
  const signature = `${name} (${args.map(([t, n, ix]) => (ix ? `index_topic_${++k} ${t} ${n}` : `${t} ${n}`)).join(', ')})`;
  const decodedTopics = raw.topics.map((t, i) => {
    if (i === 0) return t;
    const [type, n] = indexed[i - 1];
    // 동적 타입(string 등)을 indexed 로 하면 값이 아니라 해시가 들어간다 → 원문 그대로
    const value = isDynamic(type) ? t.value : decodeStatic(type, t.value.slice(2).padStart(64, '0'));
    return { index: i, name: n, type, value };
  });
  const nonIndexed = args.filter((p) => !p[2]);
  let data = null;
  try {
    const values = decodeAbi(nonIndexed.map(([t]) => t), body);
    data = nonIndexed.map(([type, n], i) => ({ name: n, type, value: values[i] }));
  } catch { /* 원문만 */ }
  return { ...raw, name, signature, topics: decodedTopics, data };
}

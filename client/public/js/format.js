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

/** 0x1234…cdef 처럼 앞뒤만 남긴다. 해시·주소 공용. */
export function shortHex(hex, keep = 6) {
  if (typeof hex !== 'string' || !hex.startsWith('0x')) return String(hex);
  if (hex.length <= 2 + keep * 2) return hex;
  return `${hex.slice(0, 2 + keep)}…${hex.slice(-keep)}`;
}

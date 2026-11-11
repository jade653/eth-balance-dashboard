/**
 * 신뢰할 수 없는 입력이 통과해야 하는 첫 관문.
 *
 * legacy/validate.js 에서 가져왔다. explorer 는 주소 외에 tx 해시도 받으므로
 * isTxHash 를 더했다. (조회 범위 화이트리스트는 DB 를 붙일 때 다시 정한다)
 *
 * 형식 검사는 "보안"이기도 하다. 정규식을 통과한 값은 16진수 문자만 담고 있어
 * SQL·HTML·URL 어디에 들어가도 특수문자로 해석될 여지가 없다.
 */

// EIP-55 체크섬까지는 보지 않는다. 대소문자 혼용 주소를 그대로 받는다.
export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// tx 해시는 keccak256 결과 32바이트 = 16진수 64자리.
export const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

// 블록 번호: "latest" 또는 0 으로 시작하지 않는 10진수 (최대 15자리면 수천 년치다).
// 16진수(0x..)는 받지 않는다 — API 바깥에는 10진수만 보인다는 규칙을 지킨다.
export const BLOCK_ID_RE = /^(latest|0|[1-9]\d{0,14})$/;

export function isBlockId(v) {
  return typeof v === 'string' && BLOCK_ID_RE.test(v);
}

export function isAddress(v) {
  return typeof v === 'string' && ADDRESS_RE.test(v);
}

export function isTxHash(v) {
  return typeof v === 'string' && TX_HASH_RE.test(v);
}

// 목록 API 의 페이지 크기. 없으면 기본값(25), 1~max(100) 만 허용.
export function parseLimit(v, dflt = 25, max = 100) {
  if (v === null || v === undefined) return dflt;
  if (!/^\d{1,3}$/.test(v)) return null;
  const n = Number(v);
  return n >= 1 && n <= max ? n : null;
}

// 페이지 번호 (홀더 순위표). 없으면 1, 1 ~ 1,000,000 만 허용.
export function parsePage(v) {
  if (v === null || v === undefined) return 1;
  if (!/^[1-9]\d{0,6}$/.test(v)) return null;
  const n = Number(v);
  return n <= 1_000_000 ? n : null;
}

// 블록 안 tx 목록의 커서 = 블록 안 순서(tx_index) 하나. 틀리면 null.
export function parseIndexCursor(v) {
  return typeof v === 'string' && /^(0|[1-9]\d{0,5})$/.test(v) ? Number(v) : null;
}

// 페이지 커서 "<블록번호>-<블록 안 순서>" (응답의 nextCursor 를 그대로 돌려받는다). 틀리면 null.
export function parseCursor(v) {
  const m = typeof v === 'string' && /^(0|[1-9]\d{0,14})-(0|[1-9]\d{0,5})$/.exec(v);
  return m ? [m[1], Number(m[2])] : null;
}

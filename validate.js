'use strict';

/**
 * 신뢰할 수 없는 입력이 통과해야 하는 첫 관문.
 *
 * 이 대시보드에서 사용자 입력이 SQL 에 닿는 경로는 /api/history 의 쿼리스트링
 * 하나뿐이다. 여기서 걸러지면 SQL 근처에도 가지 못한다.
 * (2층은 storage.js 의 ? 바인딩, 3층은 조회 경로가 SELECT 만 한다는 점이다)
 */

// EIP-55 체크섬까지는 보지 않는다. config.json 도 대소문자를 섞어 쓰고,
// 여기서 필요한 건 "SQL 로 해석될 수 있는 문자가 하나도 없다"는 보장이다.
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function isAddress(v) {
  return typeof v === 'string' && ADDRESS_RE.test(v);
}

// 평범한 객체로 만들면 constructor / __proto__ / toString 같은 상속된 키가
// 값으로 튀어나온다. range=constructor 로 [Function: Object] 가 돌아왔었다.
// Map 은 그런 키가 애초에 없으므로 구조적으로 막힌다.
const RANGES = new Map([
  ['1h', 3600],
  ['24h', 86400],
  ['7d', 604800],
]);

// 검증이 아니라 치환이다. 목록에 있으면 '우리가 정한 숫자'를 돌려주고,
// 없으면 null 이다. 사용자가 보낸 문자열 자체는 어디로도 흘러가지 않는다.
function rangeSeconds(v) {
  if (typeof v !== 'string') return null;
  return RANGES.get(v) ?? null;
}

module.exports = { ADDRESS_RE, isAddress, rangeSeconds, RANGES };

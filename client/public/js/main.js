/**
 * 화면 진입점. 지금은 서버 연결 확인(health)만 한다.
 *
 * API 주소를 "/api/v1/..." 처럼 상대경로로 쓴다. 브라우저 입장에서 화면과 API 가
 * 같은 출처(origin)에 있다는 뜻이고, 실제로 /api 를 서버로 넘겨주는 건 앞단의
 * 리버스 프록시 몫이다 (개발 중에는 scripts/dev.js, 배포 후에는 nginx).
 * 그래서 CORS 설정이 필요 없고, 클라이언트 코드는 서버가 어디 있는지 모른다.
 */
import { formatInteger } from './format.js';

const el = {
  status: document.getElementById('status'),
  chain: document.getElementById('chain'),
  block: document.getElementById('block'),
};

async function refresh() {
  try {
    const res = await fetch('/api/v1/health', { cache: 'no-store' });
    const body = await res.json();
    if (!res.ok || !body.ok) throw new Error(body.error ?? `HTTP ${res.status}`);

    el.status.textContent = '연결됨';
    el.status.dataset.state = 'ok';
    el.chain.textContent = String(body.chainId);
    el.block.textContent = formatInteger(body.block);
  } catch (err) {
    el.status.textContent = `연결 실패 (${err.message})`;
    el.status.dataset.state = 'error';
  }
}

refresh();
setInterval(refresh, 12_000); // 이더리움 블록 간격

/**
 * HTTP 요청 → 응답 을 결정하는 부분만 담는다. 포트를 열지 않는다.
 *
 * 왜 index.js 와 나눴나:
 *   createApp 은 rpc 를 "주입"받는다. 테스트에서는 가짜 rpc 를 넣어
 *   메인넷에 접속하지 않고도 라우팅·응답 형식을 검증할 수 있다.
 *   CI 가 외부 RPC 상태에 따라 깨졌다 붙었다 하면 아무도 CI 를 믿지 않게 된다.
 *
 * 프레임워크(Express/Fastify)는 아직 쓰지 않는다. REST API 를 설계하는
 * 단계에서 라우트가 늘어나면 그때 고른다.
 */

/** JSON 응답 공통 함수. 모든 API 응답은 이걸 거친다. */
function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(json);
}

/**
 * @param {{ rpc: { call(method: string, params?: unknown[]): Promise<any> } }} deps
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createApp({ rpc }) {
  return async function handler(req, res) {
    // Host 헤더를 믿지 않는다. 경로만 필요하므로 고정된 base 로 파싱한다.
    const url = new URL(req.url, 'http://localhost');

    try {
      if (url.pathname === '/api/v1/health') {
        if (req.method !== 'GET') {
          res.setHeader('allow', 'GET');
          return sendJson(res, 405, { error: 'method_not_allowed' });
        }
        return await health(res, rpc);
      }

      return sendJson(res, 404, { error: 'not_found' });
    } catch (err) {
      // 내부 에러 메시지에는 RPC URL(=API 키)이 섞일 수 있으므로 밖으로 내보내지 않는다.
      console.error(`[${req.method} ${url.pathname}]`, err);
      return sendJson(res, 500, { error: 'internal_error' });
    }
  };
}

/**
 * 서버가 살아 있고 RPC 까지 닿는지. 로드밸런서·CD 의 헬스체크가 볼 곳이다.
 * RPC 가 죽어 있으면 서버 프로세스가 살아 있어도 503 이다 — 쓸모 있는 응답을 못 주니까.
 */
async function health(res, rpc) {
  try {
    const [chainIdHex, blockHex] = await Promise.all([
      rpc.call('eth_chainId'),
      rpc.call('eth_blockNumber'),
    ]);
    return sendJson(res, 200, {
      ok: true,
      chainId: Number(BigInt(chainIdHex)),
      // 블록 번호는 문자열로 준다. 지금은 Number 범위 안이지만, 체인 데이터를
      // JS Number 로 다루는 습관 자체를 만들지 않기 위해서다 (wei 가 대표적).
      block: BigInt(blockHex).toString(),
    });
  } catch {
    return sendJson(res, 503, { ok: false, error: 'rpc_unavailable' });
  }
}

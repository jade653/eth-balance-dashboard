/**
 * HTTP 층. "어떤 URL 이 오면 무엇을 부르고, 결과를 어떤 상태코드로 돌려주나"만 다룬다.
 * 노드에 무엇을 물을지는 explorer.js 가 안다. 포트를 여는 건 index.js 다.
 *
 * REST 규칙 (이 API 전체에 적용)
 *   - URL 은 "자원(명사)"을 가리킨다: /txs/{hash}, /blocks/{number}, /addresses/{address}
 *     동사(getTx, search …)는 URL 에 넣지 않는다. 동작은 HTTP 메서드(GET)가 말한다.
 *   - 상태코드가 결과를 말한다:
 *       200 찾음 · 400 형식이 틀림 · 404 형식은 맞는데 없음
 *       405 경로는 있는데 메서드가 틀림 · 503 노드(RPC)나 DB 에 못 닿음 · 500 우리 버그
 *   - 에러 본문은 항상 { "error": "<코드>" } 한 가지 모양이다. 클라이언트가 분기하기 쉽다.
 *   - /v1 : 응답 모양을 깨는 변경이 필요해지면 /v2 를 새로 열고 v1 은 남겨 둔다.
 */
import { getTx, getBlock, getAddress } from './explorer.js';
import { isTxHash, isBlockId, isAddress, parseLimit, parseCursor, parseIndexCursor } from './validate.js';

/** 경로 → 처리 함수 표. 새 API 는 여기에 한 줄 추가하는 것으로 끝난다. */
const routes = [
  {
    method: 'GET',
    path: /^\/api\/v1\/health$/,
    handle: ({ rpc, store }) => health(rpc, store),
  },
  {
    // 홈 화면 통계 (DB). 24시간 tx 수, 평균 블록 시간 등
    method: 'GET',
    path: /^\/api\/v1\/stats$/,
    handle: async ({ store }) => {
      const [stats, coverage] = await Promise.all([store.stats(), store.coverage()]);
      return [200, { ...stats, coverage }];
    },
  },
  {
    // 최신 블록 목록 (DB). 컬렉션 자원: /blocks  ↔  단건 자원: /blocks/{number}
    method: 'GET',
    path: /^\/api\/v1\/blocks$/,
    handle: async ({ store }, _, query) => {
      const limit = parseLimit(query.get('limit'), 10, 25);
      if (limit === null) return [400, { error: 'invalid_limit' }];
      return [200, { items: await store.latestBlocks(limit) }];
    },
  },
  {
    // 최신 tx 목록 (DB)
    method: 'GET',
    path: /^\/api\/v1\/txs$/,
    handle: async ({ store }, _, query) => {
      const limit = parseLimit(query.get('limit'), 10, 25);
      if (limit === null) return [400, { error: 'invalid_limit' }];
      return [200, { items: await store.latestTxs(limit) }];
    },
  },
  {
    // 블록 안의 tx 목록 (DB). 보관 범위 밖 블록이면 items 가 비고 coverage 로 범위를 알려 준다.
    method: 'GET',
    path: /^\/api\/v1\/blocks\/([^/]+)\/txs$/,
    handle: async ({ store }, [id], query) => {
      if (!isBlockId(id) || id === 'latest') return [400, { error: 'invalid_block_id' }];
      const limit = parseLimit(query.get('limit'));
      if (limit === null) return [400, { error: 'invalid_limit' }];
      let before;
      if (query.has('cursor')) {
        before = parseIndexCursor(query.get('cursor'));
        if (before === null) return [400, { error: 'invalid_cursor' }];
      }
      const [page, coverage] = await Promise.all([store.listBlockTxs(id, { limit, before }), store.coverage()]);
      return [200, { blockNumber: id, ...page, coverage }];
    },
  },
  {
    method: 'GET',
    path: /^\/api\/v1\/txs\/([^/]+)$/,
    handle: ({ rpc }, [hash]) => {
      if (!isTxHash(hash)) return [400, { error: 'invalid_tx_hash' }];
      return found(getTx(rpc, hash));
    },
  },
  {
    method: 'GET',
    path: /^\/api\/v1\/blocks\/([^/]+)$/,
    handle: ({ rpc }, [id]) => {
      if (!isBlockId(id)) return [400, { error: 'invalid_block_id' }];
      return found(getBlock(rpc, id));
    },
  },
  {
    method: 'GET',
    path: /^\/api\/v1\/addresses\/([^/]+)$/,
    handle: ({ rpc }, [address]) => {
      if (!isAddress(address)) return [400, { error: 'invalid_address' }];
      return found(getAddress(rpc, address));
    },
  },
  {
    // 주소의 tx 목록. 노드가 아니라 DB(인덱서가 쌓은 것)에서 읽는다.
    // 하위 자원: "주소 X 의 tx 들" → /addresses/X/txs
    // 페이지: ?limit=25&cursor=<응답의 nextCursor>
    method: 'GET',
    path: /^\/api\/v1\/addresses\/([^/]+)\/txs$/,
    handle: async ({ store }, [address], query) => {
      if (!isAddress(address)) return [400, { error: 'invalid_address' }];
      const limit = parseLimit(query.get('limit'));
      if (limit === null) return [400, { error: 'invalid_limit' }];
      const cursor = query.has('cursor') ? parseCursor(query.get('cursor')) : undefined;
      if (cursor === null) return [400, { error: 'invalid_cursor' }];

      const [page, coverage] = await Promise.all([
        store.listAddressTxs(address, { limit, before: cursor }),
        store.coverage(),
      ]);
      // coverage: "DB 에 이 범위만 있다". 목록이 비어 있어도 '없음'이 아니라 '이 기간엔 없음'이다.
      return [200, { address, ...page, coverage }];
    },
  },
];

/** explorer 함수의 결과가 null 이면 404, 아니면 200 */
async function found(promise) {
  const data = await promise;
  return data === null ? [404, { error: 'not_found' }] : [200, data];
}

async function health(rpc, store) {
  const [chainIdHex, blockHex] = await rpc.batch([
    { method: 'eth_chainId' },
    { method: 'eth_blockNumber' },
  ]);
  const block = BigInt(blockHex);
  // 인덱서 상태는 덤이다. DB 가 죽어 있어도 health 자체(=RPC 조회 가능)는 성공으로 둔다.
  const coverage = await store.coverage().catch(() => null);
  return [200, {
    ok: true,
    chainId: Number(BigInt(chainIdHex)),
    block: block.toString(),
    indexer: coverage && { ...coverage, lag: (block - BigInt(coverage.toBlock)).toString() },
  }];
}

/**
 * "바깥(노드·DB)이 실패한 것"과 "우리 코드가 틀린 것"을 구분하기 위한 표시.
 * 앞의 것은 503(잠시 후 다시), 뒤의 것은 500(고쳐야 함)이다.
 * rpc·store 를 한 겹 감싸서, 거기서 나온 에러에만 표시(code)를 붙인다.
 */
class UpstreamError extends Error {
  constructor(code, cause) {
    super(cause.message, { cause });
    this.code = code;
  }
}

/** obj 의 모든 함수를 감싸서, 실패하면 UpstreamError(code) 로 바꿔 던지게 한다 */
function markUpstream(obj, code) {
  return Object.fromEntries(
    Object.entries(obj)
      .filter(([, fn]) => typeof fn === 'function')
      .map(([name, fn]) => [
        name,
        (...args) => fn.apply(obj, args).catch((err) => { throw new UpstreamError(code, err); }),
      ]),
  );
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

/**
 * @param deps.rpc   { call, batch }               — 이더리움 노드
 * @param deps.store createStore() 의 결과 (DB)     — 테스트에서는 둘 다 가짜를 넣는다
 */
export function createApp({ rpc, store }) {
  const ctx = {
    rpc: markUpstream({ call: rpc.call.bind(rpc), batch: rpc.batch.bind(rpc) }, 'rpc_unavailable'),
    store: markUpstream(store, 'db_unavailable'),
  };

  return async function handler(req, res) {
    // Host 헤더를 믿지 않는다. 경로만 필요하므로 고정된 base 로 파싱한다.
    const url = new URL(req.url, 'http://localhost');

    const matches = routes
      .map((r) => ({ route: r, m: url.pathname.match(r.path) }))
      .filter((x) => x.m);

    if (matches.length === 0) return sendJson(res, 404, { error: 'not_found' });

    const hit = matches.find((x) => x.route.method === req.method);
    if (!hit) {
      res.setHeader('allow', [...new Set(matches.map((x) => x.route.method))].join(', '));
      return sendJson(res, 405, { error: 'method_not_allowed' });
    }

    try {
      const params = hit.m.slice(1).map(decodeURIComponent);
      const [status, body] = await hit.route.handle(ctx, params, url.searchParams);
      return sendJson(res, status, body);
    } catch (err) {
      if (err instanceof UpstreamError) {
        // 원문에는 RPC URL(=API 키)이 섞일 수 있으므로 로그에만 남긴다
        console.error(`[${err.code} ${url.pathname}]`, err.message);
        return sendJson(res, 503, { error: err.code });
      }
      if (err instanceof URIError) return sendJson(res, 400, { error: 'bad_request' });
      console.error(`[${req.method} ${url.pathname}]`, err);
      return sendJson(res, 500, { error: 'internal_error' });
    }
  };
}

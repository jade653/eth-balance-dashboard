
/**
 * 최소한의 이더리움 JSON-RPC 클라이언트.
 * ethers/viem 같은 라이브러리를 쓰지 않는 이유는, 노드와 실제로 오가는
 * 요청/응답 형태를 그대로 보기 위해서다.
 *
 * 요청 형태 (batch):
 *   [{ "jsonrpc":"2.0", "id":1, "method":"eth_getBalance",
 *      "params":["0xabc...", "0x1234ff"] }, ...]
 * 응답 형태:
 *   [{ "jsonrpc":"2.0", "id":1, "result":"0x1bc16d674ec80000" }, ...]
 *   (id 순서는 보장되지 않으므로 반드시 id로 다시 정렬해야 한다)
 *
 * 엔드포인트를 여러 개 주면 네트워크/HTTP 오류 시 다음 것으로 넘어간다.
 * 에러 메시지에 URL을 넣지 않는다 — URL에는 보통 API 키가 들어 있고,
 * 이 메시지는 로그와 대시보드 화면까지 흘러간다.
 */
class RpcClient {
  constructor(urls, { timeoutMs = 10_000, batchRetryMs = 10 * 60_000 } = {}) {
    this.urls = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
    if (this.urls.length === 0) throw new Error('RPC URL이 하나 이상 필요하다');
    this.active = 0;               // 현재 쓰고 있는 엔드포인트
    this.timeoutMs = timeoutMs;
    this.batchRetryMs = batchRetryMs;
    this.nextId = 0;
    this.batchDisabledAt = null;   // 배치를 거부당한 시각. 영구히 포기하지 않고 batchRetryMs 뒤에 다시 시도한다
    this.stats = { requests: 0, errors: 0, failovers: 0, lastLatencyMs: null };
  }

  get url() { return this.urls[this.active]; }

  get batchSupported() {
    return this.batchDisabledAt === null || Date.now() - this.batchDisabledAt > this.batchRetryMs;
  }

  #failover() {
    if (this.urls.length < 2) return;
    this.active = (this.active + 1) % this.urls.length;
    this.stats.failovers += 1;
  }

  /**
   * 네트워크/HTTP 오류는 다음 엔드포인트로 넘어가며 재시도한다.
   * 엔드포인트가 하나뿐이면 같은 곳에 한 번 더 시도한다 (일시적 오류 대비).
   */
  async #post(body) {
    const attempts = Math.max(2, this.urls.length);
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        return await this.#postOnce(body);
      } catch (err) {
        lastErr = err;
        this.#failover();
      }
    }
    throw lastErr;
  }

  async #postOnce(body) {
    const started = Date.now();
    this.stats.requests += 1;
    let res;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      this.stats.errors += 1;
      throw new Error(`RPC 연결 실패: ${err.name === 'TimeoutError' ? 'timeout' : err.message}`);
    }
    this.stats.lastLatencyMs = Date.now() - started;
    if (!res.ok) {
      this.stats.errors += 1;
      const e = new Error(`RPC HTTP ${res.status} ${res.statusText}`);
      e.status = res.status;
      throw e;
    }
    return res.json();
  }

  /** 단일 호출. result를 그대로 돌려준다. */
  async call(method, params = []) {
    const id = ++this.nextId;
    const json = await this.#post({ jsonrpc: '2.0', id, method, params });
    if (json.error) throw rpcError(method, json.error);
    return json.result;
  }

  /**
   * 여러 호출을 한 번의 HTTP 요청으로 묶는다.
   * calls = [{ method, params }, ...]  ->  [result, ...] (입력 순서 유지)
   */
  async batch(calls) {
    if (calls.length === 0) return [];
    if (!this.batchSupported) return this.#sequential(calls);

    const payload = calls.map((c) => ({
      jsonrpc: '2.0',
      id: ++this.nextId,
      method: c.method,
      params: c.params ?? [],
    }));

    let json;
    try {
      json = await this.#post(payload);
    } catch (err) {
      // 4xx(429 제외)는 "배치 요청 자체를 안 받는다"는 뜻일 가능성이 높으니 순차 호출로 물러선다.
      // 네트워크 오류·5xx·429는 배치 지원 여부와 무관하므로 그대로 던진다 — 예전엔 타임아웃
      // 한 번에도 배치를 영구 비활성화해서, 이후 블록마다 N+1번 요청하는 문제가 있었다.
      if (err.status >= 400 && err.status < 500 && err.status !== 429) {
        this.batchDisabledAt = Date.now();
        return this.#sequential(calls);
      }
      throw err;
    }

    if (!Array.isArray(json)) {
      this.batchDisabledAt = Date.now();
      return this.#sequential(calls);
    }
    this.batchDisabledAt = null;

    const byId = new Map(json.map((r) => [r.id, r]));
    return payload.map((req, i) => {
      const r = byId.get(req.id);
      if (!r) throw new Error(`${calls[i].method}: 배치 응답 누락 (id=${req.id})`);
      if (r.error) throw rpcError(calls[i].method, r.error);
      return r.result;
    });
  }

  async #sequential(calls) {
    const out = [];
    for (const c of calls) out.push(await this.call(c.method, c.params));
    return out;
  }
}

/** 노드가 돌려준 JSON-RPC 에러. code 를 남겨 둬야 "메서드 없음(-32601)" 같은 걸 구분할 수 있다 */
function rpcError(method, error) {
  const e = new Error(`${method}: ${error.message}`);
  e.rpcCode = error.code;
  return e;
}

export { RpcClient };

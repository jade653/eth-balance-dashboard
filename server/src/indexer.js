/**
 * 인덱서 한 바퀴: "DB 에 마지막으로 넣은 블록 다음부터, 노드의 최신 블록까지" 몇 개씩 채운다.
 * HTTP 도, 무한 루프도, 타이머도 없다 — 그건 worker.js 가 한다. 그래서 테스트하기 쉽다.
 *
 * 노드는 "이 주소의 tx 목록"을 주지 않는다. 그래서 블록을 하나씩 받아 tx 를 DB 에 옮겨 적고,
 * 주소로 찾는 건 DB 의 색인이 한다. 이게 explorer 들(Etherscan 등)이 하는 일의 축소판이다.
 */

const hex = (n) => '0x' + n.toString(16);

/**
 * DB 의 데이터가 지금 RPC 가 가리키는 체인의 것인지 확인한다.
 *
 *   'empty'    DB 가 비어 있음 → 이 체인으로 새로 시작 (chain_id 를 기록)
 *   'ok'       같은 체인
 *   'mismatch' 다른 체인의 데이터가 들어 있음 → 그대로 두면 인덱서가 멈춘다
 *
 * chain_id 를 적어 두기 전(003 마이그레이션 이전)에 쌓인 데이터는 기록이 없다.
 * 그때는 DB 의 마지막 블록과 같은 번호의 블록을 RPC 에 물어 해시가 같은지로 판단한다.
 * (번호가 같아도 체인이 다르면 해시가 다르고, 새 체인에 그 번호가 아직 없으면 null 이다)
 */
export async function checkChain(rpc, store) {
  const chainId = String(Number(BigInt(await rpc.call('eth_chainId'))));
  const latest = await store.latestBlock();
  const saved = await store.getMeta('chain_id');

  if (!latest) {
    await store.setMeta('chain_id', chainId);
    return { status: 'empty', chainId };
  }
  if (saved) {
    return saved === chainId ? { status: 'ok', chainId } : { status: 'mismatch', chainId, saved };
  }
  const b = await rpc.call('eth_getBlockByNumber', [hex(BigInt(latest.number)), false]);
  if (b && b.hash === latest.hash) {
    await store.setMeta('chain_id', chainId);
    return { status: 'ok', chainId };
  }
  return { status: 'mismatch', chainId, saved: '(기록 없음 — 블록 해시가 다름)' };
}

/**
 * 체인의 평균 블록 간격(초)을 잰다. 최신 블록과 sample 개 전 블록의 시각 차이 / sample.
 * "24시간 = 몇 블록인가"는 체인마다 다르다 (이더리움 12초, PoA 체인은 보통 1~5초).
 */
export async function measureBlockTime(rpc, sample = 1000) {
  const head = BigInt(await rpc.call('eth_blockNumber'));
  const n = head > BigInt(sample) ? BigInt(sample) : head;
  if (n === 0n) return null;
  const [a, b] = await rpc.batch([
    { method: 'eth_getBlockByNumber', params: [hex(head - n), false] },
    { method: 'eth_getBlockByNumber', params: [hex(head), false] },
  ]);
  if (!a || !b) return null;
  const secs = Number(BigInt(b.timestamp) - BigInt(a.timestamp)) / Number(n);
  return secs > 0 ? secs : null;
}

/**
 * @param rpc   { call, batch }
 * @param store createStore() 의 결과
 * @param opts  retentionBlocks: 보관할 블록 수 (처음 시작 지점을 정한다)
 *              batchSize:       한 번의 HTTP 요청에 묶어 받을 블록 수
 * @returns { head, indexed, reorg }
 */
export async function syncOnce(rpc, store, { retentionBlocks, batchSize = 5, log = () => {} }) {
  const head = BigInt(await rpc.call('eth_blockNumber'));
  // 보관 범위의 시작. 이보다 오래된 블록은 받을 필요가 없다.
  const floor = head - BigInt(retentionBlocks) + 1n;

  let last = await store.latestBlock();
  let next = last ? BigInt(last.number) + 1n : floor;

  // 처음 켰거나, 보관 기간보다 오래 꺼져 있었으면 → 범위 시작점으로 건너뛴다.
  // 사이에 빈 구간이 생기므로 parent 검사(아래)는 건너뛴 직후 한 번은 하지 않는다.
  if (next < floor) {
    log(`gap: ${next} → ${floor} 로 건너뜀 (보관 범위 밖)`);
    next = floor;
    last = null;
  }
  if (next > head) return { head, indexed: 0, reorg: false };

  const end = next + BigInt(batchSize) - 1n < head ? next + BigInt(batchSize) - 1n : head;
  const numbers = [];
  for (let n = next; n <= end; n++) numbers.push(n);

  // true = tx 본문까지 포함해서 받는다
  const blocks = await rpc.batch(numbers.map((n) => ({ method: 'eth_getBlockByNumber', params: [hex(n), true] })));

  let indexed = 0;
  for (const b of blocks) {
    if (!b) break; // 노드가 아직 그 블록을 모름 (로드밸런싱된 RPC 에서 가끔 생긴다)

    // 리오그 감지: 새 블록의 "부모"가 내가 저장한 직전 블록이 아니면, 체인이 갈라졌던 것이다.
    // 내 마지막 블록을 지우고 돌아간다. 다음 바퀴에 그 자리의 새 블록을 다시 받는다.
    // 여러 블록이 바뀐 경우 이걸 반복하며 한 칸씩 되감는다.
    if (last && b.parentHash !== last.hash) {
      log(`reorg: 블록 ${BigInt(b.number)} 의 부모가 저장된 ${last.number} 와 다름 → ${last.number} 되감기`);
      await store.deleteFrom(last.number);
      return { head, indexed, reorg: true };
    }

    await store.insertBlock(b);
    last = { number: BigInt(b.number).toString(), hash: b.hash };
    indexed++;
  }
  return { head, indexed, reorg: false };
}

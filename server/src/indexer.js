/**
 * 인덱서 한 바퀴: "DB 에 마지막으로 넣은 블록 다음부터, 노드의 최신 블록까지" 몇 개씩 채운다.
 * HTTP 도, 무한 루프도, 타이머도 없다 — 그건 worker.js 가 한다. 그래서 테스트하기 쉽다.
 *
 * 노드는 "이 주소의 tx 목록"을 주지 않는다. 그래서 블록을 하나씩 받아 tx 를 DB 에 옮겨 적고,
 * 주소로 찾는 건 DB 의 색인이 한다. 이게 explorer 들(Etherscan 등)이 하는 일의 축소판이다.
 */

const hex = (n) => '0x' + n.toString(16);

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

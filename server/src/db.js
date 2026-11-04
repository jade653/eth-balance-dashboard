/**
 * Postgres 접근은 전부 여기를 거친다. SQL 이 코드 여기저기 흩어지지 않게.
 *
 *   createPool  — 연결 풀. 요청마다 새로 접속하지 않고 미리 열어 둔 연결을 돌려 쓴다.
 *   migrate     — migrations/*.sql 을 아직 안 적용된 것만 순서대로 적용한다.
 *   createStore — 인덱서(쓰기)와 API(읽기)가 쓰는 함수 모음.
 *
 * 모든 값은 $1, $2 … 자리표시자로 넘긴다. SQL 문자열에 사용자 입력을 이어 붙이지 않는다.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * 인스턴스 하나당 연결 수 상한. api 를 3개 띄우면 3배가 된다는 점을 기억할 것 —
 * Postgres 기본 최대 연결 수는 100 이다. "인스턴스를 늘리면 DB 연결도 늘어난다."
 */
export function createPool(connectionString, { max = 5 } = {}) {
  const pool = new pg.Pool({ connectionString, max, connectionTimeoutMillis: 3000 });
  // 쉬고 있던 연결이 끊겼을 때(DB 재시작 등). 처리하지 않으면 프로세스가 죽는다.
  pool.on('error', (err) => console.error('[pg] idle client error:', err.message));
  return pool;
}

/**
 * 스키마 변경 이력 관리.
 * schema_migrations 에 "어디까지 적용했나"를 적어 두고, 새 파일만 적용한다.
 * advisory lock: 혹시 두 프로세스가 동시에 돌려도 한 번에 하나만 적용하게 하는 DB 차원의 자물쇠.
 */
export async function migrate(pool, log = console.log) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(7601)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      // 파일 하나를 통째로 트랜잭션으로. 중간에 실패하면 반쯤 바뀐 스키마가 남지 않는다.
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log(`migration applied: ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${err.message}`, { cause: err });
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(7601)').catch(() => {});
    client.release();
  }
}

const iso = (d) => (d ? d.toISOString() : null);

export function createStore(pool) {
  return {
    /** 가장 최근에 저장한 블록. 없으면 null */
    async latestBlock() {
      const { rows } = await pool.query('SELECT number, hash FROM blocks ORDER BY number DESC LIMIT 1');
      return rows[0] ?? null;
    },

    /**
     * 블록 하나와 그 안의 tx 전부를 "한 덩어리로" 저장한다 (트랜잭션).
     * 중간에 죽어도 "블록은 있는데 tx 가 반만 있는" 상태가 생기지 않는다.
     * ON CONFLICT DO NOTHING: 같은 블록을 두 번 넣어도 결과가 같다 (재시작에 안전).
     */
    async insertBlock(b) {
      const ts = new Date(Number(BigInt(b.timestamp)) * 1000);
      const txs = b.transactions;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO blocks (number, hash, parent_hash, ts, tx_count)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
          [BigInt(b.number).toString(), b.hash, b.parentHash, ts, txs.length],
        );
        if (txs.length > 0) {
          // tx 수백 개를 INSERT 한 번으로: 열마다 배열을 넘기고 unnest 로 행으로 편다
          await client.query(
            `INSERT INTO txs (hash, block_number, tx_index, from_addr, to_addr, value_wei, ts)
             SELECT h, $2, i, f, t, v, $3
               FROM unnest($1::text[], $4::int[], $5::text[], $6::text[], $7::numeric[]) AS x(h, i, f, t, v)
             ON CONFLICT DO NOTHING`,
            [
              txs.map((t) => t.hash),
              BigInt(b.number).toString(),
              ts,
              txs.map((t) => Number(BigInt(t.transactionIndex))),
              txs.map((t) => t.from.toLowerCase()),
              txs.map((t) => t.to?.toLowerCase() ?? null),
              txs.map((t) => BigInt(t.value).toString()),
            ],
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    /** 리오그 되감기: number 이상 블록을 지운다 (tx 는 CASCADE 로 같이 지워짐) */
    async deleteFrom(number) {
      const r = await pool.query('DELETE FROM blocks WHERE number >= $1', [String(number)]);
      return r.rowCount;
    },

    /** 롤링 보관: hours 시간보다 오래된 블록을 지운다 */
    async prune(hours) {
      // make_interval(hours => …) 는 정수만 받는다. 0.5시간 같은 값도 되도록 초 단위(실수)로 넘긴다.
      const r = await pool.query('DELETE FROM blocks WHERE ts < now() - make_interval(secs => $1)', [hours * 3600]);
      return r.rowCount;
    },

    /** 지금 DB 에 들어 있는 범위. 비어 있으면 null */
    async coverage() {
      const { rows } = await pool.query(
        'SELECT min(number) AS from_block, max(number) AS to_block, min(ts) AS from_time, max(ts) AS to_time FROM blocks',
      );
      const r = rows[0];
      if (!r.to_block) return null;
      return { fromBlock: r.from_block, toBlock: r.to_block, fromTime: iso(r.from_time), toTime: iso(r.to_time) };
    },

    /**
     * 주소의 tx 목록 (최신순, 페이지 단위).
     *
     * 왜 OR 가 아니라 두 쿼리를 합치나:
     *   WHERE from_addr = $1 OR to_addr = $1 로 쓰면 USDT 컨트랙트처럼 하루 수십만 건 받는 주소에서
     *   전부 모은 뒤 정렬하게 된다. 보낸 쪽 색인·받은 쪽 색인에서 각각 "최신 N건"만 꺼내 합치면
     *   주소가 아무리 바빠도 2N 건만 본다.
     *
     * 페이지 넘기기는 offset 이 아니라 "커서"(마지막으로 본 블록·순서) 기준이다.
     *   offset 1000 은 앞의 1000건을 매번 세어 버리고, 그 사이 새 tx 가 들어오면 목록이 밀린다.
     */
    async listAddressTxs(address, { limit, before }) {
      const addr = address.toLowerCase();
      // before 가 없으면 "아주 큰 값"에서 시작 = 최신부터
      const [bBlock, bIndex] = before ?? ['9223372036854775807', 2147483647];
      const { rows } = await pool.query(
        `SELECT hash, block_number, tx_index, from_addr, to_addr, value_wei, ts FROM (
           (SELECT * FROM txs WHERE from_addr = $1 AND (block_number, tx_index) < ($2, $3)
             ORDER BY block_number DESC, tx_index DESC LIMIT $4)
           UNION ALL
           (SELECT * FROM txs WHERE to_addr = $1 AND from_addr <> $1 AND (block_number, tx_index) < ($2, $3)
             ORDER BY block_number DESC, tx_index DESC LIMIT $4)
         ) x
         ORDER BY block_number DESC, tx_index DESC LIMIT $4`,
        [addr, bBlock, bIndex, limit + 1], // 하나 더 가져와서 "다음 페이지가 있나"를 안다
      );
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map((r) => ({
          hash: r.hash,
          blockNumber: r.block_number,
          txIndex: r.tx_index,
          timestamp: iso(r.ts),
          from: r.from_addr,
          to: r.to_addr,
          valueWei: r.value_wei,
          direction: r.from_addr === addr ? (r.to_addr === addr ? 'self' : 'out') : 'in',
        })),
        nextCursor: rows.length > limit ? `${last.block_number}-${last.tx_index}` : null,
      };
    },
  };
}

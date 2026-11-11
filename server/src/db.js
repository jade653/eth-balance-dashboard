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
const dec = (hex) => (hex == null ? null : BigInt(hex).toString());

/** input 의 앞 4바이트 = 호출한 함수의 선택자. 단순 송금(0x)이면 '0x' */
const methodOf = (input) => (typeof input === 'string' && input.length >= 10 ? input.slice(0, 10).toLowerCase() : '0x');

/** txs 행 → API 응답 모양. addr 를 주면 그 주소 기준 방향(in/out/self)을 붙인다 */
function txRow(r, addr) {
  const item = {
    hash: r.hash,
    blockNumber: r.block_number,
    txIndex: r.tx_index,
    timestamp: iso(r.ts),
    from: r.from_addr,
    to: r.to_addr,
    valueWei: r.value_wei,
    method: r.method, // 이 칸이 생기기 전(002 이전)에 쌓인 행은 null
  };
  if (addr) item.direction = r.from_addr === addr ? (r.to_addr === addr ? 'self' : 'out') : 'in';
  return item;
}

const TX_COLS = 'hash, block_number, tx_index, from_addr, to_addr, value_wei, ts, method';

export function createStore(pool) {
  return {
    /** meta 표의 값 하나. 없으면 null */
    async getMeta(key) {
      const { rows } = await pool.query('SELECT value FROM meta WHERE key = $1', [key]);
      return rows[0]?.value ?? null;
    },

    async setMeta(key, value) {
      await pool.query(
        'INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
        [key, String(value)],
      );
    },

    /** 인덱서 데이터를 전부 지운다 (체인을 바꿀 때). meta 도 비운다 */
    async resetAll() {
      await pool.query('TRUNCATE blocks CASCADE');
      await pool.query('TRUNCATE tokens CASCADE');
      await pool.query('DELETE FROM meta');
    },

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
          `INSERT INTO blocks (number, hash, parent_hash, ts, tx_count, miner, gas_used, gas_limit, base_fee)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
          [
            BigInt(b.number).toString(), b.hash, b.parentHash, ts, txs.length,
            b.miner?.toLowerCase() ?? null, dec(b.gasUsed), dec(b.gasLimit), dec(b.baseFeePerGas),
          ],
        );
        if (txs.length > 0) {
          // tx 수백 개를 INSERT 한 번으로: 열마다 배열을 넘기고 unnest 로 행으로 편다
          await client.query(
            `INSERT INTO txs (hash, block_number, tx_index, from_addr, to_addr, value_wei, ts, method)
             SELECT h, $2, i, f, t, v, $3, m
               FROM unnest($1::text[], $4::int[], $5::text[], $6::text[], $7::numeric[], $8::text[]) AS x(h, i, f, t, v, m)
             ON CONFLICT DO NOTHING`,
            [
              txs.map((t) => t.hash),
              BigInt(b.number).toString(),
              ts,
              txs.map((t) => Number(BigInt(t.transactionIndex))),
              txs.map((t) => t.from.toLowerCase()),
              txs.map((t) => t.to?.toLowerCase() ?? null),
              txs.map((t) => BigInt(t.value).toString()),
              txs.map((t) => methodOf(t.input)),
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
        `SELECT ${TX_COLS} FROM (
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
        items: page.map((r) => txRow(r, addr)),
        nextCursor: rows.length > limit ? `${last.block_number}-${last.tx_index}` : null,
      };
    },

    /** 최신 블록 N개 (홈 화면 "최신 블록") */
    async latestBlocks(limit) {
      const { rows } = await pool.query(
        `SELECT number, hash, ts, tx_count, miner, gas_used, gas_limit, base_fee
           FROM blocks ORDER BY number DESC LIMIT $1`,
        [limit],
      );
      return rows.map((r) => ({
        number: r.number,
        hash: r.hash,
        timestamp: iso(r.ts),
        txCount: r.tx_count,
        miner: r.miner,
        gasUsed: r.gas_used,
        gasLimit: r.gas_limit,
        baseFeePerGasWei: r.base_fee,
      }));
    },

    /** 최신 tx N개 (홈 화면 "최신 트랜잭션"). txs_block 색인을 앞에서부터 N개만 읽는다 */
    async latestTxs(limit) {
      const { rows } = await pool.query(
        `SELECT ${TX_COLS} FROM txs ORDER BY block_number DESC, tx_index DESC LIMIT $1`,
        [limit],
      );
      return rows.map((r) => txRow(r));
    },

    /** 블록 안의 tx (블록 화면의 표). 보관 범위 밖 블록이면 빈 목록 */
    async listBlockTxs(number, { limit, before }) {
      const bIndex = before ?? 2147483647;
      const { rows } = await pool.query(
        `SELECT ${TX_COLS} FROM txs WHERE block_number = $1 AND tx_index < $2
          ORDER BY tx_index DESC LIMIT $3`,
        [String(number), bIndex, limit + 1],
      );
      const page = rows.slice(0, limit);
      return {
        items: page.map((r) => txRow(r)),
        nextCursor: rows.length > limit ? String(page.at(-1).tx_index) : null,
      };
    },

    /**
     * 홈 화면 통계. 전부 blocks 표(하루 약 7,200행)만 본다 — txs 표(하루 약 150만 행)를
     * count(*) 하면 요청마다 느려지므로, 블록마다 미리 적어 둔 tx_count 를 더한다.
     */
    async stats() {
      const { rows } = await pool.query(
        `SELECT
           (SELECT coalesce(sum(tx_count), 0) FROM blocks WHERE ts > now() - interval '24 hours') AS txs_24h,
           (SELECT count(*) FROM blocks WHERE ts > now() - interval '24 hours') AS blocks_24h,
           (SELECT extract(epoch FROM max(ts) - min(ts)) / nullif(count(*) - 1, 0)
              FROM (SELECT ts FROM blocks ORDER BY number DESC LIMIT 100) t) AS avg_block_time`,
      );
      const r = rows[0];
      return {
        txs24h: String(r.txs_24h),
        blocks24h: String(r.blocks_24h),
        avgBlockTimeSec: r.avg_block_time == null ? null : Number(Number(r.avg_block_time).toFixed(1)),
      };
    },

    /* ── 토큰 (홀더 추적) ─────────────────────────────────────────────── */

    /**
     * 추적할 토큰을 등록한다. 이미 있으면 이름·심볼·소수점만 새로 고친다 —
     * 어디까지 모았나(synced_block)와 시작 블록은 건드리지 않는다 (재시작해도 이어서 모은다).
     */
    async upsertToken({ address, name, symbol, decimals, startBlock }) {
      await pool.query(
        `INSERT INTO tokens (address, name, symbol, decimals, start_block) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (address) DO UPDATE SET name = EXCLUDED.name, symbol = EXCLUDED.symbol, decimals = EXCLUDED.decimals`,
        [address.toLowerCase(), name, symbol, decimals, String(startBlock)],
      );
    },

    async listTokens() {
      const { rows } = await pool.query(`SELECT ${TOKEN_COLS} FROM tokens ORDER BY holder_count DESC, address`);
      return rows.map(tokenRow);
    },

    /** 추적 중인 토큰 하나. 추적 대상이 아니면 null */
    async getToken(address) {
      const { rows } = await pool.query(`SELECT ${TOKEN_COLS} FROM tokens WHERE address = $1`, [address.toLowerCase()]);
      return rows[0] ? tokenRow(rows[0]) : null;
    },

    /**
     * 블록 구간 하나의 Transfer 들을 반영한다. 전송 기록 · 잔액 · "여기까지 모았다"를 한 트랜잭션으로.
     * 중간에 죽으면 셋 다 없던 일이 되므로, 같은 구간을 다시 넣어도 잔액이 두 번 더해지지 않는다.
     *
     * 잔액은 SQL 에서 더하지 않고 JS(BigInt)에서 계산해 절대값으로 쓴다. 그래야 "0 → 양수"(새 홀더),
     * "양수 → 0"(떠난 홀더)을 알 수 있어 holder_count 를 count(*) 없이 맞게 유지한다.
     * 이 표에 쓰는 건 worker 하나뿐이라 읽고-계산하고-쓰는 사이에 끼어들 쓰기가 없다.
     *
     * 0x000…0 은 잔액을 세지 않는다: 발행(from=0)·소각(to=0)의 상대편일 뿐 실제 보유자가 아니다.
     */
    async applyTokenTransfers(token, transfers, toBlock) {
      const t = token.toLowerCase();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        let holderDelta = 0;
        if (transfers.length > 0) {
          await client.query(
            `INSERT INTO token_transfers (token, block_number, log_index, tx_hash, tx_index, from_addr, to_addr, amount, ts, method)
             SELECT $1, b, l, h, i, f, o, a, s, m
               FROM unnest($2::bigint[], $3::int[], $4::text[], $5::int[], $6::text[], $7::text[], $8::numeric[], $9::timestamptz[], $10::text[])
                 AS x(b, l, h, i, f, o, a, s, m)
             ON CONFLICT DO NOTHING`,
            [
              t,
              transfers.map((x) => x.blockNumber),
              transfers.map((x) => x.logIndex),
              transfers.map((x) => x.txHash),
              transfers.map((x) => x.txIndex),
              transfers.map((x) => x.from),
              transfers.map((x) => x.to),
              transfers.map((x) => x.amount),
              transfers.map((x) => x.timestamp ?? null),
              transfers.map((x) => x.method ?? null),
            ],
          );

          const delta = new Map();
          const add = (addr, v) => { if (addr !== ZERO_ADDR) delta.set(addr, (delta.get(addr) ?? 0n) + v); };
          for (const x of transfers) {
            const v = BigInt(x.amount);
            add(x.from, -v);
            add(x.to, v);
          }
          const holders = [...delta.keys()];
          const { rows } = await client.query(
            'SELECT holder, balance FROM token_balances WHERE token = $1 AND holder = ANY($2::text[])',
            [t, holders],
          );
          const old = new Map(rows.map((r) => [r.holder, BigInt(r.balance)]));

          const upHolders = [];
          const upBalances = [];
          const gone = [];
          for (const [h, d] of delta) {
            if (d === 0n) continue;
            const before = old.get(h) ?? 0n;
            const after = before + d;
            holderDelta += (after > 0n ? 1 : 0) - (before > 0n ? 1 : 0);
            if (after === 0n) gone.push(h);
            else { upHolders.push(h); upBalances.push(after.toString()); }
          }
          if (upHolders.length) {
            await client.query(
              `INSERT INTO token_balances (token, holder, balance)
               SELECT $1, h, b FROM unnest($2::text[], $3::numeric[]) AS x(h, b)
               ON CONFLICT (token, holder) DO UPDATE SET balance = EXCLUDED.balance`,
              [t, upHolders, upBalances],
            );
          }
          if (gone.length) {
            await client.query('DELETE FROM token_balances WHERE token = $1 AND holder = ANY($2::text[])', [t, gone]);
          }
        }
        await client.query(
          `UPDATE tokens SET synced_block = $2, holder_count = holder_count + $3,
                  transfer_count = transfer_count + $4, updated_at = now()
            WHERE address = $1`,
          [t, String(toBlock), holderDelta, transfers.length],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    /** 홀더 순위 (잔액 큰 순). offset 페이지 — Etherscan 처럼 "N 페이지 중 M" 으로 넘긴다 */
    async tokenHolders(token, { limit, offset }) {
      const { rows } = await pool.query(
        `SELECT holder, balance FROM token_balances WHERE token = $1 AND balance > 0
          ORDER BY balance DESC, holder LIMIT $2 OFFSET $3`,
        [token.toLowerCase(), limit, offset],
      );
      return rows.map((r, i) => ({ rank: offset + i + 1, address: r.holder, balance: r.balance }));
    },

    /** 전체 홀더 (CSV 내려받기용) */
    async allTokenHolders(token) {
      const { rows } = await pool.query(
        'SELECT holder, balance FROM token_balances WHERE token = $1 AND balance > 0 ORDER BY balance DESC, holder',
        [token.toLowerCase()],
      );
      return rows.map((r, i) => ({ rank: i + 1, address: r.holder, balance: r.balance }));
    },

    /**
     * 홀더 분포 요약 (Etherscan 의 Holders Overview).
     *   top5 … top100 : 상위 N 명이 가진 합
     *   weighted      : Σ(순위 × 잔액). 지니 계수 = (n+1)/n − 2·weighted/(n·total)  (순위는 큰 쪽부터 1)
     *   magnitudes    : 잔액 자릿수(10^k) 별 주소 수. 화면이 decimals 를 빼서 "N 개 이상 가진 지갑 수"를 만든다
     */
    async tokenHolderSummary(token) {
      const t = token.toLowerCase();
      const [{ rows: [s] }, { rows: mags }] = await Promise.all([
        pool.query(
          `WITH r AS (
             SELECT balance, row_number() OVER (ORDER BY balance DESC, holder) AS rn
               FROM token_balances WHERE token = $1 AND balance > 0)
           SELECT count(*) AS n, coalesce(sum(balance), 0) AS total,
                  coalesce(sum(balance) FILTER (WHERE rn <= 5), 0)   AS top5,
                  coalesce(sum(balance) FILTER (WHERE rn <= 10), 0)  AS top10,
                  coalesce(sum(balance) FILTER (WHERE rn <= 25), 0)  AS top25,
                  coalesce(sum(balance) FILTER (WHERE rn <= 50), 0)  AS top50,
                  coalesce(sum(balance) FILTER (WHERE rn <= 100), 0) AS top100,
                  coalesce(sum(rn * balance), 0) AS weighted,
                  (SELECT count(*) FROM r WHERE balance * 100 >= (SELECT sum(balance) FROM r)) AS over1pct
             FROM r`,
          [t],
        ),
        pool.query(
          `SELECT floor(log(balance))::int AS mag, count(*) AS n
             FROM token_balances WHERE token = $1 AND balance > 0 GROUP BY 1 ORDER BY 1`,
          [t],
        ),
      ]);
      const str = (v) => BigInt(String(v).split('.')[0]).toString(); // numeric 합계 → 정수 문자열
      return {
        holders: Number(s.n),
        totalHeld: str(s.total),
        top5: str(s.top5), top10: str(s.top10), top25: str(s.top25), top50: str(s.top50), top100: str(s.top100),
        weighted: str(s.weighted),
        over1pct: Number(s.over1pct), // 전체 보유량의 1% 이상을 가진 주소 수
        magnitudes: mags.map((m) => ({ magnitude: m.mag, count: Number(m.n) })),
      };
    },

    /** 한 주소가 한 토큰을 얼마나 갖고 있나 (토큰 페이지의 "홀더로 거르기") */
    async tokenBalanceOf(token, holder) {
      const { rows } = await pool.query(
        'SELECT balance FROM token_balances WHERE token = $1 AND holder = $2',
        [token.toLowerCase(), holder.toLowerCase()],
      );
      return rows[0]?.balance ?? '0';
    },

    /**
     * 토큰 전송 목록 (최신순, 커서 = "블록-로그순서").
     *   token  만 주면: 그 토큰의 전체 전송
     *   holder 만 주면: 그 주소가 보내거나 받은, 추적 중인 모든 토큰의 전송 (주소 페이지)
     *   둘 다 주면    : 그 토큰에서 그 주소의 전송 (토큰 페이지의 홀더 거르기)
     */
    async listTokenTransfers({ token, holder, limit, before }) {
      const t = token?.toLowerCase() ?? null;
      const h = holder?.toLowerCase() ?? null;
      const [bBlock, bIndex] = before ?? ['9223372036854775807', 2147483647];
      const cols = `x.token, x.block_number, x.log_index, x.tx_hash, x.from_addr, x.to_addr, x.amount, x.ts, x.method,
                    k.name, k.symbol, k.decimals`;
      const page = 'ORDER BY block_number DESC, log_index DESC LIMIT $5';
      const sql = h
        ? `SELECT ${cols} FROM (
             (SELECT * FROM token_transfers WHERE from_addr = $2 AND ($1::text IS NULL OR token = $1)
                AND (block_number, log_index) < ($3, $4) ${page})
             UNION ALL
             (SELECT * FROM token_transfers WHERE to_addr = $2 AND from_addr <> $2 AND ($1::text IS NULL OR token = $1)
                AND (block_number, log_index) < ($3, $4) ${page})
           ) x JOIN tokens k ON k.address = x.token
           ORDER BY x.block_number DESC, x.log_index DESC LIMIT $5`
        : `SELECT ${cols} FROM token_transfers x JOIN tokens k ON k.address = x.token
            WHERE x.token = $1 AND $2::text IS NULL AND (x.block_number, x.log_index) < ($3, $4)
            ORDER BY x.block_number DESC, x.log_index DESC LIMIT $5`;
      const { rows } = await pool.query(sql, [t, h, bBlock, bIndex, limit + 1]);
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return {
        items: items.map((r) => {
          const item = {
            token: r.token,
            tokenName: r.name,
            tokenSymbol: r.symbol,
            tokenDecimals: r.decimals,
            txHash: r.tx_hash,
            blockNumber: r.block_number,
            logIndex: r.log_index,
            timestamp: iso(r.ts),
            from: r.from_addr,
            to: r.to_addr,
            amount: r.amount,
            method: r.method,
          };
          if (h) item.direction = r.from_addr === h ? (r.to_addr === h ? 'self' : 'out') : 'in';
          return item;
        }),
        nextCursor: rows.length > limit ? `${last.block_number}-${last.log_index}` : null,
      };
    },

    /** 주소가 가진 (추적 중인) 토큰들. 주소 페이지의 "토큰 보유" */
    async addressTokenBalances(address) {
      const { rows } = await pool.query(
        `SELECT k.address, k.name, k.symbol, k.decimals, b.balance
           FROM token_balances b JOIN tokens k ON k.address = b.token
          WHERE b.holder = $1 AND b.balance > 0 ORDER BY k.symbol, k.address`,
        [address.toLowerCase()],
      );
      return rows.map((r) => ({ token: r.address, name: r.name, symbol: r.symbol, decimals: r.decimals, balance: r.balance }));
    },
  };
}

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

const TOKEN_COLS = 'address, name, symbol, decimals, start_block, synced_block, holder_count, transfer_count, updated_at';

function tokenRow(r) {
  return {
    address: r.address,
    name: r.name,
    symbol: r.symbol,
    decimals: r.decimals,
    startBlock: r.start_block,
    syncedBlock: r.synced_block,
    holders: r.holder_count,
    transfers: String(r.transfer_count),
    updatedAt: iso(r.updated_at),
  };
}

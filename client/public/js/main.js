/**
 * 화면 진입점. 블록 탐색기의 표준 레이아웃을 따른다.
 *
 *   #/                 홈: 검색 배너 · 통계 · 최신 블록 · 최신 트랜잭션
 *   #/blocks           최신 블록 목록          #/block/{번호}     블록 상세 + 블록 안 tx
 *   #/txs              최신 트랜잭션 목록      #/tx/{해시}        트랜잭션 상세
 *   #/address/{주소}   주소: 잔액 · 정보 · tx 목록
 *
 * 화면 전환은 URL 의 # 뒤로 한다. 서버(nginx)는 언제나 index.html 하나만 주면 된다.
 * 체인에서 온 값은 전부 textContent 로만 넣는다 (innerHTML 금지 → XSS 차단).
 */
import { formatInteger, weiToEth, shortHex, routeForQuery, timeAgo, methodLabel, percent } from './format.js';

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');

/* ── DOM 도우미 ─────────────────────────────────────────────────────────── */

/** 문자열 자식은 텍스트 노드가 된다 (HTML 로 해석되지 않는다) */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

/** 정적인 SVG 아이콘 (코드에 박힌 문자열만 쓴다 — 체인 데이터는 절대 여기로 오지 않는다) */
function icon(path) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', path);
  p.setAttribute('fill', 'currentColor');
  svg.append(p);
  return svg;
}
const ICON = {
  cube: 'M12 2 3 7v10l9 5 9-5V7l-9-5Zm0 2.3L18.6 8 12 11.7 5.4 8 12 4.3ZM5 9.7l6 3.4v6.6l-6-3.4V9.7Zm8 10v-6.6l6-3.4v6.6l-6 3.4Z',
  swap: 'M7 7h11l-3-3 1.4-1.4L21.8 8l-5.4 5.4L15 12l3-3H7V7Zm10 10H6l3 3-1.4 1.4L2.2 16l5.4-5.4L9 12l-3 3h11v2Z',
  gas: 'M5 3h8v8h1a2 2 0 0 1 2 2v3a1 1 0 0 0 2 0V9.4l-2-2L17.4 6l2.6 2.6V16a3 3 0 0 1-6 0v-3h-1v8H5V3Zm2 2v4h4V5H7Z',
  clock: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm1 3v5.4l3.6 2.1-1 1.7L11 13.6V7h2Z',
  copy: 'M8 3h11v13h-2V5H8V3ZM5 7h10v14H5V7Zm2 2v10h6V9H7Z',
  check: 'm9.5 16.2-4.2-4.2-1.4 1.4 5.6 5.6L21 7.5 19.6 6l-10.1 10.2Z',
  left: 'M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12l4.6-4.6Z',
  right: 'M8.6 16.6 10 18l6-6-6-6-1.4 1.4 4.6 4.6-4.6 4.6Z',
};

const link = (href, text, cls) => h('a', { href, class: cls }, text);
const addrLink = (a, keep = 8) => (a ? link(`#/address/${a}`, shortHex(a, keep), 'mono') : h('span', { class: 'muted' }, '—'));
const blockLink = (n) => link(`#/block/${n}`, formatInteger(String(n)));
const eth = (wei, digits = 18) => `${weiToEth(wei, digits)} ETH`;
const gwei = (wei) => `${weiToEth(BigInt(wei) * 10n ** 9n, 4)} Gwei`; // wei → gwei
/** 실시간으로 줄어드는 "N초 전". data-ts 를 달아 두면 아래 타이머가 매초 다시 쓴다 */
const age = (iso) => h('span', { class: 'age', 'data-ts': iso, title: localTime(iso) }, timeAgo(iso));
const localTime = (iso) => new Date(iso).toLocaleString('ko-KR', { hour12: false, timeZoneName: 'short' });
const hint = (text) => h('span', { class: 'hint', title: text, 'aria-label': text }, '?');

function copyBtn(text) {
  const b = h('button', { type: 'button', class: 'copy', title: '복사', 'aria-label': '복사' }, icon(ICON.copy));
  b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      b.replaceChildren(icon(ICON.check));
      b.classList.add('done');
      setTimeout(() => { b.replaceChildren(icon(ICON.copy)); b.classList.remove('done'); }, 1200);
    } catch { /* 클립보드 권한이 없으면 조용히 무시 */ }
  });
  return b;
}

/** 탐색기식 "왼쪽 라벨 | 오른쪽 값" 표. rows 의 'hr' 은 구분선, 값이 undefined 인 행은 건너뛴다 */
function overview(rows) {
  const dl = h('dl', { class: 'kv' });
  for (const r of rows) {
    if (r === 'hr') { dl.append(h('hr')); continue; }
    const [label, tip, value] = r;
    if (value === undefined) continue;
    dl.append(h('div', { class: 'kv-row' }, h('dt', {}, hint(tip), label), h('dd', {}, value)));
  }
  return dl;
}

const card = (header, ...body) => h('section', { class: 'card' }, header && h('div', { class: 'card-header' }, header), ...body);
const pageTitle = (title, ...rest) => h('div', { class: 'page-title' }, h('h1', {}, title), ...rest);
const page = (...children) => h('div', { class: 'container page' }, ...children);

/* ── API ───────────────────────────────────────────────────────────────── */

class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}

async function api(path) {
  const res = await fetch(`/api/v1${path}`, { cache: 'no-store' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? `http_${res.status}`);
  return body;
}

const ERROR_TEXT = {
  not_found: '찾을 수 없습니다.',
  rpc_unavailable: '노드(RPC)에 연결할 수 없습니다. 잠시 후 다시 시도하세요.',
  db_unavailable: 'DB 에 연결할 수 없어 목록을 불러오지 못했습니다.',
  invalid_tx_hash: 'tx 해시 형식이 아닙니다.',
  invalid_address: '주소 형식이 아닙니다.',
  invalid_block_id: '블록 번호 형식이 아닙니다.',
};
const errText = (err) => ERROR_TEXT[err.message] ?? `오류: ${err.message}`;

/* ── 검색 ───────────────────────────────────────────────────────────────── */

const FILTERS = [
  ['all', '전체'],
  ['address', '주소'],
  ['tx', 'Tx 해시'],
  ['block', '블록'],
];

/** 검색창. big=true 면 홈 배너용(필터 드롭다운 포함) */
function searchForm(big) {
  const select = big ? h('select', { name: 'filter', 'aria-label': '검색 범위' }, FILTERS.map(([v, t]) => h('option', { value: v }, t))) : null;
  const input = h('input', { name: 'q', type: 'search', spellcheck: 'false', autocomplete: 'off', placeholder: '주소 / tx 해시 / 블록 번호로 검색', 'aria-label': '검색' });
  const err = h('p', { class: 'search-error', hidden: true });
  const form = h('form', { class: big ? 'search' : 'search search-sm' },
    select, input, h('button', { type: 'submit', 'aria-label': '검색' }, icon('M10 4a6 6 0 1 0 3.9 10.6l5.2 5.2 1.4-1.4-5.2-5.2A6 6 0 0 0 10 4Zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z')));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const msg = goSearch(input.value, select?.value ?? 'all');
    err.hidden = !msg;
    err.textContent = msg ?? '';
  });
  return [form, err];
}

/** 이동하면 null, 못 하면 사용자에게 보여줄 문장 */
function goSearch(q, filter) {
  const target = routeForQuery(q);
  if (!target) return 'tx 해시(0x+64자), 주소(0x+40자), 블록 번호 중 하나를 입력하세요.';
  const kind = target.split('/')[1];
  if (filter !== 'all' && filter !== kind) return `선택한 범위(${FILTERS.find(([v]) => v === filter)[1]})와 입력 형식이 다릅니다.`;
  if (location.hash === target) render();
  else location.hash = target;
  return null;
}

// 상단 바의 작은 검색창 (홈이 아닐 때만 보인다)
const topSearch = $('#top-search');
topSearch.addEventListener('submit', (e) => {
  e.preventDefault();
  const msg = goSearch(topSearch.q.value, 'all');
  if (msg) {
    topSearch.q.setCustomValidity(msg);
    topSearch.q.reportValidity();
    topSearch.q.addEventListener('input', () => topSearch.q.setCustomValidity(''), { once: true });
  } else {
    topSearch.q.value = '';
  }
});

/* ── 공용 조각: 목록 행, tx 표 ─────────────────────────────────────────── */

function blockFeedRow(b) {
  return h('div', { class: 'feed-row' },
    h('div', { class: 'feed-main' },
      h('div', { class: 'feed-icon' }, 'Bk'),
      h('div', {}, blockLink(b.number), h('div', { class: 'small muted' }, age(b.timestamp)))),
    h('div', { class: 'small' },
      h('span', { class: 'ellipsis' }, '생성자 ', b.miner ? addrLink(b.miner, 6) : h('span', { class: 'muted' }, '-')),
      h('span', {}, link(`#/block/${b.number}`, `${b.txCount} txns`), h('span', { class: 'muted' }, ' 포함'))),
    h('span', { class: 'pill', title: '가스 사용률' }, b.gasUsed && b.gasLimit ? `가스 ${percent(b.gasUsed, b.gasLimit)}` : '-'));
}

function txFeedRow(t) {
  return h('div', { class: 'feed-row' },
    h('div', { class: 'feed-main' },
      h('div', { class: 'feed-icon' }, 'Tx'),
      h('div', { style: 'min-width:0' }, h('span', { class: 'ellipsis' }, link(`#/tx/${t.hash}`, shortHex(t.hash, 8), 'mono')), h('div', { class: 'small muted' }, age(t.timestamp)))),
    h('div', { class: 'small' },
      h('span', { class: 'ellipsis' }, '보냄 ', addrLink(t.from, 6)),
      h('span', { class: 'ellipsis' }, '받음 ', t.to ? addrLink(t.to, 6) : h('span', { class: 'muted' }, '컨트랙트 생성'))),
    h('span', { class: 'pill' }, `${weiToEth(t.valueWei, 5)} ETH`));
}

/**
 * tx 표 (주소·블록·전체 목록 공용).
 * opts.address 가 있으면 그 주소 기준으로 IN/OUT 칸을 넣는다.
 */
function txTable(items, { address } = {}) {
  if (items.length === 0) return h('div', { class: 'empty' }, '표시할 트랜잭션이 없습니다.');
  const head = ['트랜잭션 해시', 'Method', '블록', 'Age', '보낸 주소', address ? '' : null, '받는 주소', '금액'].filter((x) => x !== null);
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, head.map((c, i) => h('th', { class: i === head.length - 1 ? 'num' : null }, c)))),
    h('tbody', {}, items.map((t) => h('tr', {},
      h('td', {}, link(`#/tx/${t.hash}`, shortHex(t.hash, 8), 'mono')),
      h('td', {}, h('span', { class: 'method', title: t.method ?? '' }, methodLabel(t.method))),
      h('td', {}, blockLink(t.blockNumber)),
      h('td', { class: 'muted' }, age(t.timestamp)),
      h('td', {}, sameAddr(t.from, address) ? h('span', { class: 'mono' }, shortHex(t.from, 8)) : addrLink(t.from)),
      address ? h('td', {}, h('span', { class: `badge ${t.direction}` }, { in: 'IN', out: 'OUT', self: 'SELF' }[t.direction])) : null,
      h('td', {}, !t.to ? h('span', { class: 'muted' }, '컨트랙트 생성') : sameAddr(t.to, address) ? h('span', { class: 'mono' }, shortHex(t.to, 8)) : addrLink(t.to)),
      h('td', { class: 'num' }, eth(t.valueWei, 6)),
    )))));
}
const sameAddr = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * 커서로 넘기는 목록 카드. fetchPage(cursor) → { items, nextCursor, coverage? }
 * 탐색기의 "First / < Prev / Next >" 와 같은 자리에 "최신 / 다음" 을 둔다.
 * (커서 방식은 "이전"을 만들려면 지나온 커서를 기억해 둬야 한다 — stack)
 */
function pagedTxCard(title, fetchPage, opts) {
  const meta = h('div', { class: 'table-meta' });
  const body = h('div', {}, h('div', { class: 'loading' }, '불러오는 중…'));
  const first = h('button', { type: 'button' }, '최신');
  const prev = h('button', { type: 'button' }, '‹ 이전');
  const next = h('button', { type: 'button' }, '다음 ›');
  const pager = h('div', { class: 'pager' }, first, prev, next);
  const stack = []; // 지나온 페이지들의 커서
  let current;

  async function load(cursor) {
    for (const b of [first, prev, next]) b.disabled = true;
    try {
      const page = await fetchPage(cursor);
      current = cursor;
      body.replaceChildren(txTable(page.items, opts));
      meta.replaceChildren(h('span', {}, coverageText(page.coverage)), pager);
      first.disabled = prev.disabled = stack.length === 0;
      next.disabled = !page.nextCursor;
      next.onclick = () => { stack.push(current); load(page.nextCursor); };
    } catch (err) {
      body.replaceChildren(h('p', { class: 'error' }, errText(err)));
    }
  }
  prev.onclick = () => load(stack.pop());
  first.onclick = () => { stack.length = 0; load(undefined); };
  load(undefined);

  return card(h('div', { class: 'tabs', style: 'margin:0' }, h('span', { class: 'tab active' }, title)),
    h('div', { class: 'card-body' }, meta, body));
}

const coverageText = (c) => (c
  ? `인덱서 보관 범위(블록 ${formatInteger(c.fromBlock)} ~ ${formatInteger(c.toBlock)}, ${timeAgo(c.fromTime)}부터)의 트랜잭션, 최신순`
  : '인덱서가 아직 블록을 쌓지 않았습니다.');

/* ── 화면: 홈 ───────────────────────────────────────────────────────────── */

async function homeView() {
  const [form, err] = searchForm(true);
  const statsBox = h('section', { class: 'card stats' }, h('div', { class: 'loading', style: 'grid-column:1/-1' }, '불러오는 중…'));
  const blocksBody = h('div', { class: 'card-body' }, h('div', { class: 'loading' }, '불러오는 중…'));
  const txsBody = h('div', { class: 'card-body' }, h('div', { class: 'loading' }, '불러오는 중…'));

  const root = h('div', {},
    h('section', { class: 'hero' }, h('div', { class: 'container' }, h('h1', {}, '이더리움 블록 탐색기'), form, err)),
    h('div', { class: 'container' },
      statsBox,
      h('div', { class: 'home-lists' },
        card('최신 블록', blocksBody, h('div', { class: 'card-footer' }, link('#/blocks', '블록 전체 보기 →'))),
        card('최신 트랜잭션', txsBody, h('div', { class: 'card-footer' }, link('#/txs', '트랜잭션 전체 보기 →'))))));

  async function refresh() {
    const [health, stats, blocks, txs] = await Promise.allSettled([api('/health'), api('/stats'), api('/blocks?limit=6'), api('/txs?limit=6')]);
    statsBox.replaceChildren(...statCells(health, stats, blocks));
    blocksBody.replaceChildren(...(blocks.status === 'fulfilled'
      ? blocks.value.items.map(blockFeedRow)
      : [h('p', { class: 'error' }, errText(blocks.reason))]));
    txsBody.replaceChildren(...(txs.status === 'fulfilled'
      ? txs.value.items.map(txFeedRow)
      : [h('p', { class: 'error' }, errText(txs.reason))]));
  }
  await refresh();
  return { nodes: [root], refresh, every: 12_000 };
}

/** 초당 tx 수. 실제로 쌓인 구간(블록 수 × 평균 블록 시간)으로 나눈다 — 24시간이 안 찼을 때도 맞게 */
function tpsText(s) {
  const span = Number(s.blocks24h) * (s.avgBlockTimeSec ?? 12);
  return span > 0 ? `약 ${(Number(s.txs24h) / span).toFixed(1)} TPS` : null;
}

function statCells(health, stats, blocks) {
  const ok = (r) => r.status === 'fulfilled';
  const s = ok(stats) ? stats.value : null;
  const latest = ok(blocks) ? blocks.value.items[0] : null;
  const cell = (ic, label, value, sub) => h('div', { class: 'stat' },
    h('div', { class: 'stat-icon' }, icon(ic)),
    h('div', {}, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value), sub && h('div', { class: 'stat-sub' }, sub)));
  return [
    cell(ICON.cube, '최신 블록',
      ok(health) ? blockLink(health.value.block) : '-',
      ok(health) && health.value.indexer ? `인덱서 지연 ${Math.max(0, Number(health.value.indexer.lag))}블록` : null),
    cell(ICON.swap, '트랜잭션 (24시간)',
      s ? formatInteger(s.txs24h) : '-',
      s ? tpsText(s) : null),
    cell(ICON.gas, '기본 수수료',
      latest?.baseFeePerGasWei ? gwei(latest.baseFeePerGasWei) : '-',
      latest ? `블록 ${formatInteger(latest.number)} 기준` : null),
    cell(ICON.clock, '평균 블록 시간',
      s?.avgBlockTimeSec != null ? `${s.avgBlockTimeSec}초` : '-',
      '최근 100블록'),
  ];
}

/* ── 화면: 목록 ─────────────────────────────────────────────────────────── */

async function blocksView() {
  const { items } = await api('/blocks?limit=25');
  const table = h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ['블록', 'Age', 'Txn', '생성자', '가스 사용', '가스 한도', '기본 수수료'].map((c, i) => h('th', { class: i >= 4 ? 'num' : null }, c)))),
    h('tbody', {}, items.map((b) => h('tr', {},
      h('td', {}, blockLink(b.number)),
      h('td', { class: 'muted' }, age(b.timestamp)),
      h('td', {}, link(`#/block/${b.number}`, String(b.txCount))),
      h('td', {}, b.miner ? addrLink(b.miner) : '-'),
      h('td', { class: 'num' }, b.gasUsed ? `${formatInteger(b.gasUsed)} (${percent(b.gasUsed, b.gasLimit)})` : '-'),
      h('td', { class: 'num' }, b.gasLimit ? formatInteger(b.gasLimit) : '-'),
      h('td', { class: 'num' }, b.baseFeePerGasWei ? gwei(b.baseFeePerGasWei) : '-'),
    )))));
  return {
    nodes: [page(pageTitle('블록'), card(null, h('div', { class: 'card-body' }, h('div', { class: 'table-meta' }, `최신 블록 ${items.length}개`), table)))],
  };
}

async function txsView() {
  const { items } = await api('/txs?limit=25');
  return {
    nodes: [page(pageTitle('트랜잭션'), card(null, h('div', { class: 'card-body' }, h('div', { class: 'table-meta' }, `최신 트랜잭션 ${items.length}개`), txTable(items))))],
  };
}

/* ── 화면: 트랜잭션 상세 ────────────────────────────────────────────────── */

const TX_TYPE = { 0: '0 (Legacy)', 1: '1 (EIP-2930)', 2: '2 (EIP-1559)', 3: '3 (EIP-4844 Blob)', 4: '4 (EIP-7702)' };

async function txView(hash) {
  const [t, health] = await Promise.all([api(`/txs/${hash}`), api('/health').catch(() => null)]);
  const confirmations = t.blockNumber && health ? BigInt(health.block) - BigInt(t.blockNumber) + 1n : null;
  const status = { success: ['success', '성공'], failed: ['failed', '실패'], pending: ['pending', '대기 중'] }[t.status];

  const main = overview([
    ['트랜잭션 해시', '이 트랜잭션의 고유 식별자', h('span', {}, h('span', { class: 'mono' }, t.hash), copyBtn(t.hash))],
    ['상태', '실행 결과. 실패해도 수수료는 나간다', h('span', { class: `badge ${status[0]}` }, status[1])],
    ['블록', '이 트랜잭션이 포함된 블록', t.blockNumber
      ? h('span', {}, blockLink(t.blockNumber), ' ', confirmations != null ? h('span', { class: 'badge neutral' }, `${formatInteger(confirmations.toString())} 블록 확인`) : null)
      : undefined],
    ['시각', '블록이 만들어진 시각', t.timestamp ? h('span', {}, age(t.timestamp), h('span', { class: 'muted' }, ` (${localTime(t.timestamp)})`)) : undefined],
    'hr',
    ['보낸 주소', '트랜잭션에 서명한 주소', h('span', {}, link(`#/address/${t.from}`, t.from, 'mono'), copyBtn(t.from))],
    t.to
      ? ['받는 주소', '받는 주소 또는 호출한 컨트랙트', h('span', {}, link(`#/address/${t.to}`, t.to, 'mono'), copyBtn(t.to))]
      : ['받는 주소', '받는 주소가 없으면 컨트랙트 생성', h('span', {}, '[컨트랙트 생성] ', t.contractCreated ? link(`#/address/${t.contractCreated}`, t.contractCreated, 'mono') : '-')],
    'hr',
    ['금액', '보낸 ETH. 토큰 전송은 여기가 0 이고 이벤트 로그에 담긴다', eth(t.valueWei)],
    ['트랜잭션 수수료', '실제 사용한 가스 × 가스 가격', t.feeWei ? eth(t.feeWei) : undefined],
    ['가스 가격', '가스 1단위에 실제로 낸 가격', t.gasPriceWei ? h('span', {}, gwei(t.gasPriceWei), h('span', { class: 'muted' }, ` (${eth(t.gasPriceWei)})`)) : undefined],
  ]);

  const more = overview([
    'hr',
    ['가스 한도 & 사용량', '보낸 사람이 정한 한도와 실제 사용량', t.gasUsed ? `${formatInteger(t.gasLimit)} | ${formatInteger(t.gasUsed)} (${percent(t.gasUsed, t.gasLimit)})` : formatInteger(t.gasLimit ?? '0')],
    ['최대 수수료 설정', 'EIP-1559 tx 에서 보낸 사람이 정한 상한', t.maxFeePerGasWei
      ? `최대 ${gwei(t.maxFeePerGasWei)} · 우선순위 ${gwei(t.maxPriorityFeePerGasWei ?? '0')}` : undefined],
    ['Txn 유형', '트랜잭션 형식', TX_TYPE[t.type] ?? String(t.type)],
    ['Nonce / 위치', '보낸 주소의 몇 번째 tx 인가 / 블록 안의 순서', `${t.nonce}${t.position != null ? ` | ${t.position}` : ''}`],
    ['이벤트 로그', '컨트랙트가 남긴 로그 수 (토큰 전송 등)', t.logCount !== undefined ? `${t.logCount}개` : undefined],
    ['입력 데이터', '컨트랙트 함수 호출 내용. 앞 4바이트가 함수 선택자', t.input && t.input !== '0x'
      ? h('div', { style: 'width:100%' }, h('div', { class: 'small muted' }, `Method: ${methodLabel(t.input.slice(0, 10))}`), h('textarea', { class: 'input-data', readonly: true }, t.input))
      : '0x (단순 송금)'],
  ]);
  more.hidden = true;
  const toggle = h('button', { type: 'button', class: 'more-toggle' }, '+ 자세히 보기');
  toggle.onclick = () => { more.hidden = !more.hidden; toggle.textContent = more.hidden ? '+ 자세히 보기' : '− 접기'; };

  return {
    nodes: [page(
      pageTitle('트랜잭션 상세'),
      h('div', { class: 'tabs' }, h('span', { class: 'tab active' }, '개요')),
      card(null, h('div', { class: 'card-body' }, main, more, toggle)),
    )],
  };
}

/* ── 화면: 블록 상세 ────────────────────────────────────────────────────── */

async function blockView(id) {
  const b = await api(`/blocks/${id}`);
  const n = BigInt(b.number);
  const arrows = h('span', { class: 'nav-arrows' },
    n > 0n ? h('a', { href: `#/block/${n - 1n}`, title: '이전 블록', 'aria-label': '이전 블록' }, icon(ICON.left)) : null,
    h('a', { href: `#/block/${n + 1n}`, title: '다음 블록', 'aria-label': '다음 블록' }, icon(ICON.right)));

  const info = overview([
    ['블록 높이', '체인의 처음부터 몇 번째 블록인가', h('span', {}, h('strong', {}, formatInteger(b.number)), arrows)],
    ['시각', '블록이 만들어진 시각', h('span', {}, age(b.timestamp), h('span', { class: 'muted' }, ` (${localTime(b.timestamp)})`))],
    ['트랜잭션', '이 블록에 담긴 tx 수', h('span', {},
      h('a', { href: location.hash, onclick: (e) => { e.preventDefault(); document.getElementById('block-txs')?.scrollIntoView({ behavior: 'smooth' }); } },
        `트랜잭션 ${b.txCount}개`), '가 이 블록에 있음')],
    'hr',
    ['생성자 (Fee Recipient)', '블록을 만들고 우선순위 수수료를 받은 주소', h('span', {}, link(`#/address/${b.miner}`, b.miner, 'mono'), copyBtn(b.miner))],
    ['가스 사용', '블록 안 tx 들이 쓴 가스 합계 / 한도', `${formatInteger(b.gasUsed)} (${percent(b.gasUsed, b.gasLimit)})`],
    ['가스 한도', '블록 하나에 담을 수 있는 가스 상한', formatInteger(b.gasLimit)],
    ['기본 수수료', 'EIP-1559 base fee. 가스 1단위당, 소각된다', b.baseFeePerGasWei ? h('span', {}, gwei(b.baseFeePerGasWei), h('span', { class: 'muted' }, ` (${eth(b.baseFeePerGasWei)})`)) : undefined],
    'hr',
    ['해시', '이 블록의 고유 식별자', h('span', {}, h('span', { class: 'mono' }, b.hash), copyBtn(b.hash))],
    ['부모 해시', '직전 블록의 해시. 이 연결이 "체인"이다', link(`#/block/${n - 1n}`, b.parentHash, 'mono')],
  ]);

  const list = pagedTxCard('블록 안의 트랜잭션',
    (cursor) => api(`/blocks/${b.number}/txs?limit=25${cursor ? `&cursor=${cursor}` : ''}`));
  list.id = 'block-txs';

  // 인덱서 보관 범위 밖 블록이면 DB 에 tx 가 없다 → 노드에서 받은 해시 목록이라도 보여준다
  const fallback = b.txCount > 0 ? h('section', { class: 'card', style: 'margin-top:1rem', hidden: true },
    h('div', { class: 'card-header' }, `블록 안의 트랜잭션 ${b.txCount}개 (인덱서 보관 범위 밖이라 해시만 표시)`),
    h('div', { class: 'card-body' }, h('div', { style: 'columns: 2 24rem; padding:.75rem 0' },
      b.transactions.map((tx) => h('div', { style: 'padding:.15rem 0' }, link(`#/tx/${tx}`, shortHex(tx, 12), 'mono')))))) : null;
  if (fallback) {
    api(`/blocks/${b.number}/txs?limit=1`)
      .then((p) => { if (p.items.length === 0) { fallback.hidden = false; list.hidden = true; list.id = ''; fallback.id = 'block-txs'; } })
      .catch(() => { fallback.hidden = false; });
  }

  return {
    nodes: [page(
      pageTitle('블록', h('span', { class: 'sub' }, `#${formatInteger(b.number)}`)),
      h('div', { class: 'tabs' }, h('span', { class: 'tab active' }, '개요')),
      card(null, h('div', { class: 'card-body' }, info)),
      h('div', { style: 'height:1rem' }),
      list,
      fallback,
    )],
  };
}

/* ── 화면: 주소 ─────────────────────────────────────────────────────────── */

async function addressView(address) {
  const a = await api(`/addresses/${address}`);
  const isContract = a.type === 'contract';

  const cards = h('div', { class: 'addr-cards' },
    card('개요', h('div', { class: 'card-body' },
      h('div', { class: 'mini-label' }, 'ETH 잔액'),
      h('div', { class: 'mini-value' }, eth(a.balanceWei)))),
    card('추가 정보', h('div', { class: 'card-body' },
      h('div', { class: 'mini-label' }, '유형'),
      h('div', { class: 'mini-value' }, isContract ? '컨트랙트' : '개인 지갑 (EOA)'),
      h('div', { class: 'mini-label' }, isContract ? 'Nonce (만든 컨트랙트 수)' : '보낸 트랜잭션 수 (Nonce)'),
      h('div', { class: 'mini-value' }, formatInteger(a.nonce)))));

  const list = pagedTxCard('트랜잭션', (cursor) => api(`/addresses/${address}/txs?limit=25${cursor ? `&cursor=${cursor}` : ''}`), { address });

  return {
    nodes: [page(
      pageTitle(isContract ? '컨트랙트' : '주소', h('span', { class: 'mono sub' }, a.address), copyBtn(a.address)),
      cards,
      list,
    )],
  };
}

/* ── 라우터 ─────────────────────────────────────────────────────────────── */

const routes = [
  [/^#\/?$/, homeView, 'home'],
  [/^#\/blocks$/, blocksView, 'blocks'],
  [/^#\/txs$/, txsView, 'txs'],
  [/^#\/tx\/(0x[0-9a-fA-F]{64})$/, txView, 'txs'],
  [/^#\/block\/(latest|\d+)$/, blockView, 'blocks'],
  [/^#\/address\/(0x[0-9a-fA-F]{40})$/, addressView, null],
];

let renderSeq = 0;
let refreshTimer = null;

async function render() {
  const seq = ++renderSeq; // 느린 이전 요청이 나중에 도착해 화면을 덮어쓰지 않게
  clearInterval(refreshTimer);
  const hash = location.hash || '#/';
  const route = routes.find(([re]) => re.test(hash));
  const [re, fn, navKey] = route ?? routes[0];
  const arg = route ? hash.match(re)[1] : undefined;

  // 홈에는 큰 검색 배너가 있으므로 상단 바의 작은 검색창은 숨긴다
  topSearch.hidden = fn === homeView;
  for (const a of document.querySelectorAll('.nav a')) {
    a.classList.toggle('active', a.getAttribute('href') === `#/${navKey === 'home' ? '' : navKey}`);
  }

  view.replaceChildren(h('div', { class: 'loading' }, '불러오는 중…'));
  try {
    const out = await fn(arg);
    if (seq !== renderSeq) return;
    view.replaceChildren(...out.nodes);
    window.scrollTo(0, 0);
    if (out.refresh) {
      refreshTimer = setInterval(() => { if (seq === renderSeq) out.refresh().catch(() => {}); }, out.every);
    }
  } catch (err) {
    if (seq !== renderSeq) return;
    view.replaceChildren(page(h('p', { class: 'error' }, errText(err))));
  }
}

window.addEventListener('hashchange', render);
render();

/* ── 상단 바: 연결 상태 ─────────────────────────────────────────────────── */

async function refreshStatus() {
  const el = $('#status');
  try {
    const s = await api('/health');
    el.dataset.state = 'ok';
    el.textContent = `메인넷 · #${formatInteger(s.block)}`;
  } catch (err) {
    el.dataset.state = 'error';
    el.textContent = err.message === 'rpc_unavailable' ? 'RPC 연결 끊김' : '서버 연결 끊김';
  }
}
refreshStatus();
setInterval(refreshStatus, 12_000);

// "N초 전" 표시를 매초 갱신
setInterval(() => {
  for (const el of document.querySelectorAll('.age[data-ts]')) el.textContent = timeAgo(el.dataset.ts);
}, 1000);

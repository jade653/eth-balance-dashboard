/**
 * 화면 진입점. 블록 탐색기의 표준 레이아웃을 따른다.
 *
 *   #/                 홈: 검색 배너 · 통계 · 최신 블록 · 최신 트랜잭션
 *   #/blocks           최신 블록 목록          #/block/{번호}     블록 상세 + 블록 안 tx
 *   #/txs              최신 트랜잭션 목록      #/tx/{해시}        트랜잭션 상세
 *   #/address/{주소}   주소: 잔액 · 토큰 보유 · tx 목록   (/tokentxns: 토큰 전송)
 *   #/tokens           추적 중인 토큰 목록     #/token/{주소}     토큰: 개요 · 전송 (/holders: 홀더)
 *   #/token/{주소}?a={홀더}  토큰 페이지를 홀더 한 명으로 거른 것 (Etherscan 과 같은 모양)
 *   #/tx/{해시}/logs · /internal · /state · /authorizations   tx 상세의 탭
 *
 * 화면 전환은 URL 의 # 뒤로 한다. 서버(nginx)는 언제나 index.html 하나만 주면 된다.
 * 체인에서 온 값은 전부 textContent 로만 넣는다 (innerHTML 금지 → XSS 차단).
 */
import {
  formatInteger, weiToEth, formatUnits, shortHex, routeForQuery, timeAgo, methodLabel, percent, formatGasPrice,
  sharePercent, ratio, formatUtc, giniFromSummary, walletDepth, netTransfers, decodeInput, decodeLog, hexToUtf8, titleCase,
} from './format.js';

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
  doc: 'M6 2h8l6 6v14H6V2Zm7 1.5V9h5.5L13 3.5ZM8 12v2h10v-2H8Zm0 4v2h10v-2H8Z', // 컨트랙트 표시
  coin: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm1 2v1.1c1.4.3 2.5 1.2 2.7 2.6h-2c-.2-.6-.8-1-1.7-1-1 0-1.7.5-1.7 1.1 0 .6.5.9 2 1.2 2 .4 3.6 1 3.6 3 0 1.5-1.2 2.5-2.9 2.8V17h-2v-1.2c-1.6-.3-2.8-1.3-2.9-2.9h2c.1.8.8 1.3 1.9 1.3 1.1 0 1.8-.5 1.8-1.1 0-.7-.6-1-2.1-1.3-1.9-.4-3.5-1-3.5-2.9 0-1.4 1.1-2.4 2.8-2.7V6h2Z',
  play: 'M8 5v14l11-7L8 5Z',
  fire: 'M13.5 1.7s.7 2.6.7 4.7c0 2-1.3 3.6-3.3 3.6S7.5 8.4 7.5 6.4l.1-.4A9.3 9.3 0 0 0 4 13.5a8 8 0 0 0 16 0c0-4.8-2.3-9.1-6.5-11.8ZM11.7 19c-1.8 0-3.2-1.4-3.2-3.1 0-1.6 1-2.8 2.8-3.1 1.8-.4 3.6-1.2 4.6-2.6.4 1.3.6 2.6.6 4 0 2.6-2.1 4.8-4.8 4.8Z',
  download: 'M11 3h2v9.2l3.3-3.3 1.4 1.4L12 16l-5.7-5.7 1.4-1.4 3.3 3.3V3ZM4 18h16v2H4v-2Z',
};

const link = (href, text, cls) => h('a', { href, class: cls }, text);
const addrLink = (a, keep = 8) => (a ? link(`#/address/${a}`, shortHex(a, keep), 'mono') : h('span', { class: 'muted' }, '—'));
const blockLink = (n) => link(`#/block/${n}`, formatInteger(String(n)));
/** 화면에 보일 체인 이름·잔액 단위. 시작할 때 /api/v1/chain 에서 받아 채운다 */
const CHAIN = { chainId: null, name: 'Ethereum', symbol: 'ETH' };
const eth = (wei, digits = 18) => `${weiToEth(wei, digits)} ${CHAIN.symbol}`;
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
/**
 * 블록 생성자. PoA(Clique) 체인은 miner 칸이 0x000…0 이고 실제 서명자는 extraData 의 서명에 들어 있다.
 * 0 주소를 그대로 링크로 보여주면 "모든 블록을 0 주소가 만들었다"로 읽히므로 따로 표시한다.
 */
const minerCell = (m, keep) => (!m ? h('span', { class: 'muted' }, '-')
  : m.toLowerCase() === ZERO_ADDR ? h('span', { class: 'muted', title: 'PoA 체인: 블록 서명자는 extraData 의 서명에 있다' }, '— (PoA)')
    : addrLink(m, keep));
const gwei = (wei) => formatGasPrice(wei); // 보통 Gwei, Gwei 로 0 이 되는 작은 값은 wei
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

/**
 * 추적 중인 토큰 (worker 의 TOKENS). 시작할 때 /api/v1/tokens 에서 받는다.
 * 검색창의 심볼 검색, 주소 옆 토큰 이름표에 쓴다. 못 받으면 비어 있다 (DB 없이 띄운 경우 등).
 */
const TRACKED = new Map();

/** 토큰 이름표: "Tether USD: USDT". 이름이 없으면 심볼, 둘 다 없으면 null */
const tokenLabel = (m) => (m?.name && m?.symbol ? `${m.name}: ${m.symbol}` : m?.name ?? m?.symbol ?? null);

/**
 * Etherscan 식 주소 칸: [컨트랙트 아이콘] 주소 (이름표) [복사].
 *   opts.full     전체 주소 (기본은 앞뒤만)
 *   opts.label    주소 옆 괄호 이름 (토큰 이름 등)
 *   opts.contract 컨트랙트 표시
 *   opts.href     링크 대상 (기본은 주소 페이지)
 *   opts.plain    링크 없이 (지금 보고 있는 주소)
 */
function addr(a, opts = {}) {
  if (!a) return h('span', { class: 'muted' }, '—');
  // 발행(from)·소각(to)의 상대편. Etherscan 처럼 "Null" 로 표시한다
  if (a === ZERO_ADDR && !opts.full) return h('span', { class: 'addr' }, h('a', { href: `#/address/${a}`, class: 'mono', title: a }, 'Null: 0x000…000'));
  const text = opts.full ? a : shortHex(a, opts.keep ?? 6);
  return h('span', { class: 'addr' },
    opts.contract ? h('span', { class: 'addr-icon', title: '컨트랙트' }, icon(ICON.doc)) : null,
    opts.plain ? h('span', { class: 'mono', title: a }, text) : h('a', { href: opts.href ?? `#/address/${a}`, class: 'mono', title: a }, text),
    opts.label ? h('span', { class: 'muted' }, ` (${opts.label})`) : null,
    opts.copy === false ? null : copyBtn(a));
}

/** 토큰 금액 표시. decimals 를 모르면 원래 정수 */
const tokenAmount = (raw, decimals, maxFraction = 18) =>
  (decimals != null ? formatUnits(raw, decimals, maxFraction) : formatInteger(String(raw)));

/** 토큰 이름 링크 (토큰 페이지로) */
const tokenLink = (token, m) => h('span', { class: 'token-name' },
  h('span', { class: 'token-icon' }, icon(ICON.coin)),
  link(`#/token/${token}`, m?.name ?? m?.symbol ?? shortHex(token, 6), m?.name || m?.symbol ? null : 'mono'),
  m?.symbol && m?.name ? h('span', { class: 'muted' }, ` (${m.symbol})`) : null);

/** 탭 줄. tabs = [[key, label, href]], 지금 탭은 active */
const tabBar = (tabs, active) => h('nav', { class: 'tabs' },
  tabs.filter(Boolean).map(([k, label, href]) => h('a', { href, class: `tab${k === active ? ' active' : ''}` }, label)));

/** "전체 / 순증감" 같은 두 갈래 토글. views = [[label, node]] */
function toggleViews(views) {
  const bodies = views.map(([, node]) => node);
  const buttons = views.map(([label], i) => h('button', { type: 'button', class: `chip-btn${i === 0 ? ' active' : ''}` }, label));
  buttons.forEach((b, i) => b.addEventListener('click', () => {
    buttons.forEach((x, j) => x.classList.toggle('active', i === j));
    bodies.forEach((x, j) => { x.hidden = i !== j; });
  }));
  bodies.forEach((x, j) => { x.hidden = j !== 0; });
  return h('div', { class: 'toggle-views' }, h('div', { class: 'chip-row' }, buttons), ...bodies);
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
  not_tracked: '추적 중인 토큰이 아닙니다.',
  trace_unsupported: '이 노드는 트레이스(debug_traceTransaction)를 지원하지 않습니다. debug API 를 연 노드(예: geth --http.api eth,net,web3,debug)를 RPC_HTTP_URL 로 쓰면 보입니다.',
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
  const target = routeForQuery(q) ?? tokenRouteFor(q);
  if (!target) return 'tx 해시(0x+64자), 주소(0x+40자), 블록 번호, 추적 중인 토큰의 심볼·이름 중 하나를 입력하세요.';
  const kind = target.split('/')[1] === 'token' ? 'address' : target.split('/')[1];
  if (filter !== 'all' && filter !== kind) return `선택한 범위(${FILTERS.find(([v]) => v === filter)[1]})와 입력 형식이 다릅니다.`;
  if (location.hash === target) render();
  else location.hash = target;
  return null;
}

/** 추적 중인 토큰을 심볼·이름으로 찾는다 (대소문자 무시, 정확히 같은 것만) */
function tokenRouteFor(q) {
  const s = String(q ?? '').trim().toLowerCase();
  if (!s) return null;
  for (const t of TRACKED.values()) {
    if (t.symbol?.toLowerCase() === s || t.name?.toLowerCase() === s) return `#/token/${t.address}`;
  }
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
      h('span', { class: 'ellipsis' }, '생성자 ', minerCell(b.miner, 6)),
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
    h('span', { class: 'pill' }, `${weiToEth(t.valueWei, 5)} ${CHAIN.symbol}`));
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
function pagedTxCard(title, fetchPage, opts, { render = (page) => txTable(page.items, opts), metaText = (page) => coverageText(page.coverage) } = {}) {
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
      body.replaceChildren(render(page));
      meta.replaceChildren(h('span', {}, metaText(page)), pager);
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

  return card(title && h('div', { class: 'tabs', style: 'margin:0' }, h('span', { class: 'tab active' }, title)),
    h('div', { class: 'card-body' }, meta, body));
}

/**
 * 토큰 전송 표 (토큰 페이지 · 주소 페이지 공용).
 *   opts.holder    이 주소 기준 IN/OUT 칸
 *   opts.showToken 토큰 칸 (여러 토큰이 섞인 주소 페이지)
 */
function tokenTransferTable(items, { holder, showToken } = {}) {
  if (items.length === 0) return h('div', { class: 'empty' }, '표시할 토큰 전송이 없습니다.');
  const head = ['트랜잭션 해시', 'Method', '블록', 'Age', '보낸 주소', holder ? '' : null, '받는 주소', '수량', showToken ? '토큰' : null].filter((x) => x !== null);
  const who = (a) => (a === ZERO_ADDR ? h('span', { class: 'muted', title: a }, 'Null: 0x000…000')
    : sameAddr(a, holder) ? h('span', { class: 'mono', title: a }, shortHex(a, 8)) : addrLink(a));
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, head.map((c) => h('th', { class: c === '수량' ? 'num' : null }, c)))),
    h('tbody', {}, items.map((t) => h('tr', {},
      h('td', {}, link(`#/tx/${t.txHash}`, shortHex(t.txHash, 8), 'mono')),
      h('td', {}, h('span', { class: 'method', title: t.method ?? '' }, methodLabel(t.method))),
      h('td', {}, blockLink(t.blockNumber)),
      h('td', { class: 'muted' }, t.timestamp ? age(t.timestamp) : '-'),
      h('td', {}, who(t.from)),
      holder ? h('td', {}, h('span', { class: `badge ${t.direction}` }, { in: 'IN', out: 'OUT', self: 'SELF' }[t.direction])) : null,
      h('td', {}, who(t.to)),
      h('td', { class: 'num' }, tokenAmount(t.amount, t.tokenDecimals, 6)),
      showToken ? h('td', {}, tokenLink(t.token, { name: t.tokenName, symbol: t.tokenSymbol })) : null,
    )))));
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
    h('section', { class: 'hero' }, h('div', { class: 'container' }, h('h1', {}, `${CHAIN.name} 블록 탐색기`), form, err)),
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
      ? (txs.value.items.length ? txs.value.items.map(txFeedRow) : [h('div', { class: 'empty' }, '보관 기간 안에 트랜잭션이 없습니다.')])
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
      h('td', {}, minerCell(b.miner)),
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

/* ── 화면: 트랜잭션 상세 (Etherscan 의 Transaction Details) ──────────────── */

/** 노드가 트레이스(debug API)를 지원하나. 모르면 null, 한 번 501 을 받으면 false */
const TRACE = { supported: null };

const TX_TYPE = { 0: '0 (Legacy)', 1: '1 (EIP-2930)', 2: '2 (EIP-1559)', 3: '3 (EIP-4844 Blob)', 4: '4 (EIP-7702)' };

/** tx 응답 안에서 주소에 붙일 이름표 (로그를 남긴 토큰 · 추적 중인 토큰) */
const labelFor = (t, a) => (a ? tokenLabel(t.tokens?.[a.toLowerCase()]) ?? tokenLabel(TRACKED.get(a.toLowerCase())) : null);
const isContractIn = (t, a) => !!a && (t.contracts ?? []).includes(a.toLowerCase());
const txAddr = (t, a, opts = {}) => addr(a, { label: labelFor(t, a), contract: isContractIn(t, a), ...opts });

/** "ERC-20 Tokens Transferred" 한 줄: ▸ From A To B For 2 Tether USD (USDT) */
function tokenTransferRow(t, x) {
  return h('div', { class: 'tt-row' },
    h('span', { class: 'tt-caret' }, icon(ICON.play)),
    h('strong', {}, 'From '), txAddr(t, x.from),
    h('strong', {}, ' To '), txAddr(t, x.to),
    h('strong', {}, ' For '), h('span', {}, tokenAmount(x.amount, x.decimals), ' '),
    tokenLink(x.token, x));
}

/** "Net Transfers" 한 줄: 0x2132… sent 2.075554 Tether USD (USDT) */
function netTransferRow(t, n) {
  return h('div', { class: 'tt-row' },
    txAddr(t, n.address),
    h('span', { class: n.direction === 'sent' ? 'net-out' : 'net-in' }, n.direction === 'sent' ? ' 보냄 ' : ' 받음 '),
    h('span', {}, tokenAmount(n.amount, n.decimals), ' '),
    tokenLink(n.token, n));
}

/**
 * Etherscan 의 "Transaction Action": 무슨 일이 일어났나를 한 문장씩.
 * 입력 데이터를 사전으로 풀 수 있으면 함수에 맞게, 아니면 "함수 X 호출".
 */
function txActions(t) {
  const out = [];
  const d = decodeInput(t.input);
  const tokenOfTo = t.to ? t.tokens?.[t.to.toLowerCase()] : null;
  const p = Object.fromEntries((d?.params ?? []).map((x) => [x.name.replace(/^_/, ''), x.value]));
  const amt = (v) => (tokenOfTo ? `${tokenAmount(v, tokenOfTo.decimals)} ` : `${formatInteger(v)} `);
  const sym = () => (tokenOfTo ? tokenLink(t.to, tokenOfTo) : h('span', { class: 'muted' }, '토큰'));

  if (t.authorizationList?.length) {
    for (const a of t.authorizationList) {
      out.push([h('strong', {}, 'EIP-7702 '), '위임 대상 ', addr(a.address, { label: labelFor(t, a.address) })]);
    }
  }
  if (!t.to) {
    out.push([h('strong', {}, '컨트랙트 생성 '), t.contractCreated ? addr(t.contractCreated, { contract: true }) : '-']);
  } else if (!d) {
    if (BigInt(t.valueWei ?? '0') > 0n) out.push([h('strong', {}, 'Transfer '), eth(t.valueWei), ' → ', txAddr(t, t.to)]);
  } else if (d.params && (d.name === 'transfer' || d.name === 'transferFrom')) {
    out.push([h('strong', {}, 'Transfer '), amt(p.value), sym(), d.name === 'transferFrom' ? [' 보낸 주소 ', txAddr(t, p.from)] : null, ' → ', txAddr(t, p.to)]);
  } else if (d.params && d.name === 'approve') {
    const unlimited = BigInt(p.value) >= 2n ** 255n;
    out.push([h('strong', {}, 'Approve '), txAddr(t, p.spender), ' 에게 ', unlimited ? '무제한 ' : amt(p.value), sym(), ' 사용 허락']);
  } else if (d.params && d.name === 'mint' && p.to) {
    out.push([h('strong', {}, 'Mint '), amt(p.amount), sym(), ' → ', txAddr(t, p.to)]);
  } else {
    out.push([h('strong', {}, `${d.name ? titleCase(d.name) : d.selector} `), '함수 호출 · ', txAddr(t, t.from), ' → ', txAddr(t, t.to)]);
  }
  return out.length ? h('div', { class: 'actions' }, out.map((parts) => h('div', { class: 'action-row' }, h('span', { class: 'tt-caret' }, icon(ICON.play)), parts))) : undefined;
}

/**
 * 입력 데이터 (Etherscan 의 Input Data): 보기 방식 선택 + "입력 데이터 해석" 표.
 *   기본 보기: Function: transfer(address _to, uint256 _value) / MethodID / [0]: … [1]: …
 *   UTF-8   : 글자로 읽어 본 것 (메시지를 담은 tx 등)
 *   원본    : 16진 그대로
 */
function inputDataView(input) {
  if (!input || input === '0x') return h('span', {}, '0x');
  const d = decodeInput(input);
  const defaultText = d
    ? [d.signature ? `Function: ${d.signature}\n` : null, `MethodID: ${d.selector}`, ...d.words.map((w, i) => `[${i}]:  ${w}`)].filter(Boolean).join('\n')
    : input;
  const box = h('pre', { class: 'input-data' }, defaultText);
  const views = { default: defaultText, utf8: hexToUtf8(input) ?? '(UTF-8 로 읽을 수 없는 데이터)', original: input };
  const select = h('select', { class: 'mini-select', 'aria-label': '입력 데이터 보기 방식' },
    h('option', { value: 'default' }, '기본 보기'), h('option', { value: 'utf8' }, 'UTF-8'), h('option', { value: 'original' }, '원본'));
  select.addEventListener('change', () => { box.textContent = views[select.value]; });

  const table = d?.params ? h('div', { class: 'table-wrap decoded', hidden: true }, h('table', {},
    h('thead', {}, h('tr', {}, ['#', '이름', '타입', '값'].map((c) => h('th', {}, c)))),
    h('tbody', {}, d.params.map((p, i) => h('tr', {},
      h('td', {}, String(i)), h('td', {}, p.name), h('td', { class: 'muted' }, p.type),
      h('td', { class: 'wrap' }, valueCell(p.type, p.value))))))) : null;
  const decodeBtn = table ? h('button', { type: 'button', class: 'chip-btn' }, '입력 데이터 해석') : null;
  decodeBtn?.addEventListener('click', () => {
    table.hidden = !table.hidden;
    box.hidden = !table.hidden;
    decodeBtn.textContent = table.hidden ? '입력 데이터 해석' : '원문으로 돌아가기';
  });
  return h('div', { style: 'width:100%' }, box, table, h('div', { class: 'chip-row' }, h('span', { class: 'muted small' }, '보기 방식'), select, decodeBtn));
}

/** 디코딩한 값 하나 (주소는 링크, 배열은 줄마다) */
function valueCell(type, v) {
  if (Array.isArray(v)) return h('div', {}, v.map((x) => h('div', {}, valueCell(type.slice(0, -2), x))));
  if (type === 'address') return addrLink(v, 20);
  return h('span', { class: /^(bytes|string)/.test(type) ? 'mono' : null }, v);
}

async function txView(hash, tab = 'overview') {
  const [t, health] = await Promise.all([api(`/txs/${hash}`), api('/health').catch(() => null)]);
  const base = `#/tx/${hash}`;
  const tabs = tabBar([
    ['overview', '개요', base],
    t.status !== 'pending' ? ['internal', '내부 트랜잭션', `${base}/internal`] : null,
    t.status !== 'pending' ? ['logs', `로그 (${t.logCount ?? 0})`, `${base}/logs`] : null,
    t.status !== 'pending' ? ['state', '상태', `${base}/state`] : null,
    t.authorizationList?.length ? ['authorizations', `Authorizations (${t.authorizationList.length})`, `${base}/authorizations`] : null,
  ], tab);

  const body = tab === 'logs' ? logsTab(t)
    : tab === 'internal' ? internalTab(t)
      : tab === 'state' ? stateTab(t)
        : tab === 'authorizations' ? authorizationsTab(t)
          : overviewTab(t, health);

  return { nodes: [page(pageTitle('트랜잭션 상세'), tabs, body)] };
}

function overviewTab(t, health) {
  const confirmations = t.blockNumber && health ? BigInt(health.block) - BigInt(t.blockNumber) + 1n : null;
  const status = { success: ['success', '성공'], failed: ['failed', '실패'], pending: ['pending', '대기 중'] }[t.status];
  const toIsContract = isContractIn(t, t.to) || (t.input && t.input !== '0x');

  // 실패 사유는 트레이스로만 알 수 있다 (노드가 지원할 때만, 늦게 채운다)
  const statusCell = h('span', {}, h('span', { class: `badge ${status[0]}` }, status[1]));
  // 내부 트랜잭션 중 ETH 가 오간 것 (트레이스, 늦게 채운다. 없거나 지원 안 하면 줄을 숨긴다)
  const internalRow = h('div', { class: 'kv-row', hidden: true });
  if (t.status !== 'pending' && TRACE.supported !== false) {
    api(`/txs/${t.hash}/trace`).then((tr) => {
      TRACE.supported = true;
      if (t.status === 'failed' && (tr.revertReason || tr.error)) {
        statusCell.append(h('span', { class: 'muted' }, ` 사유: '${tr.revertReason ?? tr.error}'`));
      }
      const moves = tr.calls.filter((c) => BigInt(c.valueWei) > 0n && !c.error);
      if (!moves.length) return;
      const asTransfers = moves.map((c) => ({ token: 'native', symbol: CHAIN.symbol, decimals: 18, from: c.from, to: c.to, amount: c.valueWei }));
      internalRow.replaceChildren(
        h('dt', {}, hint('컨트랙트가 실행 중에 보낸 기본 코인 (트레이스로 확인)'), '내부 트랜잭션'),
        h('dd', {}, toggleViews([
          ['전체', h('div', { class: 'tt-list' }, moves.map((c) => h('div', { class: 'tt-row' },
            h('span', { class: 'tt-caret' }, icon(ICON.play)), h('strong', {}, 'Transfer '), eth(c.valueWei),
            h('strong', {}, ' From '), txAddr(t, c.from), h('strong', {}, ' To '), txAddr(t, c.to))))],
          ['순증감', h('div', { class: 'tt-list' }, netTransfers(asTransfers).map((n) => h('div', { class: 'tt-row' },
            txAddr(t, n.address), h('span', { class: n.direction === 'sent' ? 'net-out' : 'net-in' }, n.direction === 'sent' ? ' 보냄 ' : ' 받음 '), eth(n.amount))))],
        ])));
      internalRow.hidden = false;
    }).catch((err) => {
      // 트레이스 미지원 노드면 이번 세션에서는 다시 묻지 않는다 (탭에서 직접 열면 안내가 나온다)
      if (err.message === 'trace_unsupported') TRACE.supported = false;
    });
  }

  const transfers = t.tokenTransfers ?? [];
  const main = overview([
    ['트랜잭션 액션', '이 트랜잭션에서 일어난 일 요약 (입력 데이터를 해석해 만든다)', t.status === 'pending' ? undefined : txActions(t)],
    'hr',
    ['트랜잭션 해시', '이 트랜잭션의 고유 식별자', h('span', {}, h('span', { class: 'mono' }, t.hash), copyBtn(t.hash))],
    ['상태', '실행 결과. 실패해도 수수료는 나간다', statusCell],
    ['블록', '이 트랜잭션이 포함된 블록', t.blockNumber
      ? h('span', {}, blockLink(t.blockNumber), ' ', confirmations != null ? h('span', { class: 'badge neutral' }, `${formatInteger(confirmations.toString())} 블록 확인`) : null)
      : h('span', { class: 'muted' }, '(대기 중)')],
    ['타임스탬프', '블록이 만들어진 시각', t.timestamp
      ? h('span', { class: 'ts' }, icon(ICON.clock), age(t.timestamp), h('span', { class: 'chip', title: localTime(t.timestamp) }, formatUtc(t.timestamp)))
      : undefined],
    'hr',
    ['보낸 주소 (From)', '트랜잭션에 서명한 주소', txAddr(t, t.from, { full: true })],
    // Etherscan 처럼: 컨트랙트를 부른 tx 의 to 는 "받는 사람"이 아니라 "호출한 컨트랙트"다
    t.to
      ? [toIsContract ? '호출한 컨트랙트 (To)' : '받는 주소 (To)',
        '트랜잭션의 to. 토큰 송금이면 토큰 컨트랙트이고, 토큰을 실제로 받은 주소는 아래 "ERC-20 토큰 전송"에 있다',
        txAddr(t, t.to, { full: true, contract: toIsContract })]
      : ['받는 주소 (To)', '받는 주소가 없으면 컨트랙트 생성', h('span', {}, '[ 컨트랙트 ', t.contractCreated ? addr(t.contractCreated, { full: true, contract: true }) : '-', ' 생성됨 ]')],
    ['ERC-20 토큰 전송', 'ERC-20 Transfer 이벤트 로그로 확인한 토큰 이동. 순증감 = 주소·토큰별로 합친 결과',
      transfers.length ? h('div', {},
        h('span', { class: 'badge neutral count' }, String(transfers.length)),
        toggleViews([
          ['전체', h('div', { class: 'tt-list' }, transfers.map((x) => tokenTransferRow(t, x)))],
          ['순증감', h('div', { class: 'tt-list' }, netTransfers(transfers).map((n) => netTransferRow(t, n)))],
        ])) : undefined],
    'hr',
    ['금액 (Value)', '보낸 기본 코인. 토큰 전송은 여기가 0 이고 이벤트 로그에 담긴다', h('span', { class: 'chip' }, eth(t.valueWei))],
    ['트랜잭션 수수료', '실제 사용한 가스 × 가스 가격', t.feeWei ? eth(t.feeWei) : undefined],
    ['가스 가격', '가스 1단위에 실제로 낸 가격', t.gasPriceWei ? h('span', {}, gwei(t.gasPriceWei), h('span', { class: 'muted' }, ` (${eth(t.gasPriceWei)})`)) : undefined],
  ]);
  // 늦게 채우는 내부 트랜잭션 줄은 ERC-20 줄 바로 앞에 끼운다 (Etherscan 순서)
  const erc20Row = [...main.querySelectorAll('.kv-row')].find((r) => r.querySelector('dt')?.textContent.includes('ERC-20'));
  main.insertBefore(internalRow, erc20Row ?? main.querySelectorAll('hr')[2] ?? null);

  const sep = () => h('span', { class: 'muted' }, ' | ');
  const more = overview([
    ['가스 한도 & 사용량', '보낸 사람이 정한 한도 | 실제 사용량 (비율)', t.gasUsed
      ? h('span', {}, formatInteger(t.gasLimit), sep(), formatInteger(t.gasUsed), h('span', { class: 'muted' }, ` (${percent(t.gasUsed, t.gasLimit)})`))
      : formatInteger(t.gasLimit ?? '0')],
    ['가스 수수료', 'Base: 블록의 기본 수수료(소각) · Max: 보낸 사람이 정한 상한 · Max Priority: 블록 생성자에게 주는 팁의 상한',
      t.baseFeePerGasWei || t.maxFeePerGasWei ? h('span', {},
        t.baseFeePerGasWei ? [h('span', { class: 'muted' }, 'Base: '), gwei(t.baseFeePerGasWei)] : null,
        t.maxFeePerGasWei ? [t.baseFeePerGasWei ? sep() : null, h('span', { class: 'muted' }, 'Max: '), gwei(t.maxFeePerGasWei), sep(), h('span', { class: 'muted' }, 'Max Priority: '), gwei(t.maxPriorityFeePerGasWei ?? '0')] : null)
        : undefined],
    ['소각 & 절약 수수료', '소각 = base fee × 사용 가스 (없어지는 코인) · 절약 = (Max − 실제 가격) × 사용 가스',
      t.burntFeeWei != null ? h('span', { class: 'chip-row' },
        h('span', { class: 'chip' }, h('span', { class: 'fire' }, icon(ICON.fire)), '소각: ', eth(t.burntFeeWei)),
        t.savingsFeeWei != null ? h('span', { class: 'chip' }, '💸 절약: ', eth(t.savingsFeeWei)) : null) : undefined],
    ['Blob 가스', 'EIP-4844 blob tx: 사용한 blob 가스 / blob 가스 가격', t.blobGasUsed
      ? `${formatInteger(t.blobGasUsed)} | ${gwei(t.blobGasPriceWei ?? '0')}` : undefined],
    ['기타 속성', 'Txn 유형 · Nonce(보낸 주소의 몇 번째 tx) · 블록 안의 위치', h('span', { class: 'chip-row' },
      h('span', { class: 'chip' }, h('span', { class: 'muted' }, 'Txn 유형: '), TX_TYPE[t.type] ?? String(t.type)),
      h('span', { class: 'chip' }, h('span', { class: 'muted' }, 'Nonce: '), formatInteger(t.nonce)),
      t.position != null ? h('span', { class: 'chip' }, h('span', { class: 'muted' }, '블록 안 위치: '), formatInteger(t.position)) : null)],
    ['입력 데이터', '컨트랙트 함수 호출 내용. 앞 4바이트가 함수 선택자(MethodID)', inputDataView(t.input)],
  ]);
  more.hidden = true;
  const toggle = h('button', { type: 'button', class: 'more-toggle' }, '+ 자세히 보기');
  toggle.onclick = () => { more.hidden = !more.hidden; toggle.textContent = more.hidden ? '+ 자세히 보기' : '− 접기'; };

  return card(null, h('div', { class: 'card-body' }, main, h('hr', { class: 'sep' }), h('div', { class: 'kv-row' }, h('dt', {}, hint('가스 · 수수료 내역과 입력 데이터'), '자세히:'), h('dd', {}, toggle)), more));
}

/** 로그 탭: 이벤트마다 주소 · 이름(서명) · Topics · Data (Etherscan 의 Logs) */
function logsTab(t) {
  if (!t.logs?.length) return card(null, h('div', { class: 'card-body' }, h('div', { class: 'empty' }, '이 트랜잭션은 이벤트 로그를 남기지 않았습니다.')));
  const val = (type, v) => (type === 'address' ? addrLink(v, 20) : h('span', { class: 'mono' }, v));
  const rows = t.logs.map((l) => {
    const d = decodeLog(l);
    const dataView = d.data
      ? h('div', { class: 'log-data' }, d.data.map((x) => h('div', {}, h('span', { class: 'muted' }, `${x.name} (${x.type}) : `), Array.isArray(x.value) ? x.value.join(', ') : val(x.type, x.value))))
      : null;
    const rawView = h('div', { class: 'log-data mono' }, d.words.length ? d.words.map((w) => h('div', {}, w)) : '0x');
    return h('div', { class: 'log' },
      h('div', { class: 'log-index' }, l.logIndex ?? '-'),
      h('dl', { class: 'kv log-kv' },
        h('div', { class: 'kv-row' }, h('dt', {}, '주소'), h('dd', {}, txAddr(t, l.address, { full: true, contract: true }))),
        h('div', { class: 'kv-row' }, h('dt', {}, '이름'), h('dd', {}, d.signature ? h('span', { class: 'mono' }, d.signature) : h('span', { class: 'muted' }, '(사전에 없는 이벤트)'))),
        h('div', { class: 'kv-row' }, h('dt', {}, 'Topics'), h('dd', {}, d.topics.map((tp) => h('div', { class: 'topic' },
          h('span', { class: 'topic-i' }, tp.name ? `${tp.index}: ${tp.name}` : String(tp.index)),
          tp.name ? ['→ ', val(tp.type, tp.value)] : h('span', { class: 'mono' }, tp.value))))),
        h('div', { class: 'kv-row' }, h('dt', {}, 'Data'), h('dd', {}, dataView ? toggleViews([['해석', dataView], ['Hex', rawView]]) : rawView))));
  });
  return card(h('span', {}, '트랜잭션 영수증 이벤트 로그'), h('div', { class: 'card-body' }, rows));
}

/** 내부 트랜잭션 탭 (트레이스). 기본은 값이 오간 호출만, "모든 호출" 을 켜면 전부 */
function internalTab(t) {
  const body = h('div', {}, h('div', { class: 'loading' }, '트레이스 불러오는 중…'));
  api(`/txs/${t.hash}/trace`).then((tr) => {
    const all = h('input', { type: 'checkbox' });
    const table = h('div');
    const draw = () => {
      const calls = all.checked ? tr.calls : tr.calls.filter((c) => BigInt(c.valueWei) > 0n);
      table.replaceChildren(calls.length ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['유형 · 호출 위치', '보낸 주소', '', '받는 주소', '금액', '가스 한도'].map((c, i) => h('th', { class: i >= 4 ? 'num' : null }, c)))),
        h('tbody', {}, calls.map((c) => h('tr', {},
          h('td', {}, h('span', { class: 'method' }, c.type.toLowerCase()), h('span', { class: 'muted small' }, ` call_${c.path}`), c.error ? h('span', { class: 'badge failed', title: c.error }, '실패') : null),
          h('td', {}, txAddr(t, c.from, { copy: false })),
          h('td', { class: 'muted' }, '→'),
          h('td', {}, txAddr(t, c.to, { copy: false })),
          h('td', { class: 'num' }, eth(c.valueWei)),
          h('td', { class: 'num' }, c.gasLimit ? formatInteger(c.gasLimit) : '-')))))) : h('div', { class: 'empty' }, all.checked ? '내부 호출이 없습니다.' : '값이 오간 내부 호출이 없습니다. "모든 호출 보기"를 켜면 전부 보입니다.'));
    };
    all.addEventListener('change', draw);
    draw();
    body.replaceChildren(h('div', { class: 'table-meta' },
      h('span', {}, `내부 호출 ${tr.calls.length}개 (값이 오간 것 ${tr.calls.filter((c) => BigInt(c.valueWei) > 0n).length}개)`),
      h('label', { class: 'small' }, all, ' 모든 호출 보기 (고급)')), table);
  }).catch((err) => body.replaceChildren(h('p', { class: err.message === 'trace_unsupported' ? 'muted' : 'error', style: 'padding:1rem 0' }, errText(err))));
  return card(null, h('div', { class: 'card-body' }, body));
}

/** 상태 탭: 주소마다 잔액 전/후/차이, nonce, 바뀐 저장소 칸 (Etherscan 의 State Differences) */
function stateTab(t) {
  const body = h('div', {}, h('div', { class: 'loading' }, '상태 변화 불러오는 중…'));
  api(`/txs/${t.hash}/state`).then(({ items }) => {
    const diffCell = (b, a) => {
      const d = BigInt(a) - BigInt(b);
      if (d === 0n) return h('span', { class: 'muted' }, '0');
      return h('span', { class: d > 0n ? 'net-in' : 'net-out' }, `${d > 0n ? '▲' : '▼'} ${weiToEth(d < 0n ? -d : d, 18)} ${CHAIN.symbol}`);
    };
    const rows = items.flatMap((s) => {
      const storage = s.storage.length ? h('tr', { class: 'sub-row', hidden: true }, h('td', { colspan: 5 },
        h('div', { class: 'storage' }, h('div', { class: 'muted small' }, '저장소 (Storage) 변화'), s.storage.map((x) => h('div', { class: 'storage-row mono' },
          h('div', {}, h('span', { class: 'muted' }, '칸: '), x.slot),
          h('div', {}, h('span', { class: 'muted' }, '전: '), x.before),
          h('div', {}, h('span', { class: 'muted' }, '후: '), x.after)))))) : null;
      const expand = storage ? h('button', { type: 'button', class: 'expand', 'aria-label': '저장소 변화 펼치기' }, '▸') : h('span', { class: 'expand' });
      expand.onclick = () => { storage.hidden = !storage.hidden; expand.textContent = storage.hidden ? '▸' : '▾'; };
      return [h('tr', {},
        h('td', {}, expand),
        h('td', {}, txAddr(t, s.address, { copy: false, keep: 8 })),
        h('td', {}, eth(s.balanceBefore), s.nonceBefore !== s.nonceAfter ? h('div', {}, h('span', { class: 'chip' }, `Nonce: ${s.nonceBefore}`)) : null),
        h('td', {}, eth(s.balanceAfter), s.nonceBefore !== s.nonceAfter ? h('div', {}, h('span', { class: 'chip' }, `Nonce: ${s.nonceAfter}`)) : null),
        h('td', { class: 'num' }, diffCell(s.balanceBefore, s.balanceAfter))), storage];
    });
    body.replaceChildren(
      h('p', { class: 'muted small' }, '이 트랜잭션이 실행되며 바뀐 상태입니다. 잔액은 수수료가 빠진 뒤의 값, ▸ 를 누르면 컨트랙트 저장소의 바뀐 칸이 보입니다.'),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['', '주소', '전', '후', '상태 차이'].map((c, i) => h('th', { class: i === 4 ? 'num' : null }, c)))),
        h('tbody', {}, rows))));
  }).catch((err) => body.replaceChildren(h('p', { class: err.message === 'trace_unsupported' ? 'muted' : 'error', style: 'padding:1rem 0' }, errText(err))));
  return card(h('span', {}, '상태 변화 (State Differences)'), h('div', { class: 'card-body' }, body));
}

/** EIP-7702 위임 목록 */
function authorizationsTab(t) {
  return card(null, h('div', { class: 'card-body' },
    h('p', { class: 'muted small' }, '서명한 주소(authority)가 자기 주소의 코드를 아래 컨트랙트에 맡긴다는 위임 목록입니다. authority 는 서명에서 복원해야 해서 여기서는 보여주지 않습니다.'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['#', '위임 대상 (Delegate to)', 'Chain ID', 'Nonce'].map((c) => h('th', {}, c)))),
      h('tbody', {}, t.authorizationList.map((a, i) => h('tr', {},
        h('td', {}, String(i)), h('td', {}, addr(a.address, { full: true, label: labelFor(t, a.address) })),
        h('td', {}, a.chainId === '0' ? '0 (모든 체인)' : a.chainId), h('td', {}, a.nonce))))))));
}

/* ── 화면: 토큰 (Etherscan 의 Token 페이지: 개요 · 전송 · 홀더) ─────────────── */

/** 수집 진행 문구: "블록 N 까지 반영 (최신과 M 블록 차이)" */
function syncText(tk) {
  if (!tk.tracked) return null;
  if (tk.syncedBlock == null) return `블록 ${formatInteger(tk.startBlock)} 부터 모으기 시작하는 중`;
  const behind = BigInt(tk.head) - BigInt(tk.syncedBlock);
  return `블록 ${formatInteger(tk.syncedBlock)} 까지 반영${behind > 0n ? ` · 최신과 ${formatInteger(behind.toString())} 블록 차이` : ''}`;
}

async function tokenView(address, sub, holder) {
  const tk = await api(`/tokens/${address}`);
  const sym = tk.symbol ?? '';
  const supply = tk.totalSupply;
  const units = (raw) => `${tokenAmount(raw, tk.decimals)} ${sym}`.trim();
  const tab = sub === 'holders' ? 'holders' : 'transfers';
  const base = `#/token/${tk.address}`;

  const cards = h('div', { class: 'addr-cards' },
    card('개요', h('div', { class: 'card-body' },
      h('div', { class: 'mini-label' }, '최대 총 공급량'),
      h('div', { class: 'mini-value' }, supply != null ? units(supply) : '-'),
      h('div', { class: 'mini-label' }, '홀더'),
      h('div', { class: 'mini-value' }, tk.holders != null ? formatInteger(String(tk.holders)) : '-'),
      h('div', { class: 'mini-label' }, '전송 (전체)'),
      h('div', { class: 'mini-value' }, tk.transfers != null ? formatInteger(tk.transfers) : '-'))),
    card('기타 정보', h('div', { class: 'card-body' },
      h('div', { class: 'mini-label' }, `토큰 컨트랙트 (소수점 ${tk.decimals ?? '?'}자리)`),
      h('div', { class: 'mini-value' }, addr(tk.address, { full: true, contract: true })),
      h('div', { class: 'mini-label' }, '홀더 추적'),
      h('div', { class: 'mini-value' }, tk.tracked
        ? h('span', {}, h('span', { class: 'badge success' }, '추적 중'), ' ', h('span', { class: 'muted small' }, syncText(tk)))
        : tk.tracked === false
          ? h('span', {}, h('span', { class: 'badge neutral' }, '추적 안 함'), h('div', { class: 'muted small' }, 'worker 의 TOKENS 에 이 주소를 넣으면(예: ', h('code', {}, `${tk.address}@배포블록`), ') 배포 이후 전송을 모아 홀더 순위를 만듭니다.'))
          : h('span', { class: 'muted' }, 'DB 에 연결할 수 없습니다')))));

  // 홀더 한 명으로 거른 보기 (Etherscan: /token/0x…?a=0x…)
  let filterCard = null;
  if (holder && tk.tracked) {
    const bal = h('span', {}, '…');
    filterCard = card(h('span', {}, '홀더로 거르기', h('a', { href: base, class: 'small', style: 'font-weight:400' }, '거르기 해제 ✕')), h('div', { class: 'card-body filter-card' },
      h('div', {}, h('div', { class: 'mini-label' }, '주소'), addr(holder, { full: true })),
      h('div', {}, h('div', { class: 'mini-label' }, '잔액'), bal)));
    api(`/tokens/${tk.address}/transfers?limit=1&holder=${holder}`)
      .then((p) => bal.replaceChildren(units(p.holderBalance), supply ? h('span', { class: 'muted' }, ` (${sharePercent(p.holderBalance, supply)})`) : null))
      .catch(() => bal.replaceChildren('-'));
  }

  const tabs = tabBar([
    ['transfers', '전송', base],
    holder ? null : ['holders', '홀더', `${base}/holders`],
  ], tab);

  let body;
  if (!tk.tracked) {
    body = card(null, h('div', { class: 'card-body' }, h('div', { class: 'empty' },
      tk.tracked === false ? '추적 중인 토큰이 아니라 전송·홀더 목록이 없습니다.' : 'DB 에 연결할 수 없어 목록을 불러오지 못했습니다.')));
  } else if (tab === 'holders') {
    body = holdersTab(tk, units);
  } else {
    body = pagedTxCard(null,
      (cursor) => api(`/tokens/${tk.address}/transfers?limit=25${holder ? `&holder=${holder}` : ''}${cursor ? `&cursor=${cursor}` : ''}`),
      null,
      {
        render: (p) => tokenTransferTable(p.items.map((x) => ({ ...x, tokenDecimals: tk.decimals })), { holder }),
        metaText: (p) => (holder ? '이 주소가 보내거나 받은 전송, 최신순' : `전체 ${formatInteger(p.total)}건의 전송, 최신순`),
      });
  }

  return {
    nodes: [page(
      pageTitle(h('span', { class: 'token-title' }, h('span', { class: 'token-icon lg' }, icon(ICON.coin)), '토큰 ', h('strong', {}, tk.name ?? shortHex(tk.address, 6)), sym ? h('span', { class: 'muted' }, ` (${sym})`) : null),
        h('span', { class: 'badge neutral' }, 'ERC-20')),
      cards,
      filterCard,
      filterCard ? h('div', { style: 'height:1rem' }) : null,
      tabs,
      body,
    )],
  };
}

/**
 * 홀더 탭: 분포 요약 카드 · 집중도 막대 · 보유량 구간 · 순위표 (Etherscan 의 Holders).
 * 비율은 총발행량(totalSupply) 대비. 총발행량을 모르면 지금 홀더들이 가진 합 대비.
 */
function holdersTab(tk, units) {
  const summaryBox = h('div', {}, h('div', { class: 'loading' }, '분포 계산 중…'));
  const tableBox = h('div', {}, h('div', { class: 'loading' }, '불러오는 중…'));
  const pageSize = 50;
  let whole = tk.totalSupply;

  api(`/tokens/${tk.address}/holders/summary`).then((s) => {
    whole ??= s.totalHeld;
    summaryBox.replaceChildren(holderSummary(tk, s, whole, units));
  }).catch((err) => summaryBox.replaceChildren(h('p', { class: 'error' }, errText(err))));

  async function load(pageNo) {
    try {
      const p = await api(`/tokens/${tk.address}/holders?page=${pageNo}&limit=${pageSize}`);
      const w = whole ?? tk.totalSupply;
      const pager = h('div', { class: 'pager' },
        h('button', { type: 'button', disabled: p.page <= 1, onclick: () => load(1) }, '처음'),
        h('button', { type: 'button', disabled: p.page <= 1, onclick: () => load(p.page - 1), 'aria-label': '이전 페이지' }, '‹'),
        h('span', { class: 'page-of' }, `${formatInteger(String(p.page))} / ${formatInteger(String(p.totalPages))} 페이지`),
        h('button', { type: 'button', disabled: p.page >= p.totalPages, onclick: () => load(p.page + 1), 'aria-label': '다음 페이지' }, '›'),
        h('button', { type: 'button', disabled: p.page >= p.totalPages, onclick: () => load(p.totalPages) }, '마지막'));
      const table = p.items.length ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['순위', '주소', '수량', '비율'].map((c, i) => h('th', { class: i >= 2 ? 'num' : null }, c)))),
        h('tbody', {}, p.items.map((x) => h('tr', {},
          h('td', {}, String(x.rank)),
          h('td', {}, addr(x.address, {
            keep: 10,
            contract: x.isContract,
            href: `#/token/${tk.address}?a=${x.address}`,
            label: x.address === tk.address ? '토큰 컨트랙트' : labelFor({ tokens: {} }, x.address),
          })),
          h('td', { class: 'num' }, tokenAmount(x.balance, tk.decimals)),
          h('td', { class: 'num' }, w ? h('div', { class: 'pct' },
            h('span', {}, sharePercent(x.balance, w)),
            h('span', { class: 'pct-bar', title: sharePercent(x.balance, w) }, h('span', { style: `width:${Math.max(1, ratio(x.balance, w) * 100)}%` }))) : '-'))))))
        : h('div', { class: 'empty' }, '아직 홀더가 없습니다.');
      tableBox.replaceChildren(
        h('div', { class: 'table-meta' },
          h('span', {}, `전체 ${formatInteger(String(p.total))}명의 홀더`, h('span', { class: 'muted small' }, ` · 블록 ${p.syncedBlock ? formatInteger(p.syncedBlock) : '-'} 기준`)),
          h('span', { class: 'chip-row' },
            h('a', { class: 'chip-btn', href: `/api/v1/tokens/${tk.address}/holders.csv`, download: '' }, icon(ICON.download), ' 전체 CSV'),
            pager)),
        table);
    } catch (err) {
      tableBox.replaceChildren(h('p', { class: 'error' }, errText(err)));
    }
  }
  load(1);

  return h('div', {}, summaryBox, card(null, h('div', { class: 'card-body' }, tableBox)));
}

/** 상위 구간별 몫 (Etherscan Holder Concentration 의 Top 1-5 / 6-10 / … / Outside 100) */
const CONC_SLOTS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)', 'var(--series-other)'];

function holderSummary(tk, s, whole, units) {
  const pct = (part) => sharePercent(part, whole, 2);
  const gini = giniFromSummary(s);
  const statCard = (label, value, sub) => h('div', { class: 'card holder-stat' },
    h('div', { class: 'mini-label' }, label), h('div', { class: 'stat-big' }, value), sub && h('div', { class: 'small muted' }, sub));

  const cards = h('div', { class: 'holder-stats' },
    statCard('상위 100 집중도', pct(s.top100), h('span', {}, '상위 5 홀더: ', h('strong', {}, pct(s.top5)), ' | 상위 10 홀더: ', h('strong', {}, pct(s.top10)))),
    statCard('지니 계수', gini == null ? '-' : gini.toFixed(4), `0 = 고르게, 1 = 한 곳에 몰림 · 1% 이상 보유 홀더 ${formatInteger(String(s.over1pct))}명`),
    statCard('홀더', formatInteger(String(s.holders)), `홀더들이 가진 합: ${units(s.totalHeld)}`));

  // 구간별 몫. 누적값의 차이로 만든다. 홀더가 적으면 빈 구간은 0
  const big = (v) => BigInt(v);
  const segs = [
    ['상위 1-5', big(s.top5)],
    ['6-10', big(s.top10) - big(s.top5)],
    ['11-25', big(s.top25) - big(s.top10)],
    ['26-50', big(s.top50) - big(s.top25)],
    ['51-100', big(s.top100) - big(s.top50)],
    ['100위 밖', big(whole) - big(s.top100) > 0n ? big(whole) - big(s.top100) : 0n],
  ];
  const bar = h('div', { class: 'seg-bar', role: 'img', 'aria-label': '상위 구간별 보유 비중' },
    segs.filter(([, v]) => v > 0n).map(([label, v]) => {
      const i = segs.findIndex(([l]) => l === label);
      return h('span', { class: 'seg', style: `flex-grow:${ratio(v.toString(), whole)};background:${CONC_SLOTS[i]}`, title: `${label}: ${pct(v.toString())} (${units(v.toString())})` });
    }));
  const legend = h('table', { class: 'seg-legend' }, h('tbody', {}, segs.map(([label, v], i) => h('tr', {},
    h('td', {}, h('span', { class: 'swatch', style: `background:${CONC_SLOTS[i]}` }), label),
    h('td', { class: 'num' }, pct(v.toString())),
    h('td', { class: 'num muted' }, units(v.toString()))))));
  const concentration = card('홀더 집중도', h('div', { class: 'card-body viz-root' },
    h('p', { class: 'muted small' }, tk.totalSupply ? '총발행량 대비. "100위 밖"은 나머지 홀더들(과 아직 어디에도 없는 양)의 몫입니다.' : '홀더들이 가진 합 대비.'),
    bar, legend));

  // 보유량 구간: "N 개 이상 가진 지갑 수" (Etherscan 은 달러 기준, 여기는 토큰 수량 기준)
  const depth = walletDepth(s.magnitudes, tk.decimals);
  const max = Math.max(1, ...depth.map((d) => d.count));
  const depthCard = card('보유량별 지갑 수', h('div', { class: 'card-body viz-root' },
    h('p', { class: 'muted small' }, `${tk.symbol ?? '토큰'} 을 이만큼 이상 가진 지갑 수 (누적)`),
    depth.length ? h('div', { class: 'depth' }, depth.map((d) => h('div', { class: 'depth-row', title: `≥ ${d.threshold} ${tk.symbol ?? ''}: ${formatInteger(String(d.count))}개 지갑` },
      h('span', { class: 'depth-label' }, `≥ ${d.threshold}`),
      h('span', { class: 'depth-track' }, h('span', { class: 'depth-bar', style: `width:${(d.count / max) * 100}%` })),
      h('span', { class: 'depth-value' }, formatInteger(String(d.count)))))) : h('div', { class: 'empty' }, '홀더가 없습니다.')));

  return h('div', {}, cards, h('div', { class: 'addr-cards' }, concentration, depthCard));
}

/** 추적 중인 토큰 목록 (Etherscan 의 Token Tracker) */
async function tokensView() {
  const { items, head } = await api('/tokens');
  const table = items.length ? h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ['#', '토큰', '홀더', '전송', '수집 진행'].map((c, i) => h('th', { class: i === 2 || i === 3 ? 'num' : null }, c)))),
    h('tbody', {}, items.map((t, i) => h('tr', {},
      h('td', {}, String(i + 1)),
      h('td', {}, tokenLink(t.address, t), h('div', { class: 'small muted mono' }, t.address)),
      h('td', { class: 'num' }, link(`#/token/${t.address}/holders`, formatInteger(String(t.holders)))),
      h('td', { class: 'num' }, formatInteger(t.transfers)),
      h('td', { class: 'small muted' }, syncText({ ...t, tracked: true, head })))))))
    : h('div', { class: 'empty' }, '추적 중인 토큰이 없습니다. worker 에 TOKENS=0x토큰주소@배포블록 을 설정하세요.');
  return { nodes: [page(pageTitle('토큰', h('span', { class: 'sub' }, '홀더를 추적하는 ERC-20')), card(null, h('div', { class: 'card-body' }, table)))] };
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
    ['생성자 (Fee Recipient)', '블록을 만들고 우선순위 수수료를 받은 주소', b.miner?.toLowerCase() === ZERO_ADDR
      ? h('span', {}, h('span', { class: 'mono' }, b.miner), h('span', { class: 'muted' }, ' — PoA 체인: 블록 서명자는 extraData 의 서명에 들어 있다'))
      : h('span', {}, link(`#/address/${b.miner}`, b.miner, 'mono'), copyBtn(b.miner))],
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

async function addressView(address, sub) {
  const a = await api(`/addresses/${address}`);
  const isContract = a.type === 'contract';
  const tab = sub === 'tokentxns' ? 'tokentxns' : 'txs';

  // 토큰 보유 (추적 중인 토큰만) — Etherscan 의 TOKEN HOLDINGS
  const holdings = h('div', { class: 'mini-value' }, h('span', { class: 'muted' }, '…'));
  api(`/addresses/${address}/tokens`).then(({ items }) => {
    if (!items.length) { holdings.replaceChildren(h('span', { class: 'muted' }, '없음 (추적 중인 토큰 기준)')); return; }
    holdings.replaceChildren(h('details', { class: 'holdings' },
      h('summary', {}, `토큰 ${items.length}종`),
      h('div', {}, items.map((x) => h('div', { class: 'holding' },
        tokenLink(x.token, x),
        h('a', { href: `#/token/${x.token}?a=${address}`, class: 'num' }, `${tokenAmount(x.balance, x.decimals, 6)} ${x.symbol ?? ''}`))))));
  }).catch(() => holdings.replaceChildren(h('span', { class: 'muted' }, '-')));

  // 이 컨트랙트가 토큰이면 "토큰 트래커" (Etherscan 의 More Info)
  const tracker = h('div', { hidden: true });
  if (isContract) {
    api(`/tokens/${address}`).then((tk) => {
      tracker.replaceChildren(h('div', { class: 'mini-label' }, '토큰 트래커'), h('div', { class: 'mini-value' }, tokenLink(tk.address, tk),
        tk.tracked ? h('span', { class: 'muted small' }, ` · 홀더 ${formatInteger(String(tk.holders))}명`) : null));
      tracker.hidden = false;
    }).catch(() => {});
  }

  const cards = h('div', { class: 'addr-cards' },
    card('개요', h('div', { class: 'card-body' },
      h('div', { class: 'mini-label' }, `${CHAIN.symbol} 잔액`),
      h('div', { class: 'mini-value' }, eth(a.balanceWei)),
      h('div', { class: 'mini-label' }, '토큰 보유'),
      holdings)),
    card('추가 정보', h('div', { class: 'card-body' },
      h('div', { class: 'mini-label' }, '유형'),
      h('div', { class: 'mini-value' }, isContract ? '컨트랙트' : '개인 지갑 (EOA)'),
      h('div', { class: 'mini-label' }, isContract ? 'Nonce (만든 컨트랙트 수)' : '보낸 트랜잭션 수 (Nonce)'),
      h('div', { class: 'mini-value' }, formatInteger(a.nonce)),
      a.delegatedTo ? [h('div', { class: 'mini-label' }, 'EIP-7702 위임 대상'), h('div', { class: 'mini-value' }, addr(a.delegatedTo, { contract: true }))] : null,
      tracker)));

  const base = `#/address/${address}`;
  const tabs = tabBar([['txs', '트랜잭션', base], ['tokentxns', '토큰 전송 (ERC-20)', `${base}/tokentxns`]], tab);
  const list = tab === 'tokentxns'
    ? pagedTxCard(null, (cursor) => api(`/addresses/${address}/token-transfers?limit=25${cursor ? `&cursor=${cursor}` : ''}`), null, {
      render: (p) => tokenTransferTable(p.items, { holder: address, showToken: true }),
      metaText: () => '추적 중인 토큰에서 이 주소가 보내거나 받은 전송, 최신순 (보관 기간 없음)',
    })
    : pagedTxCard(null, (cursor) => api(`/addresses/${address}/txs?limit=25${cursor ? `&cursor=${cursor}` : ''}`), { address });

  return {
    nodes: [page(
      pageTitle(isContract ? '컨트랙트' : '주소', h('span', { class: 'mono sub' }, a.address), copyBtn(a.address)),
      cards,
      tabs,
      list,
    )],
  };
}

/* ── 라우터 ─────────────────────────────────────────────────────────────── */

const ADDR = '(0x[0-9a-fA-F]{40})';
const routes = [
  [/^#\/?$/, homeView, 'home'],
  [/^#\/blocks$/, blocksView, 'blocks'],
  [/^#\/txs$/, txsView, 'txs'],
  [/^#\/tokens$/, tokensView, 'tokens'],
  [/^#\/tx\/(0x[0-9a-fA-F]{64})(?:\/(logs|internal|state|authorizations))?$/, txView, 'txs'],
  [/^#\/block\/(latest|\d+)$/, blockView, 'blocks'],
  [new RegExp(`^#/address/${ADDR}(?:/(tokentxns))?$`), addressView, null],
  // #/token/{주소}, #/token/{주소}/holders, #/token/{주소}?a={홀더}
  [new RegExp(`^#/token/${ADDR}(?:/(holders))?(?:\\?a=${ADDR})?$`), (t, sub, holder) => tokenView(t, sub, holder?.toLowerCase()), 'tokens'],
];

let renderSeq = 0;
let refreshTimer = null;

async function render() {
  const seq = ++renderSeq; // 느린 이전 요청이 나중에 도착해 화면을 덮어쓰지 않게
  clearInterval(refreshTimer);
  const hash = location.hash || '#/';
  const route = routes.find(([re]) => re.test(hash));
  const [re, fn, navKey] = route ?? routes[0];
  const args = route ? hash.match(re).slice(1) : [];


  // 홈에는 큰 검색 배너가 있으므로 상단 바의 작은 검색창은 숨긴다
  topSearch.hidden = fn === homeView;
  for (const a of document.querySelectorAll('.nav a')) {
    a.classList.toggle('active', a.getAttribute('href') === `#/${navKey === 'home' ? '' : navKey}`);
  }

  view.replaceChildren(h('div', { class: 'loading' }, '불러오는 중…'));
  try {
    const out = await fn(...args);
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

/** 체인 정보를 받아 이름·단위를 정하고 고정 문구(상단 로고·제목·하단)를 채운다 */
async function loadChain() {
  try {
    Object.assign(CHAIN, await api('/chain'));
  } catch { /* 못 받으면 기본값(Ethereum/ETH)으로 */ }
  try {
    for (const t of (await api('/tokens')).items) TRACKED.set(t.address, t);
  } catch { /* DB 없이 띄운 경우: 토큰 검색·이름표 없이 */ }
  document.title = `${CHAIN.name} Explorer`;
  $('#brand-name').textContent = `${CHAIN.name} Explorer`;
  $('#footer-chain').textContent = `${CHAIN.name} (chainId ${CHAIN.chainId ?? '?'})`;
}

window.addEventListener('hashchange', render);
loadChain().then(render);

/* ── 상단 바: 테마 (자동 → 밝게 → 어둡게) ─────────────────────────────── */

const THEMES = [
  ['auto', '자동', 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 2v16a8 8 0 0 1 0-16Z'],
  ['light', '밝게', 'M12 7a5 5 0 1 1 0 10 5 5 0 0 1 0-10ZM11 1h2v3h-2V1Zm0 19h2v3h-2v-3ZM1 11h3v2H1v-2Zm19 0h3v2h-3v-2ZM4.2 2.8l2.1 2.1-1.4 1.4-2.1-2.1 1.4-1.4Zm14.9 14.9 2.1 2.1-1.4 1.4-2.1-2.1 1.4-1.4ZM2.8 19.8l2.1-2.1 1.4 1.4-2.1 2.1-1.4-1.4ZM17.7 4.9l2.1-2.1 1.4 1.4-2.1 2.1-1.4-1.4Z'],
  ['dark', '어둡게', 'M14 2a9 9 0 1 0 8 13.1A8 8 0 0 1 14 2Z'],
];

function currentTheme() {
  const t = document.documentElement.dataset.theme;
  return t === 'light' || t === 'dark' ? t : 'auto';
}

function applyTheme(t) {
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try {
    if (t === 'auto') localStorage.removeItem('theme');
    else localStorage.setItem('theme', t);
  } catch { /* 저장 못 해도 이번 화면에는 적용된다 */ }
  const [, label, path] = THEMES.find(([k]) => k === t);
  const btn = $('#theme-toggle');
  btn.replaceChildren(icon(path), `테마: ${label}`);
  btn.title = '누를 때마다 자동 → 밝게 → 어둡게';
}

$('#theme-toggle').addEventListener('click', () => {
  const i = THEMES.findIndex(([k]) => k === currentTheme());
  applyTheme(THEMES[(i + 1) % THEMES.length][0]);
});
applyTheme(currentTheme());

/* ── 상단 바: 연결 상태 ─────────────────────────────────────────────────── */

async function refreshStatus() {
  const el = $('#status');
  try {
    const s = await api('/health');
    el.dataset.state = 'ok';
    el.textContent = `${CHAIN.name} · #${formatInteger(s.block)}`;
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

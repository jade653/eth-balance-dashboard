/**
 * 화면 진입점.
 *
 * 화면 전환은 URL 의 # 뒤(해시)로 한다:  #/tx/0x…  #/block/123  #/address/0x…
 * 해시가 바뀌어도 브라우저는 서버에 새 페이지를 요청하지 않는다. 그래서 서버(nginx)는
 * 언제나 index.html 하나만 주면 되고, 주소창 링크를 공유·새로고침해도 같은 화면이 뜬다.
 *
 * API 는 상대경로(/api/v1/…)로 부른다. /api 를 서버로 넘기는 건 앞단 프록시의 일이다.
 * 체인에서 온 값은 전부 textContent 로만 넣는다 (innerHTML 금지 → XSS 차단).
 */
import { formatInteger, weiToEth, shortHex, routeForQuery } from './format.js';

const $ = (id) => document.getElementById(id);
const view = $('view');

/** 작은 DOM 생성 도우미. 문자열 자식은 텍스트 노드가 된다(HTML 로 해석되지 않는다). */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') el.className = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

const link = (href, text, cls = 'mono') => h('a', { href, class: cls }, text);
const addrLink = (a) => (a ? link(`#/address/${a}`, a) : h('span', { class: 'muted' }, '—'));
const blockLink = (n) => link(`#/block/${n}`, formatInteger(n), '');
const eth = (wei, digits = 18) => `${weiToEth(wei, digits)} ETH`;
const gwei = (wei) => `${weiToEth(BigInt(wei) * 10n ** 9n, 4)} gwei`; // wei → gwei 표시

/** 키-값 표. rows = [[라벨, 값], ...], 값이 undefined 인 행은 건너뛴다 */
const kv = (rows) =>
  h('dl', { class: 'kv' }, rows.filter(([, v]) => v !== undefined).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));

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

/* ── 화면들 ─────────────────────────────────────────────────────────────── */

async function txView(hash) {
  const t = await api(`/txs/${hash}`);
  const rows = [
    ['tx 해시', h('span', { class: 'mono' }, t.hash)],
    ['상태', h('span', { class: `badge ${t.status}` }, { success: '성공', failed: '실패', pending: '대기 중' }[t.status])],
    ['블록', t.blockNumber ? blockLink(t.blockNumber) : undefined],
    ['시각', t.timestamp ? new Date(t.timestamp).toLocaleString() : undefined],
    ['보낸 주소', addrLink(t.from)],
    ['받는 주소', t.to ? addrLink(t.to) : h('span', {}, '컨트랙트 생성 → ', addrLink(t.contractCreated))],
    ['금액', eth(t.valueWei)],
    ['수수료', t.feeWei ? eth(t.feeWei) : undefined],
    ['가스', t.gasUsed ? `${formatInteger(t.gasUsed)} / ${formatInteger(t.gasLimit)}` : undefined],
    ['가스 가격', t.gasPriceWei ? gwei(t.gasPriceWei) : undefined],
    ['nonce', t.nonce],
    ['종류', t.input && t.input !== '0x' ? '컨트랙트 호출' : '송금'],
    ['이벤트 로그', t.logCount !== undefined ? `${t.logCount}개` : undefined],
  ];
  return [h('h2', {}, '트랜잭션'), kv(rows)];
}

async function blockView(id) {
  const b = await api(`/blocks/${id}`);
  const prev = BigInt(b.number) > 0n ? link(`#/block/${BigInt(b.number) - 1n}`, '← 이전', '') : null;
  return [
    h('h2', {}, `블록 #${formatInteger(b.number)} `, prev, ' ', link(`#/block/${BigInt(b.number) + 1n}`, '다음 →', '')),
    kv([
      ['블록 해시', h('span', { class: 'mono' }, b.hash)],
      ['시각', new Date(b.timestamp).toLocaleString()],
      ['생성자', addrLink(b.miner)],
      ['가스 사용', `${formatInteger(b.gasUsed)} / ${formatInteger(b.gasLimit)}`],
      ['기본 수수료', b.baseFeePerGasWei ? gwei(b.baseFeePerGasWei) : undefined],
      ['tx 수', formatInteger(String(b.txCount))],
    ]),
    h('ul', { class: 'txs' }, b.transactions.map((tx) => h('li', {}, link(`#/tx/${tx}`, shortHex(tx, 10))))),
  ];
}

async function addressView(address) {
  // 잔액은 노드에서, tx 목록은 DB 에서. 둘 중 목록만 실패해도 잔액은 보여준다.
  const [a, list] = await Promise.all([
    api(`/addresses/${address}`),
    api(`/addresses/${address}/txs`).catch((err) => err),
  ]);
  return [
    h('h2', {}, a.type === 'contract' ? '컨트랙트' : '주소'),
    kv([
      ['주소', h('span', { class: 'mono' }, a.address)],
      ['잔액', eth(a.balanceWei)],
      ['nonce', a.nonce],
    ]),
    txListSection(address, list),
  ];
}

const DIRECTION = { in: '받음', out: '보냄', self: '자기 자신' };

/** 주소의 tx 목록 + "더 보기" (커서로 다음 페이지) */
function txListSection(address, first) {
  const section = h('section', { class: 'txlist' });
  if (first instanceof Error) {
    section.append(h('p', { class: 'error' }, ERROR_TEXT[first.message] ?? `tx 목록 오류: ${first.message}`));
    return section;
  }

  const c = first.coverage;
  section.append(
    h('h3', {}, '최근 tx'),
    h('p', { class: 'muted' }, c
      ? `인덱서가 보관 중인 범위만 보입니다: 블록 ${formatInteger(c.fromBlock)} ~ ${formatInteger(c.toBlock)} (${new Date(c.fromTime).toLocaleString()} 이후)`
      : '인덱서가 아직 블록을 쌓지 않았습니다.'),
  );

  const tbody = h('tbody');
  const table = h('table', {}, h('thead', {}, h('tr', {},
    h('th', {}, 'tx'), h('th', {}, '블록'), h('th', {}, '시각'), h('th', {}, ''), h('th', {}, '상대 주소'), h('th', { class: 'num' }, '금액'))), tbody);
  const more = h('button', { type: 'button' }, '더 보기');

  const append = (page) => {
    for (const t of page.items) {
      const other = t.direction === 'in' ? t.from : t.to;
      tbody.append(h('tr', {},
        h('td', {}, link(`#/tx/${t.hash}`, shortHex(t.hash, 6))),
        h('td', {}, blockLink(t.blockNumber)),
        h('td', { class: 'muted' }, new Date(t.timestamp).toLocaleTimeString()),
        h('td', {}, h('span', { class: `badge ${t.direction}` }, DIRECTION[t.direction])),
        h('td', {}, other ? link(`#/address/${other}`, shortHex(other, 6)) : h('span', { class: 'muted' }, '컨트랙트 생성')),
        h('td', { class: 'num' }, eth(t.valueWei, 6)),
      ));
    }
    more.hidden = !page.nextCursor;
    more.onclick = async () => {
      more.disabled = true;
      try {
        append(await api(`/addresses/${address}/txs?cursor=${page.nextCursor}`));
      } finally {
        more.disabled = false;
      }
    };
  };

  if (first.items.length === 0) {
    section.append(h('p', {}, '이 기간에는 tx 가 없습니다.'));
  } else {
    section.append(h('div', { class: 'table-wrap' }, table), more);
    append(first);
  }
  return section;
}

const homeView = () => blockView('latest');

/* ── 라우터 ─────────────────────────────────────────────────────────────── */

const routes = [
  [/^#\/tx\/(0x[0-9a-fA-F]{64})$/, txView],
  [/^#\/block\/(latest|\d+)$/, blockView],
  [/^#\/address\/(0x[0-9a-fA-F]{40})$/, addressView],
];

const ERROR_TEXT = {
  not_found: '찾을 수 없습니다.',
  rpc_unavailable: '노드(RPC)에 연결할 수 없습니다. 잠시 후 다시 시도하세요.',
  db_unavailable: 'DB 에 연결할 수 없어 tx 목록을 불러오지 못했습니다.',
};

let renderSeq = 0;
async function render() {
  const seq = ++renderSeq; // 느린 이전 요청이 나중에 도착해 화면을 덮어쓰지 않게
  const hash = location.hash;
  const route = routes.find(([re]) => re.test(hash));
  const fn = route ? (...a) => route[1](...a) : homeView;
  const arg = route ? hash.match(route[0])[1] : undefined;

  view.replaceChildren(h('p', { class: 'muted' }, '불러오는 중…'));
  try {
    const nodes = await fn(arg);
    if (seq === renderSeq) view.replaceChildren(...nodes);
  } catch (err) {
    if (seq !== renderSeq) return;
    const msg = ERROR_TEXT[err.message] ?? `오류: ${err.message}`;
    view.replaceChildren(h('p', { class: 'error' }, msg));
  }
}

/* ── 검색 ───────────────────────────────────────────────────────────────── */

$('search').addEventListener('submit', (e) => {
  e.preventDefault();
  const target = routeForQuery($('q').value);
  $('search-error').hidden = !!target;
  if (!target) {
    $('search-error').textContent = 'tx 해시(0x+64자), 주소(0x+40자), 블록 번호 중 하나를 입력하세요.';
    return;
  }
  if (location.hash === target) render();
  else location.hash = target;
});

/* ── 서버 상태 표시 ─────────────────────────────────────────────────────── */

async function refreshStatus() {
  const el = $('status');
  try {
    const s = await api('/health');
    el.dataset.state = 'ok';
    el.textContent = `chainId ${s.chainId} · #${formatInteger(s.block)}`;
  } catch (err) {
    el.dataset.state = 'error';
    el.textContent = err.message === 'rpc_unavailable' ? 'RPC 연결 끊김' : '서버 연결 끊김';
  }
}

window.addEventListener('hashchange', render);
render();
refreshStatus();
setInterval(refreshStatus, 12_000);

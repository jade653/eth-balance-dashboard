'use strict';

/* ───────────────────────────────────────────────────────────────────────────
   프론트엔드는 "계산"을 하지 않는다. 서버가 보낸 스냅샷을 그대로 그린다.
   여기서 하는 일은 3가지뿐:
     1) SSE로 스냅샷 수신
     2) wei(정수 문자열) -> 사람이 읽는 문자열로 포맷
     3) 바뀐 부분만 DOM에 반영 (행을 통째로 다시 만들지 않는다)
   ─────────────────────────────────────────────────────────────────────────── */

const WEI_DECIMALS = 18;

const el = (id) => document.getElementById(id);
const ui = {
  status: el('status'),
  statusLabel: el('status-label'),
  blockTicker: el('block-ticker'),
  blockNumber: el('block-number'),
  rpcMeta: el('rpc-meta'),
  banner: el('error-banner'),
  kpiTotal: el('kpi-total'),
  kpiTotalDelta: el('kpi-total-delta'),
  kpiCount: el('kpi-count'),
  kpiChanged: el('kpi-changed'),
  kpiBlockTime: el('kpi-blocktime'),
  kpiBaseFee: el('kpi-basefee'),
  kpiUpdated: el('kpi-updated'),
  kpiLatency: el('kpi-latency'),
  rows: el('rows'),
  filter: el('filter'),
  footRpc: el('foot-rpc'),
  footPoll: el('foot-poll'),
};

// 기본은 'config' = config.json 의 addresses 순서. 잔액순으로 정렬하면 감시 대상인
// 잔액 0 주소가 항상 참고용 대형 주소(WETH 등) 밑으로 밀려 화면에서 사라진다.
const view = { sort: 'config', query: '' };
const state = { snapshot: null, lastBlock: null, rows: new Map() };

/* ── 포맷 유틸 ──────────────────────────────────────────────────────────── */

// wei 10진 문자열 -> { neg, int, frac }. Number로 변환하면 정밀도가 깨지므로
// 문자열 그대로 자릿수를 나눈다. (1 ETH = 10^18 wei, double의 안전 정수 범위 초과)
function splitWei(wei, dp = 4) {
  const neg = wei.startsWith('-');
  const abs = neg ? wei.slice(1) : wei;
  const padded = abs.padStart(WEI_DECIMALS + 1, '0');
  const intPart = padded.slice(0, -WEI_DECIMALS).replace(/^0+(?=\d)/, '');
  const fracPart = padded.slice(-WEI_DECIMALS).slice(0, dp);
  return { neg, int: intPart, frac: fracPart };
}

const group = (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function formatEth(wei, dp = 4) {
  const { neg, int, frac } = splitWei(wei, dp);
  return `${neg ? '-' : ''}${group(int)}.${frac}`;
}

// 변동값은 유효숫자가 작으므로 소수점을 더 길게 보여준다
function formatDelta(wei) {
  if (wei === '0') return '—';
  const { neg, int, frac } = splitWei(wei, 6);
  const trimmed = frac.replace(/0+$/, '') || '0';
  return `${neg ? '−' : '+'}${group(int)}.${trimmed}`;
}

function shortAddr(a) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function relTime(ts) {
  if (!ts) return '–';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  return `${Math.floor(s / 3600)}시간 전`;
}

function gwei(weiStr) {
  if (!weiStr) return null;
  const n = Number(BigInt(weiStr) / 1000000n) / 1000;
  return `${n.toFixed(2)} gwei`;
}

/* ── 스파크라인 (라이브러리 없이 SVG path 직접 생성) ────────────────────── */
function sparkPath(history) {
  if (history.length < 2) return null;
  const values = history.map((h) => BigInt(h.balanceWei));
  let min = values[0], max = values[0];
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
  if (max === min) return null;

  const span = max - min;
  const W = 108, H = 22, PAD = 2;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * W;
    // BigInt 비율을 소수로: (v-min)/span 을 1/10000 단위까지만 정수 연산으로 계산
    const ratio = Number(((v - min) * 10000n) / span) / 10000;
    const y = PAD + (1 - ratio) * (H - PAD * 2);
    return [x, y];
  });
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  const area = `${line}L${W},${H}L0,${H}Z`;
  const rising = values[values.length - 1] >= values[0];
  return { line, area, rising };
}

/* ── 행 생성 / 갱신 ─────────────────────────────────────────────────────── */
function createRow(acct) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>
      <div class="acct">
        <div class="acct-top"><span class="acct-name"></span><span class="tag" hidden></span></div>
        <button class="addr mono" type="button" title="클릭하면 주소 복사"></button>
      </div>
    </td>
    <td><svg class="spark" viewBox="0 0 108 26" preserveAspectRatio="none" aria-hidden="true">
          <path class="area"></path><path class="line"></path>
        </svg></td>
    <td class="num"><span class="balance mono"></span></td>
    <td class="num"><span class="delta mono"></span></td>
    <td><span class="meta"></span></td>`;

  const els = {
    name: tr.querySelector('.acct-name'),
    tag: tr.querySelector('.tag'),
    addr: tr.querySelector('.addr'),
    spark: tr.querySelector('.spark'),
    sparkLine: tr.querySelector('.line'),
    sparkArea: tr.querySelector('.area'),
    balance: tr.querySelector('.balance'),
    delta: tr.querySelector('.delta'),
    meta: tr.querySelector('.meta'),
  };

  els.name.textContent = acct.label;
  if (acct.tag) { els.tag.textContent = acct.tag; els.tag.hidden = false; }
  els.addr.textContent = shortAddr(acct.address);
  els.addr.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(acct.address);
      els.addr.textContent = '복사됨';
      els.addr.classList.add('copied');
      setTimeout(() => {
        els.addr.textContent = shortAddr(acct.address);
        els.addr.classList.remove('copied');
      }, 1200);
    } catch { /* 클립보드 권한 없으면 조용히 무시 */ }
  });

  return { tr, els };
}

function updateRow(row, acct, isNewBlock) {
  const { els, tr } = row;

  if (acct.balanceWei === null) {
    els.balance.innerHTML = '<span class="skeleton w-md"></span>';
    return;
  }

  // innerHTML 보간을 쓰지 않는다. 지금 안전한 건 서버가 BigInt 유래 숫자 문자열만
  // 내려주기 때문이지 방어했기 때문이 아니라서, 값의 출처가 바뀌면 그대로 주입구가 된다.
  const [intStr, fracStr] = formatEth(acct.balanceWei, 4).split('.');
  const frac = document.createElement('span');
  frac.className = 'frac';
  frac.textContent = `.${fracStr}`;
  els.balance.replaceChildren(intStr, frac);

  const d = acct.deltaWei;
  els.delta.textContent = formatDelta(d);
  els.delta.className = `delta mono ${d === '0' ? 'zero' : d.startsWith('-') ? 'down' : 'up'}`;

  els.meta.textContent = acct.lastChangedBlock ? `#${acct.lastChangedBlock.toLocaleString()}` : '—';

  const sp = sparkPath(acct.history);
  if (sp) {
    els.sparkLine.setAttribute('d', sp.line);
    els.sparkArea.setAttribute('d', sp.area);
    els.spark.classList.toggle('up', sp.rising);
    els.spark.classList.toggle('down', !sp.rising);
  } else {
    // 변동이 없어도 칸을 비우지 않는다. 빈 칸은 "데이터 없음"으로 오해되고,
    // 행마다 높이가 달라져 표가 흔들린다. 평평한 기준선으로 채운다.
    els.sparkLine.setAttribute('d', 'M0,13L108,13');
    els.sparkArea.setAttribute('d', '');
    els.spark.classList.remove('up', 'down');
  }

  // 잔액이 실제로 바뀐 행만 한 번 물들인다
  if (isNewBlock && d !== '0') {
    const cls = d.startsWith('-') ? 'flash-down' : 'flash-up';
    tr.classList.remove('flash-up', 'flash-down');
    void tr.offsetWidth; // 애니메이션 재시작을 위한 강제 리플로우
    tr.classList.add(cls);
  }
}

/* ── 렌더 ───────────────────────────────────────────────────────────────── */
function render(snap, isNewBlock) {
  // 상단바
  const labels = { starting: '연결 중', live: '실시간', degraded: '지연됨', error: '연결 끊김' };
  ui.status.dataset.state = snap.status;
  ui.statusLabel.textContent = labels[snap.status] ?? snap.status;

  if (snap.block) {
    ui.blockNumber.textContent = snap.block.number.toLocaleString();
    if (isNewBlock) {
      ui.blockTicker.classList.remove('bump');
      void ui.blockTicker.offsetWidth;
      ui.blockTicker.classList.add('bump');
    }
  }

  ui.rpcMeta.textContent = `${snap.rpcHost}${snap.chainId ? ` · chainId ${snap.chainId}` : ''}`;
  ui.footRpc.textContent = snap.rpcHost;
  ui.footPoll.textContent = `${snap.pollIntervalMs / 1000}초마다 폴링 · SSE 푸시`;

  if (snap.lastError) {
    ui.banner.hidden = false;
    ui.banner.textContent = `RPC 오류: ${snap.lastError}`;
  } else {
    ui.banner.hidden = true;
  }

  // KPI
  const loaded = snap.accounts.filter((a) => a.balanceWei !== null);
  if (loaded.length) {
    const total = loaded.reduce((acc, a) => acc + BigInt(a.balanceWei), 0n);
    const totalDelta = loaded.reduce((acc, a) => acc + BigInt(a.deltaWei), 0n);
    ui.kpiTotal.textContent = `${formatEth(total.toString(), 2)} ETH`;
    ui.kpiTotalDelta.textContent =
      totalDelta === 0n ? '이번 블록 변동 없음' : `이번 블록 ${formatDelta(totalDelta.toString())} ETH`;
    ui.kpiTotalDelta.style.color =
      totalDelta === 0n ? '' : totalDelta < 0n ? 'var(--down)' : 'var(--up)';
  }

  ui.kpiCount.textContent = snap.accounts.length;
  const changed = snap.accounts.filter((a) => a.deltaWei !== '0').length;
  ui.kpiChanged.textContent = changed ? `${changed}개 주소 변동` : '변동 없음';

  if (snap.block?.timestamp) {
    const t = new Date(snap.block.timestamp * 1000);
    ui.kpiBlockTime.textContent = t.toLocaleTimeString('ko-KR', { hour12: false });
    ui.kpiBaseFee.textContent = [
      gwei(snap.block.baseFeePerGas),
      snap.block.txCount != null ? `${snap.block.txCount} txs` : null,
    ].filter(Boolean).join(' · ') || ' ';
  }

  ui.kpiUpdated.textContent = relTime(snap.updatedAt);
  ui.kpiLatency.textContent = snap.latencyMs != null ? `RPC 응답 ${snap.latencyMs}ms` : ' ';

  // 테이블: 행을 재생성하지 않고 재사용 + 순서만 이동시킨다
  const first = state.rows.size === 0;
  if (first) ui.rows.innerHTML = '';

  for (const acct of snap.accounts) {
    let row = state.rows.get(acct.address);
    if (!row) {
      row = createRow(acct);
      state.rows.set(acct.address, row);
      ui.rows.appendChild(row.tr);
    }
    updateRow(row, acct, isNewBlock);
  }

  applySortAndFilter(snap);
}

function applySortAndFilter(snap) {
  const accounts = [...snap.accounts];
  const cmp = {
    config: null,                 // 서버가 준 순서를 그대로 쓴다 (정렬하지 않음)
    balance: (a, b) => {
      const x = BigInt(a.balanceWei ?? '0'), y = BigInt(b.balanceWei ?? '0');
      return x === y ? 0 : x < y ? 1 : -1;
    },
    delta: (a, b) => {
      const x = BigInt(a.deltaWei) < 0n ? -BigInt(a.deltaWei) : BigInt(a.deltaWei);
      const y = BigInt(b.deltaWei) < 0n ? -BigInt(b.deltaWei) : BigInt(b.deltaWei);
      return x === y ? 0 : x < y ? 1 : -1;
    },
    label: (a, b) => a.label.localeCompare(b.label, 'ko'),
  }[view.sort];

  if (cmp) accounts.sort(cmp);

  const q = view.query.trim().toLowerCase();
  let visible = 0;
  for (const acct of accounts) {
    const row = state.rows.get(acct.address);
    if (!row) continue;
    ui.rows.appendChild(row.tr); // 이미 붙어 있는 노드를 옮기는 것이라 상태가 유지된다
    const hit = !q || acct.label.toLowerCase().includes(q) || acct.address.toLowerCase().includes(q);
    row.tr.hidden = !hit;
    if (hit) visible += 1;
  }

  let emptyRow = ui.rows.querySelector('.empty');
  if (visible === 0) {
    if (!emptyRow) {
      emptyRow = document.createElement('tr');
      emptyRow.className = 'empty';
      emptyRow.innerHTML = '<td colspan="5">검색 결과가 없습니다.</td>';
    }
    ui.rows.appendChild(emptyRow);
  } else if (emptyRow) {
    emptyRow.remove();
  }
}

/* ── 이벤트 스트림 ──────────────────────────────────────────────────────── */
function connect() {
  const es = new EventSource('/api/stream');

  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'ping') return;

    if (msg.type === 'heartbeat') {
      if (state.snapshot) {
        state.snapshot.updatedAt = msg.updatedAt;
        state.snapshot.latencyMs = msg.latencyMs;
        ui.kpiUpdated.textContent = relTime(msg.updatedAt);
        ui.kpiLatency.textContent = `RPC 응답 ${msg.latencyMs}ms`;
      }
      return;
    }

    const isNewBlock = !!msg.block && msg.block.number !== state.lastBlock;
    state.snapshot = msg;
    state.lastBlock = msg.block?.number ?? state.lastBlock;
    document.body.classList.remove('is-stale');
    render(msg, isNewBlock);
  };

  // EventSource는 끊기면 브라우저가 알아서 재연결한다. 우리는 화면만 정직하게.
  es.onerror = () => {
    ui.status.dataset.state = 'error';
    ui.statusLabel.textContent = '서버 연결 끊김';
    document.body.classList.add('is-stale');
  };
}

/* ── 컨트롤 ─────────────────────────────────────────────────────────────── */
document.querySelectorAll('.segmented button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.segmented button').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    view.sort = btn.dataset.sort;
    if (state.snapshot) applySortAndFilter(state.snapshot);
  });
});

ui.filter.addEventListener('input', (e) => {
  view.query = e.target.value;
  if (state.snapshot) applySortAndFilter(state.snapshot);
});

// 상대 시각은 1초마다 클라이언트에서 갱신한다 (서버 왕복 불필요).
// 갱신이 폴링 주기의 3배 넘게 없으면 화면을 흐리게 해서 "낡은 값"임을 알린다.
setInterval(() => {
  const snap = state.snapshot;
  if (!snap?.updatedAt) return;
  ui.kpiUpdated.textContent = relTime(snap.updatedAt);
  const stale = Date.now() - snap.updatedAt > snap.pollIntervalMs * 3;
  document.body.classList.toggle('is-stale', stale);
  if (stale && ui.status.dataset.state === 'live') {
    ui.status.dataset.state = 'degraded';
    ui.statusLabel.textContent = '갱신 지연';
  }
}, 1000);

connect();

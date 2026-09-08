#!/usr/bin/env node
'use strict';

/**
 * 대시보드 상태 알림.
 *
 *   node notify.js daily     매일 아침 잔액 리포트 (무조건 발송)
 *   node notify.js status    매일 아침 서버 상태 (개발자용, 무조건 발송)
 *   node notify.js check     health 점검 -> 장애/복구 시에만 발송
 *   node notify.js <mode> --dry-run   보내지 않고 메일 본문만 출력
 *
 * 이 프로젝트의 "의존성 0개" 원칙을 지키기 위해 SMTP 발송은 curl 에 맡긴다.
 * 비밀번호는 argv 에 넣지 않는다 — ps 로 다른 사용자에게 보이기 때문에,
 * curl 설정을 stdin(-K -)으로 넘긴다.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const DIR = __dirname;
const ENV_PATH = process.env.NOTIFY_ENV || path.join(DIR, 'notify.env');   // 테스트용 오버라이드
const STATE_PATH = process.env.NOTIFY_STATE || path.join(DIR, 'notify-state.json');

const mode = process.argv[2];
const MODES = ['daily', 'status', 'check'];
const DRY = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');   // SMTP 대화를 보여준다 (진단용)
const RAW = process.argv.includes('--raw');           // 보내지 않고 메일 원문(MIME)을 출력
if (!MODES.includes(mode)) {
  console.error(`사용법: node notify.js ${MODES.join('|')} [--dry-run] [--verbose] [--raw]`);
  process.exit(2);
}

// ── 설정 ────────────────────────────────────────────────────────────────────
// KEY=VALUE 형식. 값에 # 이 들어갈 수 있으므로 줄 전체 주석만 걷어낸다.
function loadEnv(file) {
  if (!fs.existsSync(file)) {
    console.error(`${file} 이 없다. notify.env.example 을 복사해서 채워라.`);
    process.exit(2);
  }
  const out = {};
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i === -1) continue;
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[line.slice(0, i).trim()] = v;
  }
  return out;
}

const env = loadEnv(ENV_PATH);
const need = (k) => {
  const v = env[k];
  if (!v) { console.error(`notify.env 에 ${k} 가 비어 있다.`); process.exit(2); }
  return v;
};

const SMTP_HOST = env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = env.SMTP_PORT || '587';
const SMTP_USER = need('SMTP_USER');
const SMTP_PASS = need('SMTP_PASS');
const MAIL_FROM = env.MAIL_FROM || SMTP_USER;
// 받는 사람은 용도별로 나눌 수 있다. 일일 리포트에는 잔액이 들어가지만
// 장애 알림은 "대시보드가 죽었다"는 사실뿐이라, 공유 범위가 다를 수 있다.
// MAIL_TO_DAILY / MAIL_TO_ALERT 를 비워두면 둘 다 MAIL_TO 를 쓴다.
const list = (v) => (v || '').split(',').map((x) => x.trim()).filter(Boolean);
const MAIL_TO_ALL = list(need('MAIL_TO'));
const MAIL_TO_DAILY = list(env.MAIL_TO_DAILY).length ? list(env.MAIL_TO_DAILY) : MAIL_TO_ALL;
const MAIL_TO_ALERT = list(env.MAIL_TO_ALERT).length ? list(env.MAIL_TO_ALERT) : MAIL_TO_ALL;
// daily(잔액 리포트)만 재단 쪽과 공유하고, status/check 는 개발자용이다
const MAIL_TO = mode === 'daily' ? MAIL_TO_DAILY : MAIL_TO_ALERT;
const APP_URL = (env.APP_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const PUBLIC_URL = (env.PUBLIC_URL || '').replace(/\/$/, '');
const COOLDOWN_MIN = Number(env.ALERT_COOLDOWN_MIN || 60);

// curl 은 SMTP URL 의 '경로'를 EHLO 인사말로 쓴다. 지정하지 않으면 업로드 파일명
// (ethdash-mail-1234-....eml) 을 그대로 보내 스팸 점수에 불리하다.
// 우리가 실제로 가진 도메인을 쓴다.
const EHLO_NAME = env.EHLO_NAME
  || (PUBLIC_URL ? new URL(PUBLIC_URL).hostname : '')
  || os.hostname()
  || 'localhost';

// ── 상태 파일 ───────────────────────────────────────────────────────────────
// 어제 잔액(전일 대비 변동 계산용)과 장애 알림 중복 방지 정보를 들고 있다.
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  const tmp = STATE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, STATE_PATH);            // 중간에 죽어도 파일이 깨지지 않게
}

// ── 조회 ────────────────────────────────────────────────────────────────────
async function tryFetch(url, timeoutMs = 10_000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.json();
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, error: err.name === 'TimeoutError' ? 'timeout' : err.message };
  }
}

// ── 표시 유틸 ───────────────────────────────────────────────────────────────
const WEI = 18;

// wei 10진 문자열 -> "1,234.5678". Number 로 바꾸면 정밀도가 깨진다
function fmtEth(wei, dp = 4) {
  if (wei === null || wei === undefined) return '—';
  const neg = String(wei).startsWith('-');
  const abs = neg ? String(wei).slice(1) : String(wei);
  const p = abs.padStart(WEI + 1, '0');
  const int = p.slice(0, -WEI).replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${int}.${p.slice(-WEI).slice(0, dp)}`;
}

function fmtDelta(wei) {
  if (wei === null) return '—';
  const b = BigInt(wei);
  if (b === 0n) return '변동 없음';
  return `${b > 0n ? '+' : '−'}${fmtEth((b < 0n ? -b : b).toString(), 6)}`;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// 40자리 16진수를 그대로 9개 늘어놓으면 스팸 필터가 싫어한다.
// 대시보드 화면과 같은 축약형을 쓰고, 전체 주소는 대시보드에서 본다.
const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const kst = (ts) => new Date(ts).toLocaleString('ko-KR', { hour12: false });

// ── 메일 본문 ───────────────────────────────────────────────────────────────
const CSS_TD = 'padding:8px 10px;border-bottom:1px solid #e5e7eb;font-size:13px';
const CSS_TH = 'padding:8px 10px;border-bottom:2px solid #d1d5db;font-size:11px;'
  + 'letter-spacing:.05em;text-transform:uppercase;color:#6b7280;text-align:left';

function banner(okState, text) {
  const c = okState ? ['#065f46', '#d1fae5'] : ['#991b1b', '#fee2e2'];
  return `<div style="background:${c[1]};color:${c[0]};padding:12px 14px;border-radius:6px;`
    + `font-weight:600;font-size:14px;margin:0 0 16px">${esc(text)}</div>`;
}

// detailed: RPC 상태와 접속자 수까지 넣는다. 장애 알림에는 원인 파악에 필요하지만,
// 매일 아침 리포트에는 잔액만 보면 되므로 넣지 않는다.
function healthTable(h, detailed = false) {
  const rows = [
    ['상태', h.status ?? '—'],
    ['블록', h.block != null ? '#' + h.block.toLocaleString() : '—'],
    ['마지막 갱신', h.updatedAt ? kst(h.updatedAt) : '—'],
    ...(detailed ? [
      ['RPC', h.rpc ? `${h.rpc.active} · ${h.rpc.lastLatencyMs}ms · 실패 ${h.rpc.errors}/${h.rpc.requests}` : '—'],
      ['접속자', h.subscribers != null ? `${h.subscribers}명 (IP ${h.uniqueIps})` : '—'],
    ] : []),
  ];
  return `<table style="border-collapse:collapse;width:100%;margin:0 0 20px">`
    + rows.map(([k, v]) => `<tr><td style="${CSS_TD};color:#6b7280;width:110px">${esc(k)}</td>`
      + `<td style="${CSS_TD}">${esc(v)}</td></tr>`).join('')
    + `</table>`;
}

function balanceTable(accounts, prev) {
  const head = `<tr><th style="${CSS_TH}">주소</th><th style="${CSS_TH};text-align:right">잔액 (ETH)</th>`
    + `<th style="${CSS_TH};text-align:right">기준 대비</th></tr>`;
  const body = accounts.map((a) => {
    const before = prev ? prev[a.address.toLowerCase()] : undefined;
    const d = (before !== undefined && a.balanceWei !== null)
      ? (BigInt(a.balanceWei) - BigInt(before)).toString() : null;
    const color = d === null || d === '0' ? '#6b7280' : (d.startsWith('-') ? '#b91c1c' : '#047857');
    return `<tr>`
      + `<td style="${CSS_TD}">${esc(a.label)}`
      + `<div style="color:#9ca3af;font-size:11px;font-family:monospace">${esc(shortAddr(a.address))}</div></td>`
      + `<td style="${CSS_TD};text-align:right;font-variant-numeric:tabular-nums">${fmtEth(a.balanceWei)}</td>`
      + `<td style="${CSS_TD};text-align:right;color:${color};font-variant-numeric:tabular-nums">${esc(fmtDelta(d))}</td>`
      + `</tr>`;
  }).join('');
  return `<table style="border-collapse:collapse;width:100%">${head}${body}</table>`;
}

function wrap(inner) {
  const link = PUBLIC_URL
    ? `<p style="margin:20px 0 0"><a href="${esc(PUBLIC_URL)}" style="color:#2563eb;font-size:13px">${esc(PUBLIC_URL)}</a></p>`
    : '';
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;`
    + `max-width:640px;margin:0 auto;padding:20px;color:#111827">${inner}${link}`
    + `<p style="margin:24px 0 0;color:#9ca3af;font-size:11px">ETH Balance Monitor · ${esc(kst(Date.now()))}</p></div>`;
}

// HTML 만 보내는 메일은 대량발송으로 보인다. 같은 내용의 텍스트 파트를 함께 넣는다.
function htmlToText(html) {
  return html
    .replace(/<\/(tr|div|p|h3|table)>/g, '\n')
    .replace(/<\/t[dh]>/g, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── 발송 ────────────────────────────────────────────────────────────────────
// 헤더/본문 모두 UTF-8 이므로 제목은 RFC 2047, 본문은 base64 로 감싼다.
function buildMessage(subject, html) {
  const b64 = (t) => Buffer.from(t, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  const bnd = `bnd_${Date.now().toString(36)}_${process.pid.toString(36)}`;
  return [
    `From: ETH Balance Monitor <${MAIL_FROM}>`,
    `To: ${MAIL_TO.join(', ')}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${process.pid}@${EHLO_NAME}>`,
    // 자동 발송임을 표준 방식으로 밝힌다. 수신 거부 경로가 있는 메일은
    // 정상적인 알림으로 취급되고, 자동응답(부재중 등)도 되받지 않는다.
    `List-Unsubscribe: <mailto:${MAIL_FROM}?subject=unsubscribe>`,
    'Auto-Submitted: auto-generated',
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${bnd}"`,
    '',
    `--${bnd}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(htmlToText(html)),
    `--${bnd}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(html),
    `--${bnd}--`,
    '',
  ].join('\r\n');
}

function curlQuote(v) { return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }

function send(subject, html) {
  const msg = buildMessage(subject, html);
  if (RAW) { process.stdout.write(msg); return Promise.resolve(0); }   // MIME 구조 점검용
  if (DRY) {
    console.log('--- DRY RUN: 아래 메일을 보내지 않고 출력만 한다 ---');
    console.log(`받는 사람: ${MAIL_TO.join(', ')}`);
    console.log(`제목: ${subject}`);
    console.log(htmlToText(html));
    return Promise.resolve(0);
  }

  const tmp = path.join(os.tmpdir(), `ethdash-mail-${process.pid}-${Date.now()}.eml`);
  fs.writeFileSync(tmp, msg, { mode: 0o600 });

  // 비밀번호가 ps 에 노출되지 않도록 curl 설정을 stdin 으로 넘긴다
  const conf = [
    `url = ${curlQuote(`smtp://${SMTP_HOST}:${SMTP_PORT}/${EHLO_NAME}`)}`,
    'ssl-reqd',                                  // 587 STARTTLS 강제
    `user = ${curlQuote(`${SMTP_USER}:${SMTP_PASS}`)}`,
    `mail-from = ${curlQuote(MAIL_FROM)}`,
    ...MAIL_TO.map((t) => `mail-rcpt = ${curlQuote(t)}`),
    `upload-file = ${curlQuote(tmp)}`,
    'silent',
    'show-error',
    'max-time = 30',
    ...(VERBOSE ? ['verbose'] : []),
  ].join('\n');

  return new Promise((resolve) => {
    const c = spawn('curl', ['-K', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => {
      fs.unlinkSync(tmp);
      if (VERBOSE) {
        // 인증 구간에는 자격증명이 base64 로 들어 있으므로 걸러낸다
        console.log(err.split('\n')
          .filter((l) => /^[<>] /.test(l))
          .filter((l) => !/AUTH/i.test(l) && !/^> [A-Za-z0-9+/]{20,}={0,2}$/.test(l))
          .join('\n'));
      }
      if (code === 0) console.log(`발송 완료: ${subject} -> ${MAIL_TO.join(', ')}`);
      else console.error(`발송 실패 (curl ${code}): ${err.trim()}`);
      resolve(code);
    });
    c.stdin.end(conf);
  });
}

// ── 본체 ────────────────────────────────────────────────────────────────────
(async () => {
  const state = loadState();
  const h = await tryFetch(`${APP_URL}/api/health`);
  // health 는 장애 시 503 을 내므로 res.ok 가 아니라 본문의 ok 를 봐야 한다.
  // 연결 자체가 안 되면(프로세스 사망) body 가 없다.
  const healthy = h.body ? h.body.ok === true : false;
  const detail = h.body || { status: h.error ? `연결 실패 (${h.error})` : `HTTP ${h.status}` };

  if (mode === 'check') {
    const wasDown = state.down === true;
    const now = Date.now();

    if (!healthy) {
      const since = state.lastAlertAt ? (now - state.lastAlertAt) / 60000 : Infinity;
      if (wasDown && since < COOLDOWN_MIN) {
        console.log(`장애 지속 중 · 마지막 알림 ${Math.round(since)}분 전 · 쿨다운 ${COOLDOWN_MIN}분 -> 발송 생략`);
        return;
      }
      const title = wasDown ? '장애 지속' : '장애 발생';
      await send(`[ETH 대시보드] ${title} — ${detail.status ?? '응답 없음'}`,
        wrap(banner(false, `${title}: ${detail.status ?? '응답 없음'}`)
          + healthTable(detail, true)
          + (detail.lastError ? `<p style="font-size:13px;color:#b91c1c">${esc(detail.lastError)}</p>` : '')));
      saveState({
        ...state, down: true, lastAlertAt: now,
        // 최근 7일치만 남긴다. 매일 아침 상태 메일이 이걸로 24시간 요약을 만든다
        alerts: [...(state.alerts || []), now].filter((t) => now - t < 7 * 86400_000),
      });
      return;
    }

    if (wasDown) {
      await send('[ETH 대시보드] 복구됨',
        wrap(banner(true, '복구됨 — 정상 동작 중') + healthTable(detail, true)));
      saveState({ ...state, down: false, lastAlertAt: null });
      return;
    }
    // 정상일 때는 아무것도 출력하지 않는다 — 10분마다 로그를 채우면
    // 정작 봐야 할 줄이 묻힌다. 대신 상태 파일에 마지막 점검 시각을 남겨
    // "cron 이 돌고는 있는가"를 확인할 수 있게 한다.
    saveState({ ...state, down: false, lastCheckAt: now });
    return;
  }

  // ── status: 개발자용 일일 서버 상태. 장애가 없어도 매일 보낸다.
  // 장애 시에만 오는 알림 체계는 "문제가 없는 것"과 "알림이 고장난 것"을
  // 구분할 수 없다. 매일 한 통이 오는 것 자체가 알림 경로의 생존 증명이다.
  if (mode === 'status') {
    const now = Date.now();
    const last24 = (state.alerts || []).filter((t) => now - t < 86400_000);
    const summary = last24.length === 0
      ? '지난 24시간 장애 알림 없음'
      : `지난 24시간 장애 알림 ${last24.length}회 (마지막 ${kst(last24[last24.length - 1])})`;
    const checked = state.lastCheckAt
      ? `마지막 자동 점검 ${kst(state.lastCheckAt)}`
      : '자동 점검 기록 없음 — cron 이 도는지 확인이 필요하다';

    await send(
      `[ETH 대시보드] 서버 상태 — ${healthy ? '정상' : '이상'} · ${new Date().toLocaleDateString('ko-KR')}`,
      wrap(banner(healthy, healthy ? '정상 동작 중' : `이상 — ${detail.status ?? '응답 없음'}`)
        + healthTable(detail, true)
        + `<p style="font-size:13px;margin:0 0 4px">${esc(summary)}</p>`
        + `<p style="font-size:12px;color:#6b7280;margin:0">${esc(checked)}</p>`
        + (detail.lastError ? `<p style="font-size:13px;color:#b91c1c">${esc(detail.lastError)}</p>` : '')));
    return;
  }

  // ── daily ──
  const s = await tryFetch(`${APP_URL}/api/snapshot`);
  const accounts = s.body && Array.isArray(s.body.accounts) ? s.body.accounts : [];

  let inner = banner(healthy, healthy ? '정상 동작 중' : `이상 — ${detail.status ?? '응답 없음'}`)
    + healthTable(detail);

  if (accounts.length) {
    const ago = state.lastDailyAt
      ? (() => {
          const h = (Date.now() - state.lastDailyAt) / 3_600_000;
          return h < 1 ? `${Math.round(h * 60)}분 전` : h < 48 ? `${Math.round(h)}시간 전` : `${Math.round(h / 24)}일 전`;
        })()
      : null;
    inner += `<h3 style="font-size:13px;margin:0 0 4px;color:#374151">주소별 잔액</h3>`
      + (ago
        ? `<p style="color:#9ca3af;font-size:11px;margin:0 0 8px">기준: ${esc(kst(state.lastDailyAt))} 리포트 (${esc(ago)})</p>`
        : `<div style="margin:0 0 8px"></div>`)
      + balanceTable(accounts, state.lastDaily);
    if (!state.lastDaily) {
      inner += `<p style="color:#9ca3af;font-size:12px;margin:10px 0 0">`
        + `첫 리포트라 비교할 기준값이 없다. 다음 리포트부터 변동이 표시된다.</p>`;
    }
  } else {
    inner += `<p style="color:#b91c1c;font-size:13px">잔액을 가져오지 못했다.</p>`;
  }

  const code = await send(
    `[ETH 대시보드] 일일 리포트 — ${healthy ? '정상' : '이상'} · ${new Date().toLocaleDateString('ko-KR')}`,
    wrap(inner));

  // 발송에 성공했을 때만 기준값을 갱신한다.
  // 실패한 날 갱신해 버리면 그날의 변동이 통째로 사라진다.
  if (code === 0 && accounts.length) {
    const day = (t) => new Date(t).toLocaleDateString('sv-SE');   // YYYY-MM-DD (로컬)
    const sameDay = state.lastDailyAt && day(state.lastDailyAt) === day(Date.now());
    if (sameDay) {
      // 오늘 이미 기준값을 잡았다. 수동으로 몇 번을 더 돌려도 덮어쓰지 않는다 —
      // 덮어쓰면 다음 리포트의 "변동"이 하루치가 아니라 몇 분치가 된다.
      console.log(`기준값 유지 (오늘 ${kst(state.lastDailyAt)} 에 기록됨)`);
    } else {
      const snap = {};
      for (const a of accounts) if (a.balanceWei !== null) snap[a.address.toLowerCase()] = a.balanceWei;
      saveState({ ...state, lastDaily: snap, lastDailyAt: Date.now() });
    }
  }
})();

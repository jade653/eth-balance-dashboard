#!/usr/bin/env bash
#
# eth-balance-dashboard 배포 스크립트 (Ubuntu / 공용 서버 안전 모드)
#
# 사용법:
#   ./deploy.sh          -> 점검만 수행. 시스템을 절대 변경하지 않음 (기본값)
#   ./deploy.sh --apply  -> 점검 통과 시 실제 설치/설정 수행
#
# 설계 원칙: 공용 서버이므로 "이미 있는 것은 절대 덮어쓰지 않는다".
#   - Node 가 이미 있으면 버전만 확인하고, 낮아도 자동 업그레이드하지 않음(중단)
#   - nginx 가 없으면 자동 설치하지 않음(중단). 기존 설정/기본 사이트는 손대지 않음
#   - ufw 는 상태만 읽고 절대 켜거나 규칙을 바꾸지 않음
#   - 기존 systemd 유닛/nginx 사이트 파일이 있으면 .bak 백업 후 진행

set -euo pipefail

# ── 설정값 (환경에 맞게 수정) ────────────────────────────────────────────────
APP_NAME="eth-dashboard"          # systemd 서비스 이름
APP_USER="ethdash"                # 앱 전용 시스템 계정 (로그인 불가)
APP_DIR="/opt/eth-dashboard"      # 배포 대상 디렉터리
APP_PORT="8787"                   # server.js 가 listen 할 포트 (외부 미개방)
SERVER_NAME=""                    # 이 서버는 80을 Traefik이 점유 -> nginx/TLS는 set-domain.sh 가 443으로 담당.
                                  # 여기에 값을 넣으면 80 기반 설정이 만들어져 충돌하므로 비워 둔다.
RPC_HTTP_URL=""                   # 전용 RPC 엔드포인트. 비우면 config.json 값 사용
NODE_MAJOR_MIN="18"               # package.json engines 요구사항
NODE_MAJOR_INSTALL="22"           # Node 가 아예 없을 때 설치할 버전
NODE_SHIP_DIR="/opt/eth-dashboard-node"  # 홈 경로 node 를 복사해 둘 위치(아래 설명 참고)

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # 이 스크립트가 있는 곳 = 소스 디렉터리

# 같은 디렉터리에 deploy.env 가 있으면 위 기본값을 덮어쓴다.
# deploy.sh 를 다시 전송해도 설정값이 초기화되지 않도록 분리해 두는 용도다.
#   예) echo 'SERVER_NAME="test.mustree.kr"' > deploy.env
if [ -f "$SRC_DIR/deploy.env" ]; then
  # shellcheck disable=SC1091
  . "$SRC_DIR/deploy.env"
  echo "  [ .. ] deploy.env 적용됨"
fi

UNIT_PATH="/etc/systemd/system/${APP_NAME}.service"
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

# ── 출력 헬퍼 ────────────────────────────────────────────────────────────────
ok()    { printf '  [ OK ] %s\n' "$*"; }
info()  { printf '  [ .. ] %s\n' "$*"; }
warn()  { printf '  [WARN] %s\n' "$*"; }
fail()  { printf '  [FAIL] %s\n' "$*"; }
head1() { printf '\n== %s ==\n' "$*"; }
die()   { fail "$*"; printf '\n중단합니다. 시스템은 변경되지 않았습니다.\n'; exit 1; }

# 변경 작업 실행기: --apply 가 없으면 실행할 명령을 출력만 하고 넘어감
run() {
  if [ "$APPLY" -eq 1 ]; then
    info "실행: $*"
    "$@"
  else
    printf '  [DRY ] %s\n' "$*"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
head1 "0. 실행 환경 확인"

# apt 를 쓸 수 있는 배포판인지 확인 (엉뚱한 OS 에서 실행 방지)
if [ -r /etc/os-release ]; then
  . /etc/os-release
  ok "OS: ${PRETTY_NAME:-unknown}"
  case "${ID_LIKE:-${ID:-}}" in
    *debian*|*ubuntu*) ;;
    *) die "Ubuntu/Debian 계열이 아닙니다. 이 스크립트를 사용하지 마세요." ;;
  esac
else
  die "/etc/os-release 를 읽을 수 없습니다."
fi

# root 직접 실행보다 sudo 가능한 일반 계정을 권장. 권한을 미리 확보해 중간 프롬프트 방지
if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
  warn "root 로 실행 중입니다. 공용 서버에서는 sudo 가능한 일반 계정을 권장합니다."
else
  command -v sudo >/dev/null 2>&1 || die "sudo 가 없고 root 도 아닙니다."
  sudo -v || die "sudo 권한을 얻지 못했습니다."
  SUDO="sudo"
  ok "sudo 사용 가능"
fi

# 소스 파일이 실제로 여기 있는지 확인 (엉뚱한 디렉터리에서 실행 방지)
[ -f "$SRC_DIR/server.js" ] && [ -f "$SRC_DIR/package.json" ] \
  || die "$SRC_DIR 에 server.js / package.json 이 없습니다. 프로젝트 디렉터리에서 실행하세요."
ok "소스 디렉터리: $SRC_DIR"

# ─────────────────────────────────────────────────────────────────────────────
head1 "1. Node.js 확인"

NEED_NODE_INSTALL=0
if command -v node >/dev/null 2>&1; then
  NODE_VER="$(node -v)"                                   # 예: v22.3.0
  NODE_MAJOR="$(printf '%s' "${NODE_VER#v}" | cut -d. -f1)"  # 메이저 숫자만 추출
  if [ "$NODE_MAJOR" -ge "$NODE_MAJOR_MIN" ]; then
    ok "Node $NODE_VER 이미 설치됨 (>= $NODE_MAJOR_MIN). 설치 단계 건너뜀"
    # 홈 경로 node 는 서비스 계정이 못 읽어 203/EXEC 를 낸다. 미리 알려준다
    case "$(readlink -f "$(command -v node)")" in
      /home/*|/root/*) warn "node 가 홈 경로에 있습니다 -> $NODE_SHIP_DIR 로 복사해 사용합니다(systemd 접근 제약 회피)." ;;
    esac
  else
    # 공용 서버의 전역 Node 업그레이드는 다른 서비스를 깨뜨릴 수 있어 자동 실행 금지
    fail "Node $NODE_VER 는 요구 버전($NODE_MAJOR_MIN+)보다 낮습니다."
    echo "         전역 Node 를 올리면 다른 앱이 깨질 수 있어 자동 업그레이드하지 않습니다."
    echo "         관리자와 협의하거나, nvm 으로 이 계정에만 설치하세요:"
    echo "           curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
    echo "           nvm install $NODE_MAJOR_INSTALL"
    echo "         그 뒤 이 스크립트의 systemd ExecStart 가 해당 node 절대경로를 쓰도록 확인하세요."
    die "Node 버전 미달"
  fi
else
  warn "Node 미설치. --apply 시 NodeSource 로 Node $NODE_MAJOR_INSTALL 설치(전역 변경)."
  NEED_NODE_INSTALL=1
fi

# 이 프로젝트는 dependencies 가 없어 npm install 이 불필요. 나중에 생기면 경고
if grep -q '"dependencies"' "$SRC_DIR/package.json"; then
  warn "package.json 에 dependencies 가 생겼습니다. 배포 후 'npm ci --omit=dev' 가 필요합니다."
else
  ok "외부 의존성 없음 (npm install 불필요)"
fi

# config.json 이 깨져 있으면 새 프로세스가 부팅 중 죽고 systemd 가 3초마다 되살리다
# 서비스가 통째로 내려간다. 시스템을 건드리기 전에, 복사 원본을 미리 걸러낸다
# (server.js 의 부팅 검증과 같은 규칙). 배포본이 아니라 소스를 보므로 sudo 가 필요 없다.
if [ "$NEED_NODE_INSTALL" -eq 1 ]; then
  warn "Node 미설치 -> config.json 검증을 건너뜁니다."
elif CFG_OUT="$(node -e '
  // 스택 트레이스가 아니라 "무엇이 잘못됐는지" 한 줄로 내보낸다
  try {
    const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    if (!Array.isArray(c.addresses) || c.addresses.length === 0) throw new Error("addresses 가 비어 있다");
    const seen = new Set();
    for (const a of c.addresses) {
      if (!/^0x[0-9a-fA-F]{40}$/.test((a || {}).address || "")) throw new Error("주소 형식 오류: " + JSON.stringify(a));
      if (typeof a.label !== "string" || a.label.trim() === "") throw new Error("label 누락: " + a.address);
      const k = a.address.toLowerCase();
      if (seen.has(k)) throw new Error("주소 중복: " + a.address);
      seen.add(k);
    }
    console.log(c.addresses.length + " addresses");
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
' "$SRC_DIR/config.json" 2>&1)"; then
  ok "config.json 정상 ($CFG_OUT)"
else
  fail "config.json 이 유효하지 않습니다. 시스템은 변경하지 않았습니다."
  printf '         %s\n' "$CFG_OUT"
  die "config.json 검증 실패"
fi

# ─────────────────────────────────────────────────────────────────────────────
head1 "2. 포트 / 계정 / 디렉터리 / 유닛 충돌 확인"

# 다른 서비스가 이미 이 포트를 점유했는지 확인 (공용 서버 충돌 1순위)
if command -v ss >/dev/null 2>&1; then
  if ss -ltnH "sport = :$APP_PORT" 2>/dev/null | grep -q .; then
    # 재배포일 때는 이 포트를 우리 서비스 자신이 잡고 있는 게 정상이다.
    # 점유 프로세스의 PID 가 우리 유닛의 MainPID 와 같으면 충돌이 아니다.
    OWN_PID="$(systemctl show "$APP_NAME" -p MainPID --value 2>/dev/null || echo 0)"
    HOLDERS="$($SUDO ss -ltnpH "sport = :$APP_PORT" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u)"
    if [ -n "${OWN_PID:-}" ] && [ "$OWN_PID" != "0" ] && printf '%s
' $HOLDERS | grep -qx "$OWN_PID"; then
      ok "포트 $APP_PORT 는 기존 $APP_NAME 서비스(pid $OWN_PID)가 사용 중 -> 재배포이므로 정상"
    else
      $SUDO ss -ltnp "sport = :$APP_PORT" 2>/dev/null || true
      die "포트 $APP_PORT 를 다른 프로세스가 쓰고 있습니다. 상단 APP_PORT 를 다른 값으로 바꾸세요."
    fi
  else
    ok "포트 $APP_PORT 사용 가능"
  fi
else
  warn "ss 명령이 없어 포트 점유 여부를 확인하지 못했습니다."
fi

# 전용 계정이 이미 있으면 재생성하지 않음
NEED_USER_CREATE=0
if id -u "$APP_USER" >/dev/null 2>&1; then
  ok "계정 $APP_USER 이미 존재. 건드리지 않음"
else
  info "계정 $APP_USER 없음 -> 로그인 불가 시스템 계정으로 생성 예정"
  NEED_USER_CREATE=1
fi

# 배포 디렉터리에 남의 파일이 들어있는지 확인 (rsync --delete 로 날리는 사고 방지)
# 주의: 배포 디렉터리는 root:$APP_USER 750 으로 잠겨 있어 일반 계정은 내부를 볼 수 없다.
# 반드시 sudo 로 검사해야 "내 앱이 아니다" 오판이 나지 않는다.
if $SUDO test -e "$APP_DIR"; then
  if $SUDO test -f "$APP_DIR/server.js"; then
    ok "$APP_DIR 에 기존 배포본 존재 -> 갱신으로 진행"
  else
    die "$APP_DIR 가 이미 있는데 이 앱의 것이 아닙니다. APP_DIR 을 다른 경로로 바꾸세요."
  fi
else
  info "$APP_DIR 없음 -> 새로 생성 예정"
fi

# 같은 이름의 systemd 유닛이 이미 있는지 확인
if [ -f "$UNIT_PATH" ]; then
  warn "$UNIT_PATH 이미 존재 -> 덮어쓰기 전 .bak 으로 백업합니다."
else
  info "systemd 유닛 신규 생성 예정: $UNIT_PATH"
fi

# 파일 복사 도구 확인 (rsync 없으면 cp 로 대체)
if command -v rsync >/dev/null 2>&1; then ok "rsync 사용 가능"; else warn "rsync 없음 -> cp -a 로 복사"; fi

# ─────────────────────────────────────────────────────────────────────────────
head1 "3. nginx 확인"

DO_NGINX=0
if [ -z "$SERVER_NAME" ]; then
  warn "SERVER_NAME 이 비어 있어 nginx 설정을 건너뜁니다 (앱은 127.0.0.1:$APP_PORT 로만 동작)."
elif command -v nginx >/dev/null 2>&1; then
  ok "nginx 설치됨: $(nginx -v 2>&1)"
  DO_NGINX=1
  # 같은 server_name 을 이미 쓰는 설정이 있으면 남의 사이트를 가로챌 수 있으므로 중단
  CONFLICT="$($SUDO grep -rlE "server_name[^;]*[[:space:]]${SERVER_NAME}[;[:space:]]" \
              /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | grep -v "$APP_NAME" || true)"
  [ -n "$CONFLICT" ] && die "server_name '$SERVER_NAME' 을 이미 쓰는 설정이 있습니다: $CONFLICT"
  ok "server_name '$SERVER_NAME' 충돌 없음"
  [ -f "/etc/nginx/sites-available/$APP_NAME" ] && warn "기존 사이트 파일 존재 -> .bak 백업 후 교체"
  # sites-enabled 구조가 아닌 서버(conf.d 만 쓰는 경우)를 대비해 디렉터리 존재 확인
  [ -d /etc/nginx/sites-enabled ] || die "/etc/nginx/sites-enabled 가 없습니다. conf.d 방식이면 수동 설정하세요."
else
  # 공용 서버에 웹서버를 새로 얹는 것은 영향 범위가 커서 자동 설치하지 않음
  fail "nginx 미설치. 공용 서버에 웹서버를 새로 올리는 건 영향이 커서 자동 설치하지 않습니다."
  echo "         관리자 승인 후: sudo apt-get install -y nginx"
  echo "         또는 SERVER_NAME 을 비워두고 앱만 배포하세요."
  die "nginx 패키지가 설치돼 있지 않습니다 (SERVER_NAME 값 문제가 아닙니다)"
fi

# ─────────────────────────────────────────────────────────────────────────────
head1 "4. 방화벽 상태 확인 (읽기만, 변경하지 않음)"

if command -v ufw >/dev/null 2>&1; then
  UFW_STATE="$($SUDO ufw status 2>/dev/null | head -1)"
  ok "ufw: $UFW_STATE"
  # 여기서 ufw enable 을 하면 SSH 규칙 누락 시 서버에서 잠기므로 절대 자동 실행하지 않음
  case "$UFW_STATE" in
    *inactive*) warn "ufw 비활성. 자동으로 켜지 않습니다(SSH 차단 위험)." ;;
    *)          warn "ufw 활성. 외부 공개가 필요하면 수동으로: sudo ufw allow 'Nginx Full'" ;;
  esac
else
  info "ufw 없음. 클라우드 보안그룹으로 관리 중일 가능성이 큽니다."
fi

# ─────────────────────────────────────────────────────────────────────────────
if [ "$APPLY" -eq 0 ]; then
  head1 "점검 완료 (DRY RUN)"
  echo "  시스템은 전혀 변경되지 않았습니다."
  echo "  위 [DRY ] 항목이 실제로 실행됩니다. 진행하려면: ./deploy.sh --apply"
  exit 0
fi

# ─────────────────────────────────────────────────────────────────────────────
head1 "5. 설치 및 배포 실행"

# 5-1. Node 설치 (아예 없을 때만)
if [ "$NEED_NODE_INSTALL" -eq 1 ]; then
  run bash -c "curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR_INSTALL}.x | ${SUDO} -E bash -"
  run $SUDO apt-get install -y nodejs
fi
# systemd 는 PATH 가 제한적이라 절대경로가 필요. 심볼릭/셰방 shim 까지 실체 경로로 풀어냄
NODE_BIN="$(readlink -f "$(command -v node)")"
# 홈 디렉터리 아래의 node(nvm/conda)는 유닛의 ProtectHome=yes 와 앱 계정 권한 때문에
# 그대로 쓰면 status=203/EXEC 로 실패한다 -> 홈 밖으로 복사해서 쓴다
case "$NODE_BIN" in
  /home/*|/root/*)
    warn "node 가 홈 경로에 있습니다: $NODE_BIN"
    warn "서비스 계정이 접근할 수 없어 $NODE_SHIP_DIR/node 로 복사해 사용합니다."
    run $SUDO mkdir -p "$NODE_SHIP_DIR"
    # 재배포 시 이 바이너리는 이미 실행 중이라 직접 덮어쓰면 "Text file busy" 로 실패한다.
    # 임시 이름으로 복사한 뒤 mv(rename)로 교체하면 실행 중이어도 안전하다.
    run $SUDO cp "$NODE_BIN" "$NODE_SHIP_DIR/node.new"
    run $SUDO chmod 755 "$NODE_SHIP_DIR/node.new"
    run $SUDO mv -f "$NODE_SHIP_DIR/node.new" "$NODE_SHIP_DIR/node"
    NODE_BIN="$NODE_SHIP_DIR/node"
    ;;
esac
ok "ExecStart 에 사용할 node: $NODE_BIN"

# 5-2. 전용 계정 생성 (없을 때만). nologin = 이 계정으로 로그인 불가
if [ "$NEED_USER_CREATE" -eq 1 ]; then
  run $SUDO useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi

# 5-3. 디렉터리 생성 후 소스 복사 (.git / node_modules / deploy.sh 는 제외)
run $SUDO mkdir -p "$APP_DIR"
if command -v rsync >/dev/null 2>&1; then
  run $SUDO rsync -a --delete \
      --exclude ".git" --exclude "node_modules" \
      --exclude "deploy.sh" --exclude "deploy.env" --exclude "set-domain.sh" \
      --exclude "notify.env" --exclude "notify-state.json" --exclude "notify.log" \
      --exclude ".gitignore" \
      "$SRC_DIR/" "$APP_DIR/"
else
  run $SUDO cp -a "$SRC_DIR/." "$APP_DIR/"
fi
# 소유자는 root, 그룹만 앱 계정 -> 앱이 자기 코드를 수정할 수 없게 함
run $SUDO chown -R root:"$APP_USER" "$APP_DIR"
run $SUDO chmod -R 750 "$APP_DIR"

# 5-4. systemd 유닛 작성 (기존 파일은 타임스탬프 백업)
[ -f "$UNIT_PATH" ] && run $SUDO cp -a "$UNIT_PATH" "$UNIT_PATH.bak.$(date +%s)"

# RPC 키를 config.json(=코드)에 넣지 않고 유닛 환경변수로만 주입
RPC_LINE=""
[ -n "$RPC_HTTP_URL" ] && RPC_LINE="Environment=RPC_HTTP_URL=$RPC_HTTP_URL"

$SUDO tee "$UNIT_PATH" >/dev/null <<UNIT
[Unit]
Description=ETH Balance Dashboard
After=network-online.target
Wants=network-online.target
# config.json 오타로 부팅에 실패하면 Restart=always 가 3초마다 영원히 되살린다.
# 일정 횟수를 넘기면 멈추고 failed 로 남겨 로그를 보게 한다 (해제: systemctl reset-failed)
StartLimitIntervalSec=120
StartLimitBurst=10

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=PORT=$APP_PORT
$RPC_LINE
ExecStart=$NODE_BIN $APP_DIR/server.js
# 주소 목록만 바꿀 때는 restart 대신 reload -> SSE 연결과 잔액 히스토리가 유지된다
ExecReload=/bin/kill -HUP \$MAINPID
Restart=always
RestartSec=3

# 공용 서버 격리: 앱이 시스템 나머지를 건드리지 못하도록 제한
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
RestrictSUIDSGID=yes

# 자원 상한: 접속이 몰리거나 새더라도 같은 서버의 다른 서비스까지 끌고 가지 않게 한다
MemoryMax=512M
LimitNOFILE=8192
TasksMax=64

[Install]
WantedBy=multi-user.target
UNIT
info "작성: $UNIT_PATH"

# 유닛 변경분 반영 -> 부팅 시 자동 시작 등록 -> 즉시 기동
run $SUDO systemctl daemon-reload
run $SUDO systemctl enable "$APP_NAME"
run $SUDO systemctl restart "$APP_NAME"

# 5-5. nginx 리버스 프록시 (SERVER_NAME 이 설정된 경우만)
if [ "$DO_NGINX" -eq 1 ]; then
  SITE="/etc/nginx/sites-available/$APP_NAME"
  [ -f "$SITE" ] && run $SUDO cp -a "$SITE" "$SITE.bak.$(date +%s)"

  # 주의: 이 힌트문서 안의 \$host 등은 nginx 변수이므로 셸 확장을 막기 위해 이스케이프
  $SUDO tee "$SITE" >/dev/null <<NGINX
# IP당 연결/요청 상한. 앱에도 IP당 SSE 제한이 있지만, 프록시에서 먼저 끊는 편이
# 훨씬 싸다. 아래 두 줄은 http 컨텍스트 지시어이고 sites-enabled 는 http{} 안에서
# include 되므로 server{} 바깥에 두어야 한다.
limit_conn_zone \$binary_remote_addr zone=ethdash_conn:10m;
limit_req_zone  \$binary_remote_addr zone=ethdash_req:10m rate=20r/s;
limit_conn_status 429;
limit_req_status  429;

server {
    listen 80;
    listen [::]:80;
    server_name $SERVER_NAME;

    location / {
        # SSE는 한 연결을 오래 붙잡으므로 연결 수 제한이 실질적인 방어선이다
        limit_conn ethdash_conn 20;
        limit_req  zone=ethdash_req burst=40 nodelay;

        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # SSE(/api/stream) 스트림이 끊기지 않게 하는 필수 설정
        proxy_buffering off;             # 응답을 모으지 말고 즉시 흘려보냄
        proxy_cache off;                 # 스트림 캐싱 금지
        proxy_read_timeout 24h;          # 유휴 스트림을 타임아웃으로 끊지 않음
        proxy_set_header Connection "";  # keep-alive 유지
    }
}
NGINX
  info "작성: $SITE"

  # 심볼릭 링크로만 활성화. 기존 default 사이트나 남의 설정은 건드리지 않음
  [ -L "/etc/nginx/sites-enabled/$APP_NAME" ] \
    || run $SUDO ln -s "$SITE" "/etc/nginx/sites-enabled/$APP_NAME"

  # 문법 검증을 통과할 때만 reload -> 실패해도 돌아가던 다른 사이트에 영향 없음
  if $SUDO nginx -t; then
    run $SUDO systemctl reload nginx
  else
    fail "nginx 설정 문법 오류. reload 하지 않았습니다. 아래로 되돌리세요:"
    echo "  sudo rm /etc/nginx/sites-enabled/$APP_NAME && sudo nginx -t"
    exit 1
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
head1 "6. 배포 검증"

$SUDO systemctl --no-pager --lines=15 status "$APP_NAME" || true

# 로컬에서 실제로 응답하는지 확인 (서비스가 떠도 크래시 루프일 수 있음)
if curl -fsS -m 5 "http://127.0.0.1:$APP_PORT/api/health" >/dev/null 2>&1; then
  ok "http://127.0.0.1:$APP_PORT/api/health 응답 정상"
else
  fail "로컬 응답 없음. 로그 확인: sudo journalctl -u $APP_NAME -n 50 --no-pager"
fi

echo
echo "배포 완료."
echo "  로그:    sudo journalctl -u $APP_NAME -f"
echo "  재시작:  sudo systemctl restart $APP_NAME"
echo "  되돌리기: sudo systemctl disable --now $APP_NAME && sudo rm $UNIT_PATH && sudo systemctl daemon-reload"
[ "$DO_NGINX" -eq 1 ] && echo "  HTTPS:   sudo certbot --nginx -d $SERVER_NAME"

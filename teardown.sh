#!/usr/bin/env bash
#
# eth-balance-dashboard 완전 철거 스크립트
# deploy.sh / set-domain.sh 가 서버에 만든 것을 전부 되돌린다.
#
# 사용법:
#   ./teardown.sh                    -> 지울 대상만 보여줌. 변경 없음 (기본값)
#   ./teardown.sh --apply            -> 실제 삭제
#   ./teardown.sh --apply --purge-src -> 스테이징 소스 디렉터리까지 삭제
#   ./teardown.sh --apply --purge-data -> 잔액 기록(DB)까지 삭제
#
# 삭제 대상:
#   - systemd 유닛 + 백업본(.bak.*)      /etc/systemd/system/eth-dashboard.service*
#   - 배포 디렉터리                       /opt/eth-dashboard
#   - 복사해 둔 node 바이너리             /opt/eth-dashboard-node
#   - 전용 시스템 계정/그룹               ethdash
#   - nginx 사이트 설정 + 링크 + 백업본   (있는 경우에만)
#
# 기본으로 남기는 것:
#   - 잔액 기록 DB                        /var/lib/eth-dashboard
#     지웠다가 다시 올리는 경우가 훨씬 흔하고, 지우면 되돌릴 방법이 없다.
#     정말 지우려면 --purge-data 를 준다.
#
# 건드리지 않는 것 (다른 사용자에게 영향이 가므로):
#   - nginx 패키지 자체, nginx.conf, default 사이트, 남의 사이트 설정
#   - ufw 규칙 및 활성화 상태
#   - Node.js 설치본 (nvm 포함)

set -euo pipefail

APP_NAME="eth-dashboard"
APP_USER="ethdash"
APP_DIR="/opt/eth-dashboard"
NODE_SHIP_DIR="/opt/eth-dashboard-node"
DATA_DIR="/var/lib/eth-dashboard"
APP_PORT="8787"

UNIT_PATH="/etc/systemd/system/${APP_NAME}.service"
SITE="/etc/nginx/sites-available/$APP_NAME"
LINK="/etc/nginx/sites-enabled/$APP_NAME"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ok()    { printf '  [ OK ] %s\n' "$*"; }
info()  { printf '  [ .. ] %s\n' "$*"; }
warn()  { printf '  [WARN] %s\n' "$*"; }
head1() { printf '\n== %s ==\n' "$*"; }
die()   { printf '  [FAIL] %s\n' "$*"; exit 1; }

APPLY=0; PURGE_SRC=0; PURGE_DATA=0
for a in "$@"; do
  case "$a" in
    --apply)      APPLY=1 ;;
    --purge-src)  PURGE_SRC=1 ;;
    --purge-data) PURGE_DATA=1 ;;
    *)           die "알 수 없는 옵션: $a" ;;
  esac
done

run() {
  if [ "$APPLY" -eq 1 ]; then info "실행: $*"; "$@"; else printf '  [DRY ] %s\n' "$*"; fi
}

# ─────────────────────────────────────────────────────────────────────────────
head1 "0. 권한 확인"
if [ "$(id -u)" -eq 0 ]; then SUDO=""; else
  command -v sudo >/dev/null 2>&1 || die "sudo 가 없고 root 도 아닙니다."
  sudo -v || die "sudo 권한을 얻지 못했습니다."
  SUDO="sudo"
fi
ok "권한 확보"

# ─────────────────────────────────────────────────────────────────────────────
head1 "1. 서비스 중지 및 자동시작 해제"

if [ -f "$UNIT_PATH" ] || systemctl list-unit-files 2>/dev/null | grep -q "^${APP_NAME}.service"; then
  # disable --now = 지금 중지 + 부팅 시 자동시작 해제. Restart=always 재시작 루프도 여기서 끊긴다
  run $SUDO systemctl disable --now "$APP_NAME"
  ok "서비스 중지/해제"
else
  ok "등록된 서비스 없음. 건너뜀"
fi

# ─────────────────────────────────────────────────────────────────────────────
head1 "2. nginx 설정 제거 (설치돼 있는 경우에만)"

if command -v nginx >/dev/null 2>&1; then
  REMOVED_NGINX=0
  if [ -L "$LINK" ] || [ -e "$LINK" ]; then run $SUDO rm -f "$LINK"; REMOVED_NGINX=1; fi
  if $SUDO test -e "$SITE";  then run $SUDO rm -f "$SITE";  REMOVED_NGINX=1; fi
  # set-domain.sh / deploy.sh 가 남긴 백업본도 정리
  for f in $($SUDO sh -c "ls ${SITE}.bak.* 2>/dev/null" || true); do run $SUDO rm -f "$f"; REMOVED_NGINX=1; done

  if [ "$REMOVED_NGINX" -eq 1 ]; then
    # 문법 검증 통과할 때만 reload. 남의 사이트를 죽이지 않기 위한 안전장치
    if [ "$APPLY" -eq 1 ]; then
      $SUDO nginx -t && run $SUDO systemctl reload nginx || warn "nginx -t 실패. reload 하지 않았습니다. 수동 확인 필요."
    else
      printf '  [DRY ] %s\n' "$SUDO nginx -t && $SUDO systemctl reload nginx"
    fi
  else
    ok "이 앱의 nginx 설정 없음. 건너뜀"
  fi
  warn "nginx 패키지 자체는 제거하지 않습니다(다른 사용자가 쓸 수 있음)."
else
  ok "nginx 미설치. 건너뜀"
fi

# ─────────────────────────────────────────────────────────────────────────────
head1 "3. systemd 유닛 파일 삭제"

for f in "$UNIT_PATH" $($SUDO sh -c "ls ${UNIT_PATH}.bak.* 2>/dev/null" || true); do
  $SUDO test -e "$f" && run $SUDO rm -f "$f"
done
run $SUDO systemctl daemon-reload
# 삭제된 유닛의 실패 기록을 초기화해 systemctl 목록을 깨끗하게 만든다
run $SUDO systemctl reset-failed
ok "유닛 정리 완료"

# ─────────────────────────────────────────────────────────────────────────────
head1 "4. 배포 파일 삭제"

if $SUDO test -e "$APP_DIR"; then
  $SUDO du -sh "$APP_DIR" 2>/dev/null || true
  run $SUDO rm -rf "$APP_DIR"
else
  ok "$APP_DIR 없음"
fi

if $SUDO test -e "$NODE_SHIP_DIR"; then
  run $SUDO rm -rf "$NODE_SHIP_DIR"
else
  ok "$NODE_SHIP_DIR 없음"
fi

# 잔액 기록은 기본으로 남긴다. 서비스를 지웠다 다시 올리는 경우가 훨씬 흔하고,
# 한 번 지우면 과거 잔액은 어디서도 다시 받아올 수 없다(무료 RPC 는 최근 128블록
# 이전 state 를 주지 않는다).
if $SUDO test -e "$DATA_DIR"; then
  $SUDO du -sh "$DATA_DIR" 2>/dev/null || true
  if [ "$PURGE_DATA" -eq 1 ]; then
    run $SUDO rm -rf "$DATA_DIR"
  else
    warn "$DATA_DIR 는 남깁니다 (잔액 기록). 지우려면 --purge-data 를 주세요."
  fi
else
  ok "$DATA_DIR 없음"
fi

# ─────────────────────────────────────────────────────────────────────────────
head1 "5. 전용 계정 삭제"

if id -u "$APP_USER" >/dev/null 2>&1; then
  run $SUDO userdel "$APP_USER"
  # useradd 가 만든 동명 그룹이 남아 있으면 함께 제거
  if getent group "$APP_USER" >/dev/null 2>&1; then run $SUDO groupdel "$APP_USER"; fi
  ok "계정/그룹 $APP_USER 삭제"
else
  ok "계정 $APP_USER 없음"
fi

# ─────────────────────────────────────────────────────────────────────────────
head1 "6. 스테이징 소스 디렉터리"

if [ "$PURGE_SRC" -eq 1 ]; then
  warn "$SRC_DIR 를 통째로 삭제합니다(이 스크립트 자신 포함). 재배포하려면 다시 전송해야 합니다."
  run $SUDO rm -rf "$SRC_DIR"
else
  ok "$SRC_DIR 는 유지합니다. 함께 지우려면 --purge-src 를 추가하세요."
fi

# ─────────────────────────────────────────────────────────────────────────────
head1 "7. 확인"

if [ "$APPLY" -eq 1 ]; then
  # 포트가 실제로 비었는지 = 프로세스가 확실히 죽었는지 확인
  if ss -ltnH "sport = :$APP_PORT" 2>/dev/null | grep -q .; then
    warn "포트 $APP_PORT 가 아직 사용 중입니다:"
    $SUDO ss -ltnp "sport = :$APP_PORT" || true
  else
    ok "포트 $APP_PORT 해제됨"
  fi
  id -u "$APP_USER" >/dev/null 2>&1 && warn "계정 $APP_USER 가 남아 있습니다." || ok "계정 정리됨"
  $SUDO test -e "$APP_DIR" && warn "$APP_DIR 가 남아 있습니다." || ok "배포 디렉터리 정리됨"

  echo
  echo "철거 완료. 방화벽은 처음부터 건드리지 않았으므로 닫을 포트가 없습니다"
  echo "(앱은 127.0.0.1 에만 바인딩했고 ufw 규칙을 추가한 적이 없습니다)."
  if command -v ufw >/dev/null 2>&1; then
    echo "현재 ufw 상태 참고:"
    $SUDO ufw status 2>/dev/null | head -5 || true
  fi
else
  echo
  echo "  DRY RUN 이었습니다. 시스템은 변경되지 않았습니다."
  echo "  실제 삭제: ./teardown.sh --apply"
  echo "  소스까지:  ./teardown.sh --apply --purge-src"
  echo "  기록까지:  ./teardown.sh --apply --purge-data"
fi

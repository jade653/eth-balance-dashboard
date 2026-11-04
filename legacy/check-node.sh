#!/usr/bin/env bash
#
# 이 서버에 node:sqlite 를 쓸 수 있는 Node 가 있는지 확인한다.
#
# 이 스크립트는 시스템을 전혀 바꾸지 않는다. 읽기만 한다.
#
# 사용법:
#   ./check-node.sh
#
# node:sqlite 요구 버전:
#   23.4.0 이상   그냥 쓸 수 있다
#   22.5.0 이상   --experimental-sqlite 플래그가 필요하다
#   그 미만        쓸 수 없다
#
# 버전 숫자만 비교하지 않고 실제로 require 를 시켜 본다.
# 배포판이 빌드 옵션으로 기능을 끄는 경우가 있어 버전만 보면 틀릴 수 있다.

set -uo pipefail   # -e 는 일부러 뺐다. 이 스크립트는 '실패'를 결과로 다룬다.

APP_NAME="eth-dashboard"

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# deploy.sh 와 같은 파일에서 설정을 읽어 서비스 이름이 어긋나지 않게 한다
if [ -f "$SRC_DIR/deploy.env" ]; then
  # shellcheck disable=SC1091
  . "$SRC_DIR/deploy.env"
fi

ok()    { printf '  [ OK ] %s\n' "$*"; }
info()  { printf '  [ .. ] %s\n' "$*"; }
warn()  { printf '  [WARN] %s\n' "$*"; }
fail()  { printf '  [FAIL] %s\n' "$*"; }
head1() { printf '\n== %s ==\n' "$*"; }

# 가장 좋은 후보를 기억해 둔다 (0=없음, 1=플래그 필요, 2=그냥 됨)
BEST_RANK=0
BEST_BIN=""
BEST_VER=""

# node 하나를 검사해 한 줄로 보고하고, 최고 후보를 갱신한다.
#   $1 = node 실행 파일 경로
#   $2 = 이 후보가 어디서 왔는지 설명 (화면 표시용)
probe() {
  local bin="$1" label="${2:-}" ver plain flagged rank note real

  if [ ! -x "$bin" ]; then
    fail "$bin — 실행할 수 없다 ${label:+($label)}"
    return
  fi

  ver="$("$bin" -v 2>/dev/null)"
  if [ -z "$ver" ]; then
    fail "$bin — 버전을 읽지 못했다 ${label:+($label)}"
    return
  fi

  # 실제로 불러와 본다. 성공/실패만 보면 되므로 출력은 버린다.
  plain=0
  "$bin" -e 'require("node:sqlite")' >/dev/null 2>&1 && plain=1

  flagged=0
  if [ "$plain" -eq 0 ]; then
    "$bin" --experimental-sqlite -e 'require("node:sqlite")' >/dev/null 2>&1 && flagged=1
  fi

  if   [ "$plain"   -eq 1 ]; then rank=2; note="node:sqlite 바로 사용 가능"
  elif [ "$flagged" -eq 1 ]; then rank=1; note="node:sqlite 사용 가능 (--experimental-sqlite 필요)"
  else                            rank=0; note="node:sqlite 사용 불가"
  fi

  # 같은 실행 파일이 여러 경로로 잡히므로 실제 경로를 함께 보여준다
  real="$(readlink -f "$bin" 2>/dev/null || printf '%s' "$bin")"

  case "$rank" in
    2) ok   "$ver  $bin${label:+  ($label)}" ;;
    1) warn "$ver  $bin${label:+  ($label)}" ;;
    0) fail "$ver  $bin${label:+  ($label)}" ;;
  esac
  printf '         %s\n' "$note"
  [ "$real" != "$bin" ] && printf '         -> %s\n' "$real"

  if [ "$rank" -gt "$BEST_RANK" ]; then
    BEST_RANK="$rank"; BEST_BIN="$bin"; BEST_VER="$ver"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
head1 "1. 지금 셸의 Node"

if command -v node >/dev/null 2>&1; then
  probe "$(command -v node)" "현재 PATH"
else
  fail "이 셸의 PATH 에 node 가 없다"
fi

# ─────────────────────────────────────────────────────────────────────────────
head1 "2. systemd 서비스가 실제로 쓰는 Node"

# 서비스가 쓰는 node 는 로그인 셸의 node 와 다를 수 있다.
# 정작 중요한 건 이쪽이므로 유닛에서 직접 읽는다.
if command -v systemctl >/dev/null 2>&1; then
  UNIT_EXEC="$(systemctl show "$APP_NAME" -p ExecStart --value 2>/dev/null)"
  if [ -n "$UNIT_EXEC" ]; then
    # ExecStart 값은 "{ path=/usr/bin/node ; argv[]=... }" 형태다
    UNIT_NODE="$(printf '%s' "$UNIT_EXEC" | sed -n 's/.*path=\([^ ;]*\).*/\1/p' | head -1)"
    if [ -n "$UNIT_NODE" ]; then
      probe "$UNIT_NODE" "$APP_NAME.service"
    else
      warn "ExecStart 에서 node 경로를 뽑아내지 못했다:"
      printf '         %s\n' "$UNIT_EXEC"
    fi
  else
    info "$APP_NAME.service 가 없다 (아직 배포 전이거나 개발 장비)"
  fi
else
  info "systemctl 이 없다 (개발 장비로 보인다)"
fi

# ─────────────────────────────────────────────────────────────────────────────
head1 "3. 이 장비에 있는 다른 Node"

# 후보들을 모아 중복을 걷어낸 뒤 하나씩 검사한다
CANDIDATES=""
for p in /usr/bin/node /usr/local/bin/node \
         /opt/eth-dashboard-node/node /opt/eth-dashboard-node/bin/node; do
  [ -x "$p" ] && CANDIDATES="$CANDIDATES $p"
done
for p in "$HOME"/.nvm/versions/node/*/bin/node; do
  [ -x "$p" ] && CANDIDATES="$CANDIDATES $p"
done

SEEN=""
FOUND_OTHER=0
for p in $CANDIDATES; do
  real="$(readlink -f "$p" 2>/dev/null || printf '%s' "$p")"
  case " $SEEN " in *" $real "*) continue ;; esac
  SEEN="$SEEN $real"
  # 1번에서 이미 본 것과 같으면 건너뛴다
  [ "$real" = "$(readlink -f "$(command -v node 2>/dev/null)" 2>/dev/null)" ] && continue
  probe "$p"
  FOUND_OTHER=1
done
[ "$FOUND_OTHER" -eq 0 ] && info "위에서 본 것 말고 다른 Node 는 없다"

# ─────────────────────────────────────────────────────────────────────────────
head1 "결론"

case "$BEST_RANK" in
  2)
    ok "$BEST_VER 로 SQLite 를 바로 쓸 수 있다."
    printf '         %s\n' "$BEST_BIN"
    echo
    echo "  systemd 유닛의 ExecStart 가 이 node 를 쓰는지 확인하면 된다."
    ;;
  1)
    warn "$BEST_VER 는 플래그를 붙여야 SQLite 가 열린다."
    printf '         %s\n' "$BEST_BIN"
    echo
    echo "  ExecStart 에 --experimental-sqlite 를 넣어야 하고, 이 플래그가 붙은 기능은"
    echo "  마이너 버전에서도 동작이 바뀔 수 있다. 23.4.0 이상을 쓰는 편이 낫다."
    ;;
  0)
    fail "SQLite 를 쓸 수 있는 Node 가 이 장비에 없다. (23.4.0 이상 필요)"
    echo
    echo "  공용 서버의 전역 Node 를 올리면 다른 서비스가 깨질 수 있다."
    echo "  이 앱 전용으로만 하나 두는 방법:"
    echo
    echo "    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
    echo "    . \"\$HOME/.nvm/nvm.sh\" && nvm install 24"
    echo
    echo "  그 뒤 deploy.sh 가 NODE_SHIP_DIR(/opt/eth-dashboard-node) 로 복사해"
    echo "  ExecStart 에 그 절대경로를 쓰게 한다. 전역 Node 는 건드리지 않는다."
    ;;
esac

echo

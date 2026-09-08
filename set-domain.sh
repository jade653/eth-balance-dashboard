#!/usr/bin/env bash
#
# eth-balance-dashboard 도메인 + HTTPS(443) 설정 스크립트
#
# 이 서버는 80 포트를 다른 사용자의 Traefik 컨테이너가 점유하고 있다.
# 그래서 nginx 를 443 에만 붙이고 80 은 전혀 건드리지 않는다.
#
#   [브라우저] --https(443)--> [nginx: TLS 종료] --http--> [127.0.0.1:APP_PORT: node]
#
# 사용법:
#   ./set-domain.sh                          -> 점검만. 시스템 변경 없음 (기본값)
#   ./set-domain.sh --apply                  -> 실제 적용
#   ./set-domain.sh --install-nginx --apply  -> nginx 가 없으면 설치까지 함께
#   ./set-domain.sh --remove --apply         -> 외부 공개 해제 (앱 서비스는 유지)
#   ./set-domain.sh other.domain --apply     -> 도메인을 인자로 덮어쓰기
#
# 공용 서버 안전장치:
#   - 80 포트는 읽기만 하고 절대 점유하지 않는다
#   - nginx 기본 사이트(default)는 listen 80 이라 충돌하므로 비활성화한다
#   - 남이 쓰는 server_name 과 겹치면 중단
#   - nginx -t 통과할 때만 기동/reload -> 실패 시 자동 롤백
#   - nginx.conf 및 남의 사이트 설정은 건드리지 않는다
#   - ufw 는 상태만 읽는다

set -euo pipefail

DOMAIN_DEFAULT="test.mustree.kr"
APP_NAME="eth-dashboard"                       # deploy.sh 의 APP_NAME 과 동일해야 함
UNIT_PATH="/etc/systemd/system/${APP_NAME}.service"
SITE="/etc/nginx/sites-available/$APP_NAME"
LINK="/etc/nginx/sites-enabled/$APP_NAME"
DEFAULT_LINK="/etc/nginx/sites-enabled/default"

ok()    { printf '  [ OK ] %s\n' "$*"; }
info()  { printf '  [ .. ] %s\n' "$*"; }
warn()  { printf '  [WARN] %s\n' "$*"; }
fail()  { printf '  [FAIL] %s\n' "$*"; }
head1() { printf '\n== %s ==\n' "$*"; }
die()   { fail "$*"; printf '\n중단합니다. 시스템은 변경되지 않았습니다.\n'; exit 1; }

# ── 인자 파싱 ────────────────────────────────────────────────────────────────
DOMAIN=""; APPLY=0; REMOVE=0; INSTALL_NGINX=0
for a in "$@"; do
  case "$a" in
    --apply)         APPLY=1 ;;
    --remove)        REMOVE=1 ;;
    --install-nginx) INSTALL_NGINX=1 ;;
    -*)              die "알 수 없는 옵션: $a" ;;
    *)               DOMAIN="$a" ;;
  esac
done
[ -z "$DOMAIN" ] && DOMAIN="$DOMAIN_DEFAULT"

CERT_DIR="/etc/letsencrypt/live/$DOMAIN"
CERT="$CERT_DIR/fullchain.pem"
KEY="$CERT_DIR/privkey.pem"

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
head1 "1. 앱 서비스 확인"

$SUDO test -f "$UNIT_PATH" || die "$UNIT_PATH 가 없습니다. deploy.sh 로 앱을 먼저 배포하세요."
if systemctl is-active --quiet "$APP_NAME"; then
  ok "서비스 $APP_NAME 실행 중"
else
  warn "서비스 $APP_NAME 가 실행 중이 아닙니다. 도메인을 붙여도 502 가 납니다."
fi

# 포트를 손으로 적지 않고 유닛의 Environment=PORT= 에서 읽어 불일치를 원천 차단
APP_PORT="$(systemctl show "$APP_NAME" -p Environment --value 2>/dev/null \
            | tr ' ' '\n' | sed -n 's/^PORT=//p' | head -1)"
[ -z "$APP_PORT" ] && APP_PORT="8787"
ok "프록시 대상: 127.0.0.1:$APP_PORT (유닛에서 읽음)"

# ─────────────────────────────────────────────────────────────────────────────
# 공개 해제 모드
if [ "$REMOVE" -eq 1 ]; then
  head1 "공개 해제"
  if [ -L "$LINK" ] || [ -e "$LINK" ]; then
    run $SUDO rm -f "$LINK"
    if [ "$APPLY" -eq 1 ]; then
      $SUDO nginx -t && run $SUDO systemctl reload nginx || warn "nginx -t 실패. 수동 확인 필요."
    fi
    ok "443 공개 해제 완료. 앱은 127.0.0.1:$APP_PORT 에서 계속 동작합니다."
    ok "사이트 정의는 $SITE 에 남겨뒀습니다(재공개 시 재사용)."
    ok "인증서는 지우지 않았습니다: $CERT_DIR"
  else
    ok "이미 공개돼 있지 않습니다."
  fi
  [ "$APPLY" -eq 0 ] && echo && echo "  DRY RUN. 실제 적용: ./set-domain.sh --remove --apply"
  exit 0
fi

# ─────────────────────────────────────────────────────────────────────────────
head1 "2. 도메인 검증: $DOMAIN"

printf '%s' "$DOMAIN" | grep -qE '^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$' \
  || die "도메인 형식이 아닙니다: $DOMAIN"
printf '%s' "$DOMAIN" | grep -qE '^[0-9.]+$' && die "IP 는 server_name 으로 쓸 수 없습니다."
ok "형식 정상"

# nginx 는 server_name 을 DNS 로 조회하지 않고 Host 헤더 문자열만 비교한다.
# 따라서 DNS 가 아직 전파 중이어도 설정 진행에는 지장이 없다. 참고 정보로만 출력한다.
RESOLVED="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')"
if [ -n "$RESOLVED" ]; then
  ok "DNS(이 서버 리졸버) -> $RESOLVED"
else
  warn "이 서버 리졸버가 아직 $DOMAIN 을 모릅니다(네거티브 캐시). 설정에는 지장 없습니다."
fi

# ─────────────────────────────────────────────────────────────────────────────
head1 "3. 포트 점유 상태"

# 80 은 남의 것이다. 상태만 보고 절대 건드리지 않는다.
HOLDER80="$($SUDO ss -ltnpH '( sport = :80 )' 2>/dev/null | head -1 || true)"
if [ -n "$HOLDER80" ]; then
  warn "80 은 다른 프로세스가 사용 중입니다(건드리지 않음)"
  printf '         %s\n' "$HOLDER80"
else
  info "80 은 비어 있지만 이 스크립트는 443 만 사용합니다."
fi

# 443 은 우리가 쓸 포트다. nginx 자신이 잡고 있는 경우만 허용한다.
HOLDER443="$($SUDO ss -ltnpH '( sport = :443 )' 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true)"
if [ -n "$HOLDER443" ]; then
  IS_NGINX=1
  for pid in $HOLDER443; do
    ps -o comm= -p "$pid" 2>/dev/null | grep -q '^nginx$' || IS_NGINX=0
  done
  if [ "$IS_NGINX" -eq 1 ]; then
    ok "443 은 nginx 가 사용 중 -> 재설정이므로 정상"
  else
    $SUDO ss -ltnp '( sport = :443 )' || true
    die "443 을 nginx 가 아닌 다른 프로세스가 쓰고 있습니다."
  fi
else
  ok "443 사용 가능"
fi

# ─────────────────────────────────────────────────────────────────────────────
head1 "4. nginx 확인"

NEED_NGINX_INSTALL=0
if command -v nginx >/dev/null 2>&1; then
  ok "nginx 설치됨: $(nginx -v 2>&1)"
  # 기본 사이트는 listen 80 이라 Traefik 과 충돌해 nginx 기동을 통째로 막는다
  [ -e "$DEFAULT_LINK" ] && warn "기본 사이트(default) 활성 상태 -> 80 충돌 회피를 위해 비활성화합니다."
  # 다른 사람이 같은 도메인을 쓰면 트래픽 가로채기 사고가 난다
  CONFLICT="$($SUDO grep -rlE "server_name[^;]*[[:space:]]${DOMAIN}[;[:space:]]" \
              /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | grep -v "$APP_NAME" || true)"
  [ -n "$CONFLICT" ] && die "'$DOMAIN' 을 이미 쓰는 설정이 있습니다: $CONFLICT"
  ok "server_name 충돌 없음"
else
  if [ "$INSTALL_NGINX" -eq 1 ]; then
    warn "nginx 미설치 -> 설치합니다. 시스템 전역 서비스가 추가됩니다."
    warn "설치 직후 자동 기동이 80 충돌로 실패하는 것은 예상된 동작입니다."
    NEED_NGINX_INSTALL=1
  else
    fail "nginx 패키지가 설치돼 있지 않습니다(도메인 값 문제가 아님)."
    echo "         설치까지 함께 하려면: ./set-domain.sh --install-nginx --apply"
    die "nginx 없음"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
head1 "5. TLS 인증서 확인"

# 인증서 파일이 없는 상태로 listen 443 ssl 을 넣으면 nginx 가 기동 자체를 실패한다.
# 그래서 인증서가 없으면 여기서 멈추고 발급 절차를 안내한다.
if $SUDO test -f "$CERT" && $SUDO test -f "$KEY"; then
  EXP="$($SUDO openssl x509 -enddate -noout -in "$CERT" 2>/dev/null | cut -d= -f2 || echo '?')"
  ok "인증서 있음: $CERT_DIR (만료: $EXP)"
else
  fail "인증서가 없습니다: $CERT"
  cat <<GUIDE

  이 서버는 80 을 쓸 수 없어 표준 HTTP-01 방식(certbot --nginx)을 사용할 수 없습니다.
  DNS TXT 레코드로 소유를 증명하는 DNS-01 방식으로 발급하세요.

    1) certbot 설치
         sudo apt-get update && sudo apt-get install -y certbot

    2) 발급 (대화형. 중간에 TXT 레코드 등록을 요구합니다)
         sudo certbot certonly --manual --preferred-challenges dns -d $DOMAIN

    3) certbot 이 출력하는 값을 도메인 DNS 에 TXT 레코드로 추가
         이름: _acme-challenge.$DOMAIN
         값:   (certbot 이 알려주는 문자열)
       추가 후 아래로 전파를 확인한 다음 Enter 를 누르세요(성급히 누르면 실패합니다)
         nslookup -type=TXT _acme-challenge.$DOMAIN 8.8.8.8

    4) 발급 완료 후 이 스크립트를 다시 실행
         ./set-domain.sh --apply

  참고: --manual 방식은 자동 갱신되지 않습니다. 90일마다 2) 를 다시 실행해야 합니다.

GUIDE
  die "인증서 없음"
fi

# ─────────────────────────────────────────────────────────────────────────────
if [ "$APPLY" -eq 0 ]; then
  head1 "점검 완료 (DRY RUN)"
  echo "  시스템은 변경되지 않았습니다."
  echo "  적용하려면: ./set-domain.sh --apply"
  exit 0
fi

head1 "6. 적용"

# 6-1. nginx 설치. 자동 기동 실패는 예상된 동작이므로 중단하지 않는다
if [ "$NEED_NGINX_INSTALL" -eq 1 ]; then
  run $SUDO apt-get update
  run $SUDO apt-get install -y nginx \
    || warn "설치 중 자동 기동 실패(80 충돌) — 예상된 동작입니다. 계속 진행합니다."
fi

# 6-2. 기본 사이트 비활성화. 링크만 지우므로 원본은 sites-available 에 남는다
[ -e "$DEFAULT_LINK" ] && run $SUDO rm -f "$DEFAULT_LINK"

# 6-3. 사이트 설정 작성. 기존 파일은 타임스탬프로 백업
$SUDO test -f "$SITE" && run $SUDO cp -a "$SITE" "$SITE.bak.$(date +%s)"

# 플레이스홀더 치환 방식이라 nginx 변수($host 등)가 셸에 확장될 위험이 없다
TMP="$(mktemp)"
cat > "$TMP" <<'NGINXCONF'
# eth-balance-dashboard — 443 전용. 80 은 다른 서비스가 쓰므로 사용하지 않는다.

# IP당 연결/요청 상한. 앱에도 IP당 SSE 제한이 있지만, 프록시에서 먼저 끊는 편이
# 훨씬 싸다. 아래는 http 컨텍스트 지시어이고 sites-enabled 는 http{} 안에서
# include 되므로 server{} 바깥에 두어야 한다.
limit_conn_zone $binary_remote_addr zone=ethdash_conn:10m;
limit_req_zone  $binary_remote_addr zone=ethdash_req:10m rate=20r/s;
limit_conn_status 429;
limit_req_status  429;

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name __DOMAIN__;

    ssl_certificate     __CERT__;
    ssl_certificate_key __KEY__;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 1d;

    # 업로드가 없는 대시보드라 본문 크기를 작게 제한한다
    client_max_body_size 1m;

    location / {
        # SSE는 한 연결을 오래 붙잡으므로 연결 수 제한이 실질적인 방어선이다
        limit_conn ethdash_conn 20;
        limit_req  zone=ethdash_req burst=40 nodelay;

        proxy_pass http://127.0.0.1:__PORT__;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE(/api/stream) 스트림이 끊기지 않게 하는 필수 설정
        proxy_buffering off;             # 응답을 모으지 말고 즉시 흘려보냄
        proxy_cache off;                 # 스트림 캐싱 금지
        proxy_read_timeout 24h;          # 유휴 스트림을 타임아웃으로 끊지 않음
        proxy_set_header Connection "";  # keep-alive 유지
    }
}
NGINXCONF
sed -i "s|__DOMAIN__|$DOMAIN|g; s|__PORT__|$APP_PORT|g; s|__CERT__|$CERT|g; s|__KEY__|$KEY|g" "$TMP"
$SUDO install -m 644 -o root -g root "$TMP" "$SITE"
rm -f "$TMP"
ok "작성: $SITE (listen 443 ssl, server_name $DOMAIN)"

# 6-4. 심볼릭 링크로 활성화
[ -L "$LINK" ] || run $SUDO ln -s "$SITE" "$LINK"

# 6-5. 80 을 잡으려는 설정이 남아 있으면 기동이 실패하므로 미리 알린다
LISTEN80="$($SUDO grep -rlE '^[[:space:]]*listen[[:space:]]+(\[::\]:)?80[[:space:];]' \
            /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null || true)"
[ -n "$LISTEN80" ] && warn "아직 80 을 사용하는 설정이 있습니다(기동 실패 가능): $LISTEN80"

# 6-6. 문법 검증 통과 시에만 기동/리로드. 실패하면 링크를 되돌린다
if $SUDO nginx -t; then
  if systemctl is-active --quiet nginx; then
    run $SUDO systemctl reload nginx
  else
    run $SUDO systemctl enable --now nginx
  fi
  ok "nginx 적용 완료"
else
  fail "nginx 설정 검증 실패 -> 롤백합니다."
  $SUDO rm -f "$LINK"
  $SUDO nginx -t && warn "롤백 완료. 기존 상태로 되돌렸습니다."
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
head1 "7. 검증"

# --resolve 로 DNS 전파와 무관하게 로컬 nginx 를 직접 때려 경로만 확인한다
if curl -fsS -m 8 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health" >/dev/null 2>&1; then
  ok "https://$DOMAIN (로컬 경유) 응답 정상"
else
  fail "응답 실패."
  fail "  앱 로그:    sudo journalctl -u $APP_NAME -n 30 --no-pager"
  fail "  nginx 로그: sudo tail -20 /var/log/nginx/error.log"
fi

echo
echo "확인:"
echo "  브라우저:  https://$DOMAIN"
echo "  명령줄:    curl -sS https://$DOMAIN/api/health"
echo
echo "참고:"
echo "  - 80 은 사용하지 않으므로 http:// 로는 접속되지 않습니다. 반드시 https:// 로 접속하세요."
if command -v ufw >/dev/null 2>&1; then
  echo "  - ufw 상태: $($SUDO ufw status 2>/dev/null | head -1)  (비활성이면 켜지 마세요: SSH 차단 위험)"
fi
echo "  - 인증서 갱신(90일): sudo certbot certonly --manual --preferred-challenges dns -d $DOMAIN"
echo "    갱신 후 반영:      sudo systemctl reload nginx"
echo "  - 공개 해제: ./set-domain.sh --remove --apply"

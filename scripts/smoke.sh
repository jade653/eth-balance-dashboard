#!/usr/bin/env bash
# 띄워 둔 서비스(docker compose up)가 "배포된 모양대로" 동작하는지 바깥에서 두드려 본다.
# 단위 테스트가 코드 조각을 본다면, 이건 nginx·컨테이너·네트워크까지 합친 전체를 본다.
#
#   ./scripts/smoke.sh                  # 기본 http://127.0.0.1:8080
#   BASE=http://host:port ./scripts/smoke.sh
#
# 외부 RPC 상태에 기대지 않는다: health 는 200(정상)·503(RPC 장애) 둘 다 통과로 본다.

set -euo pipefail

BASE="${BASE:-http://127.0.0.1:8080}"
fail=0
pass() { printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=1; }

# 띄운 직후엔 아직 준비 중일 수 있으니 최대 30초 기다린다
for _ in $(seq 30); do
  curl -fs -o /dev/null "$BASE/" && break
  sleep 1
done

echo "smoke test → $BASE"

# 1) 정적 파일은 nginx 가 직접 준다
code=$(curl -s -o /dev/null -w '%{http_code} %{content_type}' "$BASE/")
[[ $code == "200 text/html"* ]] && pass "GET /            → $code" || bad "GET / → $code"

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/js/main.js")
[[ $code == 200 ]] && pass "GET /js/main.js  → $code" || bad "GET /js/main.js → $code"

# 2) /api 는 nginx 를 지나 api 컨테이너까지 간다. 404 JSON 은 node 가 만든 응답이다.
body=$(curl -s -w ' %{http_code}' "$BASE/api/v1/nope")
[[ $body == '{"error":"not_found"} 404' ]] && pass "GET /api/v1/nope → api 까지 도달 (404 JSON)" || bad "GET /api/v1/nope → $body"

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/health")
[[ $code == 200 || $code == 503 ]] && pass "GET /api/v1/health → $code" || bad "GET /api/v1/health → $code"

# 3) 로드밸런싱: 여러 번 요청하면 서로 다른 인스턴스가 받는다 (x-served-by 헤더)
want="${EXPECT_INSTANCES:-3}"
seen=$(for _ in $(seq $((want * 4))); do
  curl -s -D - -o /dev/null "$BASE/api/v1/nope" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-served-by"{print $2}'
done | sort -u)
n=$(printf '%s\n' "$seen" | grep -c . || true)
[[ $n -eq $want ]] && pass "로드밸런싱: 인스턴스 $n/$want 개가 요청을 나눠 받음" || bad "로드밸런싱: $n/$want 개만 응답 ($(echo $seen))"

exit $fail

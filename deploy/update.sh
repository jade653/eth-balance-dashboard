#!/usr/bin/env bash
# 서버에서 cron 으로 몇 분마다 돈다. "새 버전이 있으면 받아서 바꿔 끼운다."
#
#   GitHub 은 서버를 모른다. 서버가 GitHub(GHCR)을 보러 간다 (pull 방식 배포).
#   그래서 GitHub 에 서버 주소·SSH 키를 넣을 필요가 없고, 서버가 밖에서 SSH 로 열려 있을 필요도 없다.
#
#   [push] → CI(테스트·smoke) → 통과하면 이미지를 GHCR 에 올림
#                                         ▲
#   [서버 cron, 5분마다] ── 새 이미지 있나? ┘ → 있으면 pull → 컨테이너 교체 → smoke test
#
# 이 스크립트는 저장소를 clone 해 둔 디렉터리 안에서 돈다. 서버별 값은 전부 그 디렉터리의
# .env (커밋 안 됨)에 둔다: POSTGRES_PASSWORD, RPC_HTTP_URL, WEB_PORT, IMAGE_TAG …
#
#   crontab 예:  */5 * * * * /path/to/repo/deploy/update.sh >> /path/to/deploy.log 2>&1

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# cron 이 이전 실행이 안 끝났는데 또 부르면 겹치지 않게 그냥 빠진다
exec 9>/tmp/eth-explorer-update.lock
flock -n 9 || exit 0

COMPOSE=(docker compose -f compose.yaml -f deploy/compose.prod.yaml)
ts() { date '+%F %T'; }

# 1) 설정 파일(compose.yaml 등) 갱신. 서버에서 파일을 손으로 고쳤다면 여기서 멈춘다 (덮어쓰지 않음).
old_rev=$(git rev-parse HEAD)
git pull --ff-only --quiet
new_rev=$(git rev-parse HEAD)

# 2) 새 이미지 받기. 이미 같은 것이면 아무것도 안 받는다.
images_before=$("${COMPOSE[@]}" images -q 2>/dev/null | sort | tr '\n' ' ')
"${COMPOSE[@]}" pull --quiet
# 3) 바뀐 컨테이너만 새로 만든다. 그대로인 것은 건드리지 않는다.
# 출력은 모아 두었다가 실제로 바뀐 경우나 실패한 경우에만 보여준다.
if ! up_log=$("${COMPOSE[@]}" up -d --no-build --remove-orphans 2>&1); then
  echo "[$(ts)] !! docker compose up 실패"
  echo "$up_log"
  exit 1
fi
images_after=$("${COMPOSE[@]}" images -q 2>/dev/null | sort | tr '\n' ' ')

if [[ $old_rev == "$new_rev" && $images_before == "$images_after" ]]; then
  exit 0 # 바뀐 게 없으면 조용히 끝 (로그를 5분마다 채우지 않게)
fi

echo "[$(ts)] 배포: git ${old_rev:0:7} → ${new_rev:0:7}"
echo "$up_log" | grep -E 'Recreat|Creat|Start' || true

# 4) 배포 후 점검. 실패하면 알리기만 한다 — 롤백은 사람이 판단한다 (.env 에 IMAGE_TAG=sha-xxxxxxx).
port=$(grep -s '^WEB_PORT=' .env | cut -d= -f2 || true)
if BASE="http://127.0.0.1:${port:-8080}" ./scripts/smoke.sh; then
  echo "[$(ts)] 배포 완료"
else
  echo "[$(ts)] !! smoke test 실패 — 'docker compose logs' 확인 후 필요하면 IMAGE_TAG 로 이전 버전 고정"
  exit 1
fi

# 5) 더 이상 안 쓰는 옛 이미지 정리 (디스크)
docker image prune -f >/dev/null

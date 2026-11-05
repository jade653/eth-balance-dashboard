#!/usr/bin/env bash
# 두 커밋 사이에 바뀐 파일을 보고, 다시 빌드·배포해야 할 이미지를 JSON 배열로 출력한다.
#
#   ./scripts/changed-images.sh <기준 커밋> <대상 커밋>     → ["api","web"] / ["web"] / [] …
#
# 규칙
#   server/**             → api   (api·worker 공용 이미지)
#   client/**             → web   (nginx + 화면 파일)
#   .github/workflows/**  → 둘 다 (배포 절차 자체가 바뀌었으면 안전하게 전부)
#   그 외 (문서, compose.yaml, deploy/, scripts/, legacy/) → 이미지 없음
#     compose.yaml·deploy/ 는 이미지가 아니라 서버가 git pull 로 받아 간다.
#
# 기준 커밋이 비었거나 히스토리에 없으면(첫 배포, force push 등) 판단할 수 없으므로 둘 다.

set -euo pipefail

base="${1:-}"
head="${2:-HEAD}"

if [[ -z $base ]] || ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  echo '["api","web"]'
  exit 0
fi

api=false
web=false
while IFS= read -r f; do
  case "$f" in
    server/*) api=true ;;
    client/*) web=true ;;
    .github/workflows/*) api=true; web=true ;;
  esac
done < <(git diff --name-only "$base" "$head")

out=()
$api && out+=('"api"')
$web && out+=('"web"')
(IFS=,; echo "[${out[*]}]")

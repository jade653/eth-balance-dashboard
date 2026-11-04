# 프론트 이미지 = nginx + 정적 파일 + nginx 설정.
#
# 빌드 단계가 없는 순수 HTML/JS 라 파일을 그대로 복사하면 끝이다.
# 나중에 React 같은 빌드 도구를 쓰게 되면 여기 앞에 "node 로 빌드하는 단계"를 하나 두고
# 결과물(dist/)만 이 nginx 단계로 복사한다 (multi-stage build).

FROM nginx:1.28-alpine

COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY public/ /usr/share/nginx/html/

EXPOSE 80

HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

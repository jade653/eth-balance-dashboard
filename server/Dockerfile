# API 서버 이미지.
#
# 이미지 = "이 코드를 돌리는 데 필요한 모든 것(OS 일부 + Node + 코드)"을 한 덩어리로 굳힌 것.
# 어느 서버에서 띄워도 똑같이 돈다. 서버에 Node 버전을 맞추던 일(nvm, check-node.sh)이 사라진다.

FROM node:24-alpine

WORKDIR /app

# 컨테이너 안에서는 0.0.0.0 으로 열어야 다른 컨테이너(nginx)가 닿을 수 있다.
# 밖(인터넷)에 열리는지는 여기가 아니라 compose 의 ports 설정이 정한다 — api 는 아예 안 연다.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787

# 의존성(pg) 설치. package-lock.json 에 적힌 버전 그대로 설치한다 (npm ci).
# 코드보다 먼저 복사하는 이유: 코드만 바뀌었을 때 이 단계를 캐시로 건너뛰기 위해서다.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# root 로 돌리지 않는다. 앱이 뚫려도 컨테이너 안에서조차 권한이 없게.
USER node

EXPOSE 8787

# "프로세스가 살아서 대답하는가"만 본다.
# 200(정상)뿐 아니라 503(노드가 RPC 에 못 닿음)도 살아 있는 것으로 친다 —
# RPC 장애는 컨테이너를 재시작한다고 낫지 않기 때문이다.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/v1/health').then(r=>process.exit([200,503].includes(r.status)?0:1)).catch(()=>process.exit(1))"

# exec 형식(JSON 배열)으로 써야 node 가 PID 1 이 되어 docker stop 의 SIGTERM 을 직접 받는다.
CMD ["node", "src/index.js"]

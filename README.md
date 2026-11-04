# ETH Explorer (리팩토링 실습)

`legacy/` 의 ETH 잔액 대시보드를 **client-server 분리 · REST API · Docker/nginx 다중 처리 ·
GitHub CI/CD** 를 갖춘 작은 이더리움 explorer 로 다시 짜는 실습 저장소다.

## 구조

```
.
├── server/                 API 서버 (Node 24, 의존성 0)
│   ├── src/
│   │   ├── index.js        진입점: 환경변수 읽고 포트 연다 (조립만)
│   │   ├── app.js          HTTP 층: URL·메서드·상태코드 (rpc 를 주입받아 테스트 가능)
│   │   ├── explorer.js     업무 층: tx·블록·주소를 보여주려면 노드에 무엇을 묻나
│   │   ├── rpc.js          JSON-RPC 클라이언트 (legacy 에서 이식, 페일오버·배치)
│   │   └── validate.js     입력 검증 (주소, tx 해시)
│   ├── test/
│   └── Dockerfile          api 이미지 (node:24-alpine)
├── client/                 정적 프론트엔드 (빌드 없음)
│   ├── public/             배포 시 nginx 가 그대로 서빙할 파일들
│   │   ├── index.html
│   │   └── js/
│   │       ├── main.js     DOM·fetch
│   │       └── format.js   표시용 순수 함수 (Node 로 테스트)
│   ├── nginx/default.conf  nginx 설정: 정적 서빙 + /api 로드밸런싱
│   ├── scripts/dev.js      개발용 서버: 정적 파일 + /api 프록시 (nginx 없이 개발할 때)
│   ├── test/
│   └── Dockerfile          web 이미지 (nginx + public/)
├── legacy/                 기존 잔액 대시보드. 새 버전이 대체할 때까지 그대로 둔다
├── compose.yaml            전체 구성: web(nginx) 1개 + api 3개
├── scripts/smoke.sh        띄운 서비스를 바깥에서 점검 (CI 도 사용)
├── .github/workflows/ci.yml
└── .nvmrc                  Node 버전 (로컬 nvm 과 CI 가 같이 본다)
```

## Docker 로 실행 (배포와 같은 모양)

```
[브라우저] ──:8080──▶ [web: nginx] ─┬─▶ 정적 파일
                                    └─▶ /api/* → [api × 3] ──▶ 이더리움 RPC
```

```bash
docker compose up -d --build           # http://127.0.0.1:8080
./scripts/smoke.sh                     # 정적 서빙 · /api 프록시 · 로드밸런싱 점검
docker compose up -d --scale api=5     # api 를 5개로
docker compose logs -f web             # 어느 api 가 받았는지(upstream=) 보인다
docker compose down
```

RPC 를 바꾸려면 `.env` 에 `RPC_HTTP_URL=...` (커밋하지 않는다). 포트는 `WEB_PORT` 로 바꾼다.

## Docker 없이 실행 (개발용)

```bash
nvm use                         # .nvmrc -> 24

# 터미널 1: API 서버 (기본 RPC: 이더리움 메인넷 publicnode)
cd server && npm start          # http://127.0.0.1:8787

# 터미널 2: 프론트
cd client && npm run dev        # http://127.0.0.1:5173  (/api 는 8787 로 프록시)
```

`curl localhost:8787/api/v1/health` →
`{"ok":true,"chainId":1,"block":"23..."}`

## 테스트

```bash
cd server && npm test
cd client && npm test
cd legacy && npm test
```

테스트는 외부 네트워크(RPC)에 접속하지 않는다. 가짜 RPC 를 주입하거나 로컬에 가짜 노드를 띄운다.

## API

모든 숫자(블록 번호, wei, 가스)는 **10진수 문자열**로 준다. 에러 본문은 항상 `{"error":"<코드>"}`.

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/v1/health` | 서버·RPC 상태 |
| GET | `/api/v1/txs/{hash}` | tx 상세: 성공/실패, 보낸·받는 주소, 금액, 수수료, 블록·시각 |
| GET | `/api/v1/blocks/{number\|latest}` | 블록 상세 + 포함된 tx 해시 목록 |
| GET | `/api/v1/addresses/{address}` | 잔액, nonce, EOA/컨트랙트 구분 |

| 상태코드 | 뜻 |
|---|---|
| 200 | 찾음 |
| 400 | 형식이 틀림 (`invalid_tx_hash` 등) — 노드에 묻지도 않는다 |
| 404 | 형식은 맞는데 없음 (`not_found`) |
| 405 | 경로는 있는데 메서드가 틀림 (`Allow` 헤더 포함) |
| 503 | 노드(RPC)에 못 닿음 (`rpc_unavailable`) |
| 500 | 서버 코드 버그 (`internal_error`) |

주소별 tx 목록은 JSON-RPC 에 없는 기능이라 인덱서(DB) 단계에서 추가한다.

## 진행 단계

1. ✅ 폴더 분리 (client / server / legacy)
2. ✅ CI — PR·push 마다 세 패키지 테스트
3. ✅ REST API — tx · 블록 · 주소 조회 + 검색 화면
4. ✅ Docker + nginx — web 1 + api 3, 로드밸런싱, CI 에서 이미지 빌드·smoke test
5. ⬜ 다중 인스턴스 (worker / API 분리, DB 결정 — 추적 날짜 범위 포함)
6. ⬜ CD — 이미지 빌드·푸시·배포

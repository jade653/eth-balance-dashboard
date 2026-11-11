# ETH Explorer (리팩토링 실습)

`legacy/` 의 ETH 잔액 대시보드를 **client-server 분리 · REST API · Docker/nginx 다중 처리 ·
GitHub CI/CD** 를 갖춘 작은 이더리움 explorer 로 다시 짜는 실습 저장소다.

## 구조

```
.
├── server/                 api + worker (Node 24, 의존성: pg)
│   ├── src/
│   │   ├── index.js        api 진입점: 환경변수 읽고 포트 연다 (조립만)
│   │   ├── worker.js       worker 진입점: 블록을 따라가며 DB 에 쌓는다 (1개만 띄운다)
│   │   ├── indexer.js      인덱서 한 바퀴 (리오그 되감기 포함)
│   │   ├── tokens.js       토큰 홀더 인덱서: 추적 토큰의 Transfer 를 배포 블록부터 모아 잔액을 만든다
│   │   ├── db.js           Postgres: 연결 풀, 마이그레이션, 쿼리
│   │   ├── migrations/     스키마 변경 이력 (001_init.sql …)
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
│   │       ├── format.js   표시용 순수 함수 · ABI 디코딩 (Node 로 테스트)
│   │       └── signatures.js 함수 선택자·이벤트 토픽 사전 (scripts/gen-signatures.mjs 로 생성)
│   ├── nginx/default.conf  nginx 설정: 정적 서빙 + /api 로드밸런싱
│   ├── scripts/dev.js      개발용 서버: 정적 파일 + /api 프록시 (nginx 없이 개발할 때)
│   ├── test/
│   └── Dockerfile          web 이미지 (nginx + public/)
├── legacy/                 기존 잔액 대시보드. 새 버전이 대체할 때까지 그대로 둔다
├── compose.yaml            전체 구성: web(nginx) 1 + api 3 + worker 1 + db(Postgres) 1
├── scripts/smoke.sh        띄운 서비스를 바깥에서 점검 (CI·배포 스크립트도 사용)
├── deploy/                 서버 배포: update.sh (cron), compose.prod.yaml, 설정 안내
├── .github/workflows/ci.yml
└── .nvmrc                  Node 버전 (로컬 nvm 과 CI 가 같이 본다)
```

## Docker 로 실행 (배포와 같은 모양)

```
[브라우저] ──:8080──▶ [web: nginx] ─┬─▶ 정적 파일
                                    └─▶ /api/* → [api × 3] ──┬──▶ 이더리움 RPC  (tx·블록·주소 조회)
                                                              └──▶ [db: Postgres] (주소별 tx 목록, 읽기)
                                                                         ▲
                                     [worker × 1] ── 블록 받아 쌓기 ─────┘ (쓰기)
```

```bash
docker compose up -d --build           # http://127.0.0.1:8080
./scripts/smoke.sh                     # 정적 서빙 · /api 프록시 · 로드밸런싱 점검
docker compose up -d --scale api=5     # api 를 5개로
docker compose logs -f web             # 어느 api 가 받았는지(upstream=) 보인다
docker compose logs -f worker          # 인덱서 진행 상황 (lag = 최신 블록과의 차이)
docker compose down                    # DB 데이터는 볼륨에 남는다 (-v 를 붙이면 삭제)
```

설정은 `.env` 파일로 (커밋하지 않는다):

| 변수 | 기본값 | 설명 |
|---|---|---|
| `RPC_HTTP_URL` | publicnode 메인넷 | API 키가 든 URL 은 여기에 |
| `POSTGRES_PASSWORD` | `explorer` | **서버에서는 반드시 바꿀 것** |
| `CHAIN_NAME` / `NATIVE_SYMBOL` | (자동) | 화면의 체인 이름·잔액 단위. 비우면 chainId 1 → Ethereum / ETH |
| `RESET_ON_CHAIN_CHANGE` | (없음) | `1` 이면 DB 에 다른 체인의 데이터가 있을 때 지우고 새로 쌓는다. 체인을 바꿀 때 한 번만 |
| `RETENTION_HOURS` | `24` | 인덱서 보관 기간. 메인넷 실측 약 0.9~1.2GB/일 (tx 당 약 580바이트, 색인 포함) |
| `TOKEN_DISCOVERY` | `auto` | 토큰 자동 인식. `auto` = 공개 체인(이더리움 메인넷·테스트넷, 주요 L2)이 아니면 켠다 / `on` / `off` |
| `TOKEN_DISCOVERY_FROM` | `0` | 자동 인식을 이 블록부터 훑는다 (처음 한 번만. 그 뒤로는 DB 에 적힌 곳부터 이어서) |
| `TOKEN_DISCOVERY_MAX` | `100` | 추적할 토큰 수 상한. 닿으면 더 찾지 않는다 (올리고 다시 띄우면 멈춘 곳부터 이어서) |
| `TOKENS` | (없음) | 자동 인식과 별개로 꼭 추적할 ERC-20. `0x토큰주소@배포블록` 을 쉼표로 여러 개. `@배포블록` 을 빼면 찾아서 쓴다(아카이브 노드 필요, 못 찾으면 0 부터). 공개 체인에서는 이걸로 적는다 |
| `TOKEN_CONFIRMATIONS` | `5` | 토큰 전송은 최신 블록에서 이만큼 뒤까지만 모은다 (리오그 대비) |
| `WEB_PORT` | `8080` | nginx 가 여는 포트 (127.0.0.1 에만) |

처음 켜면 worker 가 최근 24시간치(약 7,200블록)를 채운다. 무료 RPC 로는 수십 분 걸릴 수 있다.

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
DB 테스트는 `TEST_DATABASE_URL` 이 있을 때만 돈다 (테이블을 지우고 시작하므로 운영 DB 를 가리키지 말 것):

```bash
docker run -d --rm -p 5432:5432 -e POSTGRES_PASSWORD=test postgres:17-alpine
cd server && TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:5432/postgres npm test
```

## API

모든 숫자(블록 번호, wei, 가스)는 **10진수 문자열**로 준다. 에러 본문은 항상 `{"error":"<코드>"}`.

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/v1/health` | 서버·RPC 상태 + 인덱서 범위·지연 |
| GET | `/api/v1/stats` | 홈 통계: 24시간 tx 수, 평균 블록 시간 (DB) |
| GET | `/api/v1/blocks?limit=` | 최신 블록 목록 (DB, 최대 25) |
| GET | `/api/v1/txs?limit=` | 최신 tx 목록 (DB, 최대 25) |
| GET | `/api/v1/blocks/{number}/txs?limit=&cursor=` | 블록 안의 tx 목록 (DB) |
| GET | `/api/v1/txs/{hash}` | tx 상세: 성공/실패, 보낸·받는 주소, 금액, 수수료, 블록·시각 |
| GET | `/api/v1/blocks/{number\|latest}` | 블록 상세 + 포함된 tx 해시 목록 |
| GET | `/api/v1/addresses/{address}` | 잔액, nonce, EOA/컨트랙트 구분 |
| GET | `/api/v1/addresses/{address}/txs?limit=&cursor=` | 주소의 tx 목록 (DB, 최신순). `nextCursor` 로 다음 페이지. `coverage` = DB 에 있는 범위 |
| GET | `/api/v1/txs/{hash}/trace` | 내부 트랜잭션 (debug_traceTransaction callTracer). 노드가 debug API 를 안 열었으면 501 `trace_unsupported` |
| GET | `/api/v1/txs/{hash}/state` | 상태 변화: 주소별 잔액·nonce·저장소 전/후 (prestateTracer diff). 501 은 위와 같다 |
| GET | `/api/v1/tokens` | 추적 중인 토큰 목록 (홀더 수·전송 수·수집 진행) |
| GET | `/api/v1/tokens/{address}` | 토큰 개요: 이름·심볼·소수점·총발행량(노드) + 홀더·전송 수(DB). 추적 안 하는 ERC-20 은 `tracked:false` |
| GET | `/api/v1/tokens/{address}/holders?page=&limit=` | 홀더 순위 (잔액 큰 순, 페이지 번호). 컨트랙트 표시 포함 |
| GET | `/api/v1/tokens/{address}/holders/summary` | 홀더 분포: 상위 5/10/25/50/100 비중, 지니 계수용 합, 보유량 자릿수 분포 |
| GET | `/api/v1/tokens/{address}/holders.csv` | 전체 홀더 CSV (순위, 주소, 잔액 정수, 잔액 소수점 적용) |
| GET | `/api/v1/tokens/{address}/transfers?limit=&cursor=&holder=` | 토큰 전송 (최신순). `holder` 를 주면 그 주소의 전송 + 잔액 |
| GET | `/api/v1/addresses/{address}/tokens` | 주소가 가진 (추적 중인) 토큰 잔액 |
| GET | `/api/v1/addresses/{address}/token-transfers?limit=&cursor=` | 주소의 토큰 전송 (추적 중인 모든 토큰) |

| 상태코드 | 뜻 |
|---|---|
| 200 | 찾음 |
| 400 | 형식이 틀림 (`invalid_tx_hash` 등) — 노드에 묻지도 않는다 |
| 404 | 형식은 맞는데 없음 (`not_found`) |
| 405 | 경로는 있는데 메서드가 틀림 (`Allow` 헤더 포함) |
| 503 | 노드(RPC)나 DB 에 못 닿음 (`rpc_unavailable` / `db_unavailable`) |
| 500 | 서버 코드 버그 (`internal_error`) |

주소별 tx 목록은 JSON-RPC 에 없는 기능이라, worker 가 블록을 받아 DB 에 옮겨 적고 그걸 읽는다.
보관 기간(기본 24시간)보다 오래된 tx 는 목록에 없다. 단건 조회(`/txs/{hash}`)는 노드에 직접 물으므로 기간 제한이 없다.

### 토큰 홀더 추적 (자동 인식 · `TOKENS`)

홀더 잔액은 "토큰이 생긴 뒤의 Transfer 를 전부 더한 값"이라 24시간 보관으로는 만들 수 없다. 그래서 추적하는 토큰만 따로,
**첫 Transfer 부터 지금까지** `eth_getLogs` 로 Transfer 이벤트를 모은다 (worker 의 `tokens.js`).

**자체 체인에서는 설정할 것이 없다.** worker 가 체인 처음부터 Transfer 로그를 주소 조건 없이 훑어, ERC-20 모양
(topic 3개 + data 32바이트, `decimals()` 나 `totalSupply()` 가 대답함)의 이벤트를 낸 컨트랙트를 찾아 등록한다.
처음 본 블록 = 그 토큰의 첫 Transfer 이므로 거기서부터 모으면 빠짐이 없다. 새로 발행한 토큰도 몇 초 안에 잡힌다.
어디까지 훑었는지는 DB 에 남아, 다시 띄워도 처음부터 다시 훑지 않는다.

공개 체인(chainId 1, 11155111 등 — `tokens.js` 의 `PUBLIC_CHAINS`)은 토큰이 수십만 개라 자동 인식을 끈다.
거기서는 추적할 토큰을 적는다:

```bash
# .env
TOKENS=0x<토큰 컨트랙트 주소>@<배포 블록>      # 여러 개면 쉼표로
```

- 블록을 하나씩 받지 않고 "이 토큰의 Transfer 만" 구간으로 받는다. 노드가 구간이 넓다고 거절하면 절반으로 줄이고, 결과가 적으면 늘린다.
- 전송 기록 · 잔액 · "어디까지 모았나"를 한 트랜잭션으로 쓴다. 중간에 죽어도 잔액이 두 번 더해지지 않는다.
- `0x000…0` 은 홀더로 세지 않는다 (발행·소각의 상대편). 홀더 잔액의 합 = `totalSupply()` 가 맞는지 확인할 수 있다.
- `TOKENS` 에 토큰을 추가하면 worker 를 다시 띄울 때 등록된다. 이미 모으던 토큰은 이어서 모은다.
- 한 번 등록된 토큰(자동 인식 포함)은 DB 에 남아 계속 모은다.

화면: `#/tokens` (토큰 목록) → `#/token/{주소}` (개요 · 전송 · 홀더). 홀더 주소를 누르면 그 홀더로 거른 전송과 잔액이 보인다.

### tx 상세 (Etherscan 과 같은 항목)

개요(트랜잭션 액션, ERC-20 토큰 전송 전체/순증감, 수수료, 가스 수수료 Base/Max/Max Priority, 소각·절약 수수료,
입력 데이터 해석) · 로그 · 내부 트랜잭션 · 상태 · (EIP-7702) Authorizations.
함수·이벤트 이름은 `client/public/js/signatures.js` 사전으로 붙인다 (서명을 추가하려면 `client/scripts/gen-signatures.mjs`).
내부 트랜잭션·상태는 노드의 `debug_traceTransaction` 이 필요하다 — 공개 RPC 는 대부분 막혀 있고, 직접 운영하는 geth 는
`--http.api eth,net,web3,debug` 로 열 수 있다. 가격 정보($)·AA 번들(User Ops) 해석은 없다.

## 진행 단계

1. ✅ 폴더 분리 (client / server / legacy)
2. ✅ CI — PR·push 마다 세 패키지 테스트
3. ✅ REST API — tx · 블록 · 주소 조회 + 검색 화면
4. ✅ Docker + nginx — web 1 + api 3, 로드밸런싱, CI 에서 이미지 빌드·smoke test
5. ✅ 인덱서 — worker / api 분리, Postgres, 최근 24시간 보관, 주소별 tx 목록
6. ✅ CD — CI 통과 시 GHCR 에 이미지, 서버 cron 이 받아 교체 (pull 방식, GitHub 에 서버 정보 없음) → [deploy/README.md](deploy/README.md)
7. ✅ 프론트/백엔드 배포 시점 분리 — 마지막 배포 이후 `client/` 가 바뀌면 web 만, `server/` 가 바뀌면 api 만 (scripts/changed-images.sh)

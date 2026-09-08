# ETH Balance Monitor

이더리움 메인넷의 특정 주소들의 ETH 잔액을 실시간으로 보여주는 대시보드.
**의존성 0개** — `node:http` + 내장 `fetch`만 사용한다. ethers/viem을 쓰지 않은 이유는
노드와 실제로 주고받는 JSON-RPC 요청/응답을 코드에서 직접 보기 위해서다.

## 실행

```bash
node server.js
```

http://localhost:8787

### 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `RPC_HTTP_URL` | `https://ethereum-rpc.publicnode.com` | Infura/Alchemy 키가 있다면 여기에 넣는다. 쉼표로 여러 개 주면 앞의 것이 죽었을 때 다음 것으로 넘어간다 |
| `POLL_MS` | `5000` | 폴링 주기 (1000~600000) |
| `PORT` | `8787` | 대시보드 포트 |
| `HOST` | `127.0.0.1` | 바인딩 주소. 리버스 프록시 뒤가 기본. Docker/PaaS에서는 `0.0.0.0` |
| `MAX_SUBSCRIBERS` | `500` | 동시 SSE 구독자 상한. 넘으면 503 |
| `MAX_SSE_PER_IP` | `10` | **IP 하나가 열 수 있는** SSE 상한. 넘으면 429. 전역 상한만 있으면 한 사람이 슬롯을 전부 차지해 나머지를 밀어낼 수 있다 |
| `TRUST_PROXY` | (자동) | 클라이언트 IP를 `X-Real-IP`/`X-Forwarded-For`에서 읽을지. 기본은 **loopback에서 온 요청만** 신뢰한다. Docker/PaaS처럼 프록시가 loopback이 아니면 `1` |
| `HEALTH_TOKEN` | (없음) | 설정하면 `/api/health?token=…` 로만 상세 정보를 준다 |

잘못된 값(숫자가 아니거나 범위 밖, 주소 형식 오류, 라벨 누락, 주소 중복)은 부팅 시 바로 종료한다.

`/api/health`는 첫 블록을 못 받았거나 **폴링 주기의 6배 동안 성공한 갱신이 없으면 503**을 낸다.
업타임 모니터나 로드밸런서의 헬스체크는 이 엔드포인트를 보면 된다.
공개 응답에는 `ok/status/stale/block/updatedAt`만 담는다 — 구독자 수가 밖에서 보이면
공격자가 자기 부하가 먹히는지 실시간으로 확인할 수 있기 때문이다. RPC 통계·구독자 수·에러
원문 같은 상세는 **서버에서 직접**(`curl localhost:8787/api/health`) 부르거나
`HEALTH_TOKEN`을 줬을 때만 나온다.

## 주소 추가/삭제는 재시작 없이

감시할 주소는 `config.json`의 `addresses` 배열에서 수정하고, 재시작 대신 리로드한다.

```bash
sudo systemctl reload eth-dashboard    # 또는: kill -HUP <pid>
```

`SIGHUP`을 받으면 `config.json`을 다시 읽어 `addresses`와 `historyLength`만 갈아끼운다.

- 그대로 남는 주소는 **계정 객체를 재사용**하므로 잔액·히스토리·변동값이 보존되고 화면도 깜빡이지 않는다
- 새 주소는 다음 폴링에서 채워진다
- **검증에 실패하면 아무것도 바꾸지 않고 계속 서빙한다.** 재시작은 이게 안 된다 —
  오타 하나에 새 프로세스가 부팅 중 죽고 systemd가 3초마다 되살리다 서비스가 통째로 내려간다
- `rpcUrl`·`pollIntervalMs`·`PORT` 등은 타이머와 소켓에 이미 묶여 있어 리로드로 못 바꾼다.
  바뀐 게 감지되면 "재시작이 필요하다"고 로그에 남기고 무시한다

## 구조

```
브라우저 ──GET /──────────► server.js ──(정적 파일)
        ──GET /api/stream─►          ──(SSE, 서버가 push)
                                      │
                            폴링 루프  │  5초마다
                                      ▼
                        ① eth_blockNumber        ← 싸게 "새 블록인가?"만 확인
                        ② 새 블록일 때만:
                           eth_getBlockByNumber   ┐
                           eth_getBalance × N     ┘ 한 번의 HTTP 배치 요청
                                      │
                                      ▼
                            메모리 상태(state) 갱신 → 전체 SSE 구독자에게 broadcast
```

| 파일 | 역할 |
|---|---|
| `rpc.js` | JSON-RPC 클라이언트. 배치 요청, id 재정렬, 배치 미지원 노드 폴백 |
| `server.js` | 폴링 루프 + 상태 저장 + REST(`/api/snapshot`, `/api/health`) + SSE(`/api/stream`) |
| `public/app.js` | SSE 수신 → wei 포맷 → DOM 부분 갱신 |
| `public/styles.css` | 디자인 토큰 기반 스타일 (다크/라이트 자동) |

## 설계상 중요한 결정 5가지

**1. 잔액 조회 시 `latest`가 아니라 고정된 블록 번호를 넘긴다.**
`eth_getBalance(addr, "latest")`를 주소마다 호출하면, 조회 도중 새 블록이 생겼을 때
주소 A는 블록 100 기준, 주소 B는 블록 101 기준이 되어 합계가 어느 시점에도
존재한 적 없는 값이 된다. 먼저 `eth_blockNumber`로 블록을 고정하고 그 번호를
모든 `eth_getBalance`에 넘긴다.

**2. N개의 호출을 하나의 HTTP 요청으로 묶는다 (JSON-RPC batch).**
주소 50개면 요청 51번이 아니라 1번. 단, 응답 배열의 순서는 보장되지 않으므로
`id`로 다시 매핑해야 한다 (`rpc.js`). 공개 RPC 중 배치를 막는 곳이 있어
실패 시 순차 호출로 자동 폴백한다.

**3. 새 블록일 때만 잔액을 다시 읽는다.**
`eth_blockNumber`는 싸고 `eth_getBalance × N`은 비싸다. 블록이 그대로면
잔액도 그대로이므로 하트비트만 보낸다. 유료 RPC의 CU 소모가 크게 줄어든다.

**4. 상태의 주인은 백엔드다.**
프론트는 계산하지 않는다. 잔액 차이(delta), 마지막 변동 블록, 히스토리 전부
서버가 만들어서 내려주고, 프론트는 포맷팅과 그리기만 한다. 탭을 여러 개 열어도
전부 같은 값이 보이고, 나중에 알림/저장을 붙일 때 로직을 옮길 필요가 없다.

**5. WebSocket이 아니라 SSE.**
서버 → 브라우저 단방향 푸시만 필요하다. SSE는 브라우저가 끊김을 감지해
자동 재연결하고, 일반 HTTP라 프록시/방화벽 문제가 적다. 브라우저에서 서버로
명령을 보낼 일이 생기면 그때 WebSocket으로 바꾸면 된다.

## 잔액을 Number로 바꾸지 않는 이유

1 ETH = 10^18 wei. JavaScript `Number`의 안전 정수 한계는 약 9×10^15이라
wei를 Number로 담는 순간 값이 깨진다. 그래서

- 서버: `BigInt`로 계산 → JSON에 담을 땐 **10진 문자열**
  (JSON은 BigInt를 직렬화하지 못한다)
- 프론트: 문자열을 그대로 자릿수로 잘라서 표시 (`splitWei`)

## 확인해 볼 것

```bash
curl -s localhost:8787/api/health | python -m json.tool
curl -s localhost:8787/api/snapshot | python -m json.tool | head -40
```

## 다음에 붙일 기능

`ROADMAP.md` 참고.

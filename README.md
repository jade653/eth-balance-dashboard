# ETH Balance Monitor

이더리움 메인넷의 특정 주소들의 ETH 잔액을 실시간으로 보여주는 대시보드.
**의존성 0개** — `node:http` + 내장 `fetch`만 사용한다. ethers/viem을 쓰지 않은 이유는
노드와 실제로 주고받는 JSON-RPC 요청/응답을 코드에서 직접 보기 위해서다.

## 실행

`node:sqlite` 를 쓰므로 Node 24 이상이 필요하다(`package.json` engines).
22 는 `--experimental-sqlite` 플래그가 있어야 하고 23.4 부터 플래그 없이 열린다. nvm 을 쓴다면
이 디렉터리에서 `.nvmrc` 가 버전을 잡아 준다.

```bash
nvm use          # .nvmrc -> 24
node server.js
```

이 서버의 계정 기본 Node 는 20 이라 `nvm use` 없이 `./deploy.sh` 를 돌리면
버전 게이트에 걸려 중단된다. 계정이 공용이라 `nvm alias default` 는 바꾸지 않는다.

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
| `DATA_DIR` | systemd의 `STATE_DIRECTORY`, 없으면 `./data` | 잔액 기록 DB를 둘 곳. 서버에서는 `/var/lib/eth-dashboard` |

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

## 잔액 기록 (SQLite)

`DATA_DIR/balances.db` 에 쌓인다. 서버에서는 systemd 의 `StateDirectory=` 가 잡아 준
`/var/lib/eth-dashboard` 다. **배포 디렉터리 밖이라 `deploy.sh` 의 `rsync --delete`
가 닿지 않는다** — 배포할 때마다 기록이 날아가는 사고가 구조적으로 불가능하다.

### 변한 순간만 적는다

잔액은 계단 함수다. 값이 매 블록 바뀌는 게 아니라 실제로 돈이 움직인 블록에서만
바뀌고 그 사이는 완전히 평평하다. 그래서 변화만 적어도 손실이 없다.

> 블록 N 시점의 잔액 = N 이하에서 마지막으로 기록된 값

매 블록 적으면 하루 7,200행 × 주소 수지만, 변화만 적으면 **하루 수십 행**이다.
잔액이 0인 채로 안 움직이는 주소는 평생 1행이다.

기록하는 순간은 두 가지뿐 — **변했을 때**, 그리고 **그 주소를 처음 봤을 때**.
두 번째가 없으면 오래 안 움직인 주소는 그래프에 점이 하나도 안 생긴다.

### `wei` 가 TEXT 인 이유

SQLite 의 `INTEGER` 는 부호 있는 64비트라 최대 약 9.2×10^18 이다.
1 ETH = 10^18 wei 이므로 **9 ETH 만 넘어도 넘친다.** `config.json` 의 WETH 컨트랙트는
수백만 ETH 를 들고 있어 확실히 깨진다. INTEGER 로 바꿔 보면
`2841337000000000000000000` 이 `2.841337e+24` 라는 부동소수점이 되어 돌아온다.
프론트에서 wei 를 `Number` 로 바꾸지 않는 것과 같은 이유다.

`PRIMARY KEY (address, block)` + `INSERT OR IGNORE` 라 같은 블록을 두 번 처리해도
행이 늘지 않는다. 리로드 직후 `forceRefresh` 가 같은 블록을 다시 읽으므로 실제로 생긴다.

### 재시작하면 복원된다

부팅 때 주소별 마지막 기록을 읽어 delta 의 기준점과 스파크라인을 되살린다.
지금까지는 재시작하면 첫 tick 의 delta 가 전부 0 이었다 — 비교할 이전 값이 없어서다.

**서버가 오래 꺼져 있었다면 첫 화면에 큰 변동값이 한 번 튄다.** 버그가 아니라
"꺼져 있는 동안 실제로 그만큼 움직였다"는 사실이다.

### 저장소가 망가져도 대시보드는 산다

디스크가 차거나 파일이 깨져도 잔액 표시는 계속된다. `storage.js` 는 어떤 이유로도
던지지 않고, 마지막 오류만 `/api/health` 상세에 남긴다. 대시보드의 본업은 잔액을
보여주는 것이지 기록을 남기는 것이 아니다.

`fsync` 는 하지 않는다. 5초마다 디스크를 강제로 때리면 공용 서버에 부담이고,
크래시 시 최후 몇 초를 잃는 건 이 용도에서 감수할 만하다. 모르고 빠뜨린 게 아니라
고른 트레이드오프다.

### 조회

```
GET /api/history?range=24h                  # 전 주소
GET /api/history?address=0x…&range=7d       # 한 주소
```

`range` 는 `1h` · `24h` · `7d` 만 받는다.

### 백업

```bash
sudo sqlite3 /var/lib/eth-dashboard/balances.db ".backup /tmp/balances-$(date +%F).db"
```

과거 잔액은 한 번 잃으면 다시 받아올 수 없다. 무료 RPC 는 최근 128블록 이전의
state 를 주지 않는다. `teardown.sh` 가 이 디렉터리를 기본으로 남기는 이유다
(정말 지우려면 `--purge-data`).

## 이메일 알림

`notify.js` 가 두 가지 일을 한다. cron 에 등록되어 있다 (`crontab -l`).

| 시각 | 모드 | 받는 사람 | 하는 일 |
|---|---|---|---|
| 매일 09:00 KST | `daily` | `MAIL_TO_DAILY` | 잔액 리포트. 주소별 잔액과 기준 대비 변동 |
| 매일 09:00 KST | `status` | `MAIL_TO_ALERT` | 서버 상태. RPC·접속자와 24시간 장애 요약. **정상이어도 보낸다** |
| 10분마다 | `check` | `MAIL_TO_ALERT` | health 점검. **장애/복구 시에만** 발송 (재알림 60분 쿨다운) |

`status` 를 따로 두는 이유는, 장애 시에만 오는 알림 체계로는 "문제가 없는 것"과
"알림 자체가 고장난 것"을 구분할 수 없기 때문이다. 매일 한 통이 오는 것 자체가
알림 경로가 살아 있다는 증명이고, 안 오면 그것이 곧 신호다.

### 받는 사람을 용도별로 나누기

일일 리포트에는 잔액이 들어가지만 장애 알림에는 안 들어간다. 공유 범위가
달라질 수 있어 `notify.env` 에서 나눌 수 있다.

```
MAIL_TO=기본@example.com,다른사람@example.com   # 아래를 비우면 둘 다 이걸 쓴다
MAIL_TO_DAILY=                                   # 일일 리포트 받을 사람
MAIL_TO_ALERT=본인@example.com                   # 장애/복구 알림 받을 사람
```

### 스팸함으로 갈 때

Gmail SMTP 로 보내므로 SPF/DKIM 은 이미 정렬돼 있다. 그래도 스팸으로 분류되면
본문 쪽 문제이고, 이미 축약 주소·multipart·List-Unsubscribe 로 대응해 뒀다.
그래도 걸린다면 **받는 쪽에서 필터를 거는 것이 확실하다** — Gmail 필터는 스팸
판정을 덮어쓴다. 검색 필터에 발신 주소를 넣고 "스팸으로 분류하지 않음"을 켠다.

전일 대비 변동은 어제 보낸 값을 `notify-state.json` 에 저장해 두고 비교한다.
과거 블록을 다시 조회하지 않는 이유는, 무료 RPC 가 보통 최근 128블록 이전의
state 를 주지 않기 때문이다. 그래서 첫 리포트에는 비교값이 없다.

### 설정

```bash
cp notify.env.example notify.env
chmod 600 notify.env
$EDITOR notify.env          # Gmail 계정 / 앱 비밀번호 / 받는 사람
node notify.js daily --dry-run   # 보내지 않고 내용만 확인
```

Gmail 앱 비밀번호는 계정 비밀번호가 아니다. 2단계 인증을 켠 뒤
<https://myaccount.google.com/apppasswords> 에서 16자리를 발급받는다.

의존성을 늘리지 않으려고 SMTP 발송은 `curl` 에 맡긴다. 비밀번호는 `ps` 로 다른
사용자에게 보이지 않도록 명령줄이 아니라 curl 설정을 stdin 으로 넘겨 전달한다.

`notify.env` 와 `notify-state.json` 은 커밋되지 않고 배포(rsync)에서도 제외된다.
설정 전까지는 실행할 때마다 `notify.log` 에 "notify.env 가 없다"만 남기고 끝난다.

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
| `storage.js` | SQLite. 변화만 적기, 부팅 복원. SQL 은 여기에만 있다 |
| `validate.js` | 신뢰할 수 없는 입력의 첫 관문 (주소 형식, range 화이트리스트) |
| `check-node.sh` | 이 장비의 Node 들을 찾아 `node:sqlite` 를 실제로 require 해 본다 |
| `test/` | `npm test` (`node --test`). 외부 의존성 없음 |

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

## 입력 신뢰 경계

바깥에서 들어오는 값이 어디까지 가는지, 어디서 막히는지.

| 종류 | 들어오는 곳 | 막는 방법 |
|---|---|---|
| **SQL injection** | `/api/history` 의 `address`·`range` | ① `validate.js` 가 형식·화이트리스트로 거른다 ② `storage.js` 가 값을 전부 `?` 로 바인딩한다 (문자열을 이어붙여 만든 SQL 은 한 줄도 없다) |
| 경로 순회 | 정적 파일 요청 경로 | `path.resolve` 후 `startsWith(root + sep)` 검사 |
| XSS | 서버가 내려준 잔액·라벨 | `innerHTML` 대신 `replaceChildren` + `textContent` |
| HTTP 헤더 | `Host` | URL 파싱에 쓰지 않는다 (`Host: a b` 한 번에 서버가 죽은 적이 있다) |
| 명령어 injection | `notify.js` 의 메일 발송 | `spawn('curl', [배열])` 로 셸을 거치지 않는다. 비밀번호는 argv 가 아니라 stdin |

`range` 는 **검증이 아니라 치환**이다. 목록에 있으면 우리가 정한 숫자를 쓰고 없으면
400 이라, 사용자가 보낸 문자열 자체가 SQL 로 흘러갈 경로가 아예 없다.
화이트리스트를 평범한 객체로 만들었더니 `range=constructor` 에 `[Function: Object]`
가 돌아와서, 상속 체인이 없는 `Map` 으로 바꿨다.

이 방어들은 테스트로 고정돼 있다. injection 테스트 둘은 `history()` 를 문자열 조립으로
바꾼 취약 버전에서 **실제로 실패하는 것까지 확인**했다. 한 번도 실패한 적 없는
테스트는 헛된 안심만 준다.

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
curl -s 'localhost:8787/api/history?range=1h' | python -m json.tool | head -30
```

## 다음에 붙일 기능

`ROADMAP.md` 참고.

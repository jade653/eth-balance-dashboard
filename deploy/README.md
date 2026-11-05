# 서버 배포 (CD)

## 구조: pull 방식

```
 개발자 push ─▶ GitHub Actions ─▶ test ─▶ docker smoke ─▶ release: 이미지를 GHCR 에 올림
                                                                      │
                                                                      ▼
 서버 cron (5분마다) ── deploy/update.sh ── 새 이미지 있나? ──▶ pull ─▶ 교체 ─▶ smoke test
```

- **GitHub 은 서버를 모른다.** 서버 주소·SSH 키·비밀번호를 GitHub(코드든 Secrets 든)에 넣지 않는다.
  서버가 공개 이미지 저장소(GHCR)를 보러 간다.
- **바뀐 쪽만 배포된다.** `client/` 만 고치면 web(nginx+화면) 이미지만, `server/` 만 고치면
  api 이미지만 새로 올라가고, 서버에서도 그 컨테이너만 교체된다. 문서·설정만 바꾼 push 는 이미지 배포가 없다.
- **테스트를 통과한 것만 배포된다.** 이미지는 CI 가 전부 통과해야 올라가므로, main 에 깨진 코드가
  들어가도 서버에는 마지막 정상 버전이 그대로 남는다.
- 서버별 값(DB 비밀번호, RPC 키, 포트, 도메인)은 전부 **서버의 `.env` 와 서버의 nginx 설정**에만 있다.

## 최초 1회 설정

아래의 `<…>` 는 서버에 맞게 바꾼다. 이 값들은 저장소에 적지 않는다.

### 0. 확인

```bash
docker compose version          # v2 여야 한다 ("docker compose", 하이픈 없음)
docker ps                       # sudo 없이 되면 일반 계정 cron 으로, 안 되면 아래 4 를 root crontab 으로
ss -ltn | grep ':8080 '         # 비어 있어야 한다 (쓰고 있으면 .env 의 WEB_PORT 를 다른 값으로)
```

### 1. 저장소 받기

```bash
git clone https://github.com/jade653/eth-balance-dashboard.git <배포 디렉터리>
cd <배포 디렉터리>
```

### 2. `.env` 만들기 (커밋되지 않는다)

```bash
mkdir -p <데이터 디렉터리>/pgdata
cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 16)
RPC_HTTP_URL=https://ethereum-rpc.publicnode.com
RETENTION_HOURS=24
WEB_PORT=8080
PGDATA_DIR=<데이터 디렉터리>/pgdata
EOF
chmod 600 .env
```

`PGDATA_DIR` 를 빼면 DB 는 Docker 볼륨(서버 디스크의 `/var/lib/docker`)에 저장된다.
서버 디스크 대신 별도 저장소(NAS 등)에 두려면 지정한다. **절대경로**여야 한다.

> **NAS(네트워크 파일시스템)에 DB 를 둘 때 — 먼저 시험해 볼 것.**
> Postgres 는 파일 잠금·fsync·소유권 변경(chown)에 민감하다. NFS 는 대체로 되지만
> SMB/CIFS 는 권한 문제로 아예 안 뜨는 경우가 많다. 2분이면 확인된다:
>
> ```bash
> findmnt -T <데이터 디렉터리>          # FSTYPE 확인 (nfs / nfs4 / cifs …)
> mkdir -p <데이터 디렉터리>/pgtest
> docker run -d --name pg-nas-test -e POSTGRES_PASSWORD=t \
>   -v <데이터 디렉터리>/pgtest:/var/lib/postgresql/data postgres:17-alpine
> sleep 20; docker logs pg-nas-test 2>&1 | tail -5; docker exec pg-nas-test pg_isready
> docker rm -f pg-nas-test
> ```
>
> 마지막 줄이 `accepting connections` 면 사용 가능. 시험 폴더(`pgtest`)는 지운다
> (컨테이너가 다른 소유자로 만들었으면 `docker run --rm -v <데이터 디렉터리>:/d alpine rm -rf /d/pgtest`).

### 3. 첫 배포

```bash
./deploy/update.sh
docker compose -f compose.yaml -f deploy/compose.prod.yaml logs -f worker   # 백필 진행 (Ctrl+C 로 나가도 계속 돈다)
```

worker 가 최근 24시간치를 채우는 데 수십 분 걸린다. 그동안에도 tx·블록 단건 조회는 된다.

### 4. 자동 갱신 등록

```bash
crontab -e
# 한 줄 추가:
*/5 * * * * <배포 디렉터리>/deploy/update.sh >> <배포 디렉터리>/deploy.log 2>&1
```

바뀐 게 없으면 로그에 아무것도 남지 않는다. 배포가 일어나면 `배포: git abc1234 → def5678` 과
smoke test 결과가 남는다.

### 5. 도메인을 새 서비스로 넘기기

기존 도메인은 서버의 nginx(443)가 받아 legacy 앱(127.0.0.1:8787)으로 넘기고 있다
(`legacy/set-domain.sh` 가 만든 설정). 그 목적지만 바꾼다.

```bash
sudo grep -n proxy_pass /etc/nginx/sites-available/eth-dashboard     # 지금: 127.0.0.1:8787
sudo sed -i 's#proxy_pass http://127.0.0.1:8787;#proxy_pass http://127.0.0.1:8080;#' /etc/nginx/sites-available/eth-dashboard
sudo nginx -t && sudo systemctl reload nginx
```

브라우저로 `https://<도메인>` 확인. **되돌리기**는 같은 명령에서 8080 과 8787 을 바꿔 다시 실행 —
legacy 앱은 아직 켜져 있으므로 즉시 돌아간다.

```
[브라우저] ─https─▶ [서버 nginx :443, TLS] ─▶ [compose web :8080] ─▶ api × 3 …
                     (기존 그대로)              (새 서비스)
```

### 6. 며칠 문제없으면 legacy 정리

```bash
sudo systemctl disable --now eth-dashboard     # legacy 앱 중지
crontab -e                                     # legacy/notify.js 줄 삭제 (옛 /api/health 를 보므로 계속 장애 메일을 보낸다)
```

## 다른 체인으로 바꾸기

RPC 주소만 바꾸면 **DB 에 이전 체인의 데이터가 남아** 인덱서가 새 체인의 블록을 이어 쌓지 못한다.
worker 는 시작할 때 DB 의 체인(chainId)과 RPC 의 체인을 비교하고, 다르면 멈춘 채 안내를 남긴다.

```bash
# 1) .env 수정
RPC_HTTP_URL=<새 RPC 주소>
CHAIN_NAME=<화면에 보일 체인 이름>        # 비우면 chainId 1 → Ethereum, 그 외 → "Chain <id>"
NATIVE_SYMBOL=<잔액 단위>                 # 비우면 ETH
RESET_ON_CHAIN_CHANGE=1                   # 이번 한 번만: 이전 체인 데이터를 지우고 새로 쌓는다

# 2) 적용 (.env 만 바뀐 경우 update.sh 는 조용히 끝나므로 직접)
docker compose -f compose.yaml -f deploy/compose.prod.yaml up -d
docker compose -f compose.yaml -f deploy/compose.prod.yaml logs -f worker   # "체인이 바뀌었다 … DB 를 비운다"

# 3) 확인 후 RESET_ON_CHAIN_CHANGE 줄을 지운다 (남겨 두면 실수로 RPC 를 바꿨을 때도 DB 가 지워진다)
```

블록 간격은 worker 가 체인에서 직접 잰다 (`블록 간격 N초 (최근 1000블록 측정)` 로그).
보관 기간(`RETENTION_HOURS`)은 시간 기준이라 체인의 블록 속도와 상관없이 그 시간만큼 보관한다.
보관 기간을 나중에 늘려도 **과거로 거슬러 채우지는 않는다** — 늘린 시점부터 더 오래 남을 뿐이다.

## 운영

| 하고 싶은 것 | 방법 |
|---|---|
| 지금 바로 배포 | `./deploy/update.sh` |
| 이전 버전으로 되돌리기 | 백엔드 `API_TAG=sha-xxxxxxx`, 프론트 `WEB_TAG=sha-xxxxxxx` 를 `.env` 에 (따로따로) → `./deploy/update.sh`. sha 는 그 이미지가 실제로 올라간 커밋이어야 한다 — GitHub 저장소의 Packages 에서 태그 목록 확인 |
| 되돌린 걸 풀기 | `.env` 에서 그 줄 삭제 → `./deploy/update.sh` |
| 로그 | `docker compose -f compose.yaml -f deploy/compose.prod.yaml logs -f <web\|api\|worker\|db>` |
| 인덱서 상태 | `curl -s 127.0.0.1:8080/api/v1/health` 의 `indexer.lag` (0~2 면 정상) |
| 컨테이너 로그 | 서비스당 최대 30MB (10MB × 3, compose.yaml 의 `x-logging`) — 넘으면 오래된 것부터 지워진다 |
| DB 백업 | `docker compose -f compose.yaml -f deploy/compose.prod.yaml exec db pg_dump -U explorer explorer > backup.sql` |

> **배포 중 짧은 끊김:** `up -d` 는 바뀐 컨테이너를 내렸다 올린다. api 3개가 동시에 교체되는
> 몇 초 동안 `/api` 가 502 를 낼 수 있다. 무중단 배포(하나씩 교체)는 다음 실습 거리다.

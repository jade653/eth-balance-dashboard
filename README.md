# ETH Explorer (리팩토링 실습)

`legacy/` 의 ETH 잔액 대시보드를 **client-server 분리 · REST API · Docker/nginx 다중 처리 ·
GitHub CI/CD** 를 갖춘 작은 이더리움 explorer 로 다시 짜는 실습 저장소다.

## 구조

```
.
├── server/                 API 서버 (Node 24, 의존성 0)
│   ├── src/
│   │   ├── index.js        진입점: 환경변수 읽고 포트 연다 (조립만)
│   │   ├── app.js          라우팅·응답 (rpc 를 주입받아 테스트 가능)
│   │   ├── rpc.js          JSON-RPC 클라이언트 (legacy 에서 이식, 페일오버·배치)
│   │   └── validate.js     입력 검증 (주소, tx 해시)
│   └── test/
├── client/                 정적 프론트엔드 (빌드 없음)
│   ├── public/             배포 시 nginx 가 그대로 서빙할 파일들
│   │   ├── index.html
│   │   └── js/
│   │       ├── main.js     DOM·fetch
│   │       └── format.js   표시용 순수 함수 (Node 로 테스트)
│   ├── scripts/dev.js      개발용 서버: 정적 파일 + /api 프록시 (= 나중의 nginx 역할)
│   └── test/
├── legacy/                 기존 잔액 대시보드. 새 버전이 대체할 때까지 그대로 둔다
├── .github/workflows/ci.yml
└── .nvmrc                  Node 버전 (로컬 nvm 과 CI 가 같이 본다)
```

## 로컬 실행

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

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/v1/health` | 서버·RPC 상태. RPC 에 못 닿으면 503 |

## 진행 단계

1. ✅ 폴더 분리 (client / server / legacy)
2. ✅ CI — PR·push 마다 세 패키지 테스트
3. ⬜ REST API 설계 (tx 조회, 블록 조회, 주소)
4. ⬜ Docker 화 + nginx (정적 서빙 + /api 프록시)
5. ⬜ 다중 인스턴스 (worker / API 분리, DB 결정 — 추적 날짜 범위 포함)
6. ⬜ CD — 이미지 빌드·푸시·배포

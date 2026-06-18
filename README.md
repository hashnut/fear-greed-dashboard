# 공포·탐욕 지수 × VOO / TQQQ 대시보드

CNN Fear & Greed Index를 매일 수집해서 VOO·TQQQ 주가와 **같은 시계열**로 겹쳐 보고,
매수/매도 신호와 백테스트를 핸드폰에서 확인하는 개인용 대시보드.

- **공포 구간(지수 ≤ 25)** 진입 → 매수 후보
- **탐욕 구간(지수 ≥ 70)** 이 N일(기본 14일) 지속 → 분할 매도 검토
- 차트에 공포(초록)·탐욕(빨강) 음영, 매수(▲)·매도(▼) 신호 마커 표시
- 전략 vs 단순보유(Buy&Hold) 백테스트(수익률·연복리·최대낙폭) 비교

## 구조

```
collector/
  config.json   ← 임계값·종목·기간 설정 (여기만 바꾸면 됨)
  fetch.mjs     ← 데이터 수집기 (Node, 의존성 0)
docs/           ← GitHub Pages가 서빙하는 정적 사이트
  index.html  app.js  style.css
  data.json     ← 수집기가 생성/갱신 (커밋되어 사이트가 읽음)
run_daily.bat   ← 매일 실행: 수집 → git push
setup_task.ps1  ← 위 .bat을 윈도우 작업 스케줄러에 등록
```

**배포 완료:** https://hashnut.github.io/fear-greed-dashboard/ (GitHub Pages, main `/docs`).

**동작 방식(클라우드 우선 + 로컬 백업):**
- **클라우드(주력):** GitHub Actions(`.github/workflows/update.yml`)가 매일 13:00·21:00 UTC에
  데이터를 받아 `docs/data.json`을 갱신·push. **PC가 꺼져 있거나 로그인 안 해도 자동 동작.**
  (확인됨: CNN이 GitHub 클라우드 IP를 차단하지 않음.)
- **로컬(선택 백업):** `run_daily.bat`을 작업 스케줄러로 돌려 PC에서도 갱신 가능.
  push 전에 `git pull --rebase`로 클라우드 커밋과 충돌 없이 공존. 등록은 아래 참고.

## 매일 수동 실행 / 테스트

```powershell
node collector\fetch.mjs      # data.json 갱신
# 로컬 미리보기:
cd docs ; python -m http.server 8765    # http://127.0.0.1:8765
```

## 처음 한 번만: 배포 셋업

### 1) Git 저장소 + GitHub
```powershell
cd D:\Fear_Greed
git init
git add .
git commit -m "init: fear & greed dashboard"
# GitHub에서 빈 repo 생성 후:
git remote add origin https://github.com/<사용자명>/<repo>.git
git branch -M main
git push -u origin main
```
> push 시 자격증명을 한 번 입력하면 Windows 자격증명 관리자에 저장되어
> 이후 `run_daily.bat`의 자동 push가 통과합니다. (또는 GitHub PAT 사용)

### 2) GitHub Pages 켜기
GitHub repo → **Settings → Pages** → Source: **Deploy from a branch** →
Branch **main**, 폴더 **/docs** → Save.
잠시 후 `https://<사용자명>.github.io/<repo>/` 주소로 접속 → 핸드폰 홈화면에 추가.

### 3) 매일 자동 실행 등록 (부팅/로그온 + 매일 정시)
```powershell
cd D:\Fear_Greed
.\setup_task.ps1                 # 기본: 로그온 시 + 매일 08:00
.\setup_task.ps1 -Time "07:30"   # 시간 변경
Start-ScheduledTask -TaskName FearGreedDashboard   # 지금 바로 한 번 실행 테스트
.\setup_task.ps1 -Remove         # 등록 해제
```
실행 로그는 `run.log`에 쌓입니다.

## 설정 바꾸기 — `collector/config.json`

| 키 | 의미 | 기본값 |
|---|---|---|
| `buyThreshold` | 이 값 이하로 내려오면 매수 신호 | `25` |
| `sellThreshold` | 이 값 이상이면 탐욕으로 카운트 | `70` |
| `sellSustainDays` | 탐욕이 며칠 지속되면 매도 신호 | `14` |
| `historyStartDate` | F&G 과거 수집 시작일(누적의 시작점) | `2021-01-01` |
| `priceRange` | Yahoo 주가 조회 범위 | `5y` |
| `backtest.initialCash` | 백테스트 초기자금 | `10000` |

> CNN은 약 1.5~2년 윈도우만 한 번에 주므로, 매일 실행하며 **누적**됩니다.
> `data.json`을 지우지 마세요(과거 F&G가 그 안에 쌓입니다).

## 주의

- CNN/Yahoo는 비공식 엔드포인트라 언제든 형식이 바뀔 수 있습니다. 수집 실패 시
  이전 `data.json`을 유지하고 화면 상단에 ⚠ 경고를 표시합니다.
- 백테스트와 신호는 **참고용**입니다. 투자 판단과 책임은 본인에게 있습니다.

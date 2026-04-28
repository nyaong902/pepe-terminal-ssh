# PePe Terminal(SSH) v2.0.5

> Claude Code 통합 강화 — 대화 이력 관리, Mermaid 자동 렌더, 다중 대화 백그라운드 진행, 그리고 다양한 UX 개선

---

## ✨ 주요 신규 기능

### Claude Code 대화 관리
- **대화 이력 패널** (Pinned / Recents) — 이름 변경, 핀 고정, 삭제, 클릭으로 대화 전환
- **백그라운드 다중 대화** — `+` 새 대화를 시작해도 이전 대화의 Claude 프로세스는 계속 응답을 수신.
  이력에서 돌아오면 진행 상태(🤔 생각 중...)가 그대로 복원됨
- **대화 포크** — 메시지 우클릭 → "여기서 포크하기" → 해당 시점까지의 대화를 새 분기로 복사.
  이전 transcript(메시지 + 툴 결과 미리보기)를 자동 inject 하여 컨텍스트 유지
- **메시지 우클릭 메뉴** — 메시지 복사 / 마크다운으로 복사 / 메시지를 컨텍스트로 첨부 / 여기서 포크하기

### Mermaid 다이어그램 자동 SVG 렌더
- ` ```mermaid ` 코드 블록을 자동으로 SVG 다이어그램으로 변환
- fence 없는 mermaid 소스(`graph LR`, `flowchart TB`, `sequenceDiagram` 등)도 자동 감지
- **저장/복사** — 각 다이어그램에 툴바 + 우클릭 메뉴: 📋 PNG 클립보드 / 📋 SVG 코드 / 💾 PNG 저장(2x) / 💾 SVG 저장
- Plan 승인 모달 안의 mermaid 도 SVG 로 렌더
- Electron native clipboard 사용으로 PNG 이미지 복사 신뢰성 확보

### GFM 테이블 + 자동 변환
- 마크다운 테이블 다크 테마 스타일링
- 탭으로 정렬된 텍스트 블록도 자동으로 GFM 테이블로 변환

### UI 개선
- **워크스페이스 탭 드래그 정렬** — HTML5 drag/drop 으로 워크스페이스 탭 순서 변경
- **패널 컨트롤 플로팅 토글** — 분할/플로팅/투명도 버튼들을 기본 숨김. 이퀄라이저 아이콘 클릭 시
  플로팅 팝업으로 표시되어 좁은 패널에서도 미니탭과 겹치지 않음
- **터미널 우클릭 메뉴 — 테마 변경** — 등록된 모든 테마 서브메뉴, 현재 적용 테마 앞에 ● 표시,
  per-term 즉시 적용
- **사이드바 트리거 둥근 모서리** — 세션관리/파일트리(우측 모서리), Claude(좌측 모서리)
- **세션 드롭다운 연결됨 우선 정렬** — 일괄전송바 +원격파일, 파일 전송 패널의 세션 선택에서
  🟢 연결됨 / ⚪ 연결안됨 그룹 분리

---

## 🐛 안정성/버그 수정

### Claude 통합
- **stale Claude session_id 자동 폴백** — `--resume` 실패("No conversation found") 시 새 세션 + transcript inject 로 안전 진행
- **claude 프로세스 트리킬** — `proc.kill()` 만으론 자식 claude 가 살아남던 문제. Windows `taskkill /T /F`, Unix process group SIGKILL
- **다중 대화 동시 실행** — 프로세스 맵 키를 `sessionId` → `requestId` 로 변경. 새 send 가 다른 대화의 백그라운드 프로세스를 죽이지 않음
- **AskUserQuestion / ToolSearch / Bash 차단** — 비대화형 모드 안정성, cwd 의 무관한 프로젝트 분석 방지
- **claude cwd 변경** — Electron 앱 폴더 → USERPROFILE. Claude 가 앱을 분석 대상으로 오인하지 않음
- **포크 작업 대상 강제 명시** — 첫 사용자 메시지의 절대경로를 prompt 최상단 + user text 양쪽에 inject. cwd/home 디렉토리 ls 금지
- **stale UNC 경로 자동 치환** — transcript 안 옛 mountRoot → 현재 활성 mountRoot
- **다이어그램 출력 규칙 주입** — Claude 에게 "ASCII 박스 드로잉 금지, mermaid 코드 블록만" 시스템 지침
- **포크 시 recentLocalPaths 클리어** — 누적된 Windows 경로가 fork 에 새지 않도록
- **stream listener race 수정** — `activeHistoryIdRef` 로 stale closure 방지
- **send useCallback deps 보정** — `messages` / `toolTimeline` 추가
- **seq counter 보정** — 이력 로드 시 max seq 반영해 새 메시지가 위로 정렬되던 문제
- **streaming race** — Plan 승인 시 streaming 이 진행 중이면 큐잉 후 자동 전송
- **stale streaming 자동 정리** — 입력창 잠김 방지
- **메시지 / Mermaid 우클릭 메뉴 분리** — 다이어그램 영역에선 다이어그램 전용 메뉴만

### 터미널 / 윈도우
- **vi 풀스크린 깨짐 방지** — `refitAllTerms` 시 숨겨진(0×0) 터미널 스킵, 0 cols/rows resize 차단
- **PTY 사이즈 즉시 동기화** — 터미널 클릭/포커스 시 debounce 회피하고 즉시 doFit + resizeSSH (vi 시작 직전 사이즈 동기 보장)
- **타이틀바 클릭으로 창 복원되는 문제** — 5px 드래그 임계값 도입. 단순 클릭(드롭다운 close 등)으론 최대화 창이 복원되지 않음

---

## 📦 다운로드

| 파일 | 설명 |
|---|---|
| `PePe Terminal(SSH) Setup 2.0.5.exe` | NSIS 인스톨러 (118 MB, 코드 서명됨) |
| `PePe Terminal(SSH) 2.0.5.exe` | 포터블 (118 MB, 코드 서명됨) |

**시스템 요구사항**: Windows 10/11 x64

---

## 🛠 기술 스택

Electron 30 + React 18 + TypeScript + Vite · xterm.js · Monaco Editor · node-pty · ssh2 · webdav-server · marked · mermaid 10 · @anthropic-ai/claude-code

---

## 만든 사람

- Code: **Claude Opus 4.7 (1M context)**
- Prompt / Direction: **ghjeong**
- Co-Author: **HyungdukSeo**

---

이전 버전: [v2.0.4](#) — 워크스페이스 공유 파일 트리 + 세션별 자동추적 옵션

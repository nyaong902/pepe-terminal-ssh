# PePe Terminal(SSH) v2.0.6

> 셸 히스토리에 흔적 없는 백그라운드 PWD 자동추적, UI 개선, 전반적인 포커스 복원

---

## ✨ 주요 신규 기능

### 백그라운드 PWD 자동추적 (셸 히스토리 0건)

기존 OSC 7 hook 방식은 셸 stdin에 `alias precmd '...'` 같은 명령을 inject해야 했고, csh/tcsh는 leading space로도 history skip이 안 되어 명령이 누적되는 문제가 있었습니다.

v2.0.6은 완전히 새로운 방식으로 전환:
- **셸에 명령 0건** — 별도 SSH exec 채널로 `/proc/[0-9]*/environ`을 스캔해 `SSH_CONNECTION` env가 일치하는 인터랙티브 셸 PID 식별
- **400ms 폴링** — `readlink /proc/PID/cwd`로 변경 감지, 변경 시 가짜 OSC 7 emit
- **셸 무관** — csh / tcsh / bash / zsh / sh / ksh / dash 모두 동작
- **csh rc 노이즈 회피** — base64로 스크립트 전달 + `/bin/sh -c` 감싸기 + `<<PEPE>>...<<END>>` 마커로 결과 구간만 추출

토글 ON/OFF는 폴링 timer 시작/중지만. 셸 history와 화면에 일체 영향 없음.

### UI 개선
- **워크스페이스 탭 드래그 정렬** — HTML5 drag/drop으로 워크스페이스 탭 순서 변경
- **미니탭바 컨트롤 플로팅 토글** — 분할/플로팅/투명도 버튼들을 ⋯ 토글 버튼 클릭 시 플로팅 팝업으로 표시. 좁은 패널에서 미니탭과 겹침 해결
- **터미널 우클릭 메뉴 — 테마 변경** — 등록된 모든 테마 서브메뉴, per-term 즉시 적용
- **사이드바 트리거 둥근 모서리** — 세션관리 / 파일트리 / Claude 트리거 콘텐츠 크기에 맞게 둥근 모서리
- **Ctrl+Shift+E 파일트리 토글** — 핀/언핀 단축키. 언핀 시 즉시 retract

### Mermaid 다이어그램
- **저장/복사** — 각 다이어그램 우상단 툴바 + 우클릭 메뉴: 📋 PNG 클립보드 / 📋 SVG 코드 / 💾 PNG 저장(2x) / 💾 SVG 저장
- **Plan 승인 모달도 Mermaid 자동 렌더**
- **GFM 테이블** + 탭 정렬 텍스트 자동 변환

### 세션 드롭다운 정렬
- 일괄전송바 +원격파일 / 파일 전송 패널 source 선택에서 🟢 연결됨 / ⚪ 연결안됨 optgroup 분리

---

## 🎯 포커스 복원 전반

가끔 터미널 커서 포커스가 사라지던 문제 해결:
- `restoreTerminalFocus()` 헬퍼 — 선택된 패널 → fullscreen visible → 첫 활성 term 우선순위로 복원
- 모달/오버레이 자동 감지 — `showOptions` / `showManual` / `infoModal` / `showQuickConnect` / `showBroadcast` 중 하나라도 열렸다 모두 닫히는 트랜지션 시 자동 복원
- 윈도우 focus 복귀 시 자동 복원 (Alt+Tab 등)

---

## 🐛 안정성/버그 수정

- **Alt+Enter 최대화 + 미니탭 플로팅 토글 시 화면 사라지는 문제** — `fs-visible` class를 querySelector 대신 React className으로 관리. floatingPanelId 변경 시 React rerender가 className 통째로 교체하며 fs-visible이 날아가던 문제 수정
- **타이틀바 단순 클릭으로 최대화 창 복원되던 문제** — 5px 드래그 임계값 도입. 단순 클릭(드롭다운 close 등)으론 unmaximize 안 됨
- **vi 풀스크린 깨짐 방지** — `refitAllTerms` 시 숨겨진(0×0) 터미널 스킵, 0 cols/rows resize 차단
- **PTY 사이즈 즉시 동기화** — 터미널 클릭/포커스 시 debounce 회피하고 즉시 doFit + resizeSSH (vi 시작 직전 사이즈 동기 보장)
- **도움말/정보 모달 스크롤 가능** — alert() 대체, 70vw × 70vh, Esc 닫기, 닫을 때 터미널 포커스 자동 복원
- **파일트리 토글 단축키 동작 수정** — 옛 per-term 토글 → 워크스페이스 공유 트리 핀/언핀

---

## 📦 다운로드

| 파일 | 설명 |
|---|---|
| `PePe Terminal(SSH) Setup 2.0.6.exe` | NSIS 인스톨러 (118 MB, 코드 서명됨) |
| `PePe Terminal(SSH) 2.0.6.exe` | 포터블 (118 MB, 코드 서명됨) |

**시스템 요구사항**: Windows 10/11 x64

> PWD 자동추적 백그라운드 폴링은 Linux 서버(`/proc` 의존)에서 동작합니다. macOS/BSD 서버는 추후 별도 방식 추가 예정.

---

## 🛠 기술 스택

Electron 30 + React 18 + TypeScript + Vite · xterm.js · Monaco Editor · node-pty · ssh2 · webdav-server · marked · mermaid 10 · @anthropic-ai/claude-code

---

## 만든 사람

- Code: **Claude Opus 4.7 (1M context)**
- Prompt / Direction: **ghjeong**

---

이전 버전: [v2.0.5](docs/RELEASE_v2.0.5.md) — Claude 대화 관리 + Mermaid 렌더 + 다중 대화 격리

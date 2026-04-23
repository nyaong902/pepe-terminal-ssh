# 스크린샷 캡처 가이드

매뉴얼([MANUAL.md](../MANUAL.md))에 참조된 이미지들을 수동으로 캡처해서 이 폴더에 저장해 주세요.

## 캡처 도구

- Windows: **Win+Shift+S** (영역 선택) 또는 **Snipping Tool**
- macOS: **Cmd+Shift+4**
- 가급적 PNG 포맷, 1600px 이하 너비로 저장.

## 권장 캡처 해상도/비율

- 화면 전체: 1400×900 (기본 BrowserWindow 크기)
- 모달: 해당 모달 + 약간 여백
- 컨텍스트 메뉴: 메뉴 주변 조금만

## 파일 목록 (순서대로)

| 번호 | 파일명 | 촬영 대상 |
|---|---|---|
| 01 | `01-first-launch.png` | 앱 첫 실행, 빈 워크스페이스 + 왼쪽 빈 세션 리스트 |
| 02 | `02-session-list.png` | 폴더+세션이 있는 세션 리스트 사이드바 |
| 03 | `03-multi-select-ctx.png` | 세션 3~4개 Ctrl+클릭 선택 → 우클릭한 컨텍스트 메뉴 (미니탭/세로/가로/타일 분할 메뉴 보이게) |
| 04 | `04-session-editor-basic.png` | 세션 편집창 상단 (이름/호스트/포트/사용자/인증/인코딩/폴더/파일트리 초기 경로) |
| 05 | `05-session-editor-jump.png` | 세션 편집창의 점프 타겟 필드 4개 (호스트/사용자/포트/비밀번호) |
| 06 | `06-session-editor-login-script.png` | 세션 편집창의 Login Script 섹션 (Expect/Send 규칙 2~3개) |
| 07 | `07-tabs-minitabs.png` | 워크스페이스 탭 바 + 패널 미니탭 두 세션 보이는 상태 |
| 08 | `08-panel-header.png` | 패널 헤더 확대 — 세션명/투명도 슬라이더/분할 버튼/플로팅/닫기 |
| 09 | `09-split-session-picker.png` | 분할 시 뜨는 "세션 선택" 팝업 (폴더 내 세션 리스트) |
| 10 | `10-floating-panel.png` | 분할 화면에서 한 패널만 플로팅 확대된 상태 (버튼 파란색 강조) |
| 11 | `11-opacity-slider.png` | 투명도 슬라이더 50% 정도 위치, 뒤 바탕화면 반투명하게 비침 |
| 12 | `12-file-tree.png` | `Ctrl+Shift+E` 로 연 파일 트리 (패널 내부 왼쪽) |
| 13 | `13-file-tree-pathbar.png` | 파일트리 상단 경로바 확대 (경로 입력 / ↵ / ⬆ / ⟳) |
| 14 | `14-file-tree-colors.png` | 확장자별 색상이 드러나는 파일 리스트 (.c .py .log .zip 등 섞여있는 폴더) |
| 15 | `15-file-tree-ctx-single.png` | 파일 하나 우클릭한 컨텍스트 메뉴 |
| 16 | `16-file-tree-ctx-multi.png` | 파일 3개 Ctrl+클릭 후 우클릭한 다중 컨텍스트 메뉴 |
| 17 | `17-file-editor.png` | 원격 파일 편집 중 Monaco 에디터 (구문 하이라이팅 보이게) |
| 18 | `18-file-transfer-tab.png` | 파일 전송 탭 활성 상태 (탭 바에 📁 아이콘) |
| 19 | `19-file-transfer-dual.png` | 2패널 파일 전송 UI — 좌 로컬 / 우 원격 |
| 20 | `20-broadcast-bar.png` | 일괄 전송바 열린 상태 (대상 드롭다운 + 버튼들) |
| 21 | `21-bcast-file-xfer.png` | 일괄 파일 전송 모달 열린 상태 (파일/폴더 3~4개 목록) |
| 22 | `22-remote-file-picker.png` | "+ 원격 파일" 누른 후 뜨는 원격 picker (세션 드롭다운 + 경로 + 파일 리스트 몇개 체크됨) |
| 23 | `23-bcast-xfer-log.png` | 일괄 전송 실행 후 로그 창 (녹색 ✓ + 빨강 ✗ 섞여있게) |
| 24 | `24-proxyjump-diagram.png` | (다이어그램) "사용자 PC → EMS(bastion) → MPM01" 경로 시각화. 단순 화살표 이미지면 충분 |
| 25 | `25-options-terminal.png` | 옵션 창 터미널 탭 |
| 26 | `26-options-keybindings.png` | 옵션 창 단축키 탭 |

## 팁

- 실제 서버/자격증명이 보이는 화면은 캡처 후 **블러/모자이크** 처리 권장
- 같은 상황 여러 컷 보다 대표 컷 1장이 좋음
- 추후 기능 추가 시 이 README의 목록도 함께 업데이트

## 이 매뉴얼은 누가 업데이트?

- 기능 추가 시 PR 에서 매뉴얼 해당 섹션과 필요 시 스크린샷 업데이트 함께 반영
- 릴리스 전에 한 번 훑어서 stale 한 화면 교체

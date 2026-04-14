# PePe Terminal(SSH) - 개발 히스토리

## 프로젝트 개요
- **경로**: `C:\Users\A\my-ssh-terminal\electron-vite-project`
- **스택**: Electron + React + TypeScript + xterm.js + ssh2
- **기능**: SSH 터미널 클라이언트 (다중 탭, 세션 관리, 패널 분할, SFTP 파일 탐색기, 투명도)
- **만든이**: Claude (feat. ghjeong[prompt])

---

## 1~5차: 기초 기능
- UI 개선, 버그 수정, 코드 리팩토링
- 세션 연결 로직 개선
- 패널 미니탭 시스템 (드래그 앤 드롭)
- SSH 연결 안정성 (lifecycle 분리)
- 미니탭 드래그 분할 (드롭 존 감지, 시각 피드백)

## 6~7차: 구조 단순화
- SessionTab 제거 → `Tab = { id, title, layout, type? }`
- 미니탭 순서 변경 (드래그 재정렬)

## 8~9차: 세션 관리
- 폴더 계층 구조 (`Folder`, `Session.folderId`, 중첩 폴더)
- 세션 사이드바 고정/자동숨기기 (📌 핀 토글)

## 10차: Workspace + 미니탭 개선
- Workspace 탭 (연결 상태 점, 테두리, +, 우클릭/미들클릭)
- 미니탭 (+버튼, 개별 연결 상태 점, 우클릭/미들클릭)

## 11차: 터미널 검색 (Ctrl+Shift+F)
- xterm-addon-search, 현재탭/전체탭, 정규식
- DOM 기반 노란색 하이라이트, 스크롤/새 데이터 시 자동 갱신

## 12차: 화면/버퍼 클리어 단축키
- Ctrl+Shift+B (스크롤 버퍼), Ctrl+Shift+L (화면), Ctrl+Shift+A (전부)
- Ctrl+L (커서 라인 위 내용을 스크롤 버퍼로 보존하며 밀어냄)

## 13차: 로그인 스크립트 (Expect/Send)
- `LoginScriptRule`, ExpectSendRunner, 30초 타임아웃

## 14차: 터미널 색구성표
- 14개 프리셋 테마, 글로벌/세션별 테마, 런타임 변경

## 15차: 글꼴 설정
- Ctrl+마우스휠 미니탭별 크기 조절 (OSD 표시)
- 세션별 글꼴/크기, 시스템 고정폭 폰트 감지

## 16차: 재연결 기능
- 30초 카운트다운, 세션 이름/호스트/시간 표시

## 17차: 메뉴바
- 햄버거(≡) 메뉴 탭바 통합
- 파일/편집/보기/창/도구/도움말
- 서브메뉴 지원 (테마), 클릭 토글 열기/닫기

## 18차: 클립보드/붙여넣기 설정
- 도구 > 옵션 (터미널/세션 탭)
- 자동 복사, 줄바꿈, 공백 제거, 여러 줄 붙여넣기 다이얼로그
- 단어 구분 기호, 터미널 우클릭 메뉴

## 19차: 세션 내보내기/가져오기
- JSON 파일 저장/로드, 세션 경로 관리

## 20차: 세션 아이콘 + 복사/붙여넣기
- 24개 이모지 선택기, Ctrl+C/V 세션 복사

## 21차: 터미널 텍스트 선택/복사
- 더블클릭 선택 + 자동 복사, 우클릭 메뉴
- 단어 구분 기호 설정

## 22차: 한국어화 + 앱 정보
- 모든 메뉴/버튼/대화상자 한국어
- PePe Terminal(SSH), 페페 아이콘

## 23차: SFTP 듀얼 패널 파일 탐색기
### 백엔드 (electron/)
- `sshBridge.ts`: SFTP 메서드, 로컬 파일 조작, 범용 전송 (4가지 조합)
  - SFTP 세션 캐시, 0바이트 파일 전송, 파일 타임스탬프 보존
  - SFTP 전용 연결 (handleSFTPConnect), realpath 홈 디렉토리
- `main.ts`: 파일 탐색기 IPC (fe:list-dir, fe:transfer, fe:mkdir 등)
  - 창 제어 IPC (window:minimize, window:toggle-maximize, window:close)
  - 멀티 인스턴스 캐시 충돌 방지
- `preload.ts`: 전체 API 노출

### 프론트엔드 (src/)
- `FileExplorer.tsx`: 듀얼 패널 메인 컴포넌트
  - 소스 선택 (로컬/원격 세션/SFTP 직접 연결)
  - 전송 버튼 (→ ←), 드래그 앤 드롭 전송
  - 다중 전송 진행률 목록 (하단, 리사이즈 가능)
  - 세션 번호 매기기, 연결 해제 버튼 (✕)
  - SSH 연결 완료 대기 재시도 (최대 10초)
  - SFTP 직접 연결 다이얼로그 (호스트/포트/사용자/비밀번호)
- `FilePanel.tsx`: 단일 파일 패널
  - 소스 드롭다운, 경로 바, ⬆상위/🔄새로고침
  - 파일 목록 (정렬, 폴더 우선, null 가드)
  - 다중 선택 (Ctrl+클릭, Shift+클릭, 마우스 드래그 범위 선택)
  - Delete 키 다중 삭제, F2 이름 변경
  - 빈 영역 클릭 선택 해제, 빈 영역 패딩
  - 전송 후 양쪽 패널 자동 새로고침 (refreshKey)
- Tab 타입 확장: `type?: 'terminal' | 'fileExplorer'`
- 파일 전송 탭에서 세션 더블클릭 → SFTP 전용 연결 (터미널 미생성)
- 세션 우클릭 > 📁 파일 전송 → 파일 전송 탭 자동 생성 + SFTP 연결

## 24차: 미니탭별 투명도 조절
### 투명 창 구조
- `transparent: true` + `frame: false` — 완전 투명 창
- 수동 최대화 (workAreaSize, `maximize()` 미사용)
- 커스텀 타이틀바 — 탭바 영역 드래그로 창 이동
  - `-webkit-app-region: drag/no-drag`
  - ─ (최소화) ☐ (최대화 토글) ✕ (닫기) 버튼
  - IPC: window:minimize, window:toggle-maximize, window:close

### 투명도 조절
- xterm `allowTransparency: true`
- 미니탭별 `termOpacity` Map으로 개별 관리
- 테마 배경색을 `#RRGGBBAA` (8자리 hex)로 변환하여 적용
- `panel-terminal-area` 배경도 `rgba(r,g,b,opacity)`로 동기화
- 패널 헤더에 슬라이더 바 (0%~100%)
- Empty 상태에서도 `rgba(0,0,0,val)`로 부드러운 조절
- 기본값: 100% (불투명)

### 관련 CSS
- html, body, #root: `background: transparent`
- `.panel-terminal-area`: 기본 `#000`, 투명도 조절 시 `rgba` 전환
- `.panel-opacity-slider`: 50px 슬라이더, 파란 thumb
- `.window-controls`: 창 제어 버튼 (오른쪽 정렬)

---

## 현재 파일 구조

```
electron/
  main.ts          — Electron 메인 (IPC, SSH/SFTP/파일탐색기/창 제어)
  preload.ts       — contextBridge API 노출
  sshBridge.ts     — SSH2 연결 + SFTP + Expect/Send + 로컬파일조작
  sessionsStore.ts — sessions.json, 폴더/세션 타입, 커스텀 경로

src/
  App.tsx           — 메인 앱, 탭/패널 상태, 메뉴, 커스텀 타이틀바
  App.css           — 전체 스타일 (투명 창, 파일 탐색기 포함)
  main.tsx          — React 엔트리
  utils/
    layoutUtils.ts      — 레이아웃 트리 유틸리티
    terminalThemes.ts   — 터미널 색구성표 프리셋 (14개)
    terminalSettings.ts — 클립보드/붙여넣기 설정
    monoFonts.ts        — 시스템 고정폭 폰트 감지
  components/
    TabBar.tsx          — Workspace 탭 바
    MenuBar.tsx         — 햄버거 메뉴 (서브메뉴 토글)
    Layout.tsx          — LayoutNode 트리 렌더링
    TerminalPanel.tsx   — 터미널 패널 (xterm, SSH, 미니탭, 검색, 재연결, 투명도)
    SessionList.tsx     — 세션 관리 사이드바 (폴더 트리, 파일 전송)
    SessionEditor.tsx   — 세션 편집 모달
    SearchBar.tsx       — 검색 바
    ContextMenu.tsx     — 공통 우클릭 메뉴
    FileExplorer.tsx    — SFTP 듀얼 패널 파일 탐색기
    FilePanel.tsx       — 단일 파일 패널 (로컬/원격)
```

## 주요 타입 구조

```typescript
Tab = { id, title, layout: LayoutNode, type?: 'terminal' | 'fileExplorer' }
LayoutNode = LeafNode | ContainerNode
LeafNode = { id, type: 'leaf', panel: Panel }
ContainerNode = { id, type: 'row'|'column', children: LayoutNode[] }
Panel = { id, sessions: PanelSession[], activeIdx }
PanelSession = { termId, sessionId, sessionName }

Session = { id, name, host, port, username, auth, encoding, folderId,
            loginScript, theme, fontFamily, fontSize, icon }
Folder = { id, name, parentId? }
LoginScriptRule = { expect, send, isRegex? }
SessionsData = { folders: Folder[], sessions: Session[] }

FileInfo = { name, isDir, size, mtime }
PanelSource = { mode: 'local'|'remote', termId?, label }
TerminalSettings = { autoCopyOnSelect, includeTrailingNewline,
                     trimTrailingWhitespace, multiLinePaste }
```

## 빌드 & 배포
```bash
npm run dev          # 개발 서버
npm run build        # 배포 빌드 (release/ 폴더)
```
- PePe Terminal(SSH) 1.0.0.exe — 포터블
- PePe Terminal(SSH) Setup 1.0.0.exe — 설치 프로그램

## 25차: 세션 편집기 비밀번호 보기
- 비밀번호 입력 옆 👁/🙈 토글 버튼
- 클릭 시 input type 전환 (password ↔ text)

## 26차: 세션 사이드바 트리거 개선
- 자동숨기기 모드 트리거: `📡 세션 관리` 세로 텍스트
- 상단 영역만 마우스 호버 → 세션 관리 열기 (하단은 반응 없음)
- 트리거 전체 높이 유지 (겹침 방지)

## 27차: 하단 상태바
### StatusBar.tsx (신규)
- **왼쪽**: 연결 상태 점(🟢/⚫) + 활성 세션 이름 + 전체 세션 수 + Workspace 이름
- **오른쪽**: 복사 알림 + 현재 날짜 + 시간 (1초 갱신)
- 복사 알림: 텍스트 선택 시 `복사됨: 42자 / 3줄` 녹색 표시 → 3초 후 자동 사라짐
- `status-copy` 커스텀 이벤트로 TerminalPanel → StatusBar 통신
- `position: fixed; bottom: 0` — 하단 고정, `app-main`에 24px padding-bottom

## 28차: 멀티 인스턴스 캐시 충돌 방지
- `app.setPath('sessionData', ...)` — 인스턴스별 고유 세션 데이터 경로

---

## 현재 파일 구조

```
electron/
  main.ts          — Electron 메인 (IPC, SSH/SFTP/파일탐색기/창 제어)
  preload.ts       — contextBridge API 노출
  sshBridge.ts     — SSH2 연결 + SFTP + Expect/Send + 로컬파일조작
  sessionsStore.ts — sessions.json, 폴더/세션 타입, 커스텀 경로

src/
  App.tsx           — 메인 앱, 탭/패널 상태, 메뉴, 커스텀 타이틀바
  App.css           — 전체 스타일
  main.tsx          — React 엔트리
  utils/
    layoutUtils.ts      — 레이아웃 트리 유틸리티
    terminalThemes.ts   — 터미널 색구성표 프리셋 (14개)
    terminalSettings.ts — 클립보드/붙여넣기 설정
    monoFonts.ts        — 시스템 고정폭 폰트 감지
  components/
    TabBar.tsx          — Workspace 탭 바
    MenuBar.tsx         — 햄버거 메뉴 (서브메뉴 토글)
    Layout.tsx          — LayoutNode 트리 렌더링
    TerminalPanel.tsx   — 터미널 패널 (xterm, SSH, 미니탭, 검색, 재연결, 투명도)
    SessionList.tsx     — 세션 관리 사이드바 (폴더 트리, 파일 전송)
    SessionEditor.tsx   — 세션 편집 모달 (비밀번호 보기)
    SearchBar.tsx       — 검색 바
    ContextMenu.tsx     — 공통 우클릭 메뉴
    FileExplorer.tsx    — SFTP 듀얼 패널 파일 탐색기
    FilePanel.tsx       — 단일 파일 패널 (로컬/원격)
    StatusBar.tsx       — 하단 상태바 (연결 정보, 시간, 복사 알림)
```

## 주요 타입 구조

```typescript
Tab = { id, title, layout: LayoutNode, type?: 'terminal' | 'fileExplorer' }
LayoutNode = LeafNode | ContainerNode
LeafNode = { id, type: 'leaf', panel: Panel }
ContainerNode = { id, type: 'row'|'column', children: LayoutNode[] }
Panel = { id, sessions: PanelSession[], activeIdx }
PanelSession = { termId, sessionId, sessionName }

Session = { id, name, host, port, username, auth, encoding, folderId,
            loginScript, theme, fontFamily, fontSize, icon }
Folder = { id, name, parentId? }
LoginScriptRule = { expect, send, isRegex? }
SessionsData = { folders: Folder[], sessions: Session[] }

FileInfo = { name, isDir, size, mtime }
PanelSource = { mode: 'local'|'remote', termId?, label }
TerminalSettings = { autoCopyOnSelect, includeTrailingNewline,
                     trimTrailingWhitespace, multiLinePaste }
```

## 빌드 & 배포
```bash
npm run dev          # 개발 서버
npm run build        # 배포 빌드 (release/ 폴더)
```
- PePe Terminal(SSH) 1.0.0.exe — 포터블
- PePe Terminal(SSH) Setup 1.0.0.exe — 설치 프로그램

## 다음 계획
- SFTP 폴더 전체 전송 (재귀)
- 파일 미리보기/편집
- 터미널 로그 저장
- 배경 이미지 설정

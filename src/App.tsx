// src/App.tsx
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import './App.css';
import { TabBar } from './components/TabBar';
import { MenuBar } from './components/MenuBar';
import type { MenuDef } from './components/MenuBar';
import { Layout } from './components/Layout';
import { SearchBar } from './components/SearchBar';
import { FileExplorer } from './components/FileExplorer';
import { FileEditor } from './components/FileEditor';
import { ClaudeChat } from './components/ClaudeChat';
import { RemoteFileTree } from './components/RemoteFileTree';
import { QuickConnectBar, QuickConnectResult } from './components/QuickConnectDialog';
import { StatusBar } from './components/StatusBar';
import { resetTermConnectState, clearScrollbackInTerm, clearScreenInTerm, clearAllInTerm, applyThemeToAll, applyThemeToTerm, applyFontToTerm, applyFontToAll, getCurrentThemeName, registerTermSession, getTermSessionInfo, getWordSeparator, setWordSeparator, refitAllTerms, applyScrollbackToAll, applyScrollbackToTerm, cloneTermStyle, isTermConnected, isTermConnecting, isTermPty, subscribeConnectedChange, focusTerm, pasteToTerm, promptPasswordAndConnect, toggleTreeVisibleForTerm, startInitialConnectWatchdog, getCurrentPwdForTerm } from './components/TerminalPanel';
import { marked } from 'marked';
// @ts-ignore — vite ?raw 로 docs/MANUAL.md 를 번들 문자열로 임베드
import manualMd from '../docs/MANUAL.md?raw';
import { getClaudeFontFamily, getClaudeFontSize, setClaudeFontFamily, setClaudeFontSize, applyClaudeFontVars } from './utils/claudeFont';
import { getTerminalSettings, saveTerminalSettings, TerminalSettings } from './utils/terminalSettings';
import { loadKeybindings, matchKeybinding, getKeybindings, DEFAULT_KEYBINDINGS, KEYBINDING_LABELS, keyEventToCombo, setKeybindingListening } from './utils/keybindings';
import { getThemeList } from './utils/terminalThemes';
import { SessionList } from './components/SessionList';
import {
  LayoutNode,
  PanelSession,
  splitNode,
  splitNodeWithSessions,
  addSessionsAsTile,
  removeLeafNode,
  addSessionToPanel,
  appendSessionsToPanel,
  removeSessionFromPanel,
  switchPanelSession,
  reorderPanelSession,
  countLeaves,
  collectAllSessions,
  findFirstLeafId,
  findEmptyLeafId,
  countSessionInTree,
  createInitialLayout,
} from './utils/layoutUtils';

export type { LayoutNode, ContainerNode, LeafNode, Panel, PanelSession } from './utils/layoutUtils';

export type TabId = string;
export type TabType = 'terminal' | 'fileExplorer' | 'fileEditor';
export type Tab = { id: TabId; title: string; layout: LayoutNode; type?: TabType; editor?: { termId: string; remotePath: string; fileName: string } };

// 일괄전송 히스토리 (앱 실행 중 유지, 최대 50개)
const broadcastHistory: string[] = [];
const MAX_BROADCAST_HISTORY = 50;
function addBroadcastHistory(text: string) {
  if (!text.trim()) return;
  const idx = broadcastHistory.indexOf(text);
  if (idx !== -1) broadcastHistory.splice(idx, 1);
  broadcastHistory.unshift(text);
  if (broadcastHistory.length > MAX_BROADCAST_HISTORY) broadcastHistory.pop();
}

function App() {
  const [tabs, setTabs] = useState<Tab[]>(() => {
    return [{ id: 'tab-1', title: 'Workspace 1', layout: createInitialLayout('tab-1') }];
  });
  const [activeTabId, setActiveTabId] = useState<TabId>('tab-1');
  // 탭별로 선택된 패널 ID 기억
  const [selectedPanelByTab, setSelectedPanelByTab] = useState<Record<string, string | null>>({});
  const selectedPanelId = selectedPanelByTab[activeTabId] ?? null;
  const setSelectedPanelId = useCallback((id: string | null) => {
    setSelectedPanelByTab(prev => ({ ...prev, [activeTabId]: id }));
  }, [activeTabId]);

  // 앱 구동 시 + 탭 전환 시 해당 탭의 패널 자동 선택 (선택된 패널이 현재 탭에 없을 때)
  useEffect(() => {
    const curTab = tabs.find(t => t.id === activeTabId);
    if (!curTab) return;
    // 현재 selectedPanelId가 이 탭의 레이아웃 안에 있는지 확인
    const findLeaf = (node: any, id: string | null): any => {
      if (!id) return null;
      if (node.type === 'leaf') return node.id === id ? node : null;
      for (const c of node.children) { const r = findLeaf(c, id); if (r) return r; }
      return null;
    };
    const inCurTab = selectedPanelId && findLeaf(curTab.layout, selectedPanelId);
    if (inCurTab) return;
    // 현재 탭의 첫 번째 leaf 찾기
    const findFirstLeaf = (node: any): any => {
      if (node.type === 'leaf') return node;
      for (const c of node.children) { const r = findFirstLeaf(c); if (r) return r; }
      return null;
    };
    const leaf = findFirstLeaf(curTab.layout);
    if (leaf) setSelectedPanelId(leaf.id);
  }, [activeTabId, tabs]);

  // 선택된 패널 변경 시 또는 탭 전환 시 해당 패널의 활성 터미널에 포커스
  useEffect(() => {
    if (!selectedPanelId) return;
    const curTab = tabs.find(t => t.id === activeTabId);
    if (!curTab) return;
    const findLeaf = (node: any, id: string): any => {
      if (node.type === 'leaf') return node.id === id ? node : null;
      for (const c of node.children) { const r = findLeaf(c, id); if (r) return r; }
      return null;
    };
    const leaf = findLeaf(curTab.layout, selectedPanelId);
    if (leaf && leaf.panel.sessions.length > 0) {
      const tid = leaf.panel.sessions[leaf.panel.activeIdx]?.termId;
      if (tid) {
        // 여러 번 시도 (DOM 렌더링 타이밍 대응)
        [50, 150, 300, 500].forEach(ms => setTimeout(() => focusTerm(tid), ms));
      }
    }
  }, [selectedPanelId, activeTabId]);
  const [showSearch, setShowSearch] = useState(false);
  const [themeName, setThemeName] = useState(getCurrentThemeName);
  const [wordSepValue, setWordSepValue] = useState('');
  const [termSettings, setTermSettings] = useState<TerminalSettings>(getTerminalSettings);
  const [showOptions, setShowOptions] = useState(false);
  const [optFontFamily, setOptFontFamily] = useState(() => localStorage.getItem('terminalFontFamily') || '');
  const [optFontSize, setOptFontSize] = useState(() => Number(localStorage.getItem('terminalFontSize')) || 14);
  const [availableFonts, setAvailableFonts] = useState<string[]>([]);
  const [optionsTab, setOptionsTab] = useState<'terminal' | 'session' | 'keybindings'>('terminal');
  const [keybindingsState, setKeybindingsState] = useState<Record<string, string>>({});
  const [keybindingsDraft, setKeybindingsDraft] = useState<Record<string, string>>({});
  const [listeningAction, setListeningAction] = useState<string | null>(null);
  const [keybindingWarning, setKeybindingWarning] = useState<string | null>(null);
  const [sessionsPathDisplay, setSessionsPathDisplay] = useState('');
  const [contextMenuRegistered, setContextMenuRegistered] = useState(false);
  const [sftpProgress, setSftpProgress] = useState<{ filename: string; transferred: number; total: number; direction: string } | null>(null);
  const [availableShells, setAvailableShells] = useState<{ name: string; path: string; icon?: string }[]>([]);
  const [defaultShell, setDefaultShell] = useState<{ name: string; path: string }>({ name: 'Windows PowerShell', path: 'powershell.exe' });
  const [optDefaultShellPath, setOptDefaultShellPath] = useState('');
  const [showBroadcast, setShowBroadcast] = useState<boolean>(true);
  const showBroadcastLoadedRef = useRef(false);
  // 사용 가능한 로컬 쉘 목록 로드 + 기본 쉘 설정 로드 + startupCwd
  useEffect(() => {
    Promise.all([
      (window as any).api?.ptyListShells?.().catch(() => []),
      (window as any).api?.getUIPrefs?.().catch(() => ({})),
      (window as any).api?.getStartupCwd?.().catch(() => null),
    ]).then(([shells, prefs, cwd]: [any[], any, string | null]) => {
      if (shells?.length) setAvailableShells(shells);
      const name = prefs?.defaultShellName || shells?.[0]?.name || 'Windows PowerShell';
      const spath = prefs?.defaultShellPath || shells?.[0]?.path || 'powershell.exe';
      setDefaultShell({ name, path: spath });
      // 초기 탭의 세션명/경로/cwd를 업데이트
      setTabs(prev => prev.map((t, i) => {
        if (i !== 0) return t;
        const update = (node: LayoutNode): LayoutNode => {
          if (node.type === 'leaf') {
            return { ...node, panel: { ...node.panel, sessions: node.panel.sessions.map(s =>
              !s.sessionId ? { ...s, sessionName: name, shellPath: spath, shellCwd: cwd || undefined } : s
            )}};
          }
          return { ...node, children: node.children.map(update) } as LayoutNode;
        };
        return { ...t, layout: update(t.layout) };
      }));
    });
  }, []);
  // 앱 시작 시 ui-prefs(config.json) 에서 로드 — sessionData 가 매 실행 분리되어
  // localStorage 가 영속되지 않으므로 IPC 로 영구 저장한다.
  useEffect(() => {
    (async () => {
      try {
        const prefs = await (window as any).api?.getUIPrefs?.();
        if (prefs && typeof prefs.showBroadcast === 'boolean') {
          setShowBroadcast(prefs.showBroadcast);
        }
        if (prefs?.keybindings) {
          loadKeybindings(prefs.keybindings);
          setKeybindingsState(prefs.keybindings);
        }
        if (typeof prefs?.claudeChatWidth === 'number' && prefs.claudeChatWidth >= 280 && prefs.claudeChatWidth <= 1200) {
          setClaudeChatWidth(prefs.claudeChatWidth);
        }
        if (typeof prefs?.claudeChatPinned === 'boolean') {
          setClaudeChatPinned(prefs.claudeChatPinned);
          if (!prefs.claudeChatPinned) setClaudeChatVisible(false);
        }
        if (typeof prefs?.showClaudeChat === 'boolean') {
          setShowClaudeChat(prefs.showClaudeChat);
        }
        if (typeof prefs?.remoteTreeWidth === 'number' && prefs.remoteTreeWidth >= 160 && prefs.remoteTreeWidth <= 800) {
          setRemoteTreeWidth(prefs.remoteTreeWidth);
        }
        if (typeof prefs?.remoteTreePinned === 'boolean') {
          setRemoteTreePinned(prefs.remoteTreePinned);
          if (!prefs.remoteTreePinned) setRemoteTreeVisible(false);
        }
        remoteTreeWidthLoadedRef.current = true;
        remoteTreePinnedLoadedRef.current = true;
        claudeChatPinnedLoadedRef.current = true;
        showClaudeChatLoadedRef.current = true;
      } catch {}
      showBroadcastLoadedRef.current = true;
    })();
  }, []);
  // 옵션 다이얼로그 열림 시 글로벌 플래그 동기화 (TerminalPanel에서 참조)
  useEffect(() => { setKeybindingListening(showOptions); }, [showOptions]);

  // 단축키 변경 listening 중: window capture phase에서 키 캡처
  useEffect(() => {
    if (!listeningAction) return;
    const captureHandler = (ev: KeyboardEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      const combo = keyEventToCombo(ev);
      console.log('[keybind-capture] combo:', combo);
      if (!combo || /^(Ctrl|Alt|Shift|Meta)(\+(Ctrl|Alt|Shift|Meta))*$/.test(combo)) return; // modifier만이면 무시
      // 중복 체크
      const allBindings = { ...DEFAULT_KEYBINDINGS, ...keybindingsDraft };
      const duplicate = Object.entries(allBindings).find(
        ([id, key]) => id !== listeningAction && key === combo
      );
      if (duplicate) {
        const dupLabel = KEYBINDING_LABELS[duplicate[0]] || duplicate[0];
        setKeybindingWarning(`"${combo}"는 "${dupLabel}"에 이미 할당되어 있습니다.`);
        setTimeout(() => setKeybindingWarning(null), 5000);
      } else {
        setKeybindingWarning(null);
      }
      setKeybindingsDraft(prev => ({ ...prev, [listeningAction!]: combo }));
      setListeningAction(null);
    };
    window.addEventListener('keydown', captureHandler, true);
    return () => window.removeEventListener('keydown', captureHandler, true);
  }, [listeningAction, keybindingsDraft]);

  useEffect(() => {
    if (!showBroadcastLoadedRef.current) return;
    try { (window as any).api?.setUIPrefs?.({ showBroadcast }); } catch {}
  }, [showBroadcast]);
  const [broadcastText, setBroadcastText] = useState('');
  const [broadcastAppendNewline, setBroadcastAppendNewline] = useState(true);
  const [broadcastScope, setBroadcastScope] = useState<'current' | 'visible' | 'connected'>('visible');
  const [broadcastShowHistory, setBroadcastShowHistory] = useState(false);
  // 일괄 파일 전송 모달
  const [showBcastFileXfer, setShowBcastFileXfer] = useState(false);
  const [bcastXferPath, setBcastXferPath] = useState(''); // 비우면 세션별 현재 경로 사용
  // source 가 있으면 그 termId(원격 서버) 에서 읽어오는 파일, 없으면 로컬 path
  const [bcastXferFiles, setBcastXferFiles] = useState<{ path: string; isFolder: boolean; sourceTermId?: string; sourceLabel?: string }[]>([]);
  const [bcastXferInProgress, setBcastXferInProgress] = useState(false);
  const [bcastXferLog, setBcastXferLog] = useState<string[]>([]);
  // 원격 소스 picker (일괄 파일 전송 서브 모달)
  const [remotePickerOpen, setRemotePickerOpen] = useState(false);
  // 선택된 세션의 ID (sessionsStore 기준). 실제 SFTP 연결의 termId/connId 는 remotePickerConnId.
  const [remotePickerSessionId, setRemotePickerSessionId] = useState<string>('');
  const [remotePickerConnId, setRemotePickerConnId] = useState<string>('');
  const [remotePickerPath, setRemotePickerPath] = useState<string>('');
  const [remotePickerFiles, setRemotePickerFiles] = useState<{ name: string; isDir: boolean }[]>([]);
  const [remotePickerSelected, setRemotePickerSelected] = useState<Set<string>>(new Set());
  const [remotePickerLoading, setRemotePickerLoading] = useState(false);
  const [remotePickerConnecting, setRemotePickerConnecting] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const manualHtml = useMemo(() => {
    try { return marked.parse(manualMd) as string; } catch { return '<pre>매뉴얼 로드 실패</pre>'; }
  }, []);
  const [remotePickerSessions, setRemotePickerSessions] = useState<any[]>([]); // 전체 세션 리스트
  const [remotePickerFolders, setRemotePickerFolders] = useState<any[]>([]); // 폴더 맵
  // picker 가 새로 만든 임시 SFTP 연결 connId 들 — 모달 닫힐 때 일괄 해제
  const [remotePickerTempConns, setRemotePickerTempConns] = useState<string[]>([]);

  // picker 가 열릴 때 전체 세션/폴더 로드
  useEffect(() => {
    if (!remotePickerOpen) return;
    (async () => {
      try {
        const data: any = await (window as any).api?.listSessions?.();
        setRemotePickerSessions(data?.sessions || []);
        setRemotePickerFolders(data?.folders || []);
      } catch {}
    })();
  }, [remotePickerOpen]);

  // 세션 선택 변경 시 자동으로 연결 보장 + 파일 리스트 로드
  useEffect(() => {
    if (!remotePickerOpen || !remotePickerSessionId) return;
    let cancelled = false;
    (async () => {
      // 1) 이미 터미널로 열린 세션이면 그 termId 재사용
      if (activeTab) {
        const open = collectAllSessions(activeTab.layout).find(s => s.sessionId === remotePickerSessionId && isTermConnected(s.termId));
        if (open) {
          if (!cancelled) {
            setRemotePickerConnId(open.termId);
            const pwd = getCurrentPwdForTerm(open.termId) || '/';
            setRemotePickerPath(pwd);
          }
          return;
        }
      }
      // 2) 아니면 백그라운드 SFTP 연결 시도
      const sess = remotePickerSessions.find(s => s.id === remotePickerSessionId);
      if (!sess) return;
      setRemotePickerConnecting(true);
      try {
        const connId = `bcast-pick-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const jumpOpts = sess.jumpTargetHost?.trim()
          ? { host: sess.jumpTargetHost.trim(), user: sess.jumpTargetUser || 'root', port: Number(sess.jumpTargetPort) || 22, password: sess.jumpTargetPassword || undefined }
          : undefined;
        const r: any = await (window as any).api?.feSftpConnect?.(connId, sess.host, sess.port || 22, sess.username, sess.auth, jumpOpts);
        if (cancelled) return;
        if (!r?.success) {
          alert(`연결 실패 (${sess.name}): ${r?.error || '알 수 없는 오류'}`);
          setRemotePickerConnecting(false);
          return;
        }
        setRemotePickerTempConns(prev => [...prev, connId]);
        setRemotePickerConnId(connId);
        try {
          const home: any = await (window as any).api?.feHomeDir?.('remote', connId);
          const homePath = typeof home === 'string' ? home : (home?.path || '/');
          if (!cancelled) setRemotePickerPath(homePath || '/');
        } catch { if (!cancelled) setRemotePickerPath('/'); }
      } catch (err: any) {
        if (!cancelled) alert(`연결 실패: ${err?.message || err}`);
      }
      if (!cancelled) setRemotePickerConnecting(false);
    })();
    return () => { cancelled = true; };
  }, [remotePickerOpen, remotePickerSessionId, remotePickerSessions]);

  // 경로/connId 기반 파일 리스트 로드
  useEffect(() => {
    if (!remotePickerOpen || !remotePickerConnId || !remotePickerPath) return;
    let cancelled = false;
    (async () => {
      setRemotePickerLoading(true);
      try {
        const r: any = await (window as any).api?.feListDir?.('remote', remotePickerPath, remotePickerConnId);
        if (!cancelled) setRemotePickerFiles(r?.files || []);
      } catch {
        if (!cancelled) setRemotePickerFiles([]);
      }
      if (!cancelled) setRemotePickerLoading(false);
    })();
    return () => { cancelled = true; };
  }, [remotePickerOpen, remotePickerConnId, remotePickerPath]);

  // 모달 닫힐 때 임시 연결 정리
  useEffect(() => {
    if (remotePickerOpen) return;
    if (remotePickerTempConns.length === 0) return;
    for (const cid of remotePickerTempConns) {
      try { (window as any).api?.feSftpDisconnect?.(cid); } catch {}
    }
    setRemotePickerTempConns([]);
  }, [remotePickerOpen]);
  const [broadcastHistoryIdx, setBroadcastHistoryIdx] = useState(-1);
  // 히스토리 드롭다운에서 방향키로 이동한 항목이 보이게 스크롤 따라오기
  useEffect(() => {
    if (!broadcastShowHistory || broadcastHistoryIdx < 0) return;
    const active = document.querySelector('.broadcast-history-dropdown .broadcast-history-item.active');
    if (active instanceof HTMLElement) {
      active.scrollIntoView({ block: 'nearest' });
    }
  }, [broadcastHistoryIdx, broadcastShowHistory]);
  const [splitSessionPicker, setSplitSessionPicker] = useState<{
    dir: 'row' | 'column';
    sessions: { sessionId: string; sessionName: string; host: string; termId: string; folderId?: string; icon?: string }[];
    folders: { id: string; name: string; parentId?: string }[];
    srcTermId?: string;
    targetNodeId: string;
  } | null>(null);
  const [splitPickerCollapsed, setSplitPickerCollapsed] = useState<Set<string>>(new Set());

  // 세션 선택 picker prefix 키 핸들러 — 파일 트리와 동일한 동작 (folder + session 가시 항목 순회, startsWith, 같은 키 반복 시 순환)
  const splitPickerLastSelectedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!splitSessionPicker) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setSplitSessionPicker(null); e.preventDefault(); e.stopPropagation(); return; }
      if (e.key.length !== 1 || e.ctrlKey || e.altKey || e.metaKey) return;
      const { sessions, folders } = splitSessionPicker;
      // 폴더 + 세션 모두 가시 순서대로 flatten (트리에 보이는 그대로)
      const items: { id: string; name: string; type: 'folder' | 'session'; data?: any }[] = [];
      const walk = (parentId?: string) => {
        const subF = folders.filter(f => (f.parentId ?? undefined) === (parentId ?? undefined));
        for (const f of subF) {
          items.push({ id: f.id, name: f.name, type: 'folder' });
          if (!splitPickerCollapsed.has(f.id)) walk(f.id);
        }
        const subS = sessions.filter(s => (s.folderId ?? undefined) === (parentId ?? undefined));
        for (const s of subS) {
          items.push({ id: s.sessionId, name: s.sessionName, type: 'session', data: s });
        }
      };
      walk(undefined);
      const ch = e.key.toLowerCase();
      const lastId = splitPickerLastSelectedRef.current;
      const curIdx = lastId ? items.findIndex(it => it.id === lastId) : -1;
      let target = -1;
      for (let i = 1; i <= items.length; i++) {
        const idx = (curIdx + i) % items.length;
        if (items[idx].name.toLowerCase().startsWith(ch)) { target = idx; break; }
      }
      if (target < 0) return;
      e.preventDefault();
      e.stopPropagation();
      const it = items[target];
      splitPickerLastSelectedRef.current = it.id;
      setTimeout(() => {
        const sel = it.type === 'session'
          ? `.folder-picker .folder-picker-item[data-sid="${CSS.escape(it.id)}"]`
          : `.folder-picker .folder-picker-item.folder-row[data-fid="${CSS.escape(it.id)}"]`;
        const el = document.querySelector(sel) as HTMLElement | null;
        el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        el?.classList.add('picker-highlight');
        setTimeout(() => el?.classList.remove('picker-highlight'), 800);
      }, 0);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [splitSessionPicker, splitPickerCollapsed]);
  const [floatingPanelId, setFloatingPanelId] = useState<string | null>(null);
  const [remoteTreeWidth, setRemoteTreeWidth] = useState<number>(240);
  const remoteTreeWidthLoadedRef = useRef(false);
  const [remoteTreePinned, setRemoteTreePinned] = useState<boolean>(true);
  const [remoteTreeVisible, setRemoteTreeVisible] = useState<boolean>(true);
  // 어느 오버레이가 최상위인지 — hover 중인 쪽이 다른 쪽 위에 오도록
  const [topPanel, setTopPanel] = useState<'session' | 'filetree' | null>(null);
  const remoteTreePinnedLoadedRef = useRef(false);
  const remoteTreeHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 세션 트리거 top 버튼 하단 y 좌표 (파일 트리 트리거의 top 위치 맞추기용)
  const [fileTreeTriggerTop, setFileTreeTriggerTop] = useState<number>(135);
  useEffect(() => {
    const measure = () => {
      const el = document.querySelector('.session-sidebar-trigger-top') as HTMLElement | null;
      if (el) {
        const r = el.getBoundingClientRect();
        setFileTreeTriggerTop(r.bottom);
      }
    };
    measure();
    const t1 = setTimeout(measure, 100);
    const t2 = setTimeout(measure, 500);
    window.addEventListener('resize', measure);
    const mo = new MutationObserver(measure);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true });
    return () => {
      clearTimeout(t1); clearTimeout(t2);
      window.removeEventListener('resize', measure);
      mo.disconnect();
    };
  }, []);
  useEffect(() => {
    if (!remoteTreePinnedLoadedRef.current) return;
    try { (window as any).api?.setUIPrefs?.({ remoteTreePinned }); } catch {}
    if (remoteTreePinned) setRemoteTreeVisible(true);
  }, [remoteTreePinned]);
  const [showClaudeChat, setShowClaudeChat] = useState(true);
  const [claudeChatWidth, setClaudeChatWidth] = useState<number>(360);
  const [claudeChatPinned, setClaudeChatPinned] = useState<boolean>(false);
  const [claudeChatVisible, setClaudeChatVisible] = useState<boolean>(false);
  const showClaudeChatLoadedRef = useRef(false);
  const claudeChatPinnedLoadedRef = useRef(false);
  const claudeChatHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!showClaudeChatLoadedRef.current) return;
    try { (window as any).api?.setUIPrefs?.({ showClaudeChat }); } catch {}
  }, [showClaudeChat]);
  useEffect(() => {
    if (!claudeChatPinnedLoadedRef.current) return;
    try { (window as any).api?.setUIPrefs?.({ claudeChatPinned }); } catch {}
    if (claudeChatPinned) setClaudeChatVisible(true);
    // 레이아웃 변경 → 터미널 재측정
    [50, 200, 500].forEach(ms => setTimeout(() => {
      window.dispatchEvent(new Event('resize'));
      refitAllTerms();
    }, ms));
  }, [claudeChatPinned]);
  // 너비/표시 변경 시에도 터미널 리핏
  useEffect(() => {
    [50, 200].forEach(ms => setTimeout(() => {
      window.dispatchEvent(new Event('resize'));
      refitAllTerms();
    }, ms));
  }, [claudeChatWidth, showClaudeChat]);
  const [claudeFileContext, setClaudeFileContext] = useState<{ fileName: string; remotePath: string; content: string }[] | null>(null);
  // WebDAV 마운트 첨부 엔트리
  const [claudeMountEntries, setClaudeMountEntries] = useState<{ termId: string; remotePath: string; uncPath: string; isDir: boolean }[]>([]);
  const [claudeAttaching, setClaudeAttaching] = useState<{ message: string; progress: number; total: number } | null>(null);
  const [, setConnectedTick] = useState(0);
  // 글로벌 연결 상태 변경시 일괄전송 카운트 등 재계산을 위해 강제 리렌더
  useEffect(() => subscribeConnectedChange(() => setConnectedTick(n => n + 1)), []);
  const [isMaximized, setIsMaximized] = useState(false);
  useEffect(() => {
    (window as any).api?.windowIsMaximized?.().then((m: boolean) => setIsMaximized(!!m)).catch(() => {});
    const off = (window as any).api?.onWindowMaximized?.((m: boolean) => setIsMaximized(!!m));
    return () => { try { off?.(); } catch {} };
  }, []);
  // Claude 채팅 전용 폰트/크기 — 터미널과 독립 설정 (src/utils/claudeFont)
  const [claudeFontFamily, setClaudeFontFamilyState] = useState(() => getClaudeFontFamily());
  const [claudeFontSize, setClaudeFontSizeState] = useState(() => getClaudeFontSize());
  useEffect(() => { applyClaudeFontVars(); }, []);
  // ClaudeChat 의 Ctrl+Wheel 이 외부에서 변경 시 옵션 창 값 동기화용
  useEffect(() => {
    const onChange = () => {
      setClaudeFontFamilyState(getClaudeFontFamily());
      setClaudeFontSizeState(getClaudeFontSize());
    };
    window.addEventListener('claude-font-changed', onChange);
    return () => window.removeEventListener('claude-font-changed', onChange);
  }, []);
  // main 프로세스 디버그 로그를 DevTools Console 로 포워딩
  useEffect(() => {
    const off = (window as any).api?.onDebugLog?.((msg: string) => {
      // eslint-disable-next-line no-console
      console.log('%c[main]', 'color:#8ab4f8', msg);
    });
    return () => { try { off?.(); } catch {} };
  }, []);
  const [fullscreenTermId, setFullscreenTermId] = useState<string | null>(null);
  const fsWasMaxRef = useRef(false);
  const [showQuickConnect, setShowQuickConnect] = useState(() => {
    const v = localStorage.getItem('showQuickConnect');
    return v === null ? true : v === '1';
  });
  useEffect(() => { localStorage.setItem('showQuickConnect', showQuickConnect ? '1' : '0'); }, [showQuickConnect]);

  // 인라인 토스트 알림 (alert 대체)
  const showToast = useCallback((msg: string, duration = 3000) => {
    const el = document.createElement('div');
    el.textContent = msg;
    Object.assign(el.style, {
      position: 'fixed', bottom: '60px', left: '50%', transform: 'translateX(-50%)',
      background: '#1a1a2e', color: '#eee', padding: '8px 18px', borderRadius: '6px',
      fontSize: '13px', zIndex: '9999', border: '1px solid #444', whiteSpace: 'nowrap',
    });
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; setTimeout(() => el.remove(), 300); }, duration);
  }, []);

  useEffect(() => {
    // DOM 이 아직 업데이트 안 됐을 수 있으므로 다음 프레임에 실행.
    // 분할 / 창 크기 조정 / 미니탭 전환 등으로 레이아웃이 바뀌어도 재적용.
    const apply = () => {
      document.querySelectorAll('.layout-leaf.fs-visible').forEach(el => el.classList.remove('fs-visible'));
      if (fullscreenTermId) {
        const target = document.querySelector(`.layout-leaf[data-active-term="${fullscreenTermId}"]`);
        if (target) target.classList.add('fs-visible');
      }
    };
    apply();
    const t1 = requestAnimationFrame(apply);
    const t2 = setTimeout(apply, 100);
    return () => { cancelAnimationFrame(t1); clearTimeout(t2); };
  }, [fullscreenTermId, activeTabId, tabs]);

  // 워크스페이스 전환 시 전체화면이면 새 워크스페이스의 선택된/첫번째 연결 패널로 fs-visible 전환
  useEffect(() => {
    if (!fullscreenTermId) return;
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab || tab.type === 'fileExplorer' || tab.type === 'fileEditor') {
      setFullscreenTermId(null);
      return;
    }
    // 현재 fullscreenTermId 가 새 워크스페이스에 있는지 확인
    const walk = (n: any): string[] => {
      if (n.type === 'leaf') {
        return (n.panel?.sessions || []).map((s: any) => s.termId);
      }
      return (n.children || []).flatMap(walk);
    };
    const termIds = walk(tab.layout);
    if (!termIds.includes(fullscreenTermId)) {
      // 새 워크스페이스엔 없음 → selectedPanel 또는 첫 leaf 의 activeTermId 로 전환
      const findFirst = (n: any): string | null => {
        if (n.type === 'leaf') {
          const s = n.panel?.sessions?.[n.panel?.activeIdx ?? 0];
          return s?.termId || null;
        }
        for (const c of (n.children || [])) { const r = findFirst(c); if (r) return r; }
        return null;
      };
      const candidate = findFirst(tab.layout);
      setFullscreenTermId(candidate);
    }
  }, [activeTabId, tabs, fullscreenTermId]);

  // 텍스트 일괄 전송 대상 termId 수집
  const collectBroadcastTargets = (scope: 'current' | 'visible' | 'connected'): string[] => {
    const ids: string[] = [];
    if (scope === 'current') {
      const tid = getActiveTermId();
      if (tid && isTermConnected(tid)) ids.push(tid);
      return ids;
    }
    if (scope === 'visible') {
      if (!activeTab) return ids;
      const walk = (node: LayoutNode) => {
        if (node.type === 'leaf') {
          const sess = node.panel.sessions[node.panel.activeIdx];
          if (sess && isTermConnected(sess.termId)) ids.push(sess.termId);
        } else for (const c of node.children) walk(c);
      };
      walk(activeTab.layout);
      return ids;
    }
    // connected: 모든 워크스페이스의 모든 미니탭 중 연결된 것
    for (const t of tabs) {
      if (t.type === 'fileExplorer') continue;
      const sessions = collectAllSessions(t.layout);
      for (const s of sessions) if (isTermConnected(s.termId)) ids.push(s.termId);
    }
    return ids;
  };

  const [broadcastNotice, setBroadcastNotice] = useState<{ text: string; kind: 'ok' | 'warn' } | null>(null);
  const broadcastNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashBroadcastNotice = (text: string, kind: 'ok' | 'warn' = 'ok') => {
    setBroadcastNotice({ text, kind });
    if (broadcastNoticeTimer.current) clearTimeout(broadcastNoticeTimer.current);
    broadcastNoticeTimer.current = setTimeout(() => setBroadcastNotice(null), 2500);
  };
  const sendBroadcast = (scope: 'current' | 'visible' | 'connected', override?: { raw: string; label?: string }, opts?: { keepFocusOnInput?: boolean }) => {
    let text: string;
    let label: string;
    if (override) {
      text = override.raw;
      label = override.label ?? '(raw)';
    } else {
      text = broadcastAppendNewline ? (broadcastText.endsWith('\n') ? broadcastText : broadcastText + '\n') : broadcastText;
      label = '텍스트';
      if (!text) { flashBroadcastNotice('텍스트를 입력하세요', 'warn'); return; }
      addBroadcastHistory(broadcastText);
    }
    const targets = collectBroadcastTargets(scope);
    if (targets.length === 0) {
      flashBroadcastNotice('대상 세션이 없습니다', 'warn');
      return;
    }
    for (const tid of targets) {
      try {
        if (isTermPty(tid)) {
          (window as any).api?.ptyInput?.(tid, text);
        } else {
          (window as any).api?.sendSSHInput?.(tid, text);
        }
      } catch {}
    }
    flashBroadcastNotice(`${label} → ${targets.length}개 세션 전송`, 'ok');
    // 전송 후 입력창 비우기 (override는 제어 문자라 제외)
    if (!override) setBroadcastText('');
    // 포커스 복귀: 기본은 활성 터미널로, 일괄작업창에서 전송한 경우엔 입력창 유지
    setTimeout(() => {
      if (opts?.keepFocusOnInput) {
        const inp = document.querySelector('.broadcast-input') as HTMLInputElement | null;
        inp?.focus();
      } else {
        const atid = getActiveTermId();
        if (atid) focusTerm(atid);
      }
    }, 0);
  };

  const handleThemeChange = (name: string) => {
    setThemeName(name);
    const tid = getActiveTermId();
    if (tid) applyThemeToTerm(tid, name);
    else applyThemeToAll(name);
  };

  const activeTab = tabs.find(t => t.id === activeTabId) ?? tabs[0];

  // 활성 터미널 termId를 가져오는 헬퍼
  const getActiveTermId = useCallback((): string | null => {
    if (!activeTab || !selectedPanelId) return null;
    const find = (node: LayoutNode): string | null => {
      if (node.type === 'leaf' && node.id === selectedPanelId) {
        const sess = node.panel.sessions[node.panel.activeIdx];
        return sess?.termId ?? null;
      }
      if (node.type !== 'leaf') for (const c of node.children) { const r = find(c); if (r) return r; }
      return null;
    };
    return find(activeTab.layout);
  }, [activeTab, selectedPanelId]);

  // 글로벌 단축키
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // 옵션 다이얼로그 열려있으면 글로벌 핸들러 무시
      if (showOptions) return;
      // 전체화면 토글 (창도 최대화, 해제 시 원래 상태로)
      if (matchKeybinding(e, 'fullscreen')) {
        e.preventDefault();
        const tid = getActiveTermId();
        if (tid) {
          setFullscreenTermId(prev => {
            const toFullscreen = prev !== tid;
            (async () => {
              try {
                const isMax = await (window as any).api?.windowIsMaximized?.();
                if (toFullscreen) {
                  // 진입: 현재 최대화 상태 저장 + 최대화
                  fsWasMaxRef.current = !!isMax;
                  if (!isMax) await (window as any).api?.windowToggleMaximize?.();
                } else {
                  // 해제: 진입 전 최대화가 아니었으면 원래대로 복원
                  if (!fsWasMaxRef.current && isMax) await (window as any).api?.windowToggleMaximize?.();
                }
              } catch {}
            })();
            return toFullscreen ? tid : null;
          });
          setTimeout(() => { refitAllTerms(); focusTerm(tid); }, 150);
        }
        return;
      }
      // 연결된 세션 선택 + 가로/세로 분할
      if ((matchKeybinding(e, 'splitSessionH') || matchKeybinding(e, 'splitSessionV')) && activeTab && selectedPanelId) {
        e.preventDefault();
        const dir: 'row' | 'column' = matchKeybinding(e, 'splitSessionV') ? 'row' : 'column';
        openSplitSessionPicker(dir, selectedPanelId);
        return;
      }
      // Alt+1..9: 워크스페이스 내 모든 미니탭(모든 패널) 기준 N번째 탭으로 이동 (Alt+9는 마지막 탭)
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        const m = /^Digit([1-9])$/.exec(e.code);
        if (m) {
          if (!activeTab) return;
          const leaves: { nodeId: string; sessions: PanelSession[]; activeIdx: number }[] = [];
          const collect = (node: LayoutNode) => {
            if (node.type === 'leaf') {
              if (node.panel.sessions.length > 0) {
                leaves.push({ nodeId: node.id, sessions: node.panel.sessions, activeIdx: node.panel.activeIdx });
              }
            } else {
              for (const c of node.children) collect(c);
            }
          };
          collect(activeTab.layout);
          const total = leaves.reduce((n, l) => n + l.sessions.length, 0);
          if (total === 0) return;
          e.preventDefault();
          const n = Number(m[1]);
          const targetGlobal = n === 9 ? total - 1 : Math.min(n - 1, total - 1);
          let acc = 0;
          for (const l of leaves) {
            if (targetGlobal < acc + l.sessions.length) {
              const localIdx = targetGlobal - acc;
              if (l.nodeId !== selectedPanelId) setSelectedPanelId(l.nodeId);
              if (localIdx !== l.activeIdx) handleSwitchSession(l.nodeId, localIdx);
              const tid = l.sessions[localIdx]?.termId;
              if (tid) setTimeout(() => focusTerm(tid), 50);
              break;
            }
            acc += l.sessions.length;
          }
          return;
        }
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      // 미니탭 순환
      if (matchKeybinding(e, 'nextTab') || matchKeybinding(e, 'prevTab')) {
        if (!activeTab) return;
        const leaves: { nodeId: string; sessions: PanelSession[]; activeIdx: number }[] = [];
        const collect = (node: LayoutNode) => {
          if (node.type === 'leaf') {
            if (node.panel.sessions.length > 0) {
              leaves.push({ nodeId: node.id, sessions: node.panel.sessions, activeIdx: node.panel.activeIdx });
            }
          } else {
            for (const c of node.children) collect(c);
          }
        };
        collect(activeTab.layout);
        const total = leaves.reduce((n, l) => n + l.sessions.length, 0);
        if (total < 2) return;
        e.preventDefault();
        // 현재 활성 위치(global index) 계산
        let curGlobal = 0;
        let found = false;
        for (const l of leaves) {
          if (l.nodeId === selectedPanelId) { curGlobal += l.activeIdx; found = true; break; }
          curGlobal += l.sessions.length;
        }
        if (!found) curGlobal = 0;
        const dir = matchKeybinding(e, 'prevTab') ? -1 : 1;
        const nextGlobal = (curGlobal + dir + total) % total;
        // global index → 해당 leaf + 로컬 index
        let acc = 0;
        for (const l of leaves) {
          if (nextGlobal < acc + l.sessions.length) {
            const localIdx = nextGlobal - acc;
            if (l.nodeId !== selectedPanelId) setSelectedPanelId(l.nodeId);
            if (localIdx !== l.activeIdx) handleSwitchSession(l.nodeId, localIdx);
            const tid = l.sessions[localIdx]?.termId;
            if (tid) setTimeout(() => focusTerm(tid), 50);
            break;
          }
          acc += l.sessions.length;
        }
        return;
      }
      // 현재 세션 복제 + 가로/세로 분할
      if ((matchKeybinding(e, 'cloneSplitH') || matchKeybinding(e, 'cloneSplitV')) && activeTab && selectedPanelId) {
        e.preventDefault();
        const dir: 'row' | 'column' = matchKeybinding(e, 'cloneSplitV') ? 'row' : 'column';
        const tid = getActiveTermId();
        const sessInfo = tid ? getTermSessionInfo(tid) : null;
        if (sessInfo && sessInfo.sessionId) {
          const newTermId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const newSess: PanelSession = { termId: newTermId, sessionId: sessInfo.sessionId, sessionName: sessInfo.sessionName || 'Session' };
          updateLayout(activeTab.id, layout => splitNodeWithSessions(layout, selectedPanelId, dir, [newSess], false));
          setTimeout(async () => {
            if (tid) cloneTermStyle(tid, newTermId);
            try {
              const r = await (window as any).api.connectSSH(newTermId, sessInfo.sessionId);
              if (r === 'need-password') promptPasswordAndConnect(newTermId, sessInfo.sessionId);
            } catch {}
            registerTermSession(newTermId, sessInfo.sessionId, sessInfo.sessionName, sessInfo.host);
            setTimeout(() => { refitAllTerms(); focusTerm(newTermId); }, 100);
          }, 100);
        } else {
          splitPanel(activeTab.id, selectedPanelId, dir);
        }
        return;
      }
      if (matchKeybinding(e, 'find')) { e.preventDefault(); setShowSearch(prev => !prev); return; }
      if (matchKeybinding(e, 'toggleFileTree')) {
        e.preventDefault();
        const tid = getActiveTermId();
        if (tid) {
          toggleTreeVisibleForTerm(tid);
          [50, 200].forEach(ms => setTimeout(() => {
            window.dispatchEvent(new Event('resize'));
            refitAllTerms();
          }, ms));
        }
        return;
      }
      const termId = getActiveTermId();
      if (!termId) return;
      if (matchKeybinding(e, 'clearScrollback')) { e.preventDefault(); clearScrollbackInTerm(termId); }
      else if (matchKeybinding(e, 'clearScreen')) { e.preventDefault(); clearScreenInTerm(termId); }
      else if (matchKeybinding(e, 'clearAll')) { e.preventDefault(); clearAllInTerm(termId); }
    };
    window.addEventListener('keydown', handler, true); // capture phase
    return () => window.removeEventListener('keydown', handler, true);
  }, [getActiveTermId, showOptions]);

  // SFTP 진행률/완료 이벤트
  useEffect(() => {
    const onProgress = (window as any).api?.onSFTPProgress?.((p: any) => {
      try { setSftpProgress(JSON.parse(p.data)); } catch {}
    });
    const onComplete = (window as any).api?.onSFTPComplete?.((p: any) => {
      setSftpProgress(null);
      try {
        JSON.parse(p.data);
        // 전송 완료 — 전송 목록에서 확인 가능
      } catch {}
    });
    return () => { onProgress?.(); onComplete?.(); };
  }, []);

  const addTab = (shellName?: string, shellPath?: string) => {
    const id = `tab-${Date.now()}`;
    const sn = shellName || defaultShell.name;
    const sp = shellPath || defaultShell.path;
    const layout = createInitialLayout(id, sn, sp);
    setTabs(prev => [...prev, { id, title: `Workspace ${prev.length + 1}`, layout }]);
    setActiveTabId(id);
    // 새 워크스페이스의 루트 패널 자동 선택
    if (layout.type === 'leaf') setSelectedPanelId(layout.id);
  };

  // 원격 파일을 에디터 탭에서 열기
  const handleOpenRemoteFile = (termId: string, remotePath: string, fileName: string) => {
    // 이미 같은 파일 열린 탭 있으면 전환
    const existing = tabs.find(t => t.type === 'fileEditor' && t.editor?.termId === termId && t.editor?.remotePath === remotePath);
    if (existing) { setActiveTabId(existing.id); return; }
    const id = `editor-${Date.now()}`;
    const layout = createInitialLayout(id);
    setTabs(prev => [...prev, { id, title: `📝 ${fileName}`, layout, type: 'fileEditor', editor: { termId, remotePath, fileName } }]);
    setActiveTabId(id);
  };

  // Claude 에 파일/폴더 첨부 (WebDAV 마운트 방식 - 실시간 SSH 접근)
  const handleAttachToClaude = async (termId: string, remotePath: string, _fileName: string, isDir: boolean) => {
    setShowClaudeChat(true);
    setClaudeAttaching({ message: 'WebDAV 마운트 준비 중...', progress: 0, total: 1 });
    try {
      // 세션 라벨(표시용)
      let sessionLabel = termId;
      try {
        const sess = findTermSession(termId);
        if (sess) sessionLabel = sess.sessionName || sess.host || termId;
      } catch {}

      // 세션 등록 (한 번만 실제 등록됨 - 내부에서 중복 체크)
      const reg: any = await (window as any).api?.claudeRegisterMount?.(termId, sessionLabel);
      if (!reg?.success) {
        setClaudeAttaching({ message: `마운트 실패: ${reg?.error || '알 수 없음'}`, progress: 0, total: 0 });
        setTimeout(() => setClaudeAttaching(null), 3500);
        return;
      }

      // UNC 경로 생성
      const pathRes: any = await (window as any).api?.claudeGetMountPath?.(termId, remotePath);
      if (!pathRes?.success) {
        setClaudeAttaching({ message: `경로 변환 실패: ${pathRes?.error || '알 수 없음'}`, progress: 0, total: 0 });
        setTimeout(() => setClaudeAttaching(null), 3500);
        return;
      }

      setClaudeMountEntries(prev => {
        const map = new Map(prev.map(e => [`${e.termId}:${e.remotePath}`, e]));
        map.set(`${termId}:${remotePath}`, { termId, remotePath, uncPath: pathRes.uncPath, isDir });
        return Array.from(map.values());
      });
      setClaudeAttaching({ message: `첨부 완료 (WebDAV 실시간 접근)`, progress: 1, total: 1 });
      setTimeout(() => setClaudeAttaching(null), 2000);
    } catch (err: any) {
      setClaudeAttaching({ message: `첨부 실패: ${err}`, progress: 0, total: 0 });
      setTimeout(() => setClaudeAttaching(null), 3500);
    }
  };

  // termId → session meta 찾기 헬퍼 (sessionName/host 참조용)
  const findTermSession = (termId: string): { sessionName?: string; host?: string } | null => {
    for (const tab of tabs) {
      const walk = (n: any): any => {
        if (n.type === 'leaf' && n.termId === termId) return n;
        if (n.children) for (const c of n.children) { const r = walk(c); if (r) return r; }
        return null;
      };
      const leaf = walk(tab.layout);
      if (leaf) return { sessionName: leaf.sessionName, host: leaf.host };
    }
    return null;
  };

  const renameTab = (id: TabId, name: string) => {
    setTabs(prev => prev.map(t => t.id === id ? { ...t, title: name } : t));
  };

  const closeTab = (id: TabId) => {
    setTabs(prev => { const f = prev.filter(t => t.id !== id); return f.length === 0 ? prev : f; });
    setActiveTabId(prev => {
      if (prev !== id) return prev;
      const r = tabs.filter(t => t.id !== id);
      return r.length > 0 ? r[0].id : prev;
    });
  };

  const updateLayout = (tabId: TabId, fn: (layout: LayoutNode) => LayoutNode) => {
    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, layout: fn(t.layout) } : t));
  };

  // 현재 활성 세션의 folderId 기준으로 같은 폴더 세션들을 picker 로 띄운다.
  // 픽커에서 선택된 세션을 새 termId 로 연결해서 targetNodeId 패널을 분할해 배치.
  // 활성 세션이 없거나 folder 내 다른 세션이 없으면 그냥 빈 분할.
  const openSplitSessionPicker = async (dir: 'row' | 'column', targetNodeId: string) => {
    // 세션 픽커 없이 바로 빈 분할 (로컬 쉘 패널 자동 생성)
    if (!activeTab) return;
    splitPanel(activeTab.id, targetNodeId, dir);
  };

  // 세션 선택 팝업 — 파일트리 형식 (폴더 + 세션 계층 구조)
  const openSplitSessionPickerWithPrompt = async (dir: 'row' | 'column', targetNodeId: string) => {
    if (!activeTab) return;
    const curTid = getActiveTermId();
    try {
      const data: any = await (window as any).api?.listSessions?.();
      const sessions: any[] = data?.sessions ?? data ?? [];
      const folders: any[] = data?.folders ?? [];
      const sessionItems = sessions.map(s => ({
        sessionId: s.id, sessionName: s.name, host: s.host || '', termId: '',
        folderId: s.folderId, icon: s.icon,
      }));
      const folderItems = folders.map((f: any) => ({ id: f.id, name: f.name, parentId: f.parentId }));
      if (sessionItems.length === 0) {
        splitPanel(activeTab.id, targetNodeId, dir);
        return;
      }
      setSplitPickerCollapsed(new Set());
      setSplitSessionPicker({
        dir, sessions: sessionItems, folders: folderItems,
        srcTermId: curTid || undefined, targetNodeId,
      });
    } catch {
      splitPanel(activeTab.id, targetNodeId, dir);
    }
  };

  const splitPanel = (tabId: TabId, targetNodeId: string, direction: 'row' | 'column') => {
    updateLayout(tabId, layout => splitNode(layout, targetNodeId, direction));
    setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
  };

  const handleSplitSessionSelect = async (target: { sessionId: string; sessionName: string; host: string; termId: string }) => {
    if (!activeTab || !splitSessionPicker) return;
    const { dir, targetNodeId } = splitSessionPicker;
    const newTermId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const newSess: PanelSession = { termId: newTermId, sessionId: target.sessionId, sessionName: target.sessionName };
    // 세션 데이터에서 theme/font 가져오기
    let fullSess: any = null;
    try {
      const data: any = await (window as any).api?.listSessions?.();
      const all: any[] = data?.sessions ?? data ?? [];
      fullSess = all.find((s: any) => s.id === target.sessionId);
    } catch {}
    updateLayout(activeTab.id, layout => splitNodeWithSessions(layout, targetNodeId, dir, [newSess], false));
    setTimeout(async () => {
      // 세션 설정 적용 (theme / fontFamily / fontSize / scrollback)
      if (fullSess?.scrollback) applyScrollbackToTerm(newTermId, fullSess.scrollback);
      setTimeout(() => {
        if (fullSess?.theme) applyThemeToTerm(newTermId, fullSess.theme);
        if (fullSess?.fontFamily || fullSess?.fontSize) applyFontToTerm(newTermId, fullSess?.fontFamily, fullSess?.fontSize);
      }, 200);
      try {
        const r = await (window as any).api.connectSSH(newTermId, target.sessionId);
        if (r === 'need-password') promptPasswordAndConnect(newTermId, target.sessionId);
      } catch {}
      registerTermSession(newTermId, target.sessionId, target.sessionName, target.host);
      setTimeout(() => { refitAllTerms(); focusTerm(newTermId); }, 100);
    }, 100);
    setSplitSessionPicker(null);
  };

  const closePanel = (tabId: TabId, targetNodeId: string) => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;
    if (countLeaves(tab.layout) === 1) {
      if (tab.layout.type === 'leaf') tab.layout.panel.sessions.forEach(s => window.api?.disconnectSSH?.(s.termId));
      return;
    }
    updateLayout(tabId, layout => removeLeafNode(layout, targetNodeId));
  };

  const handleSwitchSession = (nodeId: string, idx: number) => {
    if (!activeTab) return;
    updateLayout(activeTab.id, layout => switchPanelSession(layout, nodeId, idx));
  };

  const handleReorderSession = (nodeId: string, fromIdx: number, toIdx: number) => {
    if (!activeTab || fromIdx === toIdx) return;
    updateLayout(activeTab.id, layout => reorderPanelSession(layout, nodeId, fromIdx, toIdx));
  };

  // 세션 제거 후 빈 패널 정리 (leaf가 1개뿐이면 유지)
  const cleanEmptyLeaf = (layout: LayoutNode, nodeId: string): LayoutNode => {
    if (countLeaves(layout) <= 1) return layout;
    const isEmpty = (node: LayoutNode): boolean => {
      if (node.type === 'leaf') return node.id === nodeId && node.panel.sessions.length === 0;
      return node.children.some(isEmpty);
    };
    return isEmpty(layout) ? removeLeafNode(layout, nodeId) : layout;
  };

  const handleMoveSession = (fromNodeId: string, termId: string, toNodeId: string) => {
    if (!activeTab) return;
    updateLayout(activeTab.id, layout => {
      const findSess = (node: LayoutNode): PanelSession | null => {
        if (node.type === 'leaf' && node.id === fromNodeId) return node.panel.sessions.find(s => s.termId === termId) ?? null;
        if (node.type !== 'leaf') for (const c of node.children) { const r = findSess(c); if (r) return r; }
        return null;
      };
      const sess = findSess(layout);
      if (!sess) return layout;
      let updated = removeSessionFromPanel(layout, fromNodeId, termId);
      updated = appendSessionsToPanel(updated, toNodeId, [sess], false);
      updated = cleanEmptyLeaf(updated, fromNodeId);
      return updated;
    });
  };

  // 미니탭을 다른 패널 가장자리에 드롭 → 분할 + 세션 이동
  const handleSplitMoveSession = (fromNodeId: string, termId: string, toNodeId: string, zone: 'left' | 'right' | 'top' | 'bottom') => {
    if (!activeTab) return;
    updateLayout(activeTab.id, layout => {
      const findSess = (node: LayoutNode): PanelSession | null => {
        if (node.type === 'leaf' && node.id === fromNodeId) return node.panel.sessions.find(s => s.termId === termId) ?? null;
        if (node.type !== 'leaf') for (const c of node.children) { const r = findSess(c); if (r) return r; }
        return null;
      };
      const sess = findSess(layout);
      if (!sess) return layout;
      const direction: 'row' | 'column' = (zone === 'left' || zone === 'right') ? 'row' : 'column';
      const insertBefore = zone === 'left' || zone === 'top';
      let updated = removeSessionFromPanel(layout, fromNodeId, termId);
      updated = cleanEmptyLeaf(updated, fromNodeId);
      updated = splitNodeWithSessions(updated, toNodeId, direction, [sess], insertBefore);
      return updated;
    });
    setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
  };

  const handleAddSession = (nodeId: string, shellName?: string, shellPath?: string) => {
    if (!activeTab) return;
    const termId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sess: PanelSession = { termId, sessionId: '', sessionName: shellName || defaultShell.name, shellPath: shellPath || defaultShell.path };
    updateLayout(activeTab.id, layout => appendSessionsToPanel(layout, nodeId, [sess], true));
    setSelectedPanelId(nodeId);
  };

  const handleDuplicateSession = (nodeId: string, termId: string) => {
    if (!activeTab) return;
    const info = getTermSessionInfo(termId);
    if (!info) return;
    const newTermId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sess: PanelSession = { termId: newTermId, sessionId: info.sessionId || '', sessionName: info.sessionName || 'New Tab' };
    // 생성 전에 스타일(테마/폰트/불투명도)을 복제 → 새 터미널 생성 시 바로 반영됨
    cloneTermStyle(termId, newTermId);
    updateLayout(activeTab.id, layout => appendSessionsToPanel(layout, nodeId, [sess], true));
    registerTermSession(newTermId, info.sessionId || '', info.sessionName, info.host, info.quickSession);
    setTimeout(async () => {
      try {
        if (info.sessionId) {
          await (window as any).api?.connectSSH?.(newTermId, info.sessionId);
        } else if (info.quickSession) {
          await (window as any).api?.quickConnectSSH?.(newTermId, info.quickSession);
        }
        // 런타임에 변경된 인코딩까지 복제
        try {
          const srcEnc = await (window as any).api?.getSSHEncoding?.(termId);
          if (srcEnc) await (window as any).api?.setSSHEncoding?.(newTermId, srcEnc);
        } catch {}
        // 복제 직후 스타일 재적용 (새 xterm 마운트 이후에도 확실히 반영)
        cloneTermStyle(termId, newTermId);
      } catch {}
    }, 50);
  };

  const handleRenameSession = (nodeId: string, termId: string, name: string) => {
    if (!activeTab) return;
    updateLayout(activeTab.id, layout => {
      function walk(node: LayoutNode): LayoutNode {
        if (node.type === 'leaf' && node.id === nodeId) {
          const sessions = node.panel.sessions.map(s => s.termId === termId ? { ...s, sessionName: name } : s);
          return { ...node, panel: { ...node.panel, sessions } };
        }
        if (node.type !== 'leaf') return { ...node, children: node.children.map(walk) };
        return node;
      }
      return walk(layout);
    });
  };

  const handleConnectDrop = (nodeId: string, sessionId: string) => {
    if (!activeTab) return;
    const doConnect = async () => {
      try {
        const data = await (window as any).api.listSessions();
        const allSessions = data?.sessions ?? data ?? [];
        const session = allSessions.find((s: any) => s.id === sessionId);
        if (!session) return;

        let existingCount = 0;
        for (const t of tabs) existingCount += countSessionInTree(t.layout, sessionId);
        const displayName = `${session.name} #${existingCount + 1}`;

        // 해당 패널의 활성 미니탭이 빈(sessionId='') 세션이면 교체
        const findEmpty = (node: LayoutNode): PanelSession | null => {
          if (node.type === 'leaf' && node.id === nodeId) {
            const sess = node.panel.sessions[node.panel.activeIdx];
            return (sess && !sess.sessionId) ? sess : null;
          }
          if (node.type !== 'leaf') for (const c of node.children) { const r = findEmpty(c); if (r) return r; }
          return null;
        };
        const emptySess = findEmpty(activeTab.layout);

        if (emptySess) {
          // 빈 미니탭 → 세션 정보 교체 후 연결
          resetTermConnectState(emptySess.termId);
          updateLayout(activeTab.id, layout => {
            function walk(node: LayoutNode): LayoutNode {
              if (node.type === 'leaf' && node.id === nodeId) {
                const sessions = node.panel.sessions.map((s, i) =>
                  i === node.panel.activeIdx ? { ...s, sessionId, sessionName: displayName } : s
                );
                return { ...node, panel: { ...node.panel, sessions } };
              }
              if (node.type !== 'leaf') return { ...node, children: node.children.map(walk) };
              return node;
            }
            return walk(layout);
          });
          setTimeout(() => (window as any).api.connectSSH(emptySess.termId, sessionId), 100);
          if (session.theme) setTimeout(() => applyThemeToTerm(emptySess.termId, session.theme), 200);
          if (session.fontFamily || session.fontSize) setTimeout(() => applyFontToTerm(emptySess.termId, session.fontFamily, session.fontSize), 200);
          if (session.scrollback) applyScrollbackToTerm(emptySess.termId, session.scrollback);
          registerTermSession(emptySess.termId, sessionId, displayName, session.host ?? '');
        } else {
          // 빈 미니탭 없으면 기존 흐름
          setSelectedPanelId(nodeId);
          handleConnectSession(session.id, session.name, null, session.theme, session.fontFamily, session.fontSize, session.scrollback);
        }
      } catch {}
    };
    doConnect();
  };

  const handleCloseSession = (nodeId: string, termId: string) => {
    if (!activeTab) return;
    updateLayout(activeTab.id, layout => {
      let updated = removeSessionFromPanel(layout, nodeId, termId);
      updated = cleanEmptyLeaf(updated, nodeId);
      return updated;
    });
  };

  const movePanel = useCallback((fromPanelId: string, toPanelId: string | null, position: 'before' | 'after' | 'inside' = 'after') => {
    if (!activeTab) return;
    updateLayout(activeTab.id, layout => {
      const rr = removeLeafFromTree(layout, fromPanelId);
      if (!rr.removed) return layout;
      if (!toPanelId || position === 'inside') return replaceLeaf(rr.root, toPanelId ?? fromPanelId, rr.removed);
      return insertNear(rr.root, toPanelId, rr.removed, position);
    });
  }, [activeTab]);

  // ── SSH 연결 ──

  // 선택된 패널의 활성 미니탭이 끊겨있는지 확인
  const findDisconnectedActiveSession = (layout: LayoutNode, panelId: string): PanelSession | null => {
    if (layout.type === 'leaf') {
      if (layout.id !== panelId) return null;
      const sess = layout.panel.sessions[layout.panel.activeIdx];
      if (!sess) return null;
      // 로컬 쉘(PTY)이 실행 중이면 재사용하지 않음 → 새 미니탭 생성
      if (isTermPty(sess.termId)) return null;
      return sess;
    }
    for (const c of layout.children) { const r = findDisconnectedActiveSession(c, panelId); if (r) return r; }
    return null;
  };

  const handleConnectSession = (sessionId: string, sessionName: string, _targetPanelId?: string | null, sessionTheme?: string, sessionFontFamily?: string, sessionFontSize?: number, sessionScrollback?: number) => {
    if (!activeTab) return;
    // 파일 전송 탭이면 SFTP 직접 연결하여 파일 탐색기에 추가 (점프 호스트 설정도 반영)
    if (activeTab.type === 'fileExplorer') {
      (async () => {
        try {
          const data = await (window as any).api.listSessions();
          const allSessions = data?.sessions ?? data ?? [];
          const sess = allSessions.find((s: any) => s.id === sessionId);
          if (!sess) return;
          console.log('[fe-transfer dblclick] session:', { name: sess.name, host: sess.host, jumpTargetHost: sess.jumpTargetHost });
          const connId = `sftp-fe-${Date.now()}`;
          const jumpOpts = sess.jumpTargetHost?.trim()
            ? { host: sess.jumpTargetHost.trim(), user: sess.jumpTargetUser || 'root', port: Number(sess.jumpTargetPort) || 22, password: sess.jumpTargetPassword || undefined }
            : undefined;
          const displayHost = jumpOpts ? jumpOpts.host : sess.host;
          const result = await (window as any).api.feSftpConnect?.(connId, sess.host, sess.port || 22, sess.username, sess.auth, jumpOpts);
          if (result?.success) {
            window.dispatchEvent(new CustomEvent('fe-sftp-connected', { detail: { connId, sessionName, host: displayHost } }));
          } else {
            const msg = result?.error || '알 수 없는 오류';
            console.error('[fe-sftp-connect dblclick] failed:', msg);
            alert(`파일 전송 연결 실패 (${sessionName})\n\n${msg}`);
          }
        } catch (err: any) {
          console.error('[fe-sftp-connect dblclick] exception:', err);
        }
      })();
      return;
    }
    const applySessionTheme = (termId: string) => {
      if (sessionScrollback) applyScrollbackToTerm(termId, sessionScrollback);
      setTimeout(() => {
        if (sessionTheme) applyThemeToTerm(termId, sessionTheme);
        if (sessionFontFamily || sessionFontSize) applyFontToTerm(termId, sessionFontFamily, sessionFontSize);
      }, 200);
    };
    const registerTerm = async (termId: string) => {
      // 세션 이름/호스트 정보도 전달
      try {
        const data = await (window as any).api.listSessions();
        const sessions = data?.sessions ?? data ?? [];
        const sess = sessions.find((s: any) => s.id === sessionId);
        registerTermSession(termId, sessionId, displayName, sess?.host ?? '');
      } catch {
        registerTermSession(termId, sessionId, displayName, '');
      }
    };
    let existingCount = 0;
    for (const t of tabs) existingCount += countSessionInTree(t.layout, sessionId);
    const displayName = `${sessionName} #${existingCount + 1}`;

    // 선택된 패널의 활성 미니탭 확인
    if (selectedPanelId) {
      const activeSess = findDisconnectedActiveSession(activeTab.layout, selectedPanelId);
      if (!activeSess) {
        // 활성 세션 없거나 PTY 실행 중 → 선택된 패널에 새 미니탭으로 추가
        const { layout, termId } = addSessionToPanel(activeTab.layout, selectedPanelId, sessionId, displayName);
        setTabs(prev => prev.map(t => t.id === activeTab.id ? { ...t, layout } : t));
        setTimeout(async () => {
          const r = await (window as any).api.connectSSH(termId, sessionId);
          if (r === 'need-password') {
            promptPasswordAndConnect(termId, sessionId);
          }
        }, 0);
        applySessionTheme(termId); registerTerm(termId);
        return;
      }
      if (activeSess) {
        // 연결 상태 확인 후 분기 — 연결 중(connecting)도 "사용 중"으로 간주해서 새 미니탭으로 추가
        const checkAndConnect = async () => {
          let connected = false;
          try { connected = await (window as any).api.isSSHConnected(activeSess.termId); } catch {}
          const connecting = isTermConnecting(activeSess.termId);
          if (connected || connecting) {
            // 연결 중이면 → 같은 패널에 새 미니탭으로 추가
            const { layout, termId } = addSessionToPanel(activeTab.layout, selectedPanelId!, sessionId, displayName);
            setTabs(prev => prev.map(t => t.id === activeTab.id ? { ...t, layout } : t));
            setTimeout(async () => {
              const r = await (window as any).api.connectSSH(termId, sessionId);
              if (r === 'need-password') {
                promptPasswordAndConnect(termId, sessionId);
              }
            }, 0);
            applySessionTheme(termId); registerTerm(termId);
          } else {
            // 끊겨있으면 → 기존 termId 유지, 세션 정보만 교체 후 재연결
            resetTermConnectState(activeSess.termId);
            updateLayout(activeTab.id, layout => {
              function walk(node: LayoutNode): LayoutNode {
                if (node.type === 'leaf' && node.id === selectedPanelId) {
                  const sessions = node.panel.sessions.map((s, i) =>
                    i === node.panel.activeIdx ? { ...s, sessionId, sessionName: displayName } : s
                  );
                  return { ...node, panel: { ...node.panel, sessions } };
                }
                if (node.type !== 'leaf') return { ...node, children: node.children.map(walk) };
                return node;
              }
              return walk(layout);
            });
            setTimeout(async () => {
              const r = await (window as any).api.connectSSH(activeSess.termId, sessionId);
              if (r === 'need-password') {
                promptPasswordAndConnect(activeSess.termId, sessionId);
              }
            }, 100);
            applySessionTheme(activeSess.termId); registerTerm(activeSess.termId);
          }
        };
        checkAndConnect();
        return;
      }
    }

    const emptyLeafId = findEmptyLeafId(activeTab.layout);

    if (emptyLeafId) {
      const { layout, termId } = addSessionToPanel(activeTab.layout, emptyLeafId, sessionId, displayName);
      setSelectedPanelId(emptyLeafId);
      setTabs(prev => prev.map(t => t.id === activeTab.id ? { ...t, layout } : t));
      setTimeout(() => window.api?.connectSSH?.(termId, sessionId), 0);
      applySessionTheme(termId); registerTerm(termId);
      return;
    }

    // 빈 패널 없으면 첫 번째 패널에 미니탭으로 추가
    const firstLeafId = findFirstLeafId(activeTab.layout);
    if (firstLeafId) {
      const { layout, termId } = addSessionToPanel(activeTab.layout, firstLeafId, sessionId, displayName);
      setTabs(prev => prev.map(t => t.id === activeTab.id ? { ...t, layout } : t));
      setTimeout(() => window.api?.connectSSH?.(termId, sessionId), 0);
      applySessionTheme(termId); registerTerm(termId);
    }
  };

  const handleQuickConnect = (info: QuickConnectResult) => {
    if (!activeTab) return;
    // SFTP 프로토콜이거나 파일 전송 워크스페이스가 활성이면 SFTP 직접 연결로 처리
    if (info.protocol === 'sftp' || activeTab.type === 'fileExplorer') {
      // 파일 전송 워크스페이스가 없으면 생성하고 전환
      let feTab = tabs.find(t => t.type === 'fileExplorer');
      if (!feTab) {
        const id = `tab-fe-${Date.now()}`;
        feTab = { id, title: '📁 파일 전송', layout: createInitialLayout(id), type: 'fileExplorer' };
        setTabs(prev => [...prev, feTab!]);
      }
      setActiveTabId(feTab.id);
      // FileExplorer 마운트 후 이벤트가 처리되도록 약간 지연
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('fe-quick-sftp-connect', { detail: info }));
      }, 100);
      return;
    }
    const termId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const displayName = info.name;
    const sess: PanelSession = { termId, sessionId: '', sessionName: displayName };

    // 선택된 패널의 빈 미니탭을 우선 사용, 없으면 첫 빈 패널, 없으면 첫 패널에 미니탭 추가
    const findEmptyActiveInPanel = (layout: LayoutNode, panelId: string): PanelSession | null => {
      if (layout.type === 'leaf') {
        if (layout.id !== panelId) return null;
        const s = layout.panel.sessions[layout.panel.activeIdx];
        return (s && !s.sessionId) ? s : null;
      }
      for (const c of layout.children) { const r = findEmptyActiveInPanel(c, panelId); if (r) return r; }
      return null;
    };

    const connect = (tid: string) => {
      setTimeout(() => (window as any).api?.quickConnectSSH?.(tid, info), 100);
      registerTermSession(tid, '', displayName, info.host, info);
    };

    if (selectedPanelId) {
      const empty = findEmptyActiveInPanel(activeTab.layout, selectedPanelId);
      if (empty) {
        resetTermConnectState(empty.termId);
        updateLayout(activeTab.id, layout => {
          function walk(node: LayoutNode): LayoutNode {
            if (node.type === 'leaf' && node.id === selectedPanelId) {
              const sessions = node.panel.sessions.map((s, i) =>
                i === node.panel.activeIdx ? { ...s, sessionName: displayName } : s
              );
              return { ...node, panel: { ...node.panel, sessions } };
            }
            if (node.type !== 'leaf') return { ...node, children: node.children.map(walk) };
            return node;
          }
          return walk(layout);
        });
        connect(empty.termId);
        return;
      }
    }

    const emptyLeafId = findEmptyLeafId(activeTab.layout);
    const targetLeafId = emptyLeafId || findFirstLeafId(activeTab.layout);
    if (!targetLeafId) return;
    updateLayout(activeTab.id, layout => appendSessionsToPanel(layout, targetLeafId, [sess], true));
    setSelectedPanelId(targetLeafId);
    connect(termId);
  };

  const handleDisconnectSession = (targetPanelId?: string | null) => {
    if (!activeTab) return;
    const findTerm = (node: LayoutNode): string | null => {
      if (node.type === 'leaf') {
        if (targetPanelId && node.id !== targetPanelId) return null;
        const sess = node.panel.sessions[node.panel.activeIdx];
        return sess?.termId ?? null;
      }
      for (const c of node.children) { const r = findTerm(c); if (r) return r; }
      return null;
    };
    const tid = findTerm(activeTab.layout);
    if (tid) window.api?.disconnectSSH?.(tid);
  };

  const menuDefs: MenuDef[] = [
    {
      label: '파일',
      items: [
        { label: '새 워크스페이스', action: () => addTab() },
        { label: '워크스페이스 닫기', action: () => activeTab && closeTab(activeTab.id), disabled: tabs.length <= 1 },
        { separator: true, label: '' },
        { label: '세션 내보내기...', action: () => (window as any).api.exportSessions() },
        { label: '세션 가져오기...', action: async () => { const r = await (window as any).api.importSessions(); if (r) { window.dispatchEvent(new Event('sessions-reload')); showToast(r.addedCount != null ? `${r.addedCount}개 세션 가져옴 (총 ${r.totalParsed}개 중)` : '세션을 가져왔습니다.'); } } },
        { separator: true, label: '' },
        { label: '종료', action: () => window.close() },
      ],
    },
    {
      label: '편집',
      items: [
        { label: '복사', shortcut: 'Ctrl+Shift+C', action: () => document.execCommand('copy') },
        { label: '붙여넣기', shortcut: 'Ctrl+Shift+V', action: () => { navigator.clipboard.readText().then(text => { const tid = getActiveTermId(); if (!tid) return; pasteToTerm(tid, text); }); } },
        { separator: true, label: '' },
        { label: '찾기', shortcut: 'Ctrl+Shift+F', action: () => setShowSearch(true) },
      ],
    },
    {
      label: '보기',
      items: [
        {
          label: '테마',
          submenu: getThemeList().map(t => ({
            label: t,
            action: () => handleThemeChange(t),
          })),
        },
        { separator: true, label: '' },
        { label: '글꼴 크기 +', shortcut: 'Ctrl+휠 위', action: () => applyFontToAll(undefined, (Number(localStorage.getItem('terminalFontSize')) || 14) + 1) },
        { label: '글꼴 크기 -', shortcut: 'Ctrl+휠 아래', action: () => applyFontToAll(undefined, Math.max(8, (Number(localStorage.getItem('terminalFontSize')) || 14) - 1)) },
      ],
    },
    {
      label: '창',
      items: [
        { label: '세로 분할', action: () => { if (activeTab && selectedPanelId) openSplitSessionPicker('row', selectedPanelId); }, disabled: !selectedPanelId },
        { label: '가로 분할', action: () => { if (activeTab && selectedPanelId) openSplitSessionPicker('column', selectedPanelId); }, disabled: !selectedPanelId },
        { separator: true, label: '' },
        { label: '화면 지우기', shortcut: 'Ctrl+Shift+L', action: () => { const tid = getActiveTermId(); if (tid) clearScreenInTerm(tid); } },
        { label: '스크롤 버퍼 지우기', shortcut: 'Ctrl+Shift+B', action: () => { const tid = getActiveTermId(); if (tid) clearScrollbackInTerm(tid); } },
        { label: '모두 지우기', shortcut: 'Ctrl+Shift+A', action: () => { const tid = getActiveTermId(); if (tid) clearAllInTerm(tid); } },
      ],
    },
    {
      label: '도구',
      items: [
        { label: '📁 파일 전송', action: () => {
          const id = `tab-fe-${Date.now()}`;
          setTabs(prev => [...prev, { id, title: '📁 파일 전송', layout: createInitialLayout(id), type: 'fileExplorer' }]);
          setActiveTabId(id);
        }},
        { separator: true, label: '' },
        { label: showQuickConnect ? '⚡ 빠른 연결 바 숨기기' : '⚡ 빠른 연결 바 표시', action: () => setShowQuickConnect(v => !v) },
        { label: showClaudeChat ? '🤖 Claude 채팅 숨기기' : '🤖 Claude 채팅 표시', action: () => setShowClaudeChat(v => !v) },
        { label: showBroadcast ? '📢 텍스트 일괄 전송 바 숨기기' : '📢 텍스트 일괄 전송 바 표시', action: () => { setShowBroadcast(v => !v); } },
        { separator: true, label: '' },
        { label: '옵션...', action: async () => {
          setWordSepValue(getWordSeparator());
          setTermSettings(getTerminalSettings());
          setOptFontFamily(localStorage.getItem('terminalFontFamily') || '');
          setOptFontSize(Number(localStorage.getItem('terminalFontSize')) || 14);
          setOptDefaultShellPath(defaultShell.path);
          (window as any).api?.checkContextMenu?.().then((v: boolean) => setContextMenuRegistered(v)).catch(() => {});
          // 시스템 고정폭 폰트 감지
          const monoFonts = [
            'Cascadia Mono', 'Cascadia Code', 'Consolas', 'Courier New',
            'D2Coding', 'D2Coding ligature', 'D2CodingLigature',
            'Fira Code', 'Fira Mono', 'JetBrains Mono',
            'Source Code Pro', 'Ubuntu Mono', 'IBM Plex Mono',
            'Hack', 'Inconsolata', 'Monaco', 'Menlo',
            'Noto Sans Mono', 'Roboto Mono', 'SF Mono',
            'NanumGothicCoding', 'Malgun Gothic',
            'Lucida Console', 'DejaVu Sans Mono',
          ];
          const detected: string[] = [];
          for (const f of monoFonts) {
            try { if (document.fonts.check(`12px "${f}"`)) detected.push(f); } catch {}
          }
          setAvailableFonts(detected);
          setOptionsTab('terminal');
          setKeybindingsDraft({ ...keybindingsState });
          try { const p = await (window as any).api.getSessionsPath(); setSessionsPathDisplay(p || ''); } catch {}
          setShowOptions(true);
        } },
      ],
    },
    {
      label: '도움말',
      items: [
        { label: '📖 매뉴얼...', action: () => setShowManual(true) },
        { separator: true, label: '' },
        { label: '단축키 목록', action: () => {
          const kb = getKeybindings();
          const lines = Object.keys(KEYBINDING_LABELS).map(id => `${kb[id] || '(없음)'} — ${KEYBINDING_LABELS[id]}`);
          alert(
            '── 사용자 지정 단축키 ──\n' +
            lines.join('\n') +
            '\n\n── 고정 단축키 ──\n' +
            'Alt+1~9 — 미니탭 전환\n' +
            'Alt+Enter — 현재 터미널 전체화면 토글\n' +
            'Ctrl+L — 스크롤 맨 아래로\n' +
            'Ctrl+마우스 휠 — 글꼴 크기 조절\n' +
            'F2 — 이름 변경\n' +
            '가운데 클릭 — 탭 닫기\n' +
            'Ctrl+↑/↓ — 세션/폴더 순서 이동\n\n' +
            '── 미니탭 ──\n' +
            '∨ 버튼 — 쉘 선택 (PowerShell, CMD, Git Bash 등)\n' +
            '우클릭 — 이름 변경 / 세션 복제 / 닫기\n' +
            '휠 스크롤 — 좌우 스크롤 (‹ › 버튼)\n\n' +
            '── 터미널 ──\n' +
            '우클릭 — 복사 / 붙여넣기 / 글꼴 / 인코딩 / 화면 지우기 등\n' +
            '더블클릭 (세션) — 연결\n\n' +
            '── 파일 트리 / 원격 편집 ──\n' +
            '파일 더블클릭 — 에디터 탭에서 열기\n' +
            'Ctrl+클릭 / Shift+클릭 — 다중 선택 (일괄 다운로드)\n' +
            '우클릭 — Claude 에 첨부 / 경로 복사 / 삭제\n' +
            '🔄 — 현재 경로 새로고침\n' +
            '📌 — 파일트리 고정/자동숨김 토글\n' +
            '좌측 경계 드래그 — 너비 조절\n' +
            'Ctrl+S (에디터) — 저장\n\n' +
            '── Claude 채팅 ──\n' +
            '오른쪽 가장자리 🤖 Claude 영역 hover — 사이드바 펼침 (unpin 모드)\n' +
            '📌 — 사이드바 고정/자동숨김 토글\n' +
            '좌측 경계 드래그 — 너비 조절 (더블클릭 = 기본값)\n' +
            '/ 버튼 — 슬래시 명령 팔레트 (↑↓ 탐색, Enter 실행, Esc 닫기)\n' +
            '📄+ / 📁+ — 로컬 파일 / 폴더 첨부\n' +
            'Ctrl+Wheel — 채팅 폰트 크기 조절\n' +
            'Enter (입력창) — 전송, Shift+Enter — 줄바꿈\n' +
            '🗑 — 대화 + 컨텍스트 초기화\n\n' +
            '── 일괄 전송 ──\n' +
            'Enter — 텍스트 전송\n' +
            'Ctrl+C / Ctrl+D — ^C / ^D 신호 전송\n' +
            '↑/↓ — 히스토리 탐색 / 세션 드롭다운\n' +
            'Esc — 히스토리 드롭다운만 닫음 (바는 유지)\n\n' +
            '── 빠른 연결 바 ──\n' +
            'Enter — 연결\n' +
            'Esc — 무시 (닫기는 ✕ 버튼으로만)'
          );
        }},
        { separator: true, label: '' },
        { label: 'PePe Terminal(SSH) 정보', action: async () => {
          let sessPath = '';
          try { sessPath = await (window as any).api.getSessionsPath(); } catch {}
          alert(
          'PePe Terminal(SSH) v2.0.5\n\n' +
          '만든이: Claude (feat. ghjeong[prompt], HyungdukSeo)\n\n' +
          '── 터미널 기본 ──\n' +
          'SSH/SFTP 원격 접속 (비밀번호/키/Expect-Send 로그인)\n' +
          'ProxyJump — primary 호스트 경유 점프 타겟 SSH+SFTP 직결\n' +
          '로컬 쉘 (PowerShell, CMD, Git Bash, WSL)\n' +
          '기본 쉘 설정 / 미니탭별 쉘 선택\n' +
          '테마 / 글꼴 / 인코딩(utf-8/cp949/euc-kr) 변경\n' +
          '자동 재연결 (30초), 초기 연결 watchdog (20초 × 3회 재시도)\n' +
          '터미널 투명도 (0~100 슬라이더) / 데스크톱 투시 / Alt+Enter 전체화면\n\n' +
          '── 워크스페이스 / 패널 ──\n' +
          '다중 워크스페이스 탭\n' +
          '분할 패널 (가로/세로/타일 ⊞ N×ceil√N)\n' +
          '플로팅 확대 (패널 전체화면 오버레이)\n' +
          '패널별 미니탭, 탭 간 드래그앤드롭\n' +
          '미니탭 휠 스크롤 / ‹ › 버튼\n' +
          '탭별 선택 패널 기억 (재진입 시 자동 포커스)\n' +
          '선택된 패널 클릭 포커스 → 파일트리/Claude 컨텍스트 자동 전환\n\n' +
          '── 세션 관리 ──\n' +
          '폴더 + 세션 혼합 정렬 (Ctrl+↑/↓ 이동, 다중 선택)\n' +
          'Shift+클릭 범위 선택 / Ctrl+클릭 다중 선택\n' +
          '세션 가져오기/내보내기 (SecureCRT, Xshell)\n' +
          '세션 재클릭으로 encoding 창 토글\n' +
          'host:port 호버 플로팅 툴팁\n' +
          '폴더 펼침/접힘 상태 영속화 (앱 재시작 후 유지)\n' +
          '세션 편집:\n' +
          '  - 파일트리 초기 경로 지정\n' +
          '  - ProxyJump 점프 호스트 설정\n' +
          '  - 파일트리 자동추적 옵션 (cd 시 동기화)\n' +
          '  - 로그인 스크립트 (Expect/Send)\n\n' +
          '── 원격 파일 탐색/편집 (VS Code Remote 스타일) ──\n' +
          '워크스페이스 공유 파일 트리 (선택된 패널 세션 기준)\n' +
          '파일트리 핀/자동숨김 (📌 토글)\n' +
          '파일트리 너비 드래그 리사이즈 (160~800px)\n' +
          'SFTP 목록, mtime 정렬, 확장자별 색상/아이콘 (15+ 카테고리)\n' +
          '다중 선택 (Ctrl/Shift+클릭) + 일괄 다운로드\n' +
          '우클릭 메뉴: 파일 열기 / Claude 첨부 / 경로 복사 / 삭제\n' +
          'Monaco 에디터 탭 (구문강조, Ctrl+S 저장)\n' +
          '듀얼 패널 파일 탐색기 (SFTP/로컬 양방향) + ProxyJump 지원\n\n' +
          '── Claude Code 통합 ──\n' +
          '우측 Claude 채팅 사이드바 (핀/자동숨김, 드래그 리사이즈)\n' +
          '세션/파일트리/Claude 모두 unpin 시 z-index 마우스호버 우선\n' +
          'WebDAV 브리지 — 원격 SSH 를 로컬 UNC 로 실시간 마운트\n' +
          'Unix 경로 자동 UNC 번역 (/view/... → \\\\127.0.0.1@port\\...)\n' +
          'MCP ssh_exec — Claude 가 원격 SSH 명령 실행 (cleartool 등)\n' +
          '모델 선택 (Opus / Sonnet / Haiku / Opus Plan)\n' +
          '권한 모드 (편집 전 확인 / 자동 수락 / 계획 / 모두 허용)\n' +
          'Plan 모드 + ExitPlanMode 승인 모달 (마크다운 + Mermaid 렌더)\n' +
          'PreToolUse hooks 기반 툴 단위 승인 (체크박스)\n' +
          '대화 세션 이어가기 (--resume) + stale 세션 자동 폴백\n' +
          '로컬 파일/폴더 첨부 (📄+ / 📁+ webkitdirectory 재귀)\n' +
          '슬래시 명령 팔레트 (Context/Model/Permission/Slash, 필터 + ↑↓ 네비)\n' +
          '툴 타임라인 실시간 인디케이터 (⏳/✓/✕)\n' +
          '채팅창 독립 폰트 설정 + Ctrl+Wheel 크기 조절\n' +
          '대화 이력 관리 (Pinned/Recents, 이름 변경, 핀 고정, 삭제)\n' +
          '대화 백그라운드 진행 — + 새 대화 시작해도 이전 대화 응답 계속 수신\n' +
          '대화 포크 (메시지 우클릭 → 여기서 포크하기, 이전 컨텍스트 transcript 자동 inject)\n' +
          '메시지 우클릭 메뉴 (텍스트/마크다운 복사, 컨텍스트 첨부, 포크)\n' +
          'Mermaid 다이어그램 자동 SVG 렌더 + 우클릭 PNG/SVG 저장·복사\n' +
          'GFM 테이블 자동 렌더 (탭 정렬 텍스트도 표로 자동 변환)\n' +
          'AskUserQuestion / ToolSearch 도구 차단 (비대화형 모드 안정성)\n' +
          'requestId 단위 프로세스 분리 — 다중 대화 동시 진행, 정확한 stop\n\n' +
          '── 입력/브로드캐스트 ──\n' +
          '텍스트 일괄 전송 (현재/보이는 탭/연결된 세션/전체 세션 lazy connect)\n' +
          '빠른 연결 바 (host/user/password/enc 즉석 접속)\n' +
          'Ctrl+C / Ctrl+D 브로드캐스트\n' +
          '브로드캐스트 히스토리 (↑↓ 네비)\n' +
          'Esc 로 바가 닫히지 않음 — 닫기는 ✕ 버튼으로만\n\n' +
          '── 찾기 / 검색 ──\n' +
          '터미널 찾기 (Ctrl+Shift+F), 이력, 하이라이트\n' +
          '이전 / 다음 네비게이션\n\n' +
          '── 설정 (옵션) ──\n' +
          '기본 로컬 쉘 선택\n' +
          '탐색기 우클릭 "Open here" 등록/해제\n' +
          '세션 저장 경로 변경\n' +
          '단축키 커스터마이즈\n' +
          '터미널 설정 (word separator, scrollback 등)\n' +
          '내부 매뉴얼 뷰어 (docs/MANUAL.md)\n\n' +
          '── Windows 시스템 연동 ──\n' +
          '윈도우 프레임 없음 / 투명 / 최대화-복원\n' +
          '탐색기 "Open here" → 워크스페이스 해당 디렉토리 쉘\n\n' +
          '── 기술 스택 ──\n' +
          'Electron + React + TypeScript + Vite\n' +
          'xterm.js (터미널), Monaco Editor (코드 편집)\n' +
          'node-pty (로컬 쉘), ssh2 (SSH/SFTP)\n' +
          'webdav-server (SFTP→WebDAV 프록시)\n' +
          'marked (Markdown), iconv-lite (인코딩)\n' +
          'Claude Code CLI (@anthropic-ai/claude-code)\n\n' +
          '── 세션 저장 경로 ──\n' +
          (sessPath || '(알 수 없음)')
        ); } },
      ],
    },
  ];

  return (
    <div
      className={`app-root${showBroadcast ? ' has-broadcast' : ''}${showQuickConnect ? ' has-quickconnect' : ''}${fullscreenTermId ? ' term-fullscreen' : ''}${showClaudeChat && claudeChatPinned ? ' has-claude-pinned' : ''}${showClaudeChat && !claudeChatPinned ? ' has-claude-autohide' : ''}${topPanel ? ' top-panel-' + topPanel : ''}`}
      onMouseMove={e => {
        // 세션/파일트리 모두 unpinned 상태에서 마우스 위치에 따라 topPanel 전환
        const t = e.target as HTMLElement | null;
        if (!t || !t.closest) return;
        if (t.closest('.session-sidebar-inner, .session-sidebar-trigger')) {
          if (topPanel !== 'session') setTopPanel('session');
        } else if (t.closest('.workspace-file-tree, .workspace-file-tree-trigger')) {
          if (topPanel !== 'filetree') setTopPanel('filetree');
        }
      }}
      data-fs-term={fullscreenTermId || ''}
      style={{ ['--claude-chat-width' as any]: `${claudeChatWidth}px` }}
    >
      <SessionList
        onConnect={(sid, name, panelId, sessTheme, ff, fs, sb) => handleConnectSession(sid, name, panelId, sessTheme, ff, fs, sb)}
        onMultiConnect={(sessList, mode) => {
          if (!activeTab || sessList.length === 0) return;
          const panelId = selectedPanelId || findFirstLeafId(activeTab.layout);
          if (!panelId) return;
          if (mode === 'minitab') {
            // 한 번의 layout 업데이트로 모든 세션을 미니탭에 추가
            const newTermIds: string[] = [];
            updateLayout(activeTab.id, layout => {
              let current = layout;
              for (const s of sessList) {
                const result = addSessionToPanel(current, panelId, s.id, s.name);
                newTermIds.push(result.termId);
                current = result.layout;
              }
              return current;
            });
            // 모든 세션 동시 연결 + 테마/폰트 적용
            setTimeout(() => {
              for (let i = 0; i < sessList.length; i++) {
                const s = sessList[i] as any;
                const tid = newTermIds[i];
                if (s.scrollback) applyScrollbackToTerm(tid, s.scrollback);
                setTimeout(() => {
                  if (s.theme) applyThemeToTerm(tid, s.theme);
                  if (s.fontFamily || s.fontSize) applyFontToTerm(tid, s.fontFamily, s.fontSize);
                }, 200);
                registerTermSession(tid, s.id, s.name, s.host ?? '');
                // sshd MaxStartups(기본 10:30:60) 초과 drop 방지 — 500ms 엇갈림으로 connect
                setTimeout(() => {
                  startInitialConnectWatchdog(tid, s.id);
                  window.api?.connectSSH?.(tid, s.id)?.then((r: string) => {
                    if (r === 'need-password') promptPasswordAndConnect(tid, s.id);
                  }).catch(() => {});
                }, i * 500);
              }
              // refit + 첫 세션으로 포커스 고정 (동시 연결 시 마지막 연결 세션이 포커스 훔치는 현상 방지)
              setTimeout(() => { refitAllTerms(); if (newTermIds[0]) focusTerm(newTermIds[0]); }, 200);
            }, 50);
          } else if (mode === 'split-tile') {
            // 타일 분할: N 개 세션을 ceil(sqrt(N)) 열 × ceil(N/cols) 행 그리드로 배치
            const newTermIds = sessList.map(() => `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
            const panelSessions: PanelSession[] = sessList.map((s, i) => ({
              termId: newTermIds[i],
              sessionId: s.id,
              sessionName: s.name,
            }));
            updateLayout(activeTab.id, layout =>
              addSessionsAsTile(layout, panelId, panelSessions[0], panelSessions.slice(1))
            );
            setTimeout(() => {
              for (let i = 0; i < sessList.length; i++) {
                const s = sessList[i] as any;
                const tid = newTermIds[i];
                if (s.scrollback) applyScrollbackToTerm(tid, s.scrollback);
                setTimeout(() => {
                  if (s.theme) applyThemeToTerm(tid, s.theme);
                  if (s.fontFamily || s.fontSize) applyFontToTerm(tid, s.fontFamily, s.fontSize);
                }, 200);
                registerTermSession(tid, s.id, s.name, s.host ?? '');
                // sshd MaxStartups(기본 10:30:60) 초과 drop 방지 — 500ms 엇갈림으로 connect
                setTimeout(() => {
                  startInitialConnectWatchdog(tid, s.id);
                  window.api?.connectSSH?.(tid, s.id)?.then((r: string) => {
                    if (r === 'need-password') promptPasswordAndConnect(tid, s.id);
                  }).catch(() => {});
                }, i * 500);
              }
              // refit + 첫 세션 포커스 — stagger 전체가 끝난 뒤 포커스 확정 (뒤늦게 마운트되는 터미널이 훔쳐가는 것 방지)
              const focusDelay = 200 + sessList.length * 500 + 300;
              setTimeout(() => { refitAllTerms(); if (newTermIds[0]) focusTerm(newTermIds[0]); }, focusDelay);
            }, 50);
          } else {
            const dir: 'row' | 'column' = mode === 'split-v' ? 'row' : 'column';
            // 모든 세션의 termId를 미리 생성
            const newTermIds = sessList.map(() => `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
            // 첫 번째는 현재 패널에 세션 추가, 나머지는 분할 패널 생성 — 한 번의 layout 업데이트로 처리
            updateLayout(activeTab.id, layout => {
              // 첫 번째 세션을 현재 패널에 추가
              const result = addSessionToPanel(layout, panelId, sessList[0].id, sessList[0].name);
              // 첫 번째 세션의 termId를 교체
              const replaceTermId = (node: LayoutNode): LayoutNode => {
                if (node.type === 'leaf') {
                  const sessions = node.panel.sessions.map(s => s.termId === result.termId ? { ...s, termId: newTermIds[0] } : s);
                  return { ...node, panel: { ...node.panel, sessions } };
                }
                return { ...node, children: node.children.map(replaceTermId) };
              };
              let currentLayout = replaceTermId(result.layout);
              // 나머지 세션은 분할로 추가
              let lastPanelId = panelId;
              for (let i = 1; i < sessList.length; i++) {
                const newSess: PanelSession = { termId: newTermIds[i], sessionId: sessList[i].id, sessionName: sessList[i].name };
                currentLayout = splitNodeWithSessions(currentLayout, lastPanelId, dir, [newSess], false);
              }
              return currentLayout;
            });
            // 모든 세션 동시 연결 + 테마/폰트 적용
            setTimeout(() => {
              for (let i = 0; i < sessList.length; i++) {
                const s = sessList[i] as any;
                const tid = newTermIds[i];
                if (s.scrollback) applyScrollbackToTerm(tid, s.scrollback);
                setTimeout(() => {
                  if (s.theme) applyThemeToTerm(tid, s.theme);
                  if (s.fontFamily || s.fontSize) applyFontToTerm(tid, s.fontFamily, s.fontSize);
                }, 200);
                registerTermSession(tid, s.id, s.name, s.host ?? '');
                // sshd MaxStartups(기본 10:30:60) 초과 drop 방지 — 500ms 엇갈림으로 connect
                setTimeout(() => {
                  startInitialConnectWatchdog(tid, s.id);
                  window.api?.connectSSH?.(tid, s.id)?.then((r: string) => {
                    if (r === 'need-password') promptPasswordAndConnect(tid, s.id);
                  }).catch(() => {});
                }, i * 500);
              }
              // refit + 첫 세션 포커스 — stagger 전체가 끝난 뒤 포커스 확정 (뒤늦게 마운트되는 터미널이 훔쳐가는 것 방지)
              const focusDelay = 200 + sessList.length * 500 + 300;
              setTimeout(() => { refitAllTerms(); if (newTermIds[0]) focusTerm(newTermIds[0]); }, focusDelay);
            }, 50);
          }
        }}
        onDisconnect={panelId => handleDisconnectSession(panelId)}
        targetPanelId={selectedPanelId}
        onFileTransfer={async (sessionId, sessionName) => {
          // 파일 전송 탭이 없으면 생성
          let feTab = tabs.find(t => t.type === 'fileExplorer');
          if (!feTab) {
            const id = `tab-fe-${Date.now()}`;
            feTab = { id, title: '📁 파일 전송', layout: createInitialLayout(id), type: 'fileExplorer' };
            setTabs(prev => [...prev, feTab!]);
          }
          setActiveTabId(feTab.id);
          // SFTP 연결 — 점프 타겟 설정돼 있으면 ProxyJump 로 내부 서버까지 직결
          try {
            const data = await (window as any).api.listSessions();
            const allSessions = data?.sessions ?? data ?? [];
            const sess = allSessions.find((s: any) => s.id === sessionId);
            if (!sess) return;
            console.log('[fe-transfer] selected session:', { name: sess.name, host: sess.host, jumpTargetHost: sess.jumpTargetHost, jumpTargetUser: sess.jumpTargetUser });
            const connId = `sftp-fe-${Date.now()}`;
            const jumpOpts = sess.jumpTargetHost?.trim()
              ? { host: sess.jumpTargetHost.trim(), user: sess.jumpTargetUser || 'root', port: Number(sess.jumpTargetPort) || 22, password: sess.jumpTargetPassword || undefined }
              : undefined;
            const displayHost = jumpOpts ? jumpOpts.host : sess.host;
            const result = await (window as any).api.feSftpConnect?.(connId, sess.host, sess.port || 22, sess.username, sess.auth, jumpOpts);
            if (result?.success) {
              window.dispatchEvent(new CustomEvent('fe-sftp-connected', { detail: { connId, sessionName, host: displayHost } }));
            } else {
              const msg = result?.error || '알 수 없는 오류';
              console.error('[fe-sftp-connect] failed:', msg);
              alert(`파일 전송 연결 실패 (${sessionName})\n\n${msg}\n\nDevTools Console 에 [sftp-connect] 로그 확인 권장.`);
            }
          } catch (err: any) {
            console.error('[fe-sftp-connect] exception:', err);
            alert(`파일 전송 연결 예외: ${err?.message || err}`);
          }
        }}
      />
      {/* 파일 트리는 이제 각 TerminalPanel 내부에서 mini-tab 별로 렌더링됨 (Ctrl+Shift+E 로 토글). */}
      <div className="app-main">
        <div className="tab-bar-row">
          <MenuBar menus={menuDefs} />
          <TabBar tabs={tabs} activeTabId={activeTabId} onChange={setActiveTabId} onAddTab={addTab} onCloseTab={closeTab} onRenameTab={renameTab}
          hasSession={tabs.reduce((acc, t) => { acc[t.id] = collectAllSessions(t.layout).length > 0; return acc; }, {} as Record<string, boolean>)}
          availableShells={availableShells}
        />
          <div className="titlebar-drag-area"
            onDoubleClick={() => {
              (window as any).api?.windowEndDrag?.();
              (window as any).api?.windowToggleMaximize?.();
              [50, 200, 500].forEach(ms => setTimeout(() => { window.dispatchEvent(new Event('resize')); refitAllTerms(); }, ms));
            }}
            onMouseDown={e => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.stopPropagation();
              const api = (window as any).api;
              api?.windowStartDrag?.(e.screenX, e.screenY);
              const onMove = (ev: MouseEvent) => { ev.preventDefault(); api?.windowDragMove?.(ev.screenX, ev.screenY); };
              const onUp = () => {
                api?.windowEndDrag?.();
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
              };
              window.addEventListener('mousemove', onMove);
              window.addEventListener('mouseup', onUp);
            }}
          />
          <div className="window-controls-right">
            <select className="theme-select" value={themeName} onChange={e => handleThemeChange(e.target.value)}>
              {getThemeList().map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <button className="window-ctrl-btn" onClick={() => (window as any).api?.windowMinimize?.()}>─</button>
            <button
              className="window-ctrl-btn"
              onClick={() => { (window as any).api?.windowToggleMaximize?.(); [50, 200, 500].forEach(ms => setTimeout(() => { window.dispatchEvent(new Event('resize')); refitAllTerms(); }, ms)); }}
              title={isMaximized ? '복원' : '최대화'}
            >{isMaximized ? '❐' : '☐'}</button>
            <button className="window-ctrl-btn close" onClick={() => (window as any).api?.windowClose?.()}>✕</button>
          </div>
        </div>

        {showQuickConnect && (
          <QuickConnectBar
            onConnect={handleQuickConnect}
            onCancel={() => setShowQuickConnect(false)}
            forceProtocol={activeTab?.type === 'fileExplorer' ? 'sftp' : undefined}
          />
        )}

        {showSearch && activeTab && (
          <SearchBar
            tabs={tabs}
            activeTab={activeTab}
            selectedPanelId={selectedPanelId}
            onClose={() => setShowSearch(false)}
          />
        )}

        {/* FileExplorer는 탭이 존재하면 항상 마운트 유지 (경로 상태 보존). 비활성 시 CSS로 숨김 */}
        {tabs.some(t => t.type === 'fileExplorer') && (
          <div style={{ display: activeTab?.type === 'fileExplorer' ? 'flex' : 'none', flex: 1, minHeight: 0 }}>
            <FileExplorer sessions={
              tabs.filter(t => t.type !== 'fileExplorer').flatMap(t => collectAllSessions(t.layout)).filter(s => s.sessionId)
            } />
          </div>
        )}

        {/* FileEditor 탭들 - 마운트 유지 */}
        {tabs.filter(t => t.type === 'fileEditor' && t.editor).map(t => (
          <div key={t.id} style={{ display: activeTab?.id === t.id ? 'flex' : 'none', flex: 1, minHeight: 0 }}>
            <FileEditor
              termId={t.editor!.termId}
              remotePath={t.editor!.remotePath}
              fileName={t.editor!.fileName}
              onAnalyzeWithClaude={(ctx) => {
                setClaudeFileContext([ctx]);
                setShowClaudeChat(true);
              }}
            />
          </div>
        ))}

        {activeTab && activeTab.type !== 'fileExplorer' && activeTab.type !== 'fileEditor' && (() => {
          // 워크스페이스 레벨 파일 트리 — 선택된 패널의 활성 세션이 SSH 연결이면 표시
          let fileTreeNode: React.ReactNode = null;
          if (selectedPanelId) {
            const findLeaf = (n: any, id: string): any => {
              if (n.type === 'leaf') return n.id === id ? n : null;
              for (const c of n.children) { const r = findLeaf(c, id); if (r) return r; }
              return null;
            };
            const leaf = findLeaf(activeTab.layout, selectedPanelId);
            const sess = leaf?.panel?.sessions[leaf.panel.activeIdx];
            if (sess?.sessionId && isTermConnected(sess.termId)) {
              const onEnterTrigger = () => {
                if (remoteTreePinned) return;
                if (remoteTreeHideTimer.current) { clearTimeout(remoteTreeHideTimer.current); remoteTreeHideTimer.current = null; }
                setRemoteTreeVisible(true);
                setTopPanel('filetree');
              };
              const onEnterTree = () => {
                if (remoteTreePinned) return;
                if (remoteTreeHideTimer.current) { clearTimeout(remoteTreeHideTimer.current); remoteTreeHideTimer.current = null; }
                setTopPanel('filetree');
              };
              const onLeaveTree = () => {
                if (remoteTreePinned) return;
                if (remoteTreeHideTimer.current) clearTimeout(remoteTreeHideTimer.current);
                remoteTreeHideTimer.current = setTimeout(() => setRemoteTreeVisible(false), 500);
              };
              const onLeaveTrigger = () => {
                if (remoteTreePinned) return;
                if (remoteTreeHideTimer.current) clearTimeout(remoteTreeHideTimer.current);
                remoteTreeHideTimer.current = setTimeout(() => setRemoteTreeVisible(false), 500);
              };
              fileTreeNode = (
                <>
                  {!remoteTreePinned && (
                    <div
                      className="workspace-file-tree-trigger"
                      style={{ ['--file-tree-trigger-top' as any]: `${fileTreeTriggerTop}px` }}
                    >
                      <div className="workspace-file-tree-trigger-top" onMouseEnter={onEnterTrigger} onMouseLeave={onLeaveTrigger}>
                        <span className="workspace-file-tree-trigger-text">📁 파일 트리</span>
                      </div>
                      <div className="workspace-file-tree-trigger-bottom" />
                    </div>
                  )}
                  <div
                    className={`workspace-file-tree ${!remoteTreePinned ? 'auto-hide' : ''} ${!remoteTreePinned && !remoteTreeVisible ? 'hidden' : ''} ${topPanel === 'filetree' ? 'top' : ''}`}
                    style={{ width: `${remoteTreeWidth}px`, flexShrink: 0 }}
                    onMouseEnter={onEnterTree}
                    onMouseLeave={onLeaveTree}
                  >
                    <div className="workspace-file-tree-toolbar">
                      <button
                        className={`workspace-file-tree-pin ${remoteTreePinned ? 'pinned' : ''}`}
                        onClick={() => setRemoteTreePinned(p => !p)}
                        title={remoteTreePinned ? 'Unpin (자동 숨김)' : 'Pin (고정)'}
                      >📌</button>
                    </div>
                    <RemoteFileTree
                      key={sess.termId}
                      termId={sess.termId}
                      sessionName={sess.sessionName}
                      sessionId={sess.sessionId}
                      initialPath={getCurrentPwdForTerm(sess.termId)}
                      onOpenFile={handleOpenRemoteFile}
                      onAttachToClaude={handleAttachToClaude}
                    />
                    <div
                      className="workspace-file-tree-resizer"
                      title="드래그하여 너비 조절 (더블클릭: 기본값 240)"
                      onMouseDown={e => {
                        e.preventDefault();
                        const startX = e.clientX;
                        const startWidth = remoteTreeWidth;
                        const onMove = (ev: MouseEvent) => {
                          const w = Math.max(160, Math.min(800, startWidth + (ev.clientX - startX)));
                          setRemoteTreeWidth(w);
                        };
                        const onUp = () => {
                          window.removeEventListener('mousemove', onMove);
                          window.removeEventListener('mouseup', onUp);
                          setRemoteTreeWidth(curW => {
                            if (remoteTreeWidthLoadedRef.current) { try { (window as any).api?.setUIPrefs?.({ remoteTreeWidth: curW }); } catch {} }
                            return curW;
                          });
                          window.dispatchEvent(new Event('resize'));
                        };
                        window.addEventListener('mousemove', onMove);
                        window.addEventListener('mouseup', onUp);
                      }}
                      onDoubleClick={() => {
                        setRemoteTreeWidth(240);
                        try { (window as any).api?.setUIPrefs?.({ remoteTreeWidth: 240 }); } catch {}
                      }}
                    />
                  </div>
                </>
              );
            }
          }
          return (
            <div style={{ display: 'flex', flex: 1, minHeight: 0, position: 'relative' }}>
              {fileTreeNode}
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <Layout root={activeTab.layout}
            selectedPanelId={selectedPanelId}
            onSplit={(nodeId, dir) => openSplitSessionPicker(dir, nodeId)}
            onSplitWithPicker={(nodeId, dir) => openSplitSessionPickerWithPrompt(dir, nodeId)}
            onClose={nodeId => closePanel(activeTab.id, nodeId)}
            floatingPanelId={floatingPanelId}
            onToggleFloat={nodeId => {
              setFloatingPanelId(prev => prev === nodeId ? null : nodeId);
              setTimeout(() => { window.dispatchEvent(new Event('resize')); refitAllTerms(); }, 120);
            }}
            onSelectPanel={id => setSelectedPanelId(id)}
            onMovePanel={movePanel}
            onSwitchSession={handleSwitchSession}
            onCloseSession={handleCloseSession}
            onMoveSession={handleMoveSession}
            onSplitMoveSession={handleSplitMoveSession}
            onReorderSession={handleReorderSession}
            onAddSession={handleAddSession}
            onRenameSession={handleRenameSession}
            onConnectDrop={handleConnectDrop}
            onDuplicateSession={handleDuplicateSession}
            availableShells={availableShells}
            treeWidth={remoteTreeWidth}
            onTreeWidthChange={w => {
              setRemoteTreeWidth(w);
              if (remoteTreeWidthLoadedRef.current) { try { (window as any).api?.setUIPrefs?.({ remoteTreeWidth: w }); } catch {} }
            }}
            onOpenRemoteFile={handleOpenRemoteFile}
            onAttachToClaude={handleAttachToClaude}
          />
              </div>
            </div>
          );
        })()}
      </div>

      {showBroadcast && (
        <div className="broadcast-bar">
          <button className="broadcast-close" onClick={() => setShowBroadcast(false)} title="닫기">✕</button>
          <span className="broadcast-label" title="텍스트 일괄 전송">📢</span>
          <select
            className="broadcast-scope"
            value={broadcastScope}
            onChange={e => setBroadcastScope(e.target.value as any)}
            title="전송 대상"
          >
            <option value="visible">보이는 탭 ({collectBroadcastTargets('visible').length})</option>
            <option value="current">현재 세션 ({collectBroadcastTargets('current').length})</option>
            <option value="connected">연결된 세션 ({collectBroadcastTargets('connected').length})</option>
          </select>
          <div style={{ position: 'relative', flex: 1, display: 'flex' }}>
            <input
              className="broadcast-input"
              autoFocus
              value={broadcastText}
              onChange={e => { setBroadcastText(e.target.value); setBroadcastShowHistory(false); }}
              onBlur={() => setTimeout(() => setBroadcastShowHistory(false), 150)}
              onKeyDown={e => {
                if (e.key === 'Escape') {
                  // Esc 는 히스토리 드롭다운만 닫고 바 자체는 유지 — 닫기는 ✕ 버튼으로만
                  if (broadcastShowHistory) { e.preventDefault(); setBroadcastShowHistory(false); }
                  return;
                }
                if (e.key === 'ArrowDown' && !broadcastShowHistory) {
                  if (broadcastHistory.length > 0) { e.preventDefault(); setBroadcastShowHistory(true); setBroadcastHistoryIdx(0); setBroadcastText(broadcastHistory[0]); }
                  return;
                }
                if (e.key === 'ArrowDown' && broadcastShowHistory) {
                  e.preventDefault();
                  const next = Math.min(broadcastHistoryIdx + 1, broadcastHistory.length - 1);
                  setBroadcastHistoryIdx(next); setBroadcastText(broadcastHistory[next]);
                  return;
                }
                if (e.key === 'ArrowUp' && broadcastShowHistory) {
                  e.preventDefault();
                  const prev = Math.max(broadcastHistoryIdx - 1, 0);
                  setBroadcastHistoryIdx(prev); setBroadcastText(broadcastHistory[prev]);
                  return;
                }
                if (e.key === 'Enter') { e.preventDefault(); setBroadcastShowHistory(false); sendBroadcast(broadcastScope, undefined, { keepFocusOnInput: true }); return; }
                if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
                  if (e.key === 'c' || e.key === 'C') {
                    const inp = e.currentTarget as HTMLInputElement;
                    if (inp.selectionStart !== inp.selectionEnd) return;
                    e.preventDefault();
                    sendBroadcast(broadcastScope, { raw: '\x03', label: '^C' }, { keepFocusOnInput: true });
                  } else if (e.key === 'd' || e.key === 'D') {
                    e.preventDefault();
                    sendBroadcast(broadcastScope, { raw: '\x04', label: '^D' }, { keepFocusOnInput: true });
                  }
                }
              }}
              placeholder="전송할 텍스트 (Enter 전송, Ctrl+C/^C, Ctrl+D/^D)"
              style={{ flex: 1, borderRadius: '4px 0 0 4px' }}
            />
            <button
              className="broadcast-history-toggle"
              onMouseDown={e => e.preventDefault()}
              onClick={() => { setBroadcastShowHistory(v => !v); setBroadcastHistoryIdx(-1); }}
              title="전송 이력"
            >▾</button>
            {broadcastShowHistory && broadcastHistory.length > 0 && (
              <div className="broadcast-history-dropdown">
                {broadcastHistory.map((h, i) => (
                  <div key={`${h}-${i}`}
                    className={`broadcast-history-item ${i === broadcastHistoryIdx ? 'active' : ''}`}
                    onMouseDown={e => { e.preventDefault(); setBroadcastText(h); setBroadcastShowHistory(false); }}
                  >{h}</div>
                ))}
              </div>
            )}
          </div>
          <label className="broadcast-chk" title="끝에 개행(Enter) 추가">
            <input type="checkbox" checked={broadcastAppendNewline} onChange={e => setBroadcastAppendNewline(e.target.checked)} />
            <span>↵</span>
          </label>
          <button className="broadcast-btn" onClick={() => sendBroadcast(broadcastScope)} title="텍스트 전송 (Enter)">전송</button>
          <button className="broadcast-btn" onClick={() => { setBcastXferFiles([]); setBcastXferPath(''); setBcastXferLog([]); setShowBcastFileXfer(true); }} title="여러 세션에 파일/폴더 일괄 업로드">📤 파일전송</button>
          <button className="broadcast-btn ctrl" onClick={() => sendBroadcast(broadcastScope, { raw: '\x1b[A', label: '↑' })} title="위 방향키 (이전 명령) 전송">↑</button>
          <button className="broadcast-btn ctrl" onClick={() => sendBroadcast(broadcastScope, { raw: '\x1b[B', label: '↓' })} title="아래 방향키 (다음 명령) 전송">↓</button>
          <button className="broadcast-btn ctrl" onClick={() => sendBroadcast(broadcastScope, { raw: '\x03', label: '^C' })} title="Ctrl+C (SIGINT) 전송">^C</button>
          <button className="broadcast-btn ctrl" onClick={() => sendBroadcast(broadcastScope, { raw: '\x04', label: '^D' })} title="Ctrl+D (EOF) 전송">^D</button>
          {broadcastNotice && (
            <span className={`broadcast-notice ${broadcastNotice.kind}`}>{broadcastNotice.text}</span>
          )}
        </div>
      )}

      <StatusBar activeTab={activeTab} selectedPanelId={selectedPanelId} tabs={tabs} />

      {showOptions && (
        <div className="session-editor-backdrop" onClick={() => setShowOptions(false)}>
          <div className="session-editor" onClick={e => e.stopPropagation()} style={{ width: 500 }}>
            <h3>옵션</h3>

            <div className="options-tabs">
              <button className={`options-tab ${optionsTab === 'terminal' ? 'active' : ''}`} onClick={() => setOptionsTab('terminal')}>터미널</button>
              <button className={`options-tab ${optionsTab === 'session' ? 'active' : ''}`} onClick={() => setOptionsTab('session')}>세션</button>
              <button className={`options-tab ${optionsTab === 'keybindings' ? 'active' : ''}`} onClick={() => setOptionsTab('keybindings')}>단축키</button>
            </div>

            {optionsTab === 'terminal' && (
              <div className="options-content">
                <div style={{ marginBottom: 16 }}>
                  <div style={{ color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>클립보드</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <label className="settings-checkbox">
                      <input type="checkbox" checked={termSettings.autoCopyOnSelect}
                        onChange={e => setTermSettings(s => ({ ...s, autoCopyOnSelect: e.target.checked }))} />
                      <span>선택한 텍스트를 자동으로 클립보드에 복사</span>
                    </label>
                    <label className="settings-checkbox">
                      <input type="checkbox" checked={termSettings.includeTrailingNewline}
                        onChange={e => setTermSettings(s => ({ ...s, includeTrailingNewline: e.target.checked }))} />
                      <span>선택 영역 복사 시 마지막 줄 바꿈 문자 포함</span>
                    </label>
                    <label className="settings-checkbox">
                      <input type="checkbox" checked={termSettings.trimTrailingWhitespace}
                        onChange={e => setTermSettings(s => ({ ...s, trimTrailingWhitespace: e.target.checked }))} />
                      <span>복사 시 문자 뒤의 공백 제거하기</span>
                    </label>
                  </div>
                </div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>붙여넣기</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ color: '#aaa', fontSize: 12, marginBottom: 2 }}>여러 줄을 붙여넣는 경우:</div>
                    <label className="settings-radio">
                      <input type="radio" name="multiLinePaste" checked={termSettings.multiLinePaste === 'dialog'}
                        onChange={() => setTermSettings(s => ({ ...s, multiLinePaste: 'dialog' }))} />
                      <span>여러 줄 붙여넣기 대화 상자 열기</span>
                    </label>
                    <label className="settings-radio">
                      <input type="radio" name="multiLinePaste" checked={termSettings.multiLinePaste === 'direct'}
                        onChange={() => setTermSettings(s => ({ ...s, multiLinePaste: 'direct' }))} />
                      <span>터미널에 바로 붙여넣기</span>
                    </label>
                  </div>
                </div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>글꼴</div>
                  <select
                    style={{ width: '100%', background: '#1a1a1a', color: '#eee', border: '1px solid #333', borderRadius: 4, padding: '8px', fontSize: 14, boxSizing: 'border-box', cursor: 'pointer' }}
                    value={optFontFamily}
                    onChange={e => setOptFontFamily(e.target.value)}
                  >
                    <option value="">기본 (Cascadia Mono)</option>
                    {availableFonts.map(f => <option key={f} value={f} style={{ fontFamily: `"${f}", monospace` }}>{f}</option>)}
                  </select>
                </div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>글꼴 크기</div>
                  <input
                    type="number"
                    min={8}
                    max={40}
                    step={1}
                    style={{ width: 100, background: '#1a1a1a', color: '#eee', border: '1px solid #333', borderRadius: 4, padding: '8px', fontSize: 14, fontFamily: 'monospace', boxSizing: 'border-box' }}
                    value={optFontSize}
                    onChange={e => setOptFontSize(Math.max(8, Math.min(40, Number(e.target.value) || 14)))}
                  />
                </div>
                <div style={{ marginBottom: 16, borderTop: '1px solid #333', paddingTop: 12 }}>
                  <div style={{ color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Claude 채팅창 글꼴</div>
                  <p style={{ color: '#888', fontSize: 12, margin: '0 0 6px' }}>터미널과 독립 설정. 채팅창에서 Ctrl+휠로도 크기 조절.</p>
                  <select
                    style={{ width: '100%', background: '#1a1a1a', color: '#eee', border: '1px solid #333', borderRadius: 4, padding: '8px', fontSize: 14, boxSizing: 'border-box', cursor: 'pointer' }}
                    value={claudeFontFamily}
                    onChange={e => { setClaudeFontFamily(e.target.value); setClaudeFontFamilyState(e.target.value); }}
                  >
                    <option value="">기본 (시스템 UI 폰트)</option>
                    {availableFonts.map(f => <option key={f} value={f} style={{ fontFamily: `"${f}", sans-serif` }}>{f}</option>)}
                  </select>
                </div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Claude 채팅창 글꼴 크기</div>
                  <input
                    type="number"
                    min={9}
                    max={32}
                    step={1}
                    style={{ width: 100, background: '#1a1a1a', color: '#eee', border: '1px solid #333', borderRadius: 4, padding: '8px', fontSize: 14, fontFamily: 'monospace', boxSizing: 'border-box' }}
                    value={claudeFontSize}
                    onChange={e => {
                      const v = Math.max(9, Math.min(32, Number(e.target.value) || 13));
                      setClaudeFontSize(v);
                      setClaudeFontSizeState(v);
                    }}
                  />
                </div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>스크롤백 버퍼(줄 수)</div>
                  <p style={{ color: '#888', fontSize: 12, margin: '0 0 6px' }}>터미널 세션이 보관할 과거 출력 라인 수 (기본: 10000)</p>
                  <input
                    type="number"
                    min={1000}
                    max={1000000}
                    step={1000}
                    style={{ width: 160, background: '#1a1a1a', color: '#eee', border: '1px solid #333', borderRadius: 4, padding: '8px', fontSize: 14, fontFamily: 'monospace', boxSizing: 'border-box' }}
                    value={termSettings.scrollback}
                    onChange={e => {
                      const v = Math.max(1000, Math.min(1000000, Number(e.target.value) || 0));
                      setTermSettings(s => ({ ...s, scrollback: v }));
                    }}
                  />
                </div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>기본 로컬 쉘</div>
                  <select
                    style={{ width: '100%', background: '#1a1a1a', color: '#eee', border: '1px solid #333', borderRadius: 4, padding: '8px', fontSize: 14, boxSizing: 'border-box', cursor: 'pointer' }}
                    value={optDefaultShellPath}
                    onChange={e => setOptDefaultShellPath(e.target.value)}
                  >
                    {availableShells.map(sh => <option key={sh.path} value={sh.path}>{sh.icon ? sh.icon + ' ' : ''}{sh.name}</option>)}
                  </select>
                </div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>단어 구분 기호</div>
                  <p style={{ color: '#888', fontSize: 12, margin: '0 0 6px' }}>더블클릭 시 단어 선택을 끊는 문자</p>
                  <input
                    style={{ width: '100%', background: '#1a1a1a', color: '#eee', border: '1px solid #333', borderRadius: 4, padding: '8px', fontSize: 14, fontFamily: 'monospace', boxSizing: 'border-box' }}
                    value={wordSepValue}
                    onChange={e => setWordSepValue(e.target.value)}
                  />
                </div>
              </div>
            )}

            {optionsTab === 'session' && (
              <div className="options-content">
                <div style={{ marginBottom: 16 }}>
                  <div style={{ color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>세션 저장 경로</div>
                  <div style={{ background: '#111', border: '1px solid #333', borderRadius: 4, padding: '8px 10px', fontSize: 12, fontFamily: 'monospace', color: '#aaa', wordBreak: 'break-all', marginBottom: 8 }}>
                    {sessionsPathDisplay || '(알 수 없음)'}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button className="btn-add" onClick={() => (window as any).api.openSessionsFolder()}>경로 열기</button>
                    <button className="btn-add" onClick={async () => {
                      const r = await (window as any).api.setSessionsPath();
                      if (r) { setSessionsPathDisplay(r.path); window.dispatchEvent(new Event('sessions-reload')); }
                    }}>경로 변경...</button>
                    <button className="btn-add" onClick={async () => {
                      const r = await (window as any).api.resetSessionsPath();
                      if (r) { setSessionsPathDisplay(r.path); window.dispatchEvent(new Event('sessions-reload')); }
                    }}>기본값으로 초기화</button>
                    <button className="btn-add" onClick={() => (window as any).api.openSessionsEditor()}>파일 편집</button>
                  </div>
                </div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>탐색기 우클릭 메뉴</div>
                  <p style={{ color: '#888', fontSize: 12, margin: '0 0 6px' }}>Windows 탐색기에서 우클릭 시 "Open PePe Terminal here" 메뉴를 표시합니다.</p>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn-add" onClick={async () => {
                      const r = await (window as any).api?.registerContextMenu?.();
                      if (r?.success) { setContextMenuRegistered(true); }
                    }}>등록</button>
                    <button className="btn-add" onClick={async () => {
                      const r = await (window as any).api?.unregisterContextMenu?.();
                      if (r?.success) { setContextMenuRegistered(false); }
                    }}>해제</button>
                    <span style={{ color: contextMenuRegistered ? '#4caf50' : '#888', fontSize: 12, alignSelf: 'center' }}>
                      {contextMenuRegistered ? '● 등록됨' : '○ 미등록'}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {optionsTab === 'keybindings' && (
              <div className="options-content">
                <div className="keybinding-list">
                  {Object.keys(DEFAULT_KEYBINDINGS).map(actionId => {
                    const draftCombo = keybindingsDraft[actionId] || DEFAULT_KEYBINDINGS[actionId];
                    const isListening = listeningAction === actionId;
                    return (
                      <div className="keybinding-row" key={actionId}>
                        <span className="keybinding-label">{KEYBINDING_LABELS[actionId] || actionId}</span>
                        <input
                          className={`keybinding-combo ${isListening ? 'listening' : ''}`}
                          readOnly
                          value={isListening ? '키를 누르세요...' : draftCombo}
                        />
                        <button className="keybinding-btn" onClick={() => setListeningAction(isListening ? null : actionId)}>
                          {isListening ? '취소' : '변경'}
                        </button>
                      </div>
                    );
                  })}
                </div>
                {keybindingWarning && (
                  <div className="keybinding-warning">⚠ {keybindingWarning}</div>
                )}
                <div className="keybinding-reset">
                  <button className="keybinding-btn" onClick={() => {
                    setKeybindingsDraft({});
                    setListeningAction(null);
                    setKeybindingWarning(null);
                  }}>초기화</button>
                </div>
              </div>
            )}

            <div className="session-editor-actions">
              <button className="btn-cancel" onClick={() => { setShowOptions(false); setListeningAction(null); }}>취소</button>
              <button className="btn-save" onClick={() => {
                saveTerminalSettings(termSettings);
                setWordSeparator(wordSepValue);
                applyScrollbackToAll(termSettings.scrollback);
                applyFontToAll(optFontFamily || undefined, optFontSize);
                // 기본 쉘 저장
                const selShell = availableShells.find(s => s.path === optDefaultShellPath);
                if (selShell) {
                  setDefaultShell({ name: selShell.name, path: selShell.path });
                  (window as any).api?.setUIPrefs?.({ defaultShellName: selShell.name, defaultShellPath: selShell.path });
                }
                // 단축키 저장 — draft를 실제로 반영
                setKeybindingsState(keybindingsDraft);
                loadKeybindings(keybindingsDraft);
                (window as any).api?.setUIPrefs?.({ keybindings: keybindingsDraft });
                setListeningAction(null);
                setShowOptions(false);
              }}>저장</button>
            </div>
          </div>
        </div>
      )}

      {sftpProgress && (
        <div className="sftp-progress-bar">
          <span className="sftp-progress-text">
            {sftpProgress.direction === 'download' ? '⬇' : '⬆'} {sftpProgress.filename}
          </span>
          <div className="sftp-progress-track">
            <div className="sftp-progress-fill" style={{ width: `${sftpProgress.total > 0 ? (sftpProgress.transferred / sftpProgress.total * 100) : 0}%` }} />
          </div>
          <span className="sftp-progress-pct">
            {sftpProgress.total > 0 ? Math.round(sftpProgress.transferred / sftpProgress.total * 100) : 0}%
          </span>
        </div>
      )}
      {showClaudeChat && (() => {
        // 모든 연결된 SSH 세션 수집 (panel.sessions 내의 termId 들)
        const connectedSessions: { termId: string; label: string }[] = [];
        const seen = new Set<string>();
        const walk = (n: any) => {
          if (n.type === 'leaf') {
            const sessions = n.panel?.sessions || [];
            for (const s of sessions) {
              if (s.termId && !seen.has(s.termId) && isTermConnected(s.termId)) {
                const info = getTermSessionInfo(s.termId);
                const label = info?.sessionName || s.sessionName || info?.host || s.termId;
                connectedSessions.push({ termId: s.termId, label });
                seen.add(s.termId);
              }
            }
          } else if (n.children) {
            for (const c of n.children) walk(c);
          }
        };
        for (const t of tabs) walk(t.layout);

        // 현재 선택된 패널의 activeTermId 가 연결된 SSH 세션이면 기본 우선
        let defaultSsh: { termId: string; label: string } | null = connectedSessions[0] || null;
        if (selectedPanelId && activeTab) {
          const findLeaf = (n: any, id: string): any => {
            if (n.type === 'leaf') return n.id === id ? n : null;
            for (const c of n.children) { const r = findLeaf(c, id); if (r) return r; }
            return null;
          };
          const leaf = findLeaf(activeTab.layout, selectedPanelId);
          if (leaf && leaf.panel) {
            const activeTerm = leaf.panel.activeTermId || leaf.panel.sessions?.[0]?.termId;
            if (activeTerm && isTermConnected(activeTerm)) {
              const info = getTermSessionInfo(activeTerm);
              const s = leaf.panel.sessions.find((x: any) => x.termId === activeTerm);
              defaultSsh = { termId: activeTerm, label: info?.sessionName || s?.sessionName || info?.host || activeTerm };
            }
          }
        }

        const onEnterTrigger = () => {
          if (claudeChatPinned) return;
          if (claudeChatHideTimer.current) { clearTimeout(claudeChatHideTimer.current); claudeChatHideTimer.current = null; }
          setClaudeChatVisible(true);
        };
        const onEnterSidebar = () => {
          if (claudeChatPinned) return;
          if (claudeChatHideTimer.current) { clearTimeout(claudeChatHideTimer.current); claudeChatHideTimer.current = null; }
        };
        const onLeaveSidebar = () => {
          if (claudeChatPinned) return;
          if (claudeChatHideTimer.current) clearTimeout(claudeChatHideTimer.current);
          claudeChatHideTimer.current = setTimeout(() => setClaudeChatVisible(false), 500);
        };
        const onLeaveTrigger = () => {
          if (claudeChatPinned) return;
          if (claudeChatHideTimer.current) clearTimeout(claudeChatHideTimer.current);
          claudeChatHideTimer.current = setTimeout(() => setClaudeChatVisible(false), 500);
        };
        return (
          <>
            {!claudeChatPinned && (
              <div className="claude-chat-sidebar-trigger">
                <div className="claude-chat-sidebar-trigger-top" onMouseEnter={onEnterTrigger} onMouseLeave={onLeaveTrigger}>
                  <span className="claude-chat-sidebar-trigger-text">🤖 Claude</span>
                </div>
                <div className="claude-chat-sidebar-trigger-bottom" />
              </div>
            )}
            <div
              className={`claude-chat-sidebar ${!claudeChatPinned ? 'auto-hide' : ''} ${!claudeChatPinned && !claudeChatVisible ? 'hidden' : ''}`}
              style={{ width: `${claudeChatWidth}px` }}
              onMouseEnter={onEnterSidebar}
              onMouseLeave={onLeaveSidebar}
            >
            <div
              className="claude-chat-sidebar-resizer"
              title="드래그하여 너비 조절 (더블클릭: 기본값)"
              onMouseDown={e => {
                e.preventDefault();
                const startX = e.clientX;
                const startWidth = claudeChatWidth;
                const onMove = (ev: MouseEvent) => {
                  const dx = startX - ev.clientX;
                  const w = Math.max(280, Math.min(1200, startWidth + dx));
                  setClaudeChatWidth(w);
                };
                const onUp = () => {
                  window.removeEventListener('mousemove', onMove);
                  window.removeEventListener('mouseup', onUp);
                  // 드래그 종료 시 prefs 저장
                  setClaudeChatWidth(curW => {
                    try { (window as any).api?.setUIPrefs?.({ claudeChatWidth: curW }); } catch {}
                    return curW;
                  });
                  window.dispatchEvent(new Event('resize'));
                };
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', onUp);
              }}
              onDoubleClick={() => {
                setClaudeChatWidth(360);
                try { (window as any).api?.setUIPrefs?.({ claudeChatWidth: 360 }); } catch {}
              }}
            />
            <ClaudeChat
              onClose={() => setShowClaudeChat(false)}
              pendingContext={claudeFileContext}
              onContextConsumed={() => setClaudeFileContext(null)}
              mountEntries={claudeMountEntries}
              onClearMounted={() => setClaudeMountEntries([])}
              onRemoveMountedEntry={(rp, termId) => setClaudeMountEntries(prev => prev.filter(e => !(e.remotePath === rp && e.termId === termId)))}
              connectedSessions={connectedSessions}
              defaultSshSession={defaultSsh}
              pinned={claudeChatPinned}
              onTogglePin={() => setClaudeChatPinned(p => !p)}
            />
            </div>
          </>
        );
      })()}
      {claudeAttaching && (
        <div className="claude-attach-toast">
          <div className="claude-attach-toast-msg">🤖 {claudeAttaching.message}</div>
          {claudeAttaching.total > 0 && (
            <div className="claude-attach-toast-bar">
              <div className="claude-attach-toast-bar-fill" style={{ width: `${Math.min(100, (claudeAttaching.progress / claudeAttaching.total) * 100)}%` }} />
            </div>
          )}
        </div>
      )}
      {splitSessionPicker && (() => {
        const { folders, sessions } = splitSessionPicker;
        const toggleFolder = (fid: string) => {
          setSplitPickerCollapsed(prev => {
            const next = new Set(prev);
            if (next.has(fid)) next.delete(fid); else next.add(fid);
            return next;
          });
        };
        const renderTree = (parentId: string | undefined, depth: number): React.ReactNode[] => {
          const rows: React.ReactNode[] = [];
          const subFolders = folders.filter(f => (f.parentId ?? undefined) === (parentId ?? undefined));
          for (const f of subFolders) {
            const isCollapsed = splitPickerCollapsed.has(f.id);
            rows.push(
              <div
                key={`f-${f.id}`}
                data-fid={f.id}
                className="folder-picker-item folder-row"
                style={{ paddingLeft: 8 + depth * 16, cursor: 'pointer' }}
                onClick={() => toggleFolder(f.id)}
              >
                <span style={{ width: 14, display: 'inline-block', fontSize: 10, color: '#888' }}>{isCollapsed ? '▶' : '▼'}</span>
                📁 {f.name}
              </div>
            );
            if (!isCollapsed) rows.push(...renderTree(f.id, depth + 1));
          }
          const sessionsInFolder = sessions.filter(s => (s.folderId ?? undefined) === (parentId ?? undefined));
          for (const s of sessionsInFolder) {
            rows.push(
              <div
                key={`s-${s.sessionId}`}
                data-sid={s.sessionId}
                className="folder-picker-item picker-session-row"
                style={{ paddingLeft: 8 + depth * 16, position: 'relative' }}
                onClick={() => handleSplitSessionSelect(s)}
                title={s.host}
              >
                <span style={{ width: 14, display: 'inline-block' }} />
                {s.icon || '📡'} {s.sessionName}
                <span className="picker-session-host-tooltip">{s.host}</span>
              </div>
            );
          }
          return rows;
        };
        return (
          <div className="folder-picker-backdrop" onClick={() => setSplitSessionPicker(null)}>
            <div
              className="folder-picker"
              onClick={e => e.stopPropagation()}
            >
              <div className="folder-picker-title">세션 선택 ({splitSessionPicker.dir === 'row' ? '세로 분할' : '가로 분할'})</div>
              <div className="folder-picker-list">
                {renderTree(undefined, 0)}
              </div>
              <div className="folder-picker-actions">
                <button onClick={() => setSplitSessionPicker(null)}>취소</button>
              </div>
            </div>
          </div>
        );
      })()}

      {showManual && (
        <div className="session-editor-backdrop" onClick={() => setShowManual(false)}>
          <div className="session-editor manual-modal" onClick={e => e.stopPropagation()}
            style={{ width: '80vw', maxWidth: 1000, height: '85vh', display: 'flex', flexDirection: 'column' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 4px 8px', borderBottom: '1px solid #333' }}>
              <h3 style={{ margin: 0 }}>📖 PePe Terminal(SSH) 매뉴얼</h3>
              <button onClick={() => setShowManual(false)} title="닫기">✕</button>
            </div>
            <div className="manual-content" style={{ flex: 1, overflow: 'auto', padding: '12px 16px' }}
              dangerouslySetInnerHTML={{ __html: manualHtml }}
            />
          </div>
        </div>
      )}

      {remotePickerOpen && (
        <div className="session-editor-backdrop" style={{ zIndex: 10000 }} onClick={() => setRemotePickerOpen(false)}>
          <div className="session-editor" onClick={e => e.stopPropagation()} style={{ width: 580, maxHeight: '80vh', display: 'flex', flexDirection: 'column', zIndex: 10001 }}>
            <h3>🌐 원격 파일 선택</h3>

            <label style={{ fontSize: 12, color: '#bbb' }}>소스 세션 (전체 목록, 미연결 세션 선택 시 백그라운드 SFTP 연결)</label>
            {(() => {
              // 연결된 termId 맵 구축 (sessionId → 있으면 연결됨)
              const connectedSet = new Set<string>();
              if (activeTab) {
                for (const s of collectAllSessions(activeTab.layout)) {
                  if (s.sessionId && isTermConnected(s.termId)) connectedSet.add(s.sessionId);
                }
              }
              // 폴더 트리 (간단 평면화) — 각 세션을 "폴더경로/세션명" 으로 정렬
              const folderPath = (fid?: string): string => {
                if (!fid) return '';
                const f = remotePickerFolders.find(x => x.id === fid);
                if (!f) return '';
                const parent = folderPath(f.parentId);
                return parent ? `${parent}/${f.name}` : f.name;
              };
              const sorted = [...remotePickerSessions].sort((a, b) => {
                const fa = folderPath(a.folderId);
                const fb = folderPath(b.folderId);
                return fa.localeCompare(fb) || a.name.localeCompare(b.name);
              });
              return (
                <select value={remotePickerSessionId} onChange={e => {
                  setRemotePickerSessionId(e.target.value);
                  setRemotePickerFiles([]);
                  setRemotePickerSelected(new Set());
                }}>
                  <option value="">(세션 선택)</option>
                  {sorted.map(s => {
                    const fp = folderPath(s.folderId);
                    const mark = connectedSet.has(s.id) ? '🟢' : '⚪';
                    return (
                      <option key={s.id} value={s.id}>
                        {mark} {s.name}{fp ? ` [${fp}]` : ''} ({s.host})
                      </option>
                    );
                  })}
                </select>
              );
            })()}
            {remotePickerConnecting && (
              <div style={{ fontSize: 11, color: '#f0c64c', marginTop: 4 }}>
                연결 중...
              </div>
            )}

            <label style={{ fontSize: 12, color: '#bbb', marginTop: 10 }}>경로</label>
            <div style={{ display: 'flex', gap: 4 }}>
              <input type="text" value={remotePickerPath} onChange={e => setRemotePickerPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    setRemotePickerSelected(new Set());
                    // path 변경은 useEffect 가 자동 재로드
                  }
                }}
                style={{ flex: 1 }}
                disabled={!remotePickerConnId} />
              <button onClick={() => {
                const parent = remotePickerPath.replace(/\/[^/]+\/?$/, '') || '/';
                setRemotePickerPath(parent);
                setRemotePickerSelected(new Set());
              }} title="상위 폴더" disabled={!remotePickerConnId}>▲</button>
              <button onClick={async () => {
                if (!remotePickerConnId) return;
                setRemotePickerLoading(true);
                try { const r: any = await (window as any).api?.feListDir?.('remote', remotePickerPath, remotePickerConnId); setRemotePickerFiles(r?.files || []); } catch { setRemotePickerFiles([]); }
                setRemotePickerLoading(false);
              }} title="새로고침" disabled={!remotePickerConnId}>⟳</button>
            </div>

            <div style={{ flex: 1, minHeight: 200, maxHeight: 320, overflowY: 'auto', border: '1px solid #333', borderRadius: 4, marginTop: 8, background: '#161616' }}>
              {!remotePickerConnId ? (
                <div style={{ color: '#666', fontSize: 12, padding: 16, textAlign: 'center' }}>세션을 선택하세요</div>
              ) : remotePickerLoading || remotePickerConnecting ? (
                <div style={{ color: '#888', fontSize: 12, padding: 16, textAlign: 'center' }}>로딩 중...</div>
              ) : remotePickerFiles.length === 0 ? (
                <div style={{ color: '#666', fontSize: 12, padding: 16, textAlign: 'center' }}>(비어있음 또는 경로 에러)</div>
              ) : (
                remotePickerFiles
                  .filter(f => f.name !== '.' && f.name !== '..')
                  .sort((a, b) => (a.isDir !== b.isDir) ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name))
                  .map(f => (
                    <div key={f.name} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px', cursor: 'pointer', background: remotePickerSelected.has(f.name) ? '#2b4e74' : 'transparent' }}
                      onClick={() => {
                        setRemotePickerSelected(prev => {
                          const next = new Set(prev);
                          if (next.has(f.name)) next.delete(f.name); else next.add(f.name);
                          return next;
                        });
                      }}
                      onDoubleClick={() => {
                        if (!f.isDir) return;
                        const sep = remotePickerPath.endsWith('/') ? '' : '/';
                        setRemotePickerPath(remotePickerPath + sep + f.name);
                        setRemotePickerSelected(new Set());
                      }}
                    >
                      <input type="checkbox" readOnly checked={remotePickerSelected.has(f.name)} />
                      <span style={{ fontSize: 12 }}>{f.isDir ? '📁' : '📄'} {f.name}</span>
                    </div>
                  ))
              )}
            </div>
            <div style={{ fontSize: 11, color: '#777', marginTop: 4 }}>
              🟢 연결된 세션 / ⚪ 미연결 (선택 시 자동 연결). 클릭: 선택 / 더블클릭: 폴더 진입. {remotePickerSelected.size}개 선택됨
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
              <button onClick={() => setRemotePickerOpen(false)}>닫기</button>
              <button className="primary" disabled={remotePickerSelected.size === 0 || !remotePickerConnId}
                onClick={() => {
                  const sess = remotePickerSessions.find(s => s.id === remotePickerSessionId);
                  const sessLabel = sess?.name || remotePickerConnId.slice(-6);
                  const toAdd = [...remotePickerSelected].map(name => {
                    const sep = remotePickerPath.endsWith('/') ? '' : '/';
                    const fullPath = remotePickerPath + sep + name;
                    const isFolder = remotePickerFiles.find(f => f.name === name)?.isDir || false;
                    return { path: fullPath, isFolder, sourceTermId: remotePickerConnId, sourceLabel: sessLabel };
                  });
                  setBcastXferFiles(prev => [...prev, ...toAdd]);
                  // 닫진 않음 — 여러 세션에서 연속 선택 가능하도록 유지. 세션만 초기화.
                  setRemotePickerSelected(new Set());
                }}
              >선택 항목 추가 ({remotePickerSelected.size}개)</button>
            </div>
          </div>
        </div>
      )}

      {showBcastFileXfer && (
        <div className="session-editor-backdrop" onClick={() => !bcastXferInProgress && setShowBcastFileXfer(false)}>
          <div className="session-editor" onClick={e => e.stopPropagation()} style={{ width: 620, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
            <h3>📤 일괄 파일 전송</h3>

            <label style={{ fontSize: 12, color: '#bbb', marginTop: 8 }}>대상 세션</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <select value={broadcastScope} onChange={e => setBroadcastScope(e.target.value as any)} style={{ flex: 1 }}>
                <option value="visible">보이는 세션 모두</option>
                <option value="current">현재 세션</option>
                <option value="connected">연결된 세션 전체</option>
              </select>
              <span style={{ color: '#8ab', fontSize: 12 }}>{collectBroadcastTargets(broadcastScope).length}개</span>
            </div>

            <label style={{ fontSize: 12, color: '#bbb', marginTop: 12 }}>원격 경로 (비우면 각 세션의 현재 경로 사용)</label>
            <input type="text" value={bcastXferPath} onChange={e => setBcastXferPath(e.target.value)}
              placeholder="예: /tmp (선택사항)" />

            <label style={{ fontSize: 12, color: '#bbb', marginTop: 12 }}>업로드할 파일/폴더</label>
            <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
              <button onClick={async () => {
                const r: any = await (window as any).api?.pickFiles?.(true);
                if (r?.paths?.length) {
                  setBcastXferFiles(prev => [...prev, ...r.paths.map((p: string) => ({ path: p, isFolder: false }))]);
                }
              }}>+ 로컬 파일</button>
              <button onClick={async () => {
                const r: any = await (window as any).api?.pickFolder?.();
                if (r?.path) setBcastXferFiles(prev => [...prev, { path: r.path, isFolder: true }]);
              }}>+ 로컬 폴더</button>
              <button onClick={() => {
                // 전체 세션 리스트에서 선택 — 미연결이면 백그라운드 연결
                setRemotePickerSessionId('');
                setRemotePickerConnId('');
                setRemotePickerPath('');
                setRemotePickerFiles([]);
                setRemotePickerSelected(new Set());
                setRemotePickerOpen(true);
              }}>+ 원격 파일 (다른 서버)</button>
              <button onClick={() => setBcastXferFiles([])} disabled={bcastXferFiles.length === 0}>모두 제거</button>
            </div>
            <div style={{ flex: 1, minHeight: 100, maxHeight: 220, overflowY: 'auto', border: '1px solid #333', borderRadius: 4, padding: 6, background: '#161616' }}>
              {bcastXferFiles.length === 0 ? (
                <div style={{ color: '#666', fontSize: 12, textAlign: 'center', padding: 16 }}>파일 또는 폴더를 추가하세요</div>
              ) : (
                bcastXferFiles.map((f, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 6px', gap: 6 }}>
                    <span style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }} title={`${f.sourceTermId ? `원격(${f.sourceLabel}):` : '로컬:'} ${f.path}`}>
                      {f.sourceTermId ? '🌐' : '💻'} {f.isFolder ? '📁' : '📄'} {f.path}
                      {f.sourceTermId && <span style={{ color: '#8ab', fontSize: 10, marginLeft: 6 }}>[{f.sourceLabel}]</span>}
                    </span>
                    <button onClick={() => setBcastXferFiles(prev => prev.filter((_, idx) => idx !== i))} style={{ padding: '0 8px' }}>✕</button>
                  </div>
                ))
              )}
            </div>
            {bcastXferLog.length > 0 && (
              <div style={{ maxHeight: 120, overflowY: 'auto', fontSize: 11, fontFamily: 'monospace', color: '#aaa', background: '#0c0c0c', padding: 6, borderRadius: 4, marginTop: 8 }}>
                {bcastXferLog.map((l, i) => (
                  <div key={i} style={{ color: l.startsWith('✓') ? '#7fcf6e' : (l.startsWith('✗') ? '#e36b6b' : '#aaa') }}>{l}</div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
              <button onClick={() => setShowBcastFileXfer(false)} disabled={bcastXferInProgress}>닫기</button>
              <button className="primary" disabled={bcastXferInProgress || bcastXferFiles.length === 0 || collectBroadcastTargets(broadcastScope).length === 0}
                onClick={async () => {
                  const targets = collectBroadcastTargets(broadcastScope);
                  if (targets.length === 0) { flashBroadcastNotice('대상 세션이 없습니다', 'warn'); return; }
                  setBcastXferInProgress(true);
                  setBcastXferLog([`▶ ${targets.length}개 세션 × ${bcastXferFiles.length}개 항목 전송 시작`]);
                  const override = bcastXferPath.trim();
                  let okCount = 0;
                  let errCount = 0;
                  for (const tid of targets) {
                    const basePath = override || getCurrentPwdForTerm(tid) || '/';
                    const info = getTermSessionInfo(tid);
                    const label = info?.sessionName || tid.slice(-6);
                    for (const f of bcastXferFiles) {
                      const filename = f.path.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
                      const remotePath = basePath.endsWith('/') ? basePath + filename : basePath + '/' + filename;
                      // 동일 세션은 source == target 이므로 skip
                      if (f.sourceTermId && f.sourceTermId === tid) {
                        setBcastXferLog(prev => [...prev, `↷ ${label}: ${filename} (소스와 동일 세션, 건너뜀)`]);
                        continue;
                      }
                      const src: any = f.sourceTermId
                        ? { mode: 'remote', termId: f.sourceTermId, path: f.path }
                        : { mode: 'local', path: f.path };
                      try {
                        const r: any = await (window as any).api?.feTransfer?.(
                          src,
                          { mode: 'remote', termId: tid, path: remotePath },
                          filename,
                        );
                        if (r?.success) {
                          okCount++;
                          setBcastXferLog(prev => [...prev, `✓ ${label}: ${filename} → ${basePath}`]);
                        } else {
                          errCount++;
                          setBcastXferLog(prev => [...prev, `✗ ${label}: ${filename} — ${r?.error || 'unknown'}`]);
                        }
                      } catch (err: any) {
                        errCount++;
                        setBcastXferLog(prev => [...prev, `✗ ${label}: ${filename} — ${err?.message || err}`]);
                      }
                    }
                  }
                  setBcastXferLog(prev => [...prev, `● 완료: 성공 ${okCount}, 실패 ${errCount}`]);
                  setBcastXferInProgress(false);
                  flashBroadcastNotice(`파일전송 완료 (성공 ${okCount}/${okCount + errCount})`, errCount === 0 ? 'ok' : 'warn');
                }}>
                {bcastXferInProgress ? '전송 중...' : '전송'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;

// ── 패널 이동 헬퍼 ──

function removeLeafFromTree(root: LayoutNode, targetId: string): { root: LayoutNode; removed?: LayoutNode } {
  if (root.type === 'leaf') {
    if (root.id === targetId) return { root: { ...root }, removed: root };
    return { root };
  }
  const children: LayoutNode[] = []; let removed: LayoutNode | undefined;
  for (const child of root.children) {
    const r = removeLeafFromTree(child, targetId);
    if (r.removed && !removed) removed = r.removed;
    if (!r.removed || r.root.type !== 'leaf' || r.root.id !== targetId) children.push(r.root);
  }
  if (children.length === 0) return { root, removed };
  if (children.length === 1) return { root: children[0], removed };
  return { root: { ...root, children }, removed };
}

function replaceLeaf(root: LayoutNode, targetId: string, leaf: LayoutNode): LayoutNode {
  if (root.type === 'leaf') return root.id === targetId ? leaf : root;
  return { ...root, children: root.children.map(c => replaceLeaf(c, targetId, leaf)) };
}

function insertNear(root: LayoutNode, targetId: string, leaf: LayoutNode, pos: 'before' | 'after'): LayoutNode {
  if (root.type === 'leaf') return root;
  const nc: LayoutNode[] = [];
  for (const c of root.children) {
    if (c.type === 'leaf' && c.id === targetId) { if (pos === 'before') nc.push(leaf); nc.push(c); if (pos === 'after') nc.push(leaf); }
    else nc.push(insertNear(c, targetId, leaf, pos));
  }
  return { ...root, children: nc };
}

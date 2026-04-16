// src/App.tsx
import { useState, useCallback, useEffect, useRef } from 'react';
import './App.css';
import { TabBar } from './components/TabBar';
import { MenuBar } from './components/MenuBar';
import type { MenuDef } from './components/MenuBar';
import { Layout } from './components/Layout';
import { SearchBar } from './components/SearchBar';
import { FileExplorer } from './components/FileExplorer';
import { QuickConnectBar, QuickConnectResult } from './components/QuickConnectDialog';
import { StatusBar } from './components/StatusBar';
import { resetTermConnectState, clearScrollbackInTerm, clearScreenInTerm, clearAllInTerm, applyThemeToAll, applyThemeToTerm, applyFontToTerm, applyFontToAll, getCurrentThemeName, registerTermSession, getTermSessionInfo, getWordSeparator, setWordSeparator, refitAllTerms, applyScrollbackToAll, applyScrollbackToTerm, cloneTermStyle, isTermConnected, isTermPty, subscribeConnectedChange, focusTerm, pasteToTerm, promptPasswordAndConnect } from './components/TerminalPanel';
import { getTerminalSettings, saveTerminalSettings, TerminalSettings } from './utils/terminalSettings';
import { getThemeList } from './utils/terminalThemes';
import { SessionList } from './components/SessionList';
import {
  LayoutNode,
  PanelSession,
  splitNode,
  splitNodeWithSessions,
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
export type TabType = 'terminal' | 'fileExplorer';
export type Tab = { id: TabId; title: string; layout: LayoutNode; type?: TabType };

function App() {
  const [tabs, setTabs] = useState<Tab[]>(() => {
    return [{ id: 'tab-1', title: 'Workspace 1', layout: createInitialLayout('tab-1') }];
  });
  const [activeTabId, setActiveTabId] = useState<TabId>('tab-1');
  const [selectedPanelId, setSelectedPanelId] = useState<string | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [themeName, setThemeName] = useState(getCurrentThemeName);
  const [wordSepValue, setWordSepValue] = useState('');
  const [termSettings, setTermSettings] = useState<TerminalSettings>(getTerminalSettings);
  const [showOptions, setShowOptions] = useState(false);
  const [optFontFamily, setOptFontFamily] = useState(() => localStorage.getItem('terminalFontFamily') || '');
  const [optFontSize, setOptFontSize] = useState(() => Number(localStorage.getItem('terminalFontSize')) || 14);
  const [availableFonts, setAvailableFonts] = useState<string[]>([]);
  const [optionsTab, setOptionsTab] = useState<'terminal' | 'session'>('terminal');
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
      } catch {}
      showBroadcastLoadedRef.current = true;
    })();
  }, []);
  useEffect(() => {
    if (!showBroadcastLoadedRef.current) return;
    try { (window as any).api?.setUIPrefs?.({ showBroadcast }); } catch {}
  }, [showBroadcast]);
  const [broadcastText, setBroadcastText] = useState('');
  const [broadcastAppendNewline, setBroadcastAppendNewline] = useState(true);
  const [broadcastScope, setBroadcastScope] = useState<'current' | 'visible' | 'connected'>('current');
  const [, setConnectedTick] = useState(0);
  // 글로벌 연결 상태 변경시 일괄전송 카운트 등 재계산을 위해 강제 리렌더
  useEffect(() => subscribeConnectedChange(() => setConnectedTick(n => n + 1)), []);
  const [isMaximized, setIsMaximized] = useState(false);
  useEffect(() => {
    (window as any).api?.windowIsMaximized?.().then((m: boolean) => setIsMaximized(!!m)).catch(() => {});
    const off = (window as any).api?.onWindowMaximized?.((m: boolean) => setIsMaximized(!!m));
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
  const sendBroadcast = (scope: 'current' | 'visible' | 'connected', override?: { raw: string; label?: string }) => {
    let text: string;
    let label: string;
    if (override) {
      text = override.raw;
      label = override.label ?? '(raw)';
    } else {
      text = broadcastAppendNewline ? (broadcastText.endsWith('\n') ? broadcastText : broadcastText + '\n') : broadcastText;
      label = '텍스트';
      if (!text) { flashBroadcastNotice('텍스트를 입력하세요', 'warn'); return; }
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
      // Alt+Enter: 현재 미니탭 전체화면 토글 (창도 최대화, 해제 시 원래 상태로)
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.code === 'Enter' || e.code === 'NumpadEnter')) {
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
      const code = e.code;
      // Ctrl+Tab / Ctrl+Shift+Tab: 워크스페이스 내 모든 미니탭(모든 패널) 순환
      if (code === 'Tab') {
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
        const dir = e.shiftKey ? -1 : 1;
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
      if (!e.shiftKey) return;
      if (code === 'KeyF') { e.preventDefault(); setShowSearch(prev => !prev); return; }
      const termId = getActiveTermId();
      if (!termId) return;
      if (code === 'KeyB') { e.preventDefault(); clearScrollbackInTerm(termId); }
      else if (code === 'KeyL') { e.preventDefault(); clearScreenInTerm(termId); }
      else if (code === 'KeyA') { e.preventDefault(); clearAllInTerm(termId); }
    };
    window.addEventListener('keydown', handler, true); // capture phase
    return () => window.removeEventListener('keydown', handler, true);
  }, [getActiveTermId]);

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
    setTabs(prev => [...prev, { id, title: `Workspace ${prev.length + 1}`, layout: createInitialLayout(id, sn, sp) }]);
    setActiveTabId(id);
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

  const splitPanel = (tabId: TabId, targetNodeId: string, direction: 'row' | 'column') => {
    updateLayout(tabId, layout => splitNode(layout, targetNodeId, direction));
    setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
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
    // 파일 전송 탭이면 SFTP 직접 연결하여 파일 탐색기에 추가
    if (activeTab.type === 'fileExplorer') {
      (async () => {
        try {
          const data = await (window as any).api.listSessions();
          const allSessions = data?.sessions ?? data ?? [];
          const sess = allSessions.find((s: any) => s.id === sessionId);
          if (!sess) return;
          const connId = `sftp-fe-${Date.now()}`;
          const result = await (window as any).api.feSftpConnect?.(connId, sess.host, sess.port || 22, sess.username, sess.auth);
          if (result?.success) {
            window.dispatchEvent(new CustomEvent('fe-sftp-connected', { detail: { connId, sessionName, host: sess.host } }));
          }
        } catch {}
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
      if (activeSess) {
        // 연결 상태 확인 후 분기
        const checkAndConnect = async () => {
          let connected = false;
          try { connected = await (window as any).api.isSSHConnected(activeSess.termId); } catch {}
          if (connected) {
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
        { label: showQuickConnect ? '빠른 연결 바 숨기기' : '빠른 연결 바 표시', action: () => setShowQuickConnect(v => !v) },
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
        { label: '세로 분할', action: () => { if (activeTab && selectedPanelId) splitPanel(activeTab.id, selectedPanelId, 'row'); }, disabled: !selectedPanelId },
        { label: '가로 분할', action: () => { if (activeTab && selectedPanelId) splitPanel(activeTab.id, selectedPanelId, 'column'); }, disabled: !selectedPanelId },
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
          try { const p = await (window as any).api.getSessionsPath(); setSessionsPathDisplay(p || ''); } catch {}
          setShowOptions(true);
        } },
      ],
    },
    {
      label: '도움말',
      items: [
        { label: '단축키 목록', action: () => alert(
          '── 일반 ──\n' +
          'Ctrl+Shift+F — 찾기\n' +
          'Ctrl+Shift+L — 화면 지우기\n' +
          'Ctrl+Shift+B — 스크롤 버퍼 지우기\n' +
          'Ctrl+Shift+A — 모두 지우기\n' +
          'Ctrl+L — 스크롤 맨 아래로\n' +
          'Ctrl+마우스 휠 — 글꼴 크기 조절\n\n' +
          '── 탭/워크스페이스 ──\n' +
          'Alt+1~9 — 미니탭 전환\n' +
          'Alt+Enter — 현재 미니탭 전체화면 토글\n' +
          'Ctrl+Tab — 다음 미니탭\n' +
          'Ctrl+Shift+Tab — 이전 미니탭\n' +
          'F2 — 이름 변경\n' +
          '가운데 클릭 — 탭 닫기\n\n' +
          '── 미니탭 ──\n' +
          '∨ 버튼 — 쉘 선택 (PowerShell, CMD, Git Bash 등)\n' +
          '우클릭 — 이름 변경 / 세션 복제 / 닫기\n\n' +
          '── 터미널 ──\n' +
          '우클릭 — 복사 / 붙여넣기 / 글꼴 / 인코딩 / 화면 지우기 등'
        )},
        { separator: true, label: '' },
        { label: 'PePe Terminal(SSH) 정보', action: async () => {
          let sessPath = '';
          try { sessPath = await (window as any).api.getSessionsPath(); } catch {}
          alert(
          'PePe Terminal(SSH) v1.0.0\n\n' +
          '만든이: Claude (feat. ghjeong[prompt])\n\n' +
          '── 주요 기능 ──\n' +
          'SSH/SFTP 원격 접속\n' +
          '로컬 쉘 (PowerShell, CMD, Git Bash, WSL)\n' +
          '기본 쉘 설정 / 미니탭별 쉘 선택\n' +
          '미니탭별 글꼴 실시간 변경\n' +
          '듀얼 패널 파일 탐색기 (SFTP)\n' +
          '다중 워크스페이스 / 분할 패널\n' +
          '텍스트 일괄 전송 (브로드캐스트)\n' +
          'Windows 탐색기 우클릭 "Open here" 연동\n' +
          '찾기 (Ctrl+Shift+F) / 검색 이력\n' +
          '테마 / 글꼴 / 인코딩 변경\n' +
          'Expect/Send 로그인 스크립트\n' +
          '자동 재연결 (30초)\n\n' +
          '── 설정 (옵션) ──\n' +
          '기본 로컬 쉘 선택\n' +
          '탐색기 우클릭 메뉴 등록/해제\n' +
          '세션 저장 경로 변경\n\n' +
          '── 기술 스택 ──\n' +
          'Electron + React + TypeScript\n' +
          'xterm.js (터미널 에뮬레이터)\n' +
          'node-pty (로컬 쉘)\n' +
          'ssh2 (SSH 프로토콜)\n' +
          'iconv-lite (문자 인코딩)\n' +
          'Vite + vite-plugin-electron\n\n' +
          '── 세션 저장 경로 ──\n' +
          (sessPath || '(알 수 없음)')
        ); } },
      ],
    },
  ];

  return (
    <div className={`app-root${showBroadcast ? ' has-broadcast' : ''}${showQuickConnect ? ' has-quickconnect' : ''}${fullscreenTermId ? ' term-fullscreen' : ''}`} data-fs-term={fullscreenTermId || ''}>
      <SessionList
        onConnect={(sid, name, panelId, sessTheme, ff, fs, sb) => handleConnectSession(sid, name, panelId, sessTheme, ff, fs, sb)}
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
          // SFTP 연결
          try {
            const data = await (window as any).api.listSessions();
            const allSessions = data?.sessions ?? data ?? [];
            const sess = allSessions.find((s: any) => s.id === sessionId);
            if (!sess) return;
            const connId = `sftp-fe-${Date.now()}`;
            const result = await (window as any).api.feSftpConnect?.(connId, sess.host, sess.port || 22, sess.username, sess.auth);
            if (result?.success) {
              window.dispatchEvent(new CustomEvent('fe-sftp-connected', { detail: { connId, sessionName, host: sess.host } }));
            }
          } catch {}
        }}
      />
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

        {activeTab && activeTab.type !== 'fileExplorer' && (
          <Layout root={activeTab.layout}
            selectedPanelId={selectedPanelId}
            onSplit={(nodeId, dir) => splitPanel(activeTab.id, nodeId, dir)}
            onClose={nodeId => closePanel(activeTab.id, nodeId)}
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
          />
        )}
      </div>

      {showBroadcast && (
        <div className="broadcast-bar">
          <span className="broadcast-label" title="텍스트 일괄 전송">📢</span>
          <select
            className="broadcast-scope"
            value={broadcastScope}
            onChange={e => setBroadcastScope(e.target.value as any)}
            title="전송 대상"
          >
            <option value="current">현재 세션 ({collectBroadcastTargets('current').length})</option>
            <option value="visible">보이는 탭 ({collectBroadcastTargets('visible').length})</option>
            <option value="connected">연결된 세션 ({collectBroadcastTargets('connected').length})</option>
          </select>
          <input
            className="broadcast-input"
            autoFocus
            value={broadcastText}
            onChange={e => setBroadcastText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') { setShowBroadcast(false); return; }
              if (e.key === 'Enter') { e.preventDefault(); sendBroadcast(broadcastScope); return; }
              // Ctrl+C / Ctrl+D 를 브로드캐스트 제어 문자로 가로챔
              if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
                if (e.key === 'c' || e.key === 'C') {
                  // 텍스트가 선택된 경우는 일반 복사 동작을 허용
                  const inp = e.currentTarget as HTMLInputElement;
                  if (inp.selectionStart !== inp.selectionEnd) return;
                  e.preventDefault();
                  sendBroadcast(broadcastScope, { raw: '\x03', label: '^C' });
                } else if (e.key === 'd' || e.key === 'D') {
                  e.preventDefault();
                  sendBroadcast(broadcastScope, { raw: '\x04', label: '^D' });
                }
              }
            }}
            placeholder="전송할 텍스트 (Enter 전송, Ctrl+C/^C, Ctrl+D/^D)"
          />
          <label className="broadcast-chk" title="끝에 개행(Enter) 추가">
            <input type="checkbox" checked={broadcastAppendNewline} onChange={e => setBroadcastAppendNewline(e.target.checked)} />
            <span>↵</span>
          </label>
          <button className="broadcast-btn" onClick={() => sendBroadcast(broadcastScope)} title="텍스트 전송 (Enter)">전송</button>
          <button className="broadcast-btn ctrl" onClick={() => sendBroadcast(broadcastScope, { raw: '\x03', label: '^C' })} title="Ctrl+C (SIGINT) 전송">^C</button>
          <button className="broadcast-btn ctrl" onClick={() => sendBroadcast(broadcastScope, { raw: '\x04', label: '^D' })} title="Ctrl+D (EOF) 전송">^D</button>
          <button className="broadcast-close" onClick={() => setShowBroadcast(false)} title="닫기">✕</button>
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

            <div className="session-editor-actions">
              <button className="btn-cancel" onClick={() => setShowOptions(false)}>취소</button>
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

// src/components/RemoteFileTree.tsx
import React, { useState, useEffect, useCallback } from 'react';

type FileEntry = {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
  mtime?: number;
};

type TreeNode = {
  name: string;
  path: string;
  isDir: boolean;
  children?: TreeNode[];
  loaded?: boolean;
  loading?: boolean;
};

// termId별 트리 상태 캐시 (컴포넌트 unmount/remount에도 유지)
const treeStateCache: Map<string, { root: TreeNode; collapsed: string[]; pathInput: string }> = new Map();

type Props = {
  termId: string;
  sessionName: string;
  sessionId?: string; // 세션 ID (initialPath 조회용)
  initialPath?: string; // 세션 연결 시 사용할 초기 경로 (없으면 홈)
  onOpenFile: (termId: string, remotePath: string, fileName: string) => void;
  onAttachToClaude?: (termId: string, remotePath: string, fileName: string, isDir: boolean) => void;
};

export const RemoteFileTree: React.FC<Props> = ({ termId, sessionName, sessionId, initialPath: initialPathProp, onOpenFile, onAttachToClaude }) => {
  // 세션 initialPath 조회 상태 (null=조회중, string=경로, ''=없음/홈사용)
  const [resolvedInitialPath, setResolvedInitialPath] = useState<string | null>(initialPathProp ?? null);
  useEffect(() => {
    if (initialPathProp) { setResolvedInitialPath(initialPathProp); return; }
    if (!sessionId) { setResolvedInitialPath(''); return; }
    let cancelled = false;
    (async () => {
      try {
        const data: any = await (window as any).api?.listSessions?.();
        if (cancelled) return;
        const list = Array.isArray(data) ? data : (data?.sessions || []);
        const sess = list.find((s: any) => s.id === sessionId);
        setResolvedInitialPath(sess?.initialPath || '');
      } catch { if (!cancelled) setResolvedInitialPath(''); }
    })();
    return () => { cancelled = true; };
  }, [sessionId, initialPathProp]);
  const initialPath = resolvedInitialPath;
  const cached = treeStateCache.get(termId);
  const [root, setRoot] = useState<TreeNode | null>(cached?.root || null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(cached?.collapsed || []));
  const [pathInput, setPathInput] = useState<string>(cached?.pathInput || '');
  const [promptModal, setPromptModal] = useState<{ title: string; value: string; onSubmit: (v: string) => void } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; node: TreeNode } | null>(null);

  // 컨텍스트 메뉴 외부 클릭/ESC 닫기
  useEffect(() => {
    if (!ctxMenu) return;
    const onClick = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCtxMenu(null); };
    window.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [ctxMenu]);

  // state 변경 시 캐시에 저장
  useEffect(() => {
    if (root) {
      treeStateCache.set(termId, { root, collapsed: [...collapsed], pathInput });
    }
  }, [termId, root, collapsed, pathInput]);

  const loadChildren = useCallback(async (path: string, retries = 3): Promise<TreeNode[]> => {
    try {
      let result: any = null;
      for (let i = 0; i < retries; i++) {
        result = await (window as any).api?.feListDir?.('remote', path, termId);
        if (result?.files) break;
        if (i < retries - 1) await new Promise(r => setTimeout(r, 500));
      }
      if (!result || !result.files) return [];
      const files: FileEntry[] = result.files;
      const nodes: TreeNode[] = files
        .filter((f: any) => f.name !== '.' && f.name !== '..')
        .sort((a: any, b: any) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
        .map((f: any) => ({
          name: f.name,
          path: path.endsWith('/') ? path + f.name : path + '/' + f.name,
          isDir: f.isDir,
        }));
      return nodes;
    } catch (err) {
      console.error('[RemoteFileTree] loadChildren error', err);
      return [];
    }
  }, [termId]);

  const navigateTo = useCallback(async (targetPath: string) => {
    const cleanPath = targetPath.trim() || '/';
    const children = await loadChildren(cleanPath);
    setRoot({
      name: cleanPath,
      path: cleanPath,
      isDir: true,
      children,
      loaded: true,
    });
    setPathInput(cleanPath);
    setCollapsed(new Set());
  }, [loadChildren]);

  // 초기 경로 로드 — initialPath 조회 완료 후에만 실행
  useEffect(() => {
    // null 이면 아직 조회 중 — 대기
    if (initialPath === null) return;
    const startTargetPath = (initialPath || '').trim();
    // 이미 캐시 있고 원하는 경로와 일치하면 스킵
    const cached = treeStateCache.get(termId);
    if (cached?.root && startTargetPath && cached.root.path === startTargetPath) return;
    // 캐시 있고 initialPath 가 빈 값(홈 사용)이고 이미 홈으로 로드됐으면 스킵
    if (cached?.root && !startTargetPath) return;
    // 그 외엔 지정된 경로(또는 홈)로 재이동
    (async () => {
      try {
        let startPath = startTargetPath;
        if (!startPath) {
          let home: any = null;
          for (let i = 0; i < 5; i++) {
            home = await (window as any).api?.feHomeDir?.('remote', termId);
            if (home && typeof home === 'string' && home !== '/') break;
            await new Promise(r => setTimeout(r, 500));
          }
          startPath = typeof home === 'string' ? home : (home?.path || '/');
        } else {
          // SFTP 준비 대기
          for (let i = 0; i < 5; i++) {
            try {
              const probe: any = await (window as any).api?.feListDir?.('remote', startPath, termId);
              if (probe?.files) break;
            } catch {}
            await new Promise(r => setTimeout(r, 500));
          }
        }
        console.log('[RemoteFileTree] loading initial path:', startPath, 'for termId:', termId);
        setPathInput(startPath);
        const children = await loadChildren(startPath, 5);
        setRoot({
          name: startPath,
          path: startPath,
          isDir: true,
          children,
          loaded: true,
        });
        setCollapsed(new Set());
      } catch (err) {
        console.error('[RemoteFileTree] init error', err);
      }
    })();
  }, [termId, initialPath, loadChildren]);

  const toggleFolder = async (node: TreeNode) => {
    if (!node.isDir) return;
    const isExpanded = !collapsed.has(node.path);
    if (node.loaded) {
      // 이미 로드됨 → 단순 토글
      setCollapsed(prev => {
        const next = new Set(prev);
        if (isExpanded) next.add(node.path);
        else next.delete(node.path);
        return next;
      });
    } else {
      // 처음 여는 중 → 로드 + 펼침 (collapsed에서 제거)
      if (node.loading) return;
      node.loading = true;
      const children = await loadChildren(node.path);
      setRoot(r => {
        if (!r) return r;
        const updateNode = (n: TreeNode): TreeNode => {
          if (n.path === node.path) {
            return { ...n, children, loaded: true, loading: false };
          }
          if (n.children) return { ...n, children: n.children.map(updateNode) };
          return n;
        };
        return updateNode(r);
      });
      setCollapsed(prev => {
        const next = new Set(prev);
        next.delete(node.path); // 확실히 펼침 상태로
        return next;
      });
    }
  };

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    const isCollapsed = collapsed.has(node.path);
    return (
      <React.Fragment key={node.path}>
        <div
          className={`remote-file-item ${node.isDir ? 'folder' : 'file'}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => {
            if (node.isDir) toggleFolder(node);
            else onOpenFile(termId, node.path, node.name);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setCtxMenu({ x: e.clientX, y: e.clientY, node });
          }}
        >
          {node.isDir ? (
            <span className="remote-file-toggle">{isCollapsed ? '▶' : '▼'}</span>
          ) : (
            <span className="remote-file-toggle-space" />
          )}
          <span className="remote-file-icon">{node.isDir ? '📁' : '📄'}</span>
          <span className="remote-file-name">{node.name}</span>
        </div>
        {node.isDir && !isCollapsed && node.children && node.children.map(c => renderNode(c, depth + 1))}
      </React.Fragment>
    );
  };

  if (!root) return <div className="remote-file-loading">로딩 중...</div>;

  const openFilePrompt = () => {
    setPromptModal({
      title: '파일 열기',
      value: root?.path ? (root.path.endsWith('/') ? root.path : root.path + '/') : '/',
      onSubmit: (filePath) => {
        if (!filePath.trim()) return;
        const fileName = filePath.split('/').filter(Boolean).pop() || filePath;
        onOpenFile(termId, filePath, fileName);
      },
    });
  };

  const openFolderPrompt = () => {
    setPromptModal({
      title: '폴더 열기',
      value: root?.path || '/',
      onSubmit: (folderPath) => {
        if (!folderPath.trim()) return;
        navigateTo(folderPath);
      },
    });
  };

  return (
    <div className="remote-file-tree">
      <div className="remote-file-header">
        <span>🔌 {sessionName}</span>
        <div className="remote-file-header-actions">
          <button className="remote-file-action-btn" onClick={openFilePrompt} title="파일 열기...">📄</button>
          <button className="remote-file-action-btn" onClick={openFolderPrompt} title="폴더 열기...">📁</button>
        </div>
      </div>
      <div className="remote-file-path-bar">
        <input
          className="remote-file-path-input"
          value={pathInput}
          onChange={e => setPathInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); navigateTo(pathInput); }
          }}
          placeholder="/path/to/folder"
          title="Enter로 이동"
        />
        <button className="remote-file-path-go" onClick={() => navigateTo(pathInput)} title="이동">↵</button>
        <button className="remote-file-path-up" onClick={() => {
          if (!root) return;
          const parent = root.path.replace(/\/[^/]+\/?$/, '') || '/';
          navigateTo(parent);
        }} title="상위 폴더">▲</button>
        <button className="remote-file-path-home" onClick={async () => {
          const home = await (window as any).api?.feHomeDir?.('remote', termId);
          const homePath = typeof home === 'string' ? home : (home?.path || '/');
          navigateTo(homePath);
        }} title="홈">🏠</button>
      </div>
      <div className="remote-file-list">
        {root.children && root.children.map(c => renderNode(c, 0))}
      </div>
      {ctxMenu && (
        <div
          className="remote-file-ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={e => e.stopPropagation()}
          onContextMenu={e => e.preventDefault()}
        >
          {!ctxMenu.node.isDir && (
            <div className="remote-file-ctx-item" onClick={() => {
              onOpenFile(termId, ctxMenu.node.path, ctxMenu.node.name);
              setCtxMenu(null);
            }}>📖 파일 열기</div>
          )}
          {ctxMenu.node.isDir && (
            <div className="remote-file-ctx-item" onClick={() => {
              navigateTo(ctxMenu.node.path);
              setCtxMenu(null);
            }}>📂 이 폴더로 이동</div>
          )}
          {onAttachToClaude && (
            <div className="remote-file-ctx-item claude" onClick={() => {
              onAttachToClaude(termId, ctxMenu.node.path, ctxMenu.node.name, ctxMenu.node.isDir);
              setCtxMenu(null);
            }}>🤖 Claude에 첨부{ctxMenu.node.isDir ? ' (폴더 재귀)' : ''}</div>
          )}
          <div className="remote-file-ctx-item" onClick={async () => {
            try {
              await navigator.clipboard.writeText(ctxMenu.node.path);
            } catch {}
            setCtxMenu(null);
          }}>📋 경로 복사</div>
        </div>
      )}
      {promptModal && (
        <div className="path-prompt-backdrop" onClick={() => setPromptModal(null)}>
          <div className="path-prompt-modal" onClick={e => e.stopPropagation()}>
            <div className="path-prompt-title">{promptModal.title}</div>
            <input
              className="path-prompt-input"
              value={promptModal.value}
              autoFocus
              onChange={e => setPromptModal(p => p ? { ...p, value: e.target.value } : null)}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); promptModal.onSubmit(promptModal.value); setPromptModal(null); }
                if (e.key === 'Escape') setPromptModal(null);
              }}
              placeholder="/path/to/..."
            />
            <div className="path-prompt-actions">
              <button onClick={() => setPromptModal(null)}>취소</button>
              <button className="primary" onClick={() => { promptModal.onSubmit(promptModal.value); setPromptModal(null); }}>확인</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// src/components/SessionList.tsx
import React, { useEffect, useState, useRef, useCallback } from 'react';
import { SessionEditor } from './SessionEditor';

type LoginScriptRule = {
  expect: string;
  send: string;
  isRegex?: boolean;
};

type Session = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth?: any;
  encoding?: string;
  folderId?: string;
  loginScript?: LoginScriptRule[];
  theme?: string;
  fontFamily?: string;
  fontSize?: number;
  scrollback?: number;
  icon?: string;
};

type Folder = {
  id: string;
  name: string;
  parentId?: string;
};

type Props = {
  onConnect: (sessionId: string, sessionName: string, targetPanelId?: string | null, sessionTheme?: string, fontFamily?: string, fontSize?: number, scrollback?: number) => void;
  onFileTransfer?: (sessionId: string, sessionName: string) => void;
  onDisconnect?: (targetPanelId?: string | null) => void;
  targetPanelId?: string | null;
};

export const SessionList: React.FC<Props> = ({ onConnect, onDisconnect, onFileTransfer, targetPanelId }) => {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [width, setWidth] = useState<number>(() => {
    const saved = window.localStorage.getItem('sessionListWidth');
    return saved ? Number(saved) : 260;
  });
  const [pinned, setPinned] = useState<boolean>(true);
  const pinnedLoadedRef = useRef(false);
  const [visible, setVisible] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<'session' | 'folder'>('session');
  const [editing, setEditing] = useState<Session | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(window.localStorage.getItem('collapsedFolders') ?? '[]')); }
    catch { return new Set(); }
  });
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingType, setRenamingType] = useState<'session' | 'folder'>('folder');
  const [renameValue, setRenameValue] = useState('');
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; id: string; type: 'session' | 'folder'; name: string } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [folderPicker, setFolderPicker] = useState<{ sessionId: string } | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef<{ startX: number; startWidth: number } | null>(null);
  const widthRef = useRef(width);
  widthRef.current = width;

  useEffect(() => { reload(); }, []);

  useEffect(() => {
    const handler = () => reload();
    window.addEventListener('sessions-reload', handler);
    return () => window.removeEventListener('sessions-reload', handler);
  }, []);

  useEffect(() => {
    window.localStorage.setItem('collapsedFolders', JSON.stringify([...collapsed]));
  }, [collapsed]);

  // ui-prefs 에서 pinned 상태 로드
  useEffect(() => {
    (async () => {
      try {
        const prefs = await (window as any).api?.getUIPrefs?.();
        if (prefs && typeof prefs.sidebarPinned === 'boolean') {
          setPinned(prefs.sidebarPinned);
          if (!prefs.sidebarPinned) setVisible(false);
        }
      } catch {}
      pinnedLoadedRef.current = true;
    })();
  }, []);
  useEffect(() => {
    if (!pinnedLoadedRef.current) return;
    try { (window as any).api?.setUIPrefs?.({ sidebarPinned: pinned }); } catch {}
    if (pinned) setVisible(true);
  }, [pinned]);

  // 컨텍스트 메뉴 외부 클릭 시 닫기
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [contextMenu]);

  const reload = async () => {
    const data = await window.api?.listSessions?.();
    if (data && !Array.isArray(data)) {
      setSessions(data.sessions || []);
      setFolders(data.folders || []);
    } else {
      setSessions(data || []);
      setFolders([]);
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    e.preventDefault();
    dragging.current = { startX: e.clientX, startWidth: width };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  const onPointerMove = useCallback((ev: PointerEvent) => {
    if (!dragging.current) return;
    const delta = ev.clientX - dragging.current.startX;
    setWidth(Math.max(180, dragging.current.startWidth + delta));
  }, []);

  const onPointerUp = useCallback(() => {
    window.localStorage.setItem('sessionListWidth', String(widthRef.current));
    dragging.current = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
  }, [onPointerMove]);

  const [copiedSession, setCopiedSession] = useState<Session | null>(null);

  const handleConnect = (s: Session) => onConnect(s.id, s.name, targetPanelId ?? null, s.theme, s.fontFamily, s.fontSize, s.scrollback);
  const handleDisconnect = () => onDisconnect?.(targetPanelId ?? null);

  const handleAdd = () => {
    const folderId = selectedType === 'folder' ? selectedId : undefined;
    setEditing({ id: `sess-${Date.now()}`, name: 'New Session', host: '', port: 22, username: '', auth: { type: 'password', password: '' }, encoding: 'utf-8', folderId: folderId ?? undefined });
  };

  const handleEdit = () => {
    if (!selectedId) return;
    const s = sessions.find(x => x.id === selectedId);
    if (s) setEditing(s);
  };

  const handleDelete = async () => {
    // 다중 선택 삭제
    if (selectedIds.size > 0) {
      const ids = [...selectedIds];
      if (!confirm(`${ids.length}개 항목을 삭제하시겠습니까?`)) return;
      for (const id of ids) {
        if (sessions.some(x => x.id === id)) await window.api?.deleteSession?.(id);
        if (folders.some(x => x.id === id)) await (window as any).api.deleteFolder(id);
      }
      await reload();
      setSelectedId(null);
      setSelectedIds(new Set());
      return;
    }
    // 단일 선택 삭제
    if (!selectedId) return;
    if (selectedType === 'folder') {
      const f = folders.find(x => x.id === selectedId);
      if (!f || !confirm(`폴더 [${f.name}]를 삭제하시겠습니까?`)) return;
      await (window as any).api.deleteFolder(selectedId);
      await reload();
      setSelectedId(null);
      return;
    }
    const s = sessions.find(x => x.id === selectedId);
    if (!s || !confirm(`세션 [${s.name}]를 삭제하시겠습니까?`)) return;
    await window.api?.deleteSession?.(selectedId);
    await reload();
    setSelectedId(null);
  };

  const handleAddFolder = async () => {
    const parentId = selectedType === 'folder' ? selectedId : undefined;
    const folder = { id: `folder-${Date.now()}`, name: 'New Folder', parentId: parentId ?? undefined };
    await (window as any).api.saveFolder(folder);
    await reload();
  };

  const handleRenameSubmit = async () => {
    if (!renamingId || !renameValue.trim()) { setRenamingId(null); return; }
    if (renamingType === 'folder') {
      const f = folders.find(x => x.id === renamingId);
      if (f) { await (window as any).api.saveFolder({ ...f, name: renameValue.trim() }); }
    } else {
      const s = sessions.find(x => x.id === renamingId);
      if (s) { await (window as any).api.saveSession({ ...s, name: renameValue.trim() }); }
    }
    setRenamingId(null);
    await reload();
  };

  const startRename = (id: string, type: 'session' | 'folder', currentName: string) => {
    setRenamingId(id);
    setRenamingType(type);
    setRenameValue(currentName);
  };

  const toggleCollapse = (folderId: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      next.has(folderId) ? next.delete(folderId) : next.add(folderId);
      return next;
    });
  };

  const handleEncodingChange = async (sessionId: string, encoding: string) => {
    const s = sessions.find(x => x.id === sessionId);
    if (!s) return;
    await window.api?.saveSession?.({ ...s, encoding });
    await reload();
    setSelectedId(sessionId);
  };

  const onSaveSession = async (s: Session) => {
    await (window as any).api.saveSession(s);
    setEditing(null);
    await reload();
    setSelectedId(s.id);
    setSelectedType('session');
  };

  // 드래그로 세션을 폴더에 이동
  const handleSessionDrop = async (sessionId: string, targetFolderId: string | undefined) => {
    const s = sessions.find(x => x.id === sessionId);
    if (!s) return;
    await (window as any).api.saveSession({ ...s, folderId: targetFolderId });
    await reload();
  };

  const selectedSession = selectedType === 'session' ? sessions.find(x => x.id === selectedId) : null;

  // 재귀 트리 렌더링
  const renderTree = (parentId?: string, depth = 0) => {
    const childFolders = folders.filter(f => (f.parentId ?? undefined) === parentId);
    const childSessions = sessions.filter(s => (s.folderId ?? undefined) === parentId);

    return (
      <>
        {childFolders.map(f => {
          const isCollapsed = collapsed.has(f.id);
          const isSelected = selectedId === f.id && selectedType === 'folder';
          return (
            <React.Fragment key={f.id}>
              <div
                className={`session-item folder-item ${isSelected || selectedIds.has(f.id) ? 'selected' : ''} ${dragOverId === f.id ? 'drag-over' : ''}`}
                style={{ paddingLeft: 8 + depth * 16 }}
                onClick={e => {
                  if (e.ctrlKey || e.metaKey) {
                    setSelectedIds(prev => {
                      const next = new Set(prev);
                      if (next.size === 0 && selectedId) next.add(selectedId);
                      next.has(f.id) ? next.delete(f.id) : next.add(f.id);
                      return next;
                    });
                  } else {
                    setSelectedId(f.id); setSelectedType('folder'); setSelectedIds(new Set());
                  }
                }}
                onDoubleClick={() => toggleCollapse(f.id)}
                onContextMenu={e => { e.preventDefault(); setSelectedId(f.id); setSelectedType('folder'); setContextMenu({ x: e.clientX, y: e.clientY, id: f.id, type: 'folder', name: f.name }); }}
                onDragOver={e => { if (e.dataTransfer.types.includes('text/session-id')) { e.preventDefault(); e.stopPropagation(); setDragOverId(f.id); } }}
                onDragLeave={e => { e.stopPropagation(); setDragOverId(null); }}
                onDrop={e => {
                  e.stopPropagation();
                  const sid = e.dataTransfer.getData('text/session-id');
                  if (sid) { e.preventDefault(); handleSessionDrop(sid, f.id); }
                  setDragOverId(null);
                }}
              >
                <span className="folder-toggle" onClick={e => { e.stopPropagation(); toggleCollapse(f.id); }}>
                  {isCollapsed ? '▶' : '▼'}
                </span>
                <span className="folder-icon">📁</span>
                {renamingId === f.id ? (
                  <input
                    className="folder-rename-input"
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onBlur={handleRenameSubmit}
                    onKeyDown={e => { if (e.key === 'Enter') handleRenameSubmit(); if (e.key === 'Escape') setRenamingId(null); }}
                    autoFocus
                    onClick={e => e.stopPropagation()}
                  />
                ) : (
                  <span className="folder-name">{f.name}</span>
                )}
              </div>
              {!isCollapsed && renderTree(f.id, depth + 1)}
            </React.Fragment>
          );
        })}
        {childSessions.map(s => (
          <div
            key={s.id}
            className={`session-item ${(selectedId === s.id && selectedType === 'session') || selectedIds.has(s.id) ? 'selected' : ''}`}
            style={{ paddingLeft: 8 + depth * 16 }}
            onClick={e => {
              if (e.ctrlKey || e.metaKey) {
                setSelectedIds(prev => {
                  const next = new Set(prev);
                  if (next.size === 0 && selectedId) next.add(selectedId);
                  next.has(s.id) ? next.delete(s.id) : next.add(s.id);
                  return next;
                });
              } else {
                setSelectedId(s.id); setSelectedType('session'); setSelectedIds(new Set());
              }
            }}
            onDoubleClick={() => { if (renamingId !== s.id) handleConnect(s); }}
            onContextMenu={e => { e.preventDefault(); setSelectedId(s.id); setSelectedType('session'); setContextMenu({ x: e.clientX, y: e.clientY, id: s.id, type: 'session', name: s.name }); }}
            draggable={renamingId !== s.id}
            onDragStart={e => {
              e.dataTransfer.setData('text/session-id', s.id);
              e.dataTransfer.effectAllowed = 'move';
              const el = e.currentTarget as HTMLElement;
              e.dataTransfer.setDragImage(el, el.offsetWidth / 2, el.offsetHeight / 2);
            }}
            onDragEnd={() => setDragOverId(null)}
          >
            {renamingId === s.id ? (
              <input
                className="folder-rename-input"
                value={renameValue}
                onChange={e => setRenameValue(e.target.value)}
                onBlur={handleRenameSubmit}
                onKeyDown={e => { if (e.key === 'Enter') handleRenameSubmit(); if (e.key === 'Escape') setRenamingId(null); }}
                autoFocus
                onClick={e => e.stopPropagation()}
              />
            ) : (
              <>
                <div className="session-item-name">{s.icon && <span className="session-icon">{s.icon}</span>}{s.name}</div>
                <div className="session-item-host">{s.host}:{s.port}</div>
              </>
            )}
          </div>
        ))}
      </>
    );
  };

  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMouseEnterTrigger = () => {
    if (pinned) return;
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
    setVisible(true);
  };

  const handleMouseLeaveSidebar = () => {
    if (pinned) return;
    hideTimer.current = setTimeout(() => setVisible(false), 500);
  };

  const handleMouseEnterSidebar = () => {
    if (pinned) return;
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
  };

  return (
    <div className="session-sidebar">
      {/* 자동숨기기 모드: 세로 탭 트리거 */}
      {!pinned && (
        <div className="session-sidebar-trigger">
          <div className="session-sidebar-trigger-top" onMouseEnter={handleMouseEnterTrigger}>
            <span className="session-sidebar-trigger-text">📡 세션 관리</span>
          </div>
          <div className="session-sidebar-trigger-bottom" />
        </div>
      )}
      <div
        ref={containerRef}
        className={`session-sidebar-inner ${!pinned ? 'auto-hide' : ''} ${!pinned && !visible ? 'hidden' : ''}`}
        style={{ width }}
        onMouseLeave={handleMouseLeaveSidebar}
        onMouseEnter={handleMouseEnterSidebar}
      >
        <div className="session-toolbar">
          <div className="session-toolbar-title">세션 관리</div>
          <button
            className={`btn-pin ${pinned ? 'pinned' : ''}`}
            onClick={() => setPinned(p => !p)}
            title={pinned ? 'Unpin (auto-hide)' : 'Pin sidebar'}
          >
            📌
          </button>
        </div>

        <div className="session-bottom-actions">
          <button className="btn-add" onClick={handleAddFolder} title="폴더 추가">📁+</button>
          <button className="btn-add" onClick={handleAdd}>추가</button>
          <button className="btn-edit" onClick={handleEdit} disabled={!selectedId}>편집</button>
          <button className="btn-delete" onClick={handleDelete} disabled={!selectedId}>삭제</button>
        </div>

        <div
          className="session-list-scroll"
          tabIndex={0}
          onClick={e => { if (e.target === e.currentTarget) { setSelectedId(null); setSelectedType('session'); setSelectedIds(new Set()); } }}
          onKeyDown={e => {
            if (e.key === 'F2' && selectedId) {
              e.preventDefault();
              if (selectedType === 'folder') {
                const f = folders.find(x => x.id === selectedId);
                if (f) startRename(f.id, 'folder', f.name);
              } else {
                const s = sessions.find(x => x.id === selectedId);
                if (s) startRename(s.id, 'session', s.name);
              }
            }
            // Delete: 선택 항목 삭제
            if (e.key === 'Delete' && selectedId) {
              e.preventDefault();
              handleDelete();
            }
            // Ctrl+C: 세션 복사
            if ((e.ctrlKey || e.metaKey) && e.key === 'c' && selectedId && selectedType === 'session') {
              e.preventDefault();
              const s = sessions.find(x => x.id === selectedId);
              if (s) setCopiedSession(s);
            }
            // Ctrl+V: 세션 붙여넣기
            if ((e.ctrlKey || e.metaKey) && e.key === 'v' && copiedSession) {
              e.preventDefault();
              const newSess = { ...copiedSession, id: `sess-${Date.now()}`, name: `${copiedSession.name} (복사)` };
              (async () => { await (window as any).api.saveSession(newSess); await reload(); setSelectedId(newSess.id); setSelectedType('session'); })();
            }
          }}
          onDragOver={e => { if (e.dataTransfer.types.includes('text/session-id')) { e.preventDefault(); setDragOverId('root'); } }}
          onDragLeave={() => setDragOverId(null)}
          onDrop={e => {
            const sid = e.dataTransfer.getData('text/session-id');
            if (sid) { e.preventDefault(); handleSessionDrop(sid, undefined); }
            setDragOverId(null);
          }}
        >
          {renderTree(undefined, 0)}
        </div>

        {selectedId && selectedSession && (
          <div className="session-footer">
            <label>Encoding</label>
            <select
              value={selectedSession.encoding ?? 'utf-8'}
              onChange={e => handleEncodingChange(selectedId, e.target.value)}
            >
              <option value="utf-8">utf-8</option>
              <option value="cp949">cp949</option>
              <option value="euc-kr">euc-kr</option>
              <option value="latin1">latin1</option>
            </select>
            <div className="session-footer-actions">
              <button onClick={() => handleConnect(selectedSession)}>연결</button>
              <button onClick={() => setSelectedId(null)}>닫기</button>
              <button onClick={handleDisconnect}>연결 끊기</button>
            </div>
          </div>
        )}

        <div className="session-resize-handle" onPointerDown={onPointerDown} />
      </div>

      {editing && <SessionEditor session={editing} folders={folders} onSave={onSaveSession} onCancel={() => setEditing(null)} />}

      {folderPicker && (() => {
        const renderTree = (parentId?: string, depth = 0): React.ReactNode[] => {
          const children = folders.filter(f => (f.parentId ?? undefined) === parentId);
          const nodes: React.ReactNode[] = [];
          for (const f of children) {
            const sess = sessions.find(s => s.id === folderPicker.sessionId);
            if (sess && (sess.folderId ?? undefined) === f.id) continue;
            nodes.push(
              <div key={f.id} className="folder-picker-item" style={{ paddingLeft: 12 + depth * 16 }} onClick={() => {
                (async () => { await (window as any).api.moveToFolder(folderPicker.sessionId, f.id); await reload(); })();
                setFolderPicker(null);
              }}>
                📁 {f.name}
              </div>
            );
            nodes.push(...renderTree(f.id, depth + 1));
          }
          return nodes;
        };
        return (
          <div className="folder-picker-backdrop" onClick={() => setFolderPicker(null)}>
            <div className="folder-picker" onClick={e => e.stopPropagation()}>
              <div className="folder-picker-title">폴더로 이동</div>
              <div className="folder-picker-list">
                <div className="folder-picker-item" onClick={() => {
                  (async () => { await (window as any).api.moveToFolder(folderPicker.sessionId, null); await reload(); })();
                  setFolderPicker(null);
                }}>
                  📂 (루트)
                </div>
                {renderTree(undefined, 0)}
              </div>
              <div className="folder-picker-actions">
                <button onClick={() => setFolderPicker(null)}>취소</button>
              </div>
            </div>
          </div>
        );
      })()}

      {contextMenu && (
        <div
          className="context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={e => e.stopPropagation()}
        >
          <div className="context-menu-item" onClick={() => { startRename(contextMenu.id, contextMenu.type, contextMenu.name); setContextMenu(null); }}>
            이름 변경
          </div>
          <div className="context-menu-item" onClick={() => {
            setSelectedId(contextMenu.id);
            setSelectedType(contextMenu.type);
            setContextMenu(null);
            handleDelete();
          }}>
            삭제
          </div>
          {contextMenu.type === 'session' && (
            <>
              <div className="context-menu-item" onClick={() => {
                const s = sessions.find(x => x.id === contextMenu.id);
                if (s) { setEditing(s); }
                setContextMenu(null);
              }}>
                편집
              </div>
              <div className="context-menu-item" onClick={() => {
                const s = sessions.find(x => x.id === contextMenu.id);
                if (s) setCopiedSession(s);
                setContextMenu(null);
              }}>
                복사
              </div>
            </>
          )}
          {copiedSession && (
            <div className="context-menu-item" onClick={() => {
              const newSess = { ...copiedSession, id: `sess-${Date.now()}`, name: `${copiedSession.name} (복사)` };
              (async () => { await (window as any).api.saveSession(newSess); await reload(); setSelectedId(newSess.id); setSelectedType('session'); })();
              setContextMenu(null);
            }}>
              붙여넣기
            </div>
          )}
          {contextMenu.type === 'session' && (
            <div className="context-menu-item" onClick={() => {
              const s = sessions.find(x => x.id === contextMenu.id);
              if (s) onFileTransfer?.(s.id, s.name);
              setContextMenu(null);
            }}>
              📁 파일 전송
            </div>
          )}
          {contextMenu.type === 'session' && folders.length > 0 && (
            <>
              <div className="context-menu-separator" />
              <div className="context-menu-item" onClick={() => {
                setFolderPicker({ sessionId: contextMenu.id });
                setContextMenu(null);
              }}>
                📂 폴더로 이동...
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};

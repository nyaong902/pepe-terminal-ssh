// src/components/FilePanel.tsx
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ContextMenu } from './ContextMenu';

export type FileInfo = {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
};

export type PanelSource = {
  // 'lazy-remote' 는 아직 연결되지 않은 원격 세션 (FileExplorer 가 선택 시 자동 SFTP 연결)
  mode: 'local' | 'remote' | 'lazy-remote';
  termId?: string;
  sessionId?: string; // lazy-remote 용 식별자
  label: string;
};

type SortKey = 'name' | 'size' | 'mtime';
type SortDir = 'asc' | 'desc';

type Props = {
  source: PanelSource;
  sources: PanelSource[];
  onSourceChange: (src: PanelSource) => void;
  selectedFiles: Set<string>;
  onSelectionChange: (sel: Set<string>) => void;
  currentPath: string;
  onPathChange: (path: string) => void;
  onFileDrop?: (files: string[], srcMode: string, srcTermId?: string, srcPath?: string) => void;
  onDisconnect?: () => void;
  panelId: string;
  refreshKey?: number;
};

const api = (window as any).api || {};

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

function formatDate(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export const FilePanel: React.FC<Props> = ({ source, sources, onSourceChange, selectedFiles, onSelectionChange, currentPath, onPathChange, onFileDrop, onDisconnect, panelId, refreshKey }) => {
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [editPath, setEditPath] = useState(currentPath);
  const [editingPath, setEditingPath] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file?: FileInfo } | null>(null);
  const [renamingFile, setRenamingFile] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [lastClickIdx, setLastClickIdx] = useState(-1);
  const listRef = useRef<HTMLDivElement | null>(null);
  const dragJustEnded = useRef(false);

  const loadDir = useCallback(async (dir: string) => {
    if (!dir) return;
    setLoading(true);
    setError('');
    try {
      if (typeof api.feListDir !== 'function') { setError('API를 사용할 수 없습니다. 앱을 재시작해주세요.'); setFiles([]); setLoading(false); return; }
      const result = await api.feListDir(source.mode, dir, source.termId);
      if (result?.error) { setError(result.error); setFiles([]); }
      else { setFiles(result?.files || []); }
    } catch (e: any) { setError(String(e)); setFiles([]); }
    setLoading(false);
  }, [source.mode, source.termId]);

  useEffect(() => { loadDir(currentPath); }, [currentPath, loadDir, refreshKey]);
  useEffect(() => { setEditPath(currentPath); }, [currentPath]);

  const sep = source.mode === 'local' && navigator.platform.startsWith('Win') ? '\\' : '/';

  const navigate = (dir: string) => {
    onPathChange(dir);
  };

  const goUp = () => {
    let parent: string;
    if (source.mode === 'local' && navigator.platform.startsWith('Win')) {
      parent = currentPath.replace(/\\[^\\]*\\?$/, '') || currentPath.slice(0, 3);
    } else {
      parent = currentPath.replace(/\/[^/]*\/?$/, '') || '/';
    }
    navigate(parent);
  };

  const enterDir = (name: string) => {
    const newPath = currentPath.endsWith(sep) ? currentPath + name : currentPath + sep + name;
    navigate(newPath);
  };

  const handleDoubleClick = (file: FileInfo) => {
    if (file.isDir) enterDir(file.name);
  };

  const handleClick = (file: FileInfo, idx: number, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selectedFiles);
      next.has(file.name) ? next.delete(file.name) : next.add(file.name);
      onSelectionChange(next);
    } else if (e.shiftKey && lastClickIdx >= 0) {
      const sorted = getSortedFiles();
      const start = Math.min(lastClickIdx, idx);
      const end = Math.max(lastClickIdx, idx);
      const next = new Set(selectedFiles);
      for (let i = start; i <= end; i++) next.add(sorted[i].name);
      onSelectionChange(next);
    } else {
      onSelectionChange(new Set([file.name]));
    }
    setLastClickIdx(idx);
  };

  const getSortedFiles = useCallback(() => {
    const valid = files.filter(f => f && f.name);
    const sorted = valid.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      let cmp = 0;
      if (sortKey === 'name') cmp = (a.name || '').localeCompare(b.name || '');
      else if (sortKey === 'size') cmp = (a.size || 0) - (b.size || 0);
      else cmp = (a.mtime || 0) - (b.mtime || 0);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [files, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  };

  const handleContextMenu = (e: React.MouseEvent, file?: FileInfo) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, file });
  };

  const handleDelete = async (name: string) => {
    const targets = selectedFiles.size > 1 && selectedFiles.has(name) ? [...selectedFiles] : [name];
    if (!confirm(`${targets.length}개 항목을 삭제하시겠습니까?\n${targets.join(', ')}`)) return;
    try {
      for (const f of targets) {
        const filePath = currentPath.endsWith(sep) ? currentPath + f : currentPath + sep + f;
        await api.feDelete?.(source.mode, filePath, source.termId);
      }
      onSelectionChange(new Set());
      loadDir(currentPath);
    } catch {}
  };

  const handleMkdir = async () => {
    const name = prompt('새 폴더 이름:');
    if (!name) return;
    try {
      const dirPath = currentPath.endsWith(sep) ? currentPath + name : currentPath + sep + name;
      await api.feMkdir?.(source.mode, dirPath, source.termId);
      loadDir(currentPath);
    } catch {}
  };

  const handleRenameSubmit = async (oldName: string) => {
    if (!renameValue.trim() || renameValue === oldName) { setRenamingFile(null); return; }
    try {
      const oldPath = currentPath.endsWith(sep) ? currentPath + oldName : currentPath + sep + oldName;
      const newPath = currentPath.endsWith(sep) ? currentPath + renameValue : currentPath + sep + renameValue;
      await api.feRename?.(source.mode, oldPath, newPath, source.termId);
      setRenamingFile(null);
      loadDir(currentPath);
    } catch { setRenamingFile(null); }
  };

  const sortedFiles = getSortedFiles();
  const sortIcon = (key: SortKey) => sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  return (
    <div className="fe-panel">
      <div className="fe-panel-header">
        {source.mode === 'remote' && onDisconnect && (
          <button className="fe-disconnect-btn" onClick={onDisconnect} title="연결 끊기">✕</button>
        )}
        <select className="fe-source-select" value={`${source.mode}:${source.termId || source.sessionId || ''}`}
          onChange={e => {
            const [m, t] = [e.target.value.split(':')[0], e.target.value.split(':').slice(1).join(':')];
            const s = sources.find(s => s.mode === m && ((s.termId || s.sessionId || '') === t));
            if (s) onSourceChange(s);
          }}
        >
          {(() => {
            const localSources = sources.filter(s => s.mode === 'local');
            const connected = sources.filter(s => s.mode === 'remote');
            const lazy = sources.filter(s => s.mode === 'lazy-remote');
            const renderOpt = (s: PanelSource) => (
              <option key={`${s.mode}:${s.termId || s.sessionId || ''}`} value={`${s.mode}:${s.termId || s.sessionId || ''}`}>{s.label}</option>
            );
            return (
              <>
                {localSources.map(renderOpt)}
                {connected.length > 0 && (
                  <optgroup label="🟢 연결됨">
                    {connected.map(renderOpt)}
                  </optgroup>
                )}
                {lazy.length > 0 && (
                  <optgroup label="⚪ 연결 안됨">
                    {lazy.map(renderOpt)}
                  </optgroup>
                )}
              </>
            );
          })()}
        </select>
      </div>
      <div className="fe-path-bar">
        <button className="fe-path-btn" onClick={goUp} title="상위 폴더">⬆</button>
        <button className="fe-path-btn" onClick={() => loadDir(currentPath)} title="새로고침">🔄</button>
        {editingPath ? (
          <input className="fe-path-input" value={editPath} onChange={e => setEditPath(e.target.value)}
            onBlur={() => { setEditingPath(false); navigate(editPath); }}
            onKeyDown={e => { if (e.key === 'Enter') { setEditingPath(false); navigate(editPath); } if (e.key === 'Escape') setEditingPath(false); }}
            autoFocus
          />
        ) : (
          <div className="fe-path-display" onClick={() => setEditingPath(true)}>{currentPath}</div>
        )}
      </div>
      <div className="fe-file-header">
        <span className="fe-col-name" onClick={() => toggleSort('name')}>이름{sortIcon('name')}</span>
        <span className="fe-col-size" onClick={() => toggleSort('size')}>크기{sortIcon('size')}</span>
        <span className="fe-col-date" onClick={() => toggleSort('mtime')}>날짜{sortIcon('mtime')}</span>
      </div>
      <div className="fe-file-list" tabIndex={0} ref={listRef}
        onClick={e => { if (e.target === e.currentTarget && !dragJustEnded.current) onSelectionChange(new Set()); }}
        onMouseDown={e => {
          if (e.button !== 0) return;
          const target = e.target as HTMLElement;
          if (target.closest('.fe-file-row') || target.closest('.fe-rename-input')) return;
          if (!listRef.current) return;
          const startY = e.clientY;
          let currentY = startY;
          const addToExisting = e.ctrlKey || e.metaKey;
          const baseSel = addToExisting ? new Set(selectedFiles) : new Set<string>();

          // DOM 직접 조작으로 사각형 표시 (state 업데이트 없이)
          const overlay = document.createElement('div');
          overlay.className = 'fe-drag-select';
          overlay.style.position = 'absolute';
          overlay.style.left = '0';
          overlay.style.right = '0';
          overlay.style.pointerEvents = 'none';
          overlay.style.zIndex = '5';
          listRef.current.appendChild(overlay);

          if (!addToExisting) onSelectionChange(new Set());

          const onMove = (ev: MouseEvent) => {
            currentY = ev.clientY;
            const rect = listRef.current!.getBoundingClientRect();
            const top = Math.min(startY, currentY) - rect.top + listRef.current!.scrollTop;
            const height = Math.abs(currentY - startY);
            overlay.style.top = top + 'px';
            overlay.style.height = height + 'px';

            // 선택 업데이트 (throttle: 프레임당 1번)
            if (!(overlay as any).__raf) {
              (overlay as any).__raf = requestAnimationFrame(() => {
                const rows = listRef.current!.querySelectorAll('.fe-file-row');
                const sel = new Set(baseSel);
                const minY = Math.min(startY, currentY);
                const maxY = Math.max(startY, currentY);
                rows.forEach(row => {
                  const r = row.getBoundingClientRect();
                  if (r.bottom >= minY && r.top <= maxY) {
                    const name = row.getAttribute('data-name');
                    if (name) sel.add(name);
                  }
                });
                onSelectionChange(sel);
                (overlay as any).__raf = null;
              });
            }
          };
          const onUp = () => {
            overlay.remove();
            dragJustEnded.current = true;
            setTimeout(() => { dragJustEnded.current = false; }, 100);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
          };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        }}
        onKeyDown={e => {
          if (e.key === 'Delete' && selectedFiles.size > 0) {
            e.preventDefault();
            handleDelete([...selectedFiles][0]);
          }
          if (e.key === 'F2' && selectedFiles.size > 0) {
            e.preventDefault();
            const sorted = getSortedFiles();
            const first = sorted.find(f => selectedFiles.has(f.name));
            if (first) { setRenamingFile(first.name); setRenameValue(first.name); }
          }
          // prefix 키 점프 — 단일 키 누르면 해당 문자로 시작하는 첫 파일 선택, 같은 키 반복 시 순환
          if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
            const sorted = getSortedFiles();
            const ch = e.key.toLowerCase();
            // 현재 선택된 파일 다음부터 찾기 (같은 키 반복 시 순환)
            const curIdx = sorted.findIndex(f => selectedFiles.has(f.name));
            let target = -1;
            for (let i = 1; i <= sorted.length; i++) {
              const idx = (curIdx + i) % sorted.length;
              if (sorted[idx].name.toLowerCase().startsWith(ch)) { target = idx; break; }
            }
            if (target >= 0) {
              e.preventDefault();
              onSelectionChange(new Set([sorted[target].name]));
              // 스크롤 위치 조정
              setTimeout(() => {
                const el = document.querySelector(`.fe-file-row[data-name="${CSS.escape(sorted[target].name)}"]`) as HTMLElement | null;
                el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
              }, 0);
            }
          }
        }}
        onContextMenu={e => handleContextMenu(e)}
        onDragOver={e => { if (e.dataTransfer.types.includes('text/fe-files')) { e.preventDefault(); e.currentTarget.classList.add('fe-drop-target'); } }}
        onDragLeave={e => { e.currentTarget.classList.remove('fe-drop-target'); }}
        onDrop={e => {
          e.currentTarget.classList.remove('fe-drop-target');
          const raw = e.dataTransfer.getData('text/fe-files');
          if (!raw) return;
          e.preventDefault();
          try {
            const data = JSON.parse(raw);
            if (data.panelId !== panelId) onFileDrop?.(data.files, data.srcMode, data.srcTermId, data.srcPath);
          } catch {}
        }}
      >
        {loading && <div className="fe-loading">로딩 중...</div>}
        {error && <div className="fe-error">{error}</div>}
        {!loading && !error && sortedFiles.map((file, idx) => (
          <div key={file.name} data-name={file.name}
            className={`fe-file-row ${selectedFiles.has(file.name) ? 'selected' : ''}`}
            onClick={e => handleClick(file, idx, e)}
            onDoubleClick={() => handleDoubleClick(file)}
            onContextMenu={e => { e.stopPropagation(); handleContextMenu(e, file); }}
            draggable
            onDragStart={e => {
              const filesToDrag = selectedFiles.has(file.name) ? [...selectedFiles] : [file.name];
              e.dataTransfer.setData('text/fe-files', JSON.stringify({
                panelId, files: filesToDrag, srcMode: source.mode, srcTermId: source.termId, srcPath: currentPath,
              }));
              e.dataTransfer.effectAllowed = 'copy';
            }}
          >
            <span className="fe-col-name">
              <span className="fe-file-icon">{file.isDir ? '📁' : '📄'}</span>
              {renamingFile === file.name ? (
                <input className="fe-rename-input" value={renameValue}
                  onChange={e => setRenameValue(e.target.value)}
                  onBlur={() => handleRenameSubmit(file.name)}
                  onKeyDown={e => { if (e.key === 'Enter') handleRenameSubmit(file.name); if (e.key === 'Escape') setRenamingFile(null); }}
                  autoFocus onClick={e => e.stopPropagation()}
                />
              ) : (
                <span className="fe-file-name">{file.name}</span>
              )}
            </span>
            <span className="fe-col-size">{file.isDir ? '' : formatSize(file.size)}</span>
            <span className="fe-col-date">{formatDate(file.mtime)}</span>
          </div>
        ))}
        <div className="fe-file-padding"
          draggable={selectedFiles.size > 0}
          onDragStart={e => {
            if (selectedFiles.size === 0) return;
            e.dataTransfer.setData('text/fe-files', JSON.stringify({
              panelId, files: [...selectedFiles], srcMode: source.mode, srcTermId: source.termId, srcPath: currentPath,
            }));
            e.dataTransfer.effectAllowed = 'copy';
          }}
        />
      </div>
      <div className="fe-status-bar">
        {files.length}개 항목 | {selectedFiles.size}개 선택
      </div>

      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={() => setContextMenu(null)} items={[
          ...(contextMenu.file ? [
            { label: '이름 변경', onClick: () => { setRenamingFile(contextMenu.file!.name); setRenameValue(contextMenu.file!.name); } },
            { label: '삭제', onClick: () => handleDelete(contextMenu.file!.name) },
          ] : []),
          { label: '새 폴더', onClick: handleMkdir },
          { label: '새로고침', onClick: () => loadDir(currentPath) },
        ]} />
      )}
    </div>
  );
};

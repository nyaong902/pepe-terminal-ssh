// src/components/FileExplorer.tsx
import React, { useState, useEffect } from 'react';
import { FilePanel, PanelSource } from './FilePanel';
import type { PanelSession } from '../utils/layoutUtils';

const api = (window as any).api || {};

type Props = {
  sessions: PanelSession[];
};

export const FileExplorer: React.FC<Props> = ({ sessions }) => {
  const [sources, setSources] = useState<PanelSource[]>([{ mode: 'local', label: '🖥️ 로컬' }]);
  const [leftSource, setLeftSource] = useState<PanelSource>({ mode: 'local', label: '🖥️ 로컬' });
  const [rightSource, setRightSource] = useState<PanelSource>({ mode: 'local', label: '🖥️ 로컬' });
  const [leftPath, setLeftPath] = useState('C:\\');
  const [rightPath, setRightPath] = useState('C:\\');
  const [leftSelected, setLeftSelected] = useState<Set<string>>(new Set());
  const [rightSelected, setRightSelected] = useState<Set<string>>(new Set());
  const [transferring, setTransferring] = useState(false);
  const [transfers, setTransfers] = useState<{ id: string; filename: string; pct: number; done: boolean }[]>([]);
  const [initDone, setInitDone] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const rightSourceSetRef = React.useRef(false);
  const [showSftpConnect, setShowSftpConnect] = useState<'left' | 'right' | null>(null);
  const [selectedSide, setSelectedSide] = useState<'left' | 'right'>('left');
  const [sftpHost, setSftpHost] = useState('');
  const [sftpPort, setSftpPort] = useState(22);
  const [sftpUser, setSftpUser] = useState('');
  const [sftpPass, setSftpPass] = useState('');
  const [sftpConnecting, setSftpConnecting] = useState(false);
  const [transfersHeight, setTransfersHeight] = useState(() => {
    const saved = localStorage.getItem('feTransfersHeight');
    return saved ? Number(saved) : 120;
  });
  const resizing = React.useRef<{ startY: number; startH: number } | null>(null);
  // 세션 ID → 폴더 이름 매핑 (드롭다운 label 에 폴더 접두사 붙이기용)
  const [sessionFolderMap, setSessionFolderMap] = useState<Record<string, string>>({});
  // 전체 세션 리스트 (드롭다운 확장용 — 미연결 포함)
  const [allSessionsList, setAllSessionsList] = useState<any[]>([]);
  // lazy 연결로 생성된 SFTP 임시 connId — FileExplorer unmount 시 정리
  const [lazyConns, setLazyConns] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data: any = await api.listSessions?.();
        if (cancelled) return;
        const allSessions: any[] = data?.sessions ?? [];
        const folders: any[] = data?.folders ?? [];
        setAllSessionsList(allSessions);
        const folderById: Record<string, any> = {};
        for (const f of folders) folderById[f.id] = f;
        const folderPath = (fid?: string): string => {
          if (!fid) return '';
          const f = folderById[fid];
          if (!f) return '';
          const parent = folderPath(f.parentId);
          return parent ? `${parent}/${f.name}` : f.name;
        };
        const map: Record<string, string> = {};
        for (const s of allSessions) map[s.id] = folderPath(s.folderId);
        setSessionFolderMap(map);
      } catch {}
    };
    load();
    return () => { cancelled = true; };
  }, [sessions.length]);

  // 언마운트 시 lazy 연결 정리
  useEffect(() => {
    return () => {
      for (const cid of lazyConns) {
        try { api?.feSftpDisconnect?.(cid); } catch {}
      }
    };
  }, [lazyConns]);

  // 초기 경로
  useEffect(() => {
    (async () => {
      try {
        const home = await api?.feGetHome?.();
        if (home) { setLeftPath(home); setRightPath(home); }
      } catch {}
      setInitDone(true);
    })();

    // SFTP 진행률
    let unsub: any, unsub2: any;
    try {
      unsub = api?.onSFTPProgress?.((p: any) => {
        try {
          const d = JSON.parse(p.data);
          setTransfers(prev => {
            const existing = prev.find(t => t.filename === d.filename && !t.done);
            if (existing) return prev.map(t => t === existing ? { ...t, pct: d.total > 0 ? Math.round(d.transferred / d.total * 100) : 0 } : t);
            return [...prev, { id: `t-${Date.now()}`, filename: d.filename, pct: d.total > 0 ? Math.round(d.transferred / d.total * 100) : 0, done: false }];
          });
        } catch {}
      });
      unsub2 = api?.onSFTPComplete?.((p: any) => {
        try {
          const d = JSON.parse(p.data);
          setTransfers(prev => prev.map(t => t.filename === d.filename && !t.done ? { ...t, pct: 100, done: true } : t));
        } catch {}
        setTransferring(false);
      });
    } catch {}
    return () => { try { unsub?.(); } catch {} try { unsub2?.(); } catch {} };
  }, []);

  // 파일 전송 탭에서 세션 더블클릭으로 SFTP 연결된 이벤트 수신
  useEffect(() => {
    const handler = async (e: Event) => {
      const { connId, sessionName, host } = (e as CustomEvent).detail;
      setSources(prev => {
        // 같은 세션 이름 번호 매기기
        const sameNameCount = prev.filter(s => s.label?.includes(sessionName)).length;
        const num = sameNameCount + 1;
        const label = `🌐 ${sessionName} #${num} (${host})`;
        const newSrc: PanelSource = { mode: 'remote', termId: connId, label };
        if (prev.find(s => s.termId === connId)) return prev;
        const idx = prev.findIndex(s => (s.mode as any) === 'sftp-connect');
        const arr = [...prev];
        if (idx >= 0) arr.splice(idx, 0, newSrc);
        else arr.push(newSrc);
        // 오른쪽 패널이 로컬이면 자동 전환
        if (rightSource.mode === 'local') {
          setRightSource(newSrc);
          getHomeWithRetry('remote', connId).then(p => setRightPath(p));
        }
        return arr;
      });
    };
    window.addEventListener('fe-sftp-connected', handler);
    return () => window.removeEventListener('fe-sftp-connected', handler);
  }, [rightSource.mode]);

  // 빠른 연결 바에서 들어오는 SFTP 직접 연결 요청 처리
  useEffect(() => {
    const handler = async (ev: any) => {
      const info = ev.detail || {};
      if (!info.host || !info.username) return;
      const connId = `sftp-${Date.now()}`;
      try {
        const result = await api.feSftpConnect?.(connId, info.host, Number(info.port) || 22, info.username, { type: 'password', password: info.auth?.password ?? '' });
        if (!result?.success) { alert(`연결 실패: ${result?.error || '알 수 없는 오류'}`); return; }
        const newSrc: PanelSource = { mode: 'remote', termId: connId, label: `🔌 ${info.username}@${info.host}` };
        setSources(prev => {
          if (prev.find(s => s.termId === connId)) return prev;
          const idx = prev.findIndex(s => (s.mode as any) === 'sftp-connect');
          const arr = [...prev];
          if (idx >= 0) arr.splice(idx, 0, newSrc); else arr.push(newSrc);
          return arr;
        });
        // 현재 선택된 패널에 SFTP 연결 배치
        if (selectedSide === 'left') {
          setLeftSource(newSrc);
          try { const home = await api.feHomeDir('remote', connId); setLeftPath(home || '/'); } catch { setLeftPath('/'); }
        } else {
          setRightSource(newSrc);
          try { const home = await api.feHomeDir('remote', connId); setRightPath(home || '/'); } catch { setRightPath('/'); }
        }
      } catch (err: any) { alert(`연결 실패: ${err}`); }
    };
    window.addEventListener('fe-quick-sftp-connect', handler);
    return () => window.removeEventListener('fe-quick-sftp-connect', handler);
  }, [selectedSide]);

  // sessions prop 변경 시 소스 목록 갱신
  const sessKey = sessions.map(s => s.termId).join(',');
  useEffect(() => {
    const newSources: PanelSource[] = [{ mode: 'local', label: '🖥️ 로컬' }];
    // 이미 터미널로 연결된 세션의 sessionId
    const connectedSessionIds = new Set(sessions.map(s => s.sessionId).filter(Boolean));
    // 1) 이미 연결된 세션을 먼저 🟢 로 추가
    for (const sess of sessions) {
      const folder = sessionFolderMap[sess.sessionId];
      const label = folder ? `🟢 ${sess.sessionName}  [${folder}]` : `🟢 ${sess.sessionName}`;
      newSources.push({ mode: 'remote', termId: sess.termId, sessionId: sess.sessionId, label });
    }
    // 2) 미연결 세션을 ⚪ (lazy-remote) 로 추가 — 선택 시 자동 백그라운드 SFTP 연결
    for (const s of allSessionsList) {
      if (connectedSessionIds.has(s.id)) continue;
      const folder = sessionFolderMap[s.id];
      const label = folder ? `⚪ ${s.name}  [${folder}] (${s.host})` : `⚪ ${s.name} (${s.host})`;
      newSources.push({ mode: 'lazy-remote', sessionId: s.id, label });
    }
    // 3) 기존 수동 SFTP 연결(🔌) 유지
    for (const s of sources) {
      if (s.label?.startsWith('🔌') && s.mode === 'remote' && !newSources.find(n => n.termId === s.termId)) {
        newSources.push(s);
      }
    }
    newSources.push({ mode: 'sftp-connect' as any, label: '🔌 SFTP 직접 연결...' });
    setSources(newSources);
    // 최초 1회만: 원격 소스가 있고 rightSource가 로컬이면 첫 원격을 오른쪽 기본으로
    if (initDone && sessions.length > 0 && rightSource.mode === 'local' && !rightSourceSetRef.current) {
      rightSourceSetRef.current = true;
      const first = sessions[0];
      const newSrc: PanelSource = { mode: 'remote', termId: first.termId, label: `🌐 ${first.sessionName}` };
      setRightSource(newSrc);
      // SSH 연결 완료 대기 후 홈 디렉토리 가져오기 (최대 10초)
      const tryGetHome = async (retries: number) => {
        for (let i = 0; i < retries; i++) {
          try {
            const home = await api?.feHomeDir?.('remote', first.termId);
            if (home && home !== '/') { setRightPath(home); return; }
          } catch {}
          await new Promise(r => setTimeout(r, 1000));
        }
        setRightPath('/');
      };
      tryGetHome(10);
    }
  }, [sessKey, initDone, sessionFolderMap, allSessionsList]);

  const sep = (source: PanelSource) => source.mode === 'local' && navigator.platform.startsWith('Win') ? '\\' : '/';

  const getHomeWithRetry = async (mode: string, termId?: string): Promise<string> => {
    for (let i = 0; i < 5; i++) {
      try {
        const home = await api?.feHomeDir?.(mode, termId);
        if (home && home !== '/') return home;
      } catch {}
      if (mode === 'local') break;
      await new Promise(r => setTimeout(r, 1000));
    }
    return mode === 'local' ? 'C:\\' : '/';
  };

  // lazy-remote 소스를 실제 연결된 remote 소스로 변환. 실패 시 null 반환.
  const realizeLazyRemote = async (src: PanelSource): Promise<PanelSource | null> => {
    if (src.mode !== 'lazy-remote' || !src.sessionId) return null;
    const sess = allSessionsList.find(s => s.id === src.sessionId);
    if (!sess) { alert('세션 정보를 찾을 수 없습니다'); return null; }
    const connId = `fe-lazy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const jumpOpts = sess.jumpTargetHost?.trim()
      ? { host: sess.jumpTargetHost.trim(), user: sess.jumpTargetUser || 'root', port: Number(sess.jumpTargetPort) || 22, password: sess.jumpTargetPassword || undefined }
      : undefined;
    try {
      const r: any = await api?.feSftpConnect?.(connId, sess.host, sess.port || 22, sess.username, sess.auth, jumpOpts);
      if (!r?.success) {
        alert(`연결 실패 (${sess.name}): ${r?.error || '알 수 없는 오류'}`);
        return null;
      }
    } catch (err: any) {
      alert(`연결 실패 (${sess.name}): ${err?.message || err}`);
      return null;
    }
    setLazyConns(prev => [...prev, connId]);
    const folder = sessionFolderMap[sess.id];
    const label = folder ? `🟢 ${sess.name}  [${folder}]` : `🟢 ${sess.name}`;
    const newSrc: PanelSource = { mode: 'remote', termId: connId, sessionId: sess.id, label };
    // 소스 리스트 업데이트 — lazy 항목 제거하고 연결된 항목 추가
    setSources(prev => {
      const filtered = prev.filter(s => !(s.mode === 'lazy-remote' && s.sessionId === sess.id));
      // '직접 연결' 항목 앞에 삽입
      const idx = filtered.findIndex(s => (s.mode as any) === 'sftp-connect');
      const arr = [...filtered];
      if (idx >= 0) arr.splice(idx, 0, newSrc); else arr.push(newSrc);
      return arr;
    });
    return newSrc;
  };

  const handleLeftSourceChange = async (src: PanelSource) => {
    if (src.mode === 'sftp-connect' as any) { setShowSftpConnect('left'); return; }
    if (src.mode === 'lazy-remote') {
      const real = await realizeLazyRemote(src);
      if (!real) return;
      setLeftSource(real);
      setLeftPath(await getHomeWithRetry('remote', real.termId));
      return;
    }
    setLeftSource(src);
    setLeftPath(await getHomeWithRetry(src.mode, src.termId));
  };

  const handleRightSourceChange = async (src: PanelSource) => {
    if (src.mode === 'sftp-connect' as any) { setShowSftpConnect('right'); return; }
    if (src.mode === 'lazy-remote') {
      const real = await realizeLazyRemote(src);
      if (!real) return;
      setRightSource(real);
      setRightPath(await getHomeWithRetry('remote', real.termId));
      return;
    }
    setRightSource(src);
    setRightPath(await getHomeWithRetry(src.mode, src.termId));
  };

  const handleDisconnect = async (src: PanelSource) => {
    if (src.mode !== 'remote' || !src.termId) return;
    try { await api?.feSftpDisconnect?.(src.termId); } catch {}
    setSources(prev => prev.filter(s => s.termId !== src.termId));
    if (leftSource.termId === src.termId) { setLeftSource({ mode: 'local', label: '🖥️ 로컬' }); setLeftPath(await getHomeWithRetry('local')); }
    if (rightSource.termId === src.termId) { setRightSource({ mode: 'local', label: '🖥️ 로컬' }); setRightPath(await getHomeWithRetry('local')); }
  };

  const handleSftpConnect = async () => {
    if (!sftpHost || !sftpUser) return;
    setSftpConnecting(true);
    const connId = `sftp-${Date.now()}`;
    try {
      const result = await api.feSftpConnect?.(connId, sftpHost, sftpPort, sftpUser, { type: 'password', password: sftpPass });
      if (!result?.success) { alert(`연결 실패: ${result?.error || '알 수 없는 오류'}`); setSftpConnecting(false); return; }
      const newSrc: PanelSource = { mode: 'remote', termId: connId, label: `🔌 ${sftpUser}@${sftpHost}` };
      setSources(prev => [...prev, newSrc]);
      if (showSftpConnect === 'left') {
        setLeftSource(newSrc);
        try { const home = await api.feHomeDir('remote', connId); setLeftPath(home || '/'); } catch { setLeftPath('/'); }
      } else {
        setRightSource(newSrc);
        try { const home = await api.feHomeDir('remote', connId); setRightPath(home || '/'); } catch { setRightPath('/'); }
      }
    } catch (err: any) { alert(`연결 실패: ${err}`); }
    setSftpConnecting(false);
    setShowSftpConnect(null);
    setSftpHost(''); setSftpPort(22); setSftpUser(''); setSftpPass('');
  };

  const transferFiles = async (direction: 'left-to-right' | 'right-to-left') => {
    const srcSource = direction === 'left-to-right' ? leftSource : rightSource;
    const dstSource = direction === 'left-to-right' ? rightSource : leftSource;
    const srcPath = direction === 'left-to-right' ? leftPath : rightPath;
    const dstPath = direction === 'left-to-right' ? rightPath : leftPath;
    const selected = direction === 'left-to-right' ? leftSelected : rightSelected;
    const dstSep = sep(dstSource);
    const srcSep = sep(srcSource);

    if (selected.size === 0) return;
    setTransferring(true);

    for (const name of selected) {
      const srcFull = srcPath.endsWith(srcSep) ? srcPath + name : srcPath + srcSep + name;
      const dstFull = dstPath.endsWith(dstSep) ? dstPath + name : dstPath + dstSep + name;
      try {
        const result = await api.feTransfer?.(
          { mode: srcSource.mode, termId: srcSource.termId, path: srcFull },
          { mode: dstSource.mode, termId: dstSource.termId, path: dstFull },
          name,
        );
        if (result && !result.success) {
          alert(`전송 실패: ${name}\n${result.error}`);
        }
      } catch (err: any) {
        alert(`전송 실패: ${name}\n${err}`);
      }
    }

    setTransferring(false);
    setTimeout(() => setTransfers(prev => prev.filter(t => !t.done)), 3000);
    setRefreshKey(k => k + 1);
  };

  const handleFileDrop = async (targetSide: 'left' | 'right', fileNames: string[], srcMode: string, srcTermId?: string, srcPath?: string) => {
    const dstSource = targetSide === 'left' ? leftSource : rightSource;
    const dstPath = targetSide === 'left' ? leftPath : rightPath;
    const dstSep = sep(dstSource);
    const srcSep = srcMode === 'local' && navigator.platform.startsWith('Win') ? '\\' : '/';

    setTransferring(true);
    for (const name of fileNames) {
      const srcFull = (srcPath || '').endsWith(srcSep) ? (srcPath || '') + name : (srcPath || '') + srcSep + name;
      const dstFull = dstPath.endsWith(dstSep) ? dstPath + name : dstPath + dstSep + name;
      try {
        await api.feTransfer?.(
          { mode: srcMode, termId: srcTermId, path: srcFull },
          { mode: dstSource.mode, termId: dstSource.termId, path: dstFull },
          name,
        );
      } catch (err: any) {
        alert(`전송 실패: ${name}\n${err}`);
      }
    }
    setTransferring(false);
    setTimeout(() => setTransfers(prev => prev.filter(t => !t.done)), 3000);
    setRefreshKey(k => k + 1);
  };

  const onResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    resizing.current = { startY: e.clientY, startH: transfersHeight };
    const onMove = (ev: MouseEvent) => {
      if (!resizing.current) return;
      const delta = resizing.current.startY - ev.clientY;
      const newH = Math.max(40, Math.min(400, resizing.current.startH + delta));
      setTransfersHeight(newH);
    };
    const onUp = () => {
      resizing.current = null;
      localStorage.setItem('feTransfersHeight', String(transfersHeight));
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  try { return (
    <div className="fe-container">
      <div className="fe-dual">
        <div className={`fe-panel-wrap ${selectedSide === 'left' ? 'selected' : ''}`} onMouseDownCapture={() => setSelectedSide('left')}>
          <FilePanel panelId="left" refreshKey={refreshKey}
            source={leftSource} sources={sources} onSourceChange={handleLeftSourceChange}
            selectedFiles={leftSelected} onSelectionChange={setLeftSelected}
            currentPath={leftPath} onPathChange={setLeftPath}
            onFileDrop={(files, srcMode, srcTermId, srcPath) => handleFileDrop('left', files, srcMode, srcTermId, srcPath)}
            onDisconnect={() => handleDisconnect(leftSource)}
          />
        </div>
        <div className="fe-transfer-btns">
          <button className="fe-transfer-btn" onClick={() => transferFiles('left-to-right')} disabled={transferring || leftSelected.size === 0} title="오른쪽으로 전송">→</button>
          <button className="fe-transfer-btn" onClick={() => transferFiles('right-to-left')} disabled={transferring || rightSelected.size === 0} title="왼쪽으로 전송">←</button>
        </div>
        <div className={`fe-panel-wrap ${selectedSide === 'right' ? 'selected' : ''}`} onMouseDownCapture={() => setSelectedSide('right')}>
          <FilePanel panelId="right" refreshKey={refreshKey}
            source={rightSource} sources={sources} onSourceChange={handleRightSourceChange}
            selectedFiles={rightSelected} onSelectionChange={setRightSelected}
            currentPath={rightPath} onPathChange={setRightPath}
            onFileDrop={(files, srcMode, srcTermId, srcPath) => handleFileDrop('right', files, srcMode, srcTermId, srcPath)}
            onDisconnect={() => handleDisconnect(rightSource)}
          />
        </div>
      </div>
      <div className="fe-transfers-resize" onMouseDown={onResizeStart} />
      <div className="fe-transfers" style={{ height: transfersHeight }}>
        <div className="fe-transfers-header">전송 목록</div>
        {transfers.length === 0 && <div className="fe-transfers-empty">전송 대기 중...</div>}
        {transfers.map(t => (
          <div key={t.id} className={`fe-transfer-row ${t.done ? 'done' : ''}`}>
            <span className="fe-transfer-icon">{t.done ? '✅' : '⏳'}</span>
            <span className="fe-transfer-text">{t.filename}</span>
            <div className="fe-progress-track">
              <div className="fe-progress-fill" style={{ width: `${t.pct}%` }} />
            </div>
            <span className="fe-progress-pct">{t.pct}%</span>
          </div>
        ))}
      </div>
      {showSftpConnect && (
        <div className="session-editor-backdrop" onClick={() => setShowSftpConnect(null)}>
          <div className="session-editor" onClick={e => e.stopPropagation()} style={{ width: 400 }}>
            <h3>🔌 SFTP 직접 연결</h3>
            <div className="session-editor-grid">
              <label>호스트</label>
              <input value={sftpHost} onChange={e => setSftpHost(e.target.value)} placeholder="192.168.0.1" autoFocus />
              <label>포트</label>
              <input type="number" value={sftpPort} onChange={e => setSftpPort(Number(e.target.value) || 22)} />
              <label>사용자</label>
              <input value={sftpUser} onChange={e => setSftpUser(e.target.value)} placeholder="root" />
              <label>비밀번호</label>
              <input type="password" value={sftpPass} onChange={e => setSftpPass(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSftpConnect(); }}
              />
            </div>
            <div className="session-editor-actions">
              <button className="btn-cancel" onClick={() => setShowSftpConnect(null)}>취소</button>
              <button className="btn-save" onClick={handleSftpConnect} disabled={sftpConnecting}>
                {sftpConnecting ? '연결 중...' : '연결'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  ); } catch (err: any) {
    return <div style={{ padding: 20, color: '#e74c3c' }}>파일 탐색기 로드 실패: {String(err)}</div>;
  }
};

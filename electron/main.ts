// electron/main.ts
import { app, BrowserWindow, ipcMain, dialog, Menu, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import * as pty from 'node-pty';
import { fileURLToPath } from 'url';
import { loadSessionsData, saveSessionsData, getSessionsPath, saveCustomPath, loadUIPrefs, saveUIPrefs, Session, Folder, SessionsData } from './sessionsStore';
import { getSSHBridge } from './sshBridge';
import { createWebDAVBridge } from './webdavBridge';
// MCP 서버 스크립트를 번들에 임베드 (vite ?raw) — 런타임에 임시 파일로 추출 후 spawn
// @ts-ignore
import mcpSshServerScript from './mcpSshServer.cjs?raw';
// @ts-ignore
import claudeHookScript from './claudeHookScript.cjs?raw';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
(globalThis as any).__dirname = __dirname;

// 멀티 인스턴스 캐시 충돌 방지
const instanceId = `${process.pid}-${Date.now()}`;
const sessionDataPath = path.join(app.getPath('userData'), `session-${instanceId}`);
app.setPath('sessionData', sessionDataPath);

let mainWindow: BrowserWindow | null = null;
let sessionsData: SessionsData = { folders: [], sessions: [] };
const connectedPanels = new Set<string>();
const connectingPanels = new Set<string>();

// Safety net — ssh2 같은 라이브러리에서 뒤늦게 던지는 stray error 로 앱 전체가
// 다이얼로그와 함께 죽지 않도록 uncaught 를 로깅만 하고 삼킨다.
// 치명적 원인은 소스에서 제대로 처리해야 하지만, 최소한 사용자 경험 보호용.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.stack || err);
  try { mainWindow?.webContents.send('debug:log', `[uncaughtException] ${err?.message || err}`); } catch {}
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  try { mainWindow?.webContents.send('debug:log', `[unhandledRejection] ${(reason as any)?.message || reason}`); } catch {}
});

// 커맨드라인에서 전달된 초기 경로 (탐색기 우클릭 → "터미널에서 열기")
function getStartupCwd(): string | null {
  // 1) 커맨드라인 인자에서 경로 탐색
  const args = process.argv.slice(app.isPackaged ? 1 : 2);
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    try {
      const stat = fs.statSync(arg);
      if (stat.isDirectory()) return arg;
      if (stat.isFile()) return path.dirname(arg);
    } catch {}
  }
  // 2) 임시 파일에서 경로 읽기 (portable 대응)
  const tmpFile = path.join(require('os').tmpdir(), '.pepe-terminal-cwd');
  try {
    const fileStat = fs.statSync(tmpFile);
    // 30초 이내 생성된 파일만 사용 (이전 세션 잔여 파일 무시)
    const tooOld = Date.now() - fileStat.mtimeMs > 30000;
    // 읽기 후 즉시 삭제 (어떤 경우든 파일은 삭제)
    const cwd = tooOld ? '' : fs.readFileSync(tmpFile, 'utf8').trim();
    fs.unlinkSync(tmpFile);
    if (cwd) {
      try {
        const dirStat = fs.statSync(cwd);
        if (dirStat.isDirectory()) return cwd;
        if (dirStat.isFile()) return path.dirname(cwd);
      } catch {}
    }
  } catch {
    // 파일이 없거나 읽기 실패 — 삭제 한번 더 시도
    try { fs.unlinkSync(tmpFile); } catch {}
  }
  return null;
}
let startupCwd: string | null = getStartupCwd();

// 창 최대화 상태 + 복원 좌표
let isMaximized = false;
let savedBounds = { x: 100, y: 100, width: 1400, height: 900 };

function createWindow() {
  if (app.isPackaged) Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    icon: path.join(__dirname, '../public/icon.ico'),
    frame: false,
    transparent: true,
    hasShadow: false,
    show: false, // 준비 완료 후 표시
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // 콘텐츠 렌더링 완료 후 창 표시 (빈 화면 방지)
  mainWindow.once('ready-to-show', () => { mainWindow?.show(); });

  const devServerUrl = process.env['ELECTRON_RENDERER_URL'] || process.env['VITE_DEV_SERVER_URL'];
  if (!app.isPackaged && devServerUrl) {
    mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  // 타이틀바 더블클릭 → 최대화 토글
  mainWindow.on('maximize', () => {
    console.log('[window] maximize event, bounds:', mainWindow?.getBounds());
    isMaximized = true;
    mainWindow?.webContents.send('window:maximized', true);
  });
  mainWindow.on('unmaximize', () => {
    console.log('[window] unmaximize event, bounds:', mainWindow?.getBounds(), 'savedBounds:', savedBounds);
    isMaximized = false;
    // savedBounds의 위치/크기로 강제 복원 (Windows native restore 좌표 오류 방지)
    if (mainWindow) {
      const cur = mainWindow.getBounds();
      if (cur.x !== savedBounds.x || cur.y !== savedBounds.y || cur.width !== savedBounds.width || cur.height !== savedBounds.height) {
        mainWindow.setBounds(savedBounds);
      }
    }
    mainWindow?.webContents.send('window:maximized', false);
  });
  // non-maximized 상태에서 resize/move가 멈춘 후 300ms 뒤 savedBounds 갱신 (debounce)
  let savedBoundsTimer: NodeJS.Timeout | null = null;
  const updateSaved = () => {
    if (savedBoundsTimer) clearTimeout(savedBoundsTimer);
    savedBoundsTimer = setTimeout(() => {
      if (!mainWindow || isMaximized || mainWindow.isMaximized() || mainWindow.isFullScreen()) return;
      savedBounds = mainWindow.getBounds();
    }, 300);
  };
  mainWindow.on('resize', updateSaved);
  mainWindow.on('move', updateSaved);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── App lifecycle ──

app.whenReady().then(() => {
  sessionsData = loadSessionsData();
  createWindow();

  const bridge = getSSHBridge();
  bridge.onMessage((msg) => {
    if (!mainWindow) return;

    switch (msg.type) {
      case 'data':
        mainWindow.webContents.send('ssh:data', { panelId: msg.panelId, data: msg.data });
        break;
      case 'connected':
        connectingPanels.delete(msg.panelId);
        connectedPanels.add(msg.panelId);
        mainWindow.webContents.send('ssh:connected', { panelId: msg.panelId });
        break;
      case 'closed':
        connectingPanels.delete(msg.panelId);
        connectedPanels.delete(msg.panelId);
        mainWindow.webContents.send('ssh:closed', { panelId: msg.panelId });
        break;
      case 'error':
        connectingPanels.delete(msg.panelId);
        mainWindow.webContents.send('ssh:error', { panelId: msg.panelId, error: msg.error });
        break;
      case 'auth-prompt':
        mainWindow.webContents.send('ssh:auth-prompt', { panelId: msg.panelId, prompts: msg.prompts });
        break;
      case 'sftp-progress':
        mainWindow.webContents.send('sftp:progress', { panelId: msg.panelId, data: msg.data });
        break;
      case 'sftp-complete':
        mainWindow.webContents.send('sftp:complete', { panelId: msg.panelId, data: msg.data });
        break;
      case 'sftp-error':
        mainWindow.webContents.send('sftp:error', { panelId: msg.panelId, error: msg.error });
        break;
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 앱 시작 5초 후 비동기로 session-* 정리 (시작 속도에 영향 없음)
setTimeout(() => {
  try {
    const userDataDir = app.getPath('userData');
    for (const entry of fs.readdirSync(userDataDir)) {
      if (!entry.startsWith('session-')) continue;
      if (entry === `session-${instanceId}`) continue;
      try { fs.rmSync(path.join(userDataDir, entry), { recursive: true }); } catch {}
    }
  } catch {}
}, 5000);

// ── Session IPC ──

ipcMain.handle('sessions:path', () => {
  try { return getSessionsPath(); }
  catch { return ''; }
});

ipcMain.handle('sessions:set-path', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '세션 저장 경로 선택',
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const newPath = path.join(result.filePaths[0], 'sessions.json');
  saveCustomPath(newPath);
  // 새 경로에서 데이터 다시 로드
  sessionsData = loadSessionsData();
  return { path: newPath, data: sessionsData };
});

ipcMain.handle('sessions:reset-path', () => {
  saveCustomPath(null);
  sessionsData = loadSessionsData();
  return { path: getSessionsPath(), data: sessionsData };
});

ipcMain.handle('sessions:open-folder', () => {
  try { shell.openPath(path.dirname(path.join(app.getPath('userData'), 'sessions.json'))); }
  catch {}
});

ipcMain.handle('sessions:open-editor', () => {
  try { shell.openPath(path.join(app.getPath('userData'), 'sessions.json')); }
  catch {}
});

ipcMain.handle('ui-prefs:get', () => loadUIPrefs());
ipcMain.handle('ui-prefs:set', (_e, prefs: Record<string, any>) => { saveUIPrefs(prefs); return true; });

ipcMain.handle('app:startup-cwd', () => startupCwd);
ipcMain.handle('app:clear-startup-cwd', () => {
  startupCwd = null;
  // 임시 파일도 확실히 삭제
  try { fs.unlinkSync(path.join(require('os').tmpdir(), '.pepe-terminal-cwd')); } catch {}
});

// 탐색기 우클릭 컨텍스트 메뉴 등록/해제
ipcMain.handle('app:register-context-menu', () => {
  if (process.platform !== 'win32') return { success: false, error: 'Windows only' };
  const { execSync } = require('child_process');
  const os = require('os');
  try {
    // Portable: PORTABLE_EXECUTABLE_FILE 환경변수로 원본 exe 경로 사용
    const exePath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const tmpCwdFile = path.join(os.tmpdir(), '.pepe-terminal-cwd');
    const iconPath = app.isPackaged ? exePath : path.join(__dirname, '..', 'public', 'icon.ico');

    // 런처 vbs 생성 — 창 없이 경로를 임시파일에 쓰고 exe 실행
    const vbsPath = path.join(app.getPath('userData'), 'pepe-open-here.vbs');
    const vbsContent = [
      'Set fso = CreateObject("Scripting.FileSystemObject")',
      `Set f = fso.CreateTextFile("${tmpCwdFile}", True)`,
      'f.Write WScript.Arguments(0)',
      'f.Close',
      'Set sh = CreateObject("WScript.Shell")',
      `sh.Run """${exePath}""" & " """ & WScript.Arguments(0) & """", 1, False`,
    ].join('\r\n');
    fs.writeFileSync(vbsPath, vbsContent, 'utf8');

    const vbsEsc = vbsPath.replace(/\\/g, '\\\\');
    const iconEsc = iconPath.replace(/\\/g, '\\\\');

    execSync(`reg add "HKCU\\Software\\Classes\\Directory\\Background\\shell\\PepeTerminal" /ve /d "Open PePe Terminal here" /f`, { stdio: 'pipe' });
    execSync(`reg add "HKCU\\Software\\Classes\\Directory\\Background\\shell\\PepeTerminal" /v Icon /d "${iconEsc}" /f`, { stdio: 'pipe' });
    execSync(`reg add "HKCU\\Software\\Classes\\Directory\\Background\\shell\\PepeTerminal\\command" /ve /d "wscript \\"${vbsEsc}\\" \\"%V\\"" /f`, { stdio: 'pipe' });
    execSync(`reg add "HKCU\\Software\\Classes\\Directory\\shell\\PepeTerminal" /ve /d "Open PePe Terminal here" /f`, { stdio: 'pipe' });
    execSync(`reg add "HKCU\\Software\\Classes\\Directory\\shell\\PepeTerminal" /v Icon /d "${iconEsc}" /f`, { stdio: 'pipe' });
    execSync(`reg add "HKCU\\Software\\Classes\\Directory\\shell\\PepeTerminal\\command" /ve /d "wscript \\"${vbsEsc}\\" \\"%1\\"" /f`, { stdio: 'pipe' });
    return { success: true };
  } catch (err: any) { return { success: false, error: String(err) }; }
});

ipcMain.handle('app:unregister-context-menu', () => {
  if (process.platform !== 'win32') return { success: false, error: 'Windows only' };
  const { execSync } = require('child_process');
  try {
    execSync(`reg delete "HKCU\\Software\\Classes\\Directory\\Background\\shell\\PepeTerminal" /f`, { stdio: 'pipe' });
    execSync(`reg delete "HKCU\\Software\\Classes\\Directory\\shell\\PepeTerminal" /f`, { stdio: 'pipe' });
    return { success: true };
  } catch (err: any) { return { success: false, error: String(err) }; }
});

ipcMain.handle('app:check-context-menu', () => {
  if (process.platform !== 'win32') return false;
  const { execSync } = require('child_process');
  try {
    execSync(`reg query "HKCU\\Software\\Classes\\Directory\\Background\\shell\\PepeTerminal"`, { stdio: 'pipe' });
    return true;
  } catch { return false; }
});

ipcMain.handle('sessions:list', () => sessionsData);

ipcMain.handle('sessions:save', (_e, s: Session) => {
  const idx = sessionsData.sessions.findIndex(x => x.id === s.id);
  if (idx >= 0) sessionsData.sessions[idx] = s;
  else sessionsData.sessions.push(s);
  saveSessionsData(sessionsData);
  return sessionsData;
});

// childOrder 헬퍼: 부모의 자식 순서 목록 가져오기 (없으면 폴더 먼저, 세션 나중 기본값 생성)
function getChildOrder(parentId?: string): string[] {
  const key = parentId || '__root__';
  if (!sessionsData.childOrder) sessionsData.childOrder = {};
  if (!sessionsData.childOrder[key]) {
    // 기본값: 폴더 먼저, 세션 나중 (기존 동작 호환)
    const folders = sessionsData.folders.filter(f => (f.parentId ?? undefined) === parentId).map(f => f.id);
    const sessions = sessionsData.sessions.filter(s => (s.folderId ?? undefined) === parentId).map(s => s.id);
    sessionsData.childOrder[key] = [...folders, ...sessions];
  }
  // 실제 존재하는 항목만 필터 + 누락된 항목 추가
  const allIds = new Set([
    ...sessionsData.folders.filter(f => (f.parentId ?? undefined) === parentId).map(f => f.id),
    ...sessionsData.sessions.filter(s => (s.folderId ?? undefined) === parentId).map(s => s.id),
  ]);
  const order = sessionsData.childOrder[key].filter(id => allIds.has(id));
  for (const aid of allIds) { if (!order.includes(aid)) order.push(aid); }
  sessionsData.childOrder[key] = order;
  return order;
}

function setChildOrder(parentId: string | undefined, order: string[]) {
  if (!sessionsData.childOrder) sessionsData.childOrder = {};
  sessionsData.childOrder[parentId || '__root__'] = order;
}

function removeFromChildOrder(parentId: string | undefined, itemId: string) {
  const order = getChildOrder(parentId);
  const idx = order.indexOf(itemId);
  if (idx >= 0) order.splice(idx, 1);
  setChildOrder(parentId, order);
}

function addToChildOrder(parentId: string | undefined, itemId: string, position: 'first' | 'last' | { before: string } | { after: string }) {
  const order = getChildOrder(parentId);
  // 이미 있으면 제거
  const existIdx = order.indexOf(itemId);
  if (existIdx >= 0) order.splice(existIdx, 1);
  if (position === 'first') order.unshift(itemId);
  else if (position === 'last') order.push(itemId);
  else if ('before' in position) {
    const ti = order.indexOf(position.before);
    order.splice(ti >= 0 ? ti : 0, 0, itemId);
  } else {
    const ti = order.indexOf(position.after);
    order.splice(ti >= 0 ? ti + 1 : order.length, 0, itemId);
  }
  setChildOrder(parentId, order);
}

ipcMain.handle('sessions:reorder', (_e, { id, type, direction }: { id: string; type: 'session' | 'folder'; direction: 'up' | 'down' | 'top' | 'bottom' }) => {
  // 현재 부모 찾기
  let parentId: string | undefined;
  if (type === 'session') {
    const sess = sessionsData.sessions.find(s => s.id === id);
    if (!sess) return sessionsData;
    parentId = sess.folderId;
  } else {
    const folder = sessionsData.folders.find(f => f.id === id);
    if (!folder) return sessionsData;
    parentId = folder.parentId;
  }

  const order = getChildOrder(parentId);
  const idx = order.indexOf(id);
  if (idx < 0) return sessionsData;

  if (direction === 'top') {
    // 같은 폴더 내 맨 처음
    order.splice(idx, 1);
    order.unshift(id);
    setChildOrder(parentId, order);
  } else if (direction === 'bottom') {
    // 같은 폴더 내 맨 끝
    order.splice(idx, 1);
    order.push(id);
    setChildOrder(parentId, order);
  } else if (direction === 'up') {
    if (idx > 0) {
      const prevId = order[idx - 1];
      const prevIsFolder = sessionsData.folders.some(f => f.id === prevId);
      if (prevIsFolder) {
        // 위가 폴더 → 그 폴더 안으로 진입 (마지막 자식으로)
        removeFromChildOrder(parentId, id);
        if (type === 'session') {
          sessionsData.sessions.find(s => s.id === id)!.folderId = prevId;
        } else {
          sessionsData.folders.find(f => f.id === id)!.parentId = prevId;
        }
        addToChildOrder(prevId, id, 'last');
      } else {
        // 위가 세션 → swap
        [order[idx], order[idx - 1]] = [order[idx - 1], order[idx]];
        setChildOrder(parentId, order);
      }
    } else if (parentId) {
      // 폴더 맨 위 → 부모 폴더로 올라감
      removeFromChildOrder(parentId, id);
      if (type === 'session') {
        sessionsData.sessions.find(s => s.id === id)!.folderId = sessionsData.folders.find(f => f.id === parentId)?.parentId;
      } else {
        sessionsData.folders.find(f => f.id === id)!.parentId = sessionsData.folders.find(f => f.id === parentId)?.parentId;
      }
      const grandParentId = sessionsData.folders.find(f => f.id === parentId)?.parentId;
      addToChildOrder(grandParentId, id, { before: parentId });
    }
  } else { // down
    if (idx < order.length - 1) {
      // 아래 항목 확인: 폴더면 진입, 아니면 swap
      const nextId = order[idx + 1];
      const isFolder = sessionsData.folders.some(f => f.id === nextId);
      if (isFolder) {
        // 다음이 폴더 → 그 폴더에 진입 (첫 번째 자식으로)
        removeFromChildOrder(parentId, id);
        if (type === 'session') {
          sessionsData.sessions.find(s => s.id === id)!.folderId = nextId;
        } else {
          sessionsData.folders.find(f => f.id === id)!.parentId = nextId;
        }
        addToChildOrder(nextId, id, 'first');
      } else {
        // 다음이 세션 → swap
        [order[idx], order[idx + 1]] = [order[idx + 1], order[idx]];
        setChildOrder(parentId, order);
      }
    } else if (parentId) {
      // 폴더 맨 아래 → 부모 폴더 밖으로 (부모 뒤에 배치)
      removeFromChildOrder(parentId, id);
      if (type === 'session') {
        sessionsData.sessions.find(s => s.id === id)!.folderId = sessionsData.folders.find(f => f.id === parentId)?.parentId;
      } else {
        sessionsData.folders.find(f => f.id === id)!.parentId = sessionsData.folders.find(f => f.id === parentId)?.parentId;
      }
      const grandParentId = sessionsData.folders.find(f => f.id === parentId)?.parentId;
      addToChildOrder(grandParentId, id, { after: parentId });
    }
  }

  saveSessionsData(sessionsData);
  return sessionsData;
});

ipcMain.handle('sessions:move-to-folder', (_e, { sessionId, targetFolderId }: { sessionId: string; targetFolderId: string | null }) => {
  const sess = sessionsData.sessions.find(s => s.id === sessionId);
  if (!sess) return sessionsData;
  sess.folderId = targetFolderId ?? undefined;
  saveSessionsData(sessionsData);
  return sessionsData;
});

ipcMain.handle('sessions:delete', (_e, id: string) => {
  sessionsData.sessions = sessionsData.sessions.filter(s => s.id !== id);
  saveSessionsData(sessionsData);
  return sessionsData;
});

ipcMain.handle('folders:save', (_e, f: Folder) => {
  const idx = sessionsData.folders.findIndex(x => x.id === f.id);
  if (idx >= 0) sessionsData.folders[idx] = f;
  else sessionsData.folders.push(f);
  saveSessionsData(sessionsData);
  return sessionsData;
});

ipcMain.handle('folders:delete', (_e, id: string) => {
  // 하위 폴더의 parentId를 삭제된 폴더의 parentId로 올림
  const deleted = sessionsData.folders.find(f => f.id === id);
  const parentId = deleted?.parentId;
  sessionsData.folders = sessionsData.folders.filter(f => f.id !== id);
  sessionsData.folders.forEach(f => { if (f.parentId === id) f.parentId = parentId; });
  // 하위 세션의 folderId도 올림
  sessionsData.sessions.forEach(s => { if (s.folderId === id) s.folderId = parentId; });
  saveSessionsData(sessionsData);
  return sessionsData;
});

// ── SSH IPC ──

// ── Export/Import Sessions ──

ipcMain.handle('sessions:export', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Sessions',
    defaultPath: 'sessions-export.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return null;
  try {
    fs.writeFileSync(result.filePath, JSON.stringify(sessionsData, null, 2), 'utf8');
    return result.filePath;
  } catch { return null; }
});

ipcMain.handle('sessions:import', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Sessions',
    filters: [
      { name: 'All Supported', extensions: ['json', 'xml', 'xts'] },
      { name: 'PePe Terminal JSON', extensions: ['json'] },
      { name: 'SecureCRT XML', extensions: ['xml'] },
      { name: 'Xshell Backup (xts)', extensions: ['xts'] },
    ],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  const ext = path.extname(filePath).toLowerCase();
  try {
    let imported: SessionsData;
    if (ext === '.xml') {
      imported = parseSecureCRTXml(filePath);
    } else if (ext === '.xts') {
      imported = parseXshellXts(filePath);
    } else {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      imported = Array.isArray(raw)
        ? { folders: [], sessions: raw }
        : { folders: raw.folders ?? [], sessions: raw.sessions ?? [] };
    }
    // 기존 데이터에 머지 (중복: host+port+username 동일하면 스킵)
    for (const f of imported.folders) {
      const exists = sessionsData.folders.some(x => x.name === f.name && x.parentId === f.parentId);
      if (!exists) sessionsData.folders.push(f);
      else {
        // 같은 이름+부모의 기존 폴더 ID로 세션의 folderId를 매핑
        const existing = sessionsData.folders.find(x => x.name === f.name && x.parentId === f.parentId)!;
        for (const s of imported.sessions) {
          if (s.folderId === f.id) s.folderId = existing.id;
        }
        // 하위 폴더의 parentId도 매핑
        for (const cf of imported.folders) {
          if (cf.parentId === f.id) cf.parentId = existing.id;
        }
      }
    }
    let addedCount = 0;
    for (const s of imported.sessions) {
      const dup = sessionsData.sessions.some(x => x.host === s.host && x.port === s.port && x.username === s.username && x.name === s.name);
      if (!dup) { sessionsData.sessions.push(s); addedCount++; }
    }
    saveSessionsData(sessionsData);
    return { data: sessionsData, addedCount, totalParsed: imported.sessions.length };
  } catch (err: any) { console.error('Import error:', err); return null; }
});

// ── SecureCRT XML 파서 ──
function parseSecureCRTXml(filePath: string): SessionsData {
  const xml = fs.readFileSync(filePath, 'utf8');
  const lines = xml.split('\n');
  const folders: Folder[] = [];
  const sessions: Session[] = [];

  let inSessions = false;
  let depth = 0;
  const keyStack: { name: string; folderId?: string; props: Record<string, string> }[] = [];

  for (const line of lines) {
    if (line.includes('<key name="Sessions">')) { inSessions = true; depth = 0; continue; }
    if (!inSessions) continue;

    const keyMatch = line.match(/<key name="([^"]+)">/);
    if (keyMatch) {
      depth++;
      const parentFolderId = keyStack.length > 0 ? keyStack[keyStack.length - 1].folderId : undefined;
      keyStack.push({ name: keyMatch[1], folderId: undefined, props: {} });
      // 부모 폴더 ID 기억
      keyStack[keyStack.length - 1].folderId = `folder-scrt-${Date.now()}-${depth}-${Math.random().toString(36).slice(2, 6)}`;
      keyStack[keyStack.length - 1].props['_parentFolderId'] = parentFolderId || '';
      continue;
    }

    if (line.includes('</key>')) {
      if (keyStack.length > 0) {
        const item = keyStack.pop()!;
        const hostname = item.props['Hostname'];
        if (hostname) {
          // 이것은 세션
          const portStr = item.props['[SSH2] Port'] || '22';
          const username = item.props['Username'] || '';
          const encodingRaw = item.props['Output Transformer Name'] || '';
          let encoding = 'utf-8';
          if (encodingRaw.toLowerCase().includes('euc-kr') || encodingRaw.toLowerCase().includes('euc_kr')) encoding = 'euc-kr';
          else if (encodingRaw.toLowerCase().includes('cp949')) encoding = 'cp949';
          else if (encodingRaw.toLowerCase().includes('utf-8') || encodingRaw.toLowerCase().includes('utf8') || encodingRaw === 'UTF-8') encoding = 'utf-8';
          else if (encodingRaw) encoding = encodingRaw.toLowerCase();

          const parentFolderId = item.props['_parentFolderId'] || undefined;
          sessions.push({
            id: `sess-scrt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: item.name,
            host: hostname,
            port: parseInt(portStr, 10) || 22,
            username,
            encoding,
            folderId: parentFolderId || undefined,
            auth: { type: 'password', password: '' },
          });
        } else {
          // 하위 세션이 있었다면 이것은 폴더
          const hasSessions = sessions.some(s => s.folderId === item.folderId);
          const hasSubFolders = folders.some(f => f.parentId === item.folderId);
          if (hasSessions || hasSubFolders) {
            const parentFolderId = item.props['_parentFolderId'] || undefined;
            folders.push({
              id: item.folderId!,
              name: item.name,
              parentId: parentFolderId || undefined,
            });
          }
        }
      }
      depth--;
      if (depth < 0) break;
      continue;
    }

    // 프로퍼티 파싱
    if (keyStack.length > 0) {
      const strMatch = line.match(/<string name="([^"]+)">([^<]*)<\/string>/);
      if (strMatch) { keyStack[keyStack.length - 1].props[strMatch[1]] = strMatch[2]; continue; }
      const dwordMatch = line.match(/<dword name="([^"]+)">(\d+)<\/dword>/);
      if (dwordMatch) { keyStack[keyStack.length - 1].props[dwordMatch[1]] = dwordMatch[2]; continue; }
      const emptyStr = line.match(/<string name="([^"]+)"\/>/);
      if (emptyStr) { keyStack[keyStack.length - 1].props[emptyStr[1]] = ''; continue; }
    }
  }

  return { folders, sessions };
}

// ── Xshell xts(ZIP) 파서 ──
function parseXshellXts(filePath: string): SessionsData {
  const folders: Folder[] = [];
  const sessions: Session[] = [];
  const folderMap = new Map<string, string>(); // path → folderId

  // 임시 디렉토리에 추출
  const tmpDir = path.join(os.tmpdir(), `pepe-xshell-import-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // PowerShell Expand-Archive는 .zip만 허용하므로 .xts → .zip 복사 후 추출
    const zipCopy = path.join(tmpDir, 'import.zip');
    fs.copyFileSync(filePath, zipCopy);
    execSync(`powershell -Command "Expand-Archive -Path '${zipCopy}' -DestinationPath '${tmpDir}' -Force"`, { timeout: 30000 });
    try { fs.unlinkSync(zipCopy); } catch {}

    // Xshell 폴더 찾기
    const xshellDir = path.join(tmpDir, 'Xshell');
    if (!fs.existsSync(xshellDir)) {
      // Xshell 폴더가 없으면 tmpDir 자체를 탐색
      walkXshellDir(tmpDir, '', folders, sessions, folderMap);
    } else {
      walkXshellDir(xshellDir, '', folders, sessions, folderMap);
    }
  } finally {
    // 임시 디렉토리 정리
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  return { folders, sessions };
}

// Xshell encoding 숫자 → 문자열 매핑
function xshellEncodingMap(val: string): string {
  switch (val) {
    case '2': return 'euc-kr';
    case '0': case '65001': return 'utf-8';
    case '1': return 'cp949';
    case '28591': return 'latin1';
    default: return 'utf-8';
  }
}

function getOrCreateFolder(folderPath: string, folders: Folder[], folderMap: Map<string, string>): string | undefined {
  if (!folderPath || folderPath === '.') return undefined;
  if (folderMap.has(folderPath)) return folderMap.get(folderPath)!;

  const parts = folderPath.split(/[\\/]/);
  let currentPath = '';
  let parentId: string | undefined;

  for (const part of parts) {
    currentPath = currentPath ? `${currentPath}/${part}` : part;
    if (folderMap.has(currentPath)) {
      parentId = folderMap.get(currentPath)!;
      continue;
    }
    const folderId = `folder-xsh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    folders.push({ id: folderId, name: part, parentId });
    folderMap.set(currentPath, folderId);
    parentId = folderId;
  }
  return parentId;
}

function walkXshellDir(dir: string, relPath: string, folders: Folder[], sessions: Session[], folderMap: Map<string, string>) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkXshellDir(fullPath, relPath ? `${relPath}/${entry.name}` : entry.name, folders, sessions, folderMap);
    } else if (entry.name.endsWith('.xsh')) {
      try {
        const buf = fs.readFileSync(fullPath);
        const txt = buf.toString('utf16le');
        const lines = txt.split(/\r?\n/);
        let host = '', port = '22', user = '', enc = 'utf-8';
        let useExpectSend = false, expectSendCount = 0;
        const expectMap: Record<string, string> = {};
        const sendMap: Record<string, string> = {};
        for (const l of lines) {
          const m = l.match(/^(.+?)=(.*)$/);
          if (!m) continue;
          const k = m[1].trim(), v = m[2].trim();
          if (k === 'Host') host = v;
          if (k === 'Port') port = v;
          if (k === 'UserName') user = v;
          if (k === 'Encoding') enc = xshellEncodingMap(v);
          if (k === 'UseExpectSend' && v === '1') useExpectSend = true;
          if (k === 'ExpectSend_Count') expectSendCount = parseInt(v, 10) || 0;
          const expectMatch = k.match(/^ExpectSend_Expect_(\d+)$/);
          if (expectMatch) expectMap[expectMatch[1]] = v;
          const sendMatch = k.match(/^ExpectSend_Send_(\d+)$/);
          if (sendMatch) sendMap[sendMatch[1]] = v;
        }
        if (host) {
          const folderId = getOrCreateFolder(relPath, folders, folderMap);
          const name = entry.name.replace(/\.xsh$/, '');
          // Expect/Send 로그인 스크립트 변환
          const loginScript: { expect: string; send: string }[] = [];
          if (useExpectSend && expectSendCount > 0) {
            for (let i = 0; i < expectSendCount; i++) {
              const expect = expectMap[String(i)] ?? '';
              const send = sendMap[String(i)] ?? '';
              if (send) loginScript.push({ expect, send });
            }
          }
          sessions.push({
            id: `sess-xsh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name,
            host,
            port: parseInt(port, 10) || 22,
            username: user,
            encoding: enc,
            folderId,
            auth: { type: 'password', password: '' },
            loginScript: loginScript.length > 0 ? loginScript : undefined,
          });
        }
      } catch {}
    }
  }
}

// ── 파일 탐색기 IPC ──

ipcMain.handle('fe:list-dir', async (_e, { mode, termId, dirPath }: { mode: string; termId?: string; dirPath: string }) => {
  try {
    const bridge = getSSHBridge();
    if (mode === 'local') {
      return { files: await bridge.handleLocalListDir(dirPath) };
    } else {
      if (!termId) return { error: '연결 ID가 없습니다' };
      return { files: await bridge.handleSFTPListDir(termId, dirPath) };
    }
  } catch (err: any) { return { error: `${dirPath}: ${String(err)}` }; }
});

ipcMain.handle('fe:get-drives', async () => {
  // Windows 드라이브 목록
  if (process.platform === 'win32') {
    const drives: string[] = [];
    for (let i = 65; i <= 90; i++) {
      const d = String.fromCharCode(i) + ':\\';
      try { await fs.promises.access(d); drives.push(d); } catch {}
    }
    return drives;
  }
  return ['/'];
});

ipcMain.handle('fe:get-home', () => {
  return require('os').homedir();
});

ipcMain.handle('fe:transfer', async (_e, { src, dst, filename }: any) => {
  try {
    const bridge = getSSHBridge();
    await bridge.handleTransfer(src, dst, filename);
    return { success: true };
  } catch (err: any) { return { success: false, error: String(err) }; }
});

ipcMain.handle('fe:mkdir', async (_e, { mode, termId, dirPath }: any) => {
  try {
    const bridge = getSSHBridge();
    if (mode === 'local') await bridge.handleLocalMkdir(dirPath);
    else await bridge.handleSFTPMkdir(termId, dirPath);
    return { success: true };
  } catch (err: any) { return { success: false, error: String(err) }; }
});

ipcMain.handle('fe:delete', async (_e, { mode, termId, filePath }: any) => {
  try {
    const bridge = getSSHBridge();
    if (mode === 'local') await bridge.handleLocalDelete(filePath);
    else await bridge.handleSFTPDelete(termId, filePath);
    return { success: true };
  } catch (err: any) { return { success: false, error: String(err) }; }
});

ipcMain.handle('fe:rename', async (_e, { mode, termId, oldPath, newPath }: any) => {
  try {
    const bridge = getSSHBridge();
    if (mode === 'local') await bridge.handleLocalRename(oldPath, newPath);
    else await bridge.handleSFTPRename(termId, oldPath, newPath);
    return { success: true };
  } catch (err: any) { return { success: false, error: String(err) }; }
});

ipcMain.handle('fe:home-dir', async (_e, { mode, termId }: { mode: string; termId?: string }) => {
  try {
    const bridge = getSSHBridge();
    if (mode === 'local') return require('os').homedir();
    const home = await bridge.handleSFTPRealPath(termId!, '.');
    // 경로 접근 가능한지 확인
    try { await bridge.handleSFTPListDir(termId!, home); return home; } catch {}
    // 접근 불가하면 / 시도
    try { await bridge.handleSFTPListDir(termId!, '/'); return '/'; } catch {}
    return home;
  } catch { return '/'; }
});

ipcMain.handle('fe:sftp-connect', async (_e, { connId, host, port, username, auth }: any) => {
  try {
    const bridge = getSSHBridge();
    await bridge.handleSFTPConnect(connId, host, port || 22, username, auth);
    return { success: true };
  } catch (err: any) { return { success: false, error: String(err) }; }
});

ipcMain.handle('fe:sftp-disconnect', (_e, { connId }: any) => {
  const bridge = getSSHBridge();
  bridge.handleSFTPDisconnect(connId);
});

ipcMain.handle('fe:connected-sessions', () => {
  const bridge = getSSHBridge();
  return bridge.getConnectedPanelIds();
});

// ── SFTP IPC ──

ipcMain.handle('sftp:download', async (_e, { panelId, remotePath, isDir }: { panelId: string; remotePath: string; isDir?: boolean }) => {
  if (!mainWindow) return null;
  const bridge = getSSHBridge();
  const baseName = remotePath.split('/').filter(Boolean).pop() || 'download';
  if (isDir) {
    // 폴더 다운로드 — 부모 폴더 고른 뒤 그 안에 원격 폴더 이름으로 재귀 복사
    const pick = await dialog.showOpenDialog(mainWindow, {
      title: '다운로드 받을 위치 선택',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (pick.canceled || pick.filePaths.length === 0) return null;
    const parentDir = pick.filePaths[0];
    const localDst = path.join(parentDir, baseName);
    try {
      await bridge.handleTransfer(
        { mode: 'remote', termId: panelId, path: remotePath },
        { mode: 'local', path: localDst },
        baseName,
      );
      return { success: true, localPath: localDst };
    } catch (err: any) {
      return { success: false, error: String(err) };
    }
  }
  // 파일 다운로드 — 저장 이름까지 지정
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '원격 파일 저장',
    defaultPath: baseName,
  });
  if (result.canceled || !result.filePath) return null;
  try {
    await bridge.handleSFTPDownload(panelId, remotePath, result.filePath);
    return { success: true, localPath: result.filePath };
  } catch (err: any) {
    return { success: false, error: String(err) };
  }
});

ipcMain.handle('sftp:upload', async (_e, { panelId, remotePath, kind }: { panelId: string; remotePath: string; kind?: 'file' | 'folder' }) => {
  if (!mainWindow) return null;
  const isFolder = kind === 'folder';
  const result = await dialog.showOpenDialog(mainWindow, {
    title: isFolder ? '업로드할 폴더 선택' : '업로드할 파일 선택',
    properties: [isFolder ? 'openDirectory' : 'openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const localPath = result.filePaths[0];
  const filename = localPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
  const fullRemote = remotePath.endsWith('/') ? remotePath + filename : remotePath + '/' + filename;
  try {
    const bridge = getSSHBridge();
    if (isFolder) {
      await bridge.handleTransfer(
        { mode: 'local', path: localPath },
        { mode: 'remote', termId: panelId, path: fullRemote },
        filename,
      );
    } else {
      await bridge.handleSFTPUpload(panelId, localPath, fullRemote);
    }
    return { success: true, remotePath: fullRemote };
  } catch (err: any) {
    return { success: false, error: String(err) };
  }
});

ipcMain.handle('sftp:list-dir', async (_e, { panelId, remotePath }: { panelId: string; remotePath: string }) => {
  try {
    const bridge = getSSHBridge();
    return await bridge.handleSFTPListDir(panelId, remotePath);
  } catch (err: any) {
    return { error: String(err) };
  }
});

ipcMain.handle('sftp:read-file', async (_e, { panelId, remotePath, encoding }: { panelId: string; remotePath: string; encoding?: string }) => {
  try {
    const bridge = getSSHBridge();
    const buf = await bridge.handleSFTPReadFile(panelId, remotePath);
    const iconv = require('iconv-lite');
    const enc = (encoding || 'utf-8').toLowerCase();
    let text: string;
    try {
      if (enc === 'utf-8' || enc === 'utf8') {
        text = buf.toString('utf-8');
      } else if (iconv.encodingExists(enc)) {
        text = iconv.decode(buf, enc);
      } else {
        text = buf.toString('utf-8');
      }
    } catch {
      text = buf.toString('utf-8');
    }
    return { success: true, text, size: buf.length };
  } catch (err: any) {
    return { success: false, error: String(err) };
  }
});

ipcMain.handle('sftp:write-file', async (_e, { panelId, remotePath, content, encoding }: { panelId: string; remotePath: string; content: string; encoding?: string }) => {
  try {
    const bridge = getSSHBridge();
    const iconv = require('iconv-lite');
    const enc = (encoding || 'utf-8').toLowerCase();
    let buf: Buffer;
    if (enc === 'utf-8' || enc === 'utf8') {
      buf = Buffer.from(content, 'utf-8');
    } else if (iconv.encodingExists(enc)) {
      buf = iconv.encode(content, enc);
    } else {
      buf = Buffer.from(content, 'utf-8');
    }
    await bridge.handleSFTPWriteFile(panelId, remotePath, buf);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: String(err) };
  }
});



// ── 창 제어 ──
let dragStartPos: { x: number; y: number } | null = null;

ipcMain.on('window:start-drag', (_e, { mouseX, mouseY }: any) => {
  if (!mainWindow) return;
  const [wx, wy] = mainWindow.getPosition();
  dragStartPos = { x: mouseX - wx, y: mouseY - wy };
});

ipcMain.on('window:drag-move', (_e, { mouseX, mouseY }: any) => {
  if (!mainWindow || !dragStartPos) return;
  // 최대화 상태에서 드래그하면 자동 복원
  if (mainWindow.isMaximized()) {
    const restoreW = savedBounds.width;
    const restoreH = savedBounds.height;
    const offsetX = Math.min(dragStartPos.x, restoreW - 80);
    const newX = mouseX - offsetX;
    const newY = mouseY - Math.min(dragStartPos.y, 20);
    mainWindow.unmaximize();
    mainWindow.setBounds({ x: newX, y: newY, width: restoreW, height: restoreH });
    dragStartPos = { x: offsetX, y: Math.min(dragStartPos.y, 20) };
    isMaximized = false;
    return;
  }
  mainWindow.setPosition(mouseX - dragStartPos.x, mouseY - dragStartPos.y);
});

ipcMain.on('window:end-drag', () => { dragStartPos = null; });

ipcMain.handle('window:minimize', () => mainWindow?.minimize());
ipcMain.handle('window:toggle-maximize', () => {
  if (!mainWindow) return;
  dragStartPos = null;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
    isMaximized = false;
  } else {
    savedBounds = mainWindow.getBounds();
    mainWindow.maximize();
    isMaximized = true;
  }
  mainWindow.webContents.send('window:maximized', isMaximized);
});
ipcMain.handle('window:is-maximized', () => !!mainWindow?.isMaximized());
ipcMain.handle('window:close', () => mainWindow?.close());

ipcMain.handle('ssh:auth-response', (_e, { panelId, responses }: { panelId: string; responses: string[] }) => {
  const bridge = getSSHBridge();
  bridge.handleAuthResponse(panelId, responses);
  return 'ok';
});

ipcMain.handle('ssh:reset-state', (_e, panelId: string) => {
  connectedPanels.delete(panelId);
  connectingPanels.delete(panelId);
  return 'ok';
});

ipcMain.handle('ssh:connect', (_e, { panelId, sessionId, cols, rows }) => {
  if (connectingPanels.has(panelId)) return 'already';
  if (connectedPanels.has(panelId)) return 'already';

  const session = sessionsData.sessions.find(s => s.id === sessionId);
  if (!session) throw new Error('Session not found');

  // 비밀번호가 비어있으면 renderer에 비밀번호 요청
  const needsPassword = !session.auth || (session.auth.type === 'password' && !session.auth.password);
  if (needsPassword) {
    return 'need-password';
  }

  connectingPanels.add(panelId);

  const bridge = getSSHBridge();
  bridge.handleConnect(panelId, session, cols, rows);
  return 'ok';
});

ipcMain.handle('ssh:connect-with-password', (_e, { panelId, sessionId, password, cols, rows }) => {
  if (connectingPanels.has(panelId)) return 'already';
  if (connectedPanels.has(panelId)) return 'already';
  const session = sessionsData.sessions.find(s => s.id === sessionId);
  if (!session) throw new Error('Session not found');
  connectingPanels.add(panelId);
  const bridge = getSSHBridge();
  // 임시로 비밀번호를 설정해서 연결
  const sessionWithPw = { ...session, auth: { type: 'password' as const, password } };
  bridge.handleConnect(panelId, sessionWithPw, cols, rows);
  return 'ok';
});

ipcMain.handle('ssh:quick-connect', (_e, { panelId, session, cols, rows }) => {
  if (connectingPanels.has(panelId)) return 'already';
  if (connectedPanels.has(panelId)) return 'already';
  if (!session || !session.host || !session.username) throw new Error('Invalid session');

  connectingPanels.add(panelId);
  const bridge = getSSHBridge();
  bridge.handleConnect(panelId, session, cols, rows);
  return 'ok';
});

ipcMain.handle('ssh:is-connected', (_e, panelId: string) => {
  return connectedPanels.has(panelId);
});

ipcMain.on('ssh:input', (_e, { panelId, data, b64 }) => {
  getSSHBridge().handleInput(panelId, data, b64);
});

ipcMain.on('ssh:disconnect', (_e, { panelId }) => {
  getSSHBridge().handleDisconnect(panelId);
  if (webdavBridge) {
    try { webdavBridge.unregisterSession(panelId); } catch {}
  }
});

ipcMain.on('ssh:resize', (_e, { panelId, cols, rows }) => {
  getSSHBridge().handleResize(panelId, cols, rows);
});

ipcMain.handle('ssh:set-encoding', (_e, { panelId, encoding }) => {
  return getSSHBridge().setEncoding(panelId, encoding);
});

ipcMain.handle('ssh:get-encoding', (_e, panelId: string) => {
  return getSSHBridge().getEncoding(panelId);
});

// ── Local Shell (node-pty) ──
const ptyProcesses = new Map<string, pty.IPty>();

let shellsCache: { name: string; path: string; icon?: string }[] | null = null;
ipcMain.handle('pty:list-shells', async () => {
  if (shellsCache) return shellsCache;
  const shells: { name: string; path: string; icon?: string }[] = [];
  if (process.platform === 'win32') {
    shells.push({ name: 'Windows PowerShell', path: 'powershell.exe', icon: '⚡' });
    const pwshPaths = [
      path.join(process.env.ProgramFiles || '', 'PowerShell', '7', 'pwsh.exe'),
      path.join(process.env.ProgramFiles || '', 'PowerShell', '6', 'pwsh.exe'),
    ];
    for (const p of pwshPaths) {
      try { fs.accessSync(p); shells.push({ name: 'PowerShell Core', path: p, icon: '⚡' }); break; } catch {}
    }
    shells.push({ name: '명령 프롬프트 (CMD)', path: 'cmd.exe', icon: '▪' });
    const gitBashPaths = [
      path.join(process.env.ProgramFiles || '', 'Git', 'bin', 'bash.exe'),
      path.join(process.env['ProgramFiles(x86)'] || '', 'Git', 'bin', 'bash.exe'),
      'C:\\Program Files\\Git\\bin\\bash.exe',
    ];
    for (const p of gitBashPaths) {
      try { fs.accessSync(p); shells.push({ name: 'Git Bash', path: p, icon: '' }); break; } catch {}
    }
    try { fs.accessSync('C:\\Windows\\System32\\wsl.exe'); shells.push({ name: 'WSL', path: 'wsl.exe', icon: '🐧' }); } catch {}
  } else {
    const sh = process.env.SHELL || '/bin/bash';
    shells.push({ name: 'Default Shell', path: sh });
    if (sh !== '/bin/bash') try { fs.accessSync('/bin/bash'); shells.push({ name: 'Bash', path: '/bin/bash' }); } catch {}
    if (sh !== '/bin/zsh') try { fs.accessSync('/bin/zsh'); shells.push({ name: 'Zsh', path: '/bin/zsh' }); } catch {}
  }
  shellsCache = shells;
  return shells;
});

ipcMain.handle('pty:spawn', (_e, { panelId, shell: shellPath, cols, rows, cwd }: { panelId: string; shell?: string; cols?: number; rows?: number; cwd?: string }) => {
  if (ptyProcesses.has(panelId)) return 'already';
  const sh = shellPath || (process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash');
  const proc = pty.spawn(sh, [], {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: cwd || process.env.USERPROFILE || process.env.HOME || '.',
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>,
  });
  ptyProcesses.set(panelId, proc);
  proc.onData((data: string) => {
    mainWindow?.webContents.send('pty:data', { panelId, data });
  });
  proc.onExit(({ exitCode }: { exitCode: number }) => {
    ptyProcesses.delete(panelId);
    mainWindow?.webContents.send('pty:exit', { panelId, exitCode });
  });
  return 'ok';
});

ipcMain.on('pty:input', (_e, { panelId, data }: { panelId: string; data: string }) => {
  ptyProcesses.get(panelId)?.write(data);
});

ipcMain.on('pty:resize', (_e, { panelId, cols, rows }: { panelId: string; cols: number; rows: number }) => {
  try { ptyProcesses.get(panelId)?.resize(cols, rows); } catch {}
});

ipcMain.on('pty:kill', (_e, { panelId }: { panelId: string }) => {
  const proc = ptyProcesses.get(panelId);
  if (proc) { proc.kill(); ptyProcesses.delete(panelId); }
});

// ── Claude Code CLI 연동 ──
const claudeProcesses: Map<string, any> = new Map();

ipcMain.handle('claude:check', async () => {
  try {
    const { spawn } = require('child_process');
    return await new Promise<{ installed: boolean; version?: string }>(resolve => {
      const proc = spawn('claude', ['--version'], { shell: true });
      let output = '';
      proc.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
      proc.on('error', () => resolve({ installed: false }));
      proc.on('close', (code: number) => {
        if (code === 0) resolve({ installed: true, version: output.trim() });
        else resolve({ installed: false });
      });
    });
  } catch {
    return { installed: false };
  }
});

// ── MCP/Hook 공용 Control TCP 서버 ──
let mcpControlPort = 0;
let mcpControlToken = '';
// hook-approve pending: 렌더러로 요청 보내고 응답 받아올 때까지 sock 보관
const pendingApprovals = new Map<string, { sock: any; reqId: any }>();
(globalThis as any).__pepePendingApprovals = pendingApprovals;

const startMcpControl = async (): Promise<void> => {
  if (mcpControlPort) return;
  const net = require('net');
  const crypto = require('crypto');
  mcpControlToken = crypto.randomBytes(16).toString('hex');
  await new Promise<void>((resolve) => {
    const srv = net.createServer((sock: any) => {
      let buf = '';
      sock.on('data', (d: Buffer) => {
        buf += d.toString('utf-8');
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!line.trim()) continue;
          (async () => {
            try {
              const req = JSON.parse(line);
              if (req.token !== mcpControlToken) {
                sock.write(JSON.stringify({ id: req.id, error: 'invalid token' }) + '\n');
                return;
              }
              if (req.op === 'exec') {
                const bridge = getSSHBridge();
                const result = await bridge.handleExec(req.termId, req.command, req.timeoutMs || 60000);
                sock.write(JSON.stringify({ id: req.id, result }) + '\n');
              } else if (req.op === 'hook-approve') {
                // 승인 요청을 렌더러로 전달. 응답은 ipcMain.handle('claude:hook-respond') 에서 처리
                const approvalId = `app-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                pendingApprovals.set(approvalId, { sock, reqId: req.id });
                mainWindow?.webContents.send('claude:hook-approval-request', {
                  approvalId,
                  toolName: req.toolName,
                  toolInput: req.toolInput,
                  sessionId: req.sessionId,
                });
              } else {
                sock.write(JSON.stringify({ id: req.id, error: 'unknown op' }) + '\n');
              }
            } catch (err: any) {
              try { sock.write(JSON.stringify({ id: null, error: String(err) }) + '\n'); } catch {}
            }
          })();
        }
      });
      sock.on('error', () => {});
    });
    srv.listen(0, '127.0.0.1', () => {
      mcpControlPort = srv.address().port;
      console.log(`[mcp-control] listening on 127.0.0.1:${mcpControlPort}`);
      resolve();
    });
  });
};

// 렌더러에서 승인/거부 결과 수신
ipcMain.handle('claude:hook-respond', (_e, { approvalId, decision, reason }: { approvalId: string; decision: 'allow' | 'deny'; reason?: string }) => {
  const pending = pendingApprovals.get(approvalId);
  if (!pending) return { success: false, error: 'no pending approval' };
  pendingApprovals.delete(approvalId);
  try {
    pending.sock.write(JSON.stringify({ id: pending.reqId, result: decision, reason: reason || '' }) + '\n');
  } catch {}
  return { success: true };
});

// ── WebDAV 브리지: 원격 SSH 를 로컬 UNC 경로로 마운트 ──
let webdavBridge: any = null;
const getWebDAVBridge = () => {
  if (!webdavBridge) {
    webdavBridge = createWebDAVBridge(getSSHBridge());
  }
  return webdavBridge;
};

ipcMain.handle('claude:register-mount', async (_e, { panelId, sessionLabel }: { panelId: string; sessionLabel: string }) => {
  try {
    const bridge = getWebDAVBridge();
    await bridge.ensureStarted();
    bridge.registerSession(panelId, sessionLabel);
    return { success: true, mountRoot: bridge.getMountRoot(panelId), port: bridge.getPort() };
  } catch (err: any) {
    console.error('[claude:register-mount] error:', err);
    return { success: false, error: String(err) };
  }
});

ipcMain.handle('claude:unregister-mount', async (_e, { panelId }: { panelId: string }) => {
  try {
    if (webdavBridge) webdavBridge.unregisterSession(panelId);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: String(err) };
  }
});

ipcMain.handle('claude:get-mount-path', async (_e, { panelId, remotePath }: { panelId: string; remotePath: string }) => {
  try {
    const bridge = getWebDAVBridge();
    if (!bridge.hasSession(panelId)) return { success: false, error: '세션이 등록되지 않음' };
    return { success: true, uncPath: bridge.toUncPath(panelId, remotePath), httpUrl: bridge.toHttpUrl(panelId, remotePath) };
  } catch (err: any) {
    return { success: false, error: String(err) };
  }
});

// claude CLI 실행 + 스트리밍 응답 (print 모드)
ipcMain.handle('claude:send', async (_e, { sessionId, prompt, addDirs, disallowBash, sshTermId, resumeSessionId, permissionMode, model, perToolApproval }: { sessionId: string; prompt: string; addDirs?: string[]; disallowBash?: boolean; sshTermId?: string; resumeSessionId?: string | null; permissionMode?: string; model?: string; perToolApproval?: boolean }) => {
  try {
    const { spawn } = require('child_process');
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    console.log('[claude] spawn start, prompt length:', prompt.length);

    const isWin = process.platform === 'win32';

    // 긴 프롬프트는 임시 파일로 → shell 파이프로 stdin 주입 (Windows .cmd 스크립트에서 node spawn stdin 이 안먹히는 문제 회피)
    const tmpFile = path.join(os.tmpdir(), `claude-prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    fs.writeFileSync(tmpFile, prompt, 'utf-8');

    // npm global bin 을 PATH 에 보강 (Electron 실행 환경에서 누락될 수 있음)
    const extraPaths: string[] = [];
    if (isWin) {
      if (process.env.APPDATA) extraPaths.push(path.join(process.env.APPDATA, 'npm'));
      if (process.env.USERPROFILE) extraPaths.push(path.join(process.env.USERPROFILE, 'AppData', 'Roaming', 'npm'));
      if (process.env.ProgramFiles) extraPaths.push(path.join(process.env.ProgramFiles, 'nodejs'));
    } else {
      extraPaths.push('/usr/local/bin', '/opt/homebrew/bin', path.join(os.homedir(), '.npm-global', 'bin'), path.join(os.homedir(), '.nvm', 'versions'));
    }
    const sep = isWin ? ';' : ':';
    const augmentedPath = [process.env.PATH || '', ...extraPaths].filter(Boolean).join(sep);
    const spawnEnv = {
      ...process.env,
      PATH: augmentedPath,
      Path: augmentedPath,
      // UTF-8 강제 (한글 깨짐 방지)
      PYTHONIOENCODING: 'utf-8',
      LANG: process.env.LANG || 'en_US.UTF-8',
      LC_ALL: process.env.LC_ALL || 'en_US.UTF-8',
    };

    // --add-dir 옵션으로 스테이징된 디렉토리를 작업 범위에 추가
    const addDirArgs = (addDirs && addDirs.length > 0)
      ? addDirs.map(d => `--add-dir "${d.replace(/"/g, '\\"')}"`).join(' ')
      : '';
    console.log('[claude] addDirs:', addDirs);

    // 권한 모드: bypassPermissions=모두허용 / acceptEdits=편집만자동 / plan=계획만 / default=요청시
    // -p (print) 모드는 인터랙티브 불가 → 대부분 bypassPermissions 가 안전
    let permFlag: string;
    if (permissionMode === 'plan') permFlag = '--permission-mode plan';
    else if (permissionMode === 'acceptEdits') permFlag = '--permission-mode acceptEdits';
    else if (permissionMode === 'default') permFlag = '--permission-mode default';
    else permFlag = '--dangerously-skip-permissions'; // bypassPermissions (기본)
    // MCP 서버 설정 (원격 SSH 명령 실행용) — sshTermId 가 있을 때만 활성화
    let mcpConfigArg = '';
    let mcpCfgTmp = '';
    let mcpLogPath = '';
    if (sshTermId) {
      await startMcpControl();
      // 임베드된 스크립트를 임시 파일로 추출 (dev/prod 모두 작동)
      const mcpScriptPath = path.join(os.tmpdir(), 'pepe-mcp-ssh-server.cjs');
      try {
        const existing = fs.existsSync(mcpScriptPath) ? fs.readFileSync(mcpScriptPath, 'utf-8') : '';
        if (existing !== mcpSshServerScript) {
          fs.writeFileSync(mcpScriptPath, mcpSshServerScript, 'utf-8');
        }
      } catch (err) {
        console.error('[claude] MCP script extract failed:', err);
      }
      mcpLogPath = path.join(os.tmpdir(), `pepe-mcp-${Date.now()}.log`);
      const mcpCfg = {
        mcpServers: {
          pepe_ssh: {
            command: process.execPath,
            args: [mcpScriptPath],
            env: {
              PEPE_CTRL_PORT: String(mcpControlPort),
              PEPE_CTRL_TOKEN: mcpControlToken,
              PEPE_TERM_ID: sshTermId,
              PEPE_LOG_PATH: mcpLogPath,
              ELECTRON_RUN_AS_NODE: '1',
            },
          },
        },
      };
      mcpCfgTmp = path.join(os.tmpdir(), `claude-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
      fs.writeFileSync(mcpCfgTmp, JSON.stringify(mcpCfg), 'utf-8');
      mcpConfigArg = `--mcp-config "${mcpCfgTmp}"`;
      console.log('[claude] MCP config written:', mcpCfgTmp, 'termId:', sshTermId, 'scriptExists:', fs.existsSync(mcpScriptPath), 'path:', mcpScriptPath);
    }

    // SSH 컨텍스트: 로컬 Bash 금지 (Unix 경로 접근 불가) — Read/Edit/Grep/Glob/LS + MCP ssh_exec 허용
    // 파일 편집은 WebDAV UNC 경로로 Edit/Write → SFTP 프록시로 원격 반영
    // 원격 명령 실행은 mcp__pepe_ssh__ssh_exec (MCP 서버 경유)
    const mcpToolAllow = sshTermId ? `"mcp__pepe_ssh__ssh_exec"` : '';
    const allowedFlag = disallowBash
      ? `--allowedTools "Read" "Edit" "Write" "Glob" "Grep" "LS" ${mcpToolAllow} "WebFetch" "WebSearch"`
      : '';

    // 이전 대화 세션 이어가기 (--resume <session_id>)
    const resumeFlag = resumeSessionId ? `--resume "${resumeSessionId}"` : '';
    console.log('[claude] resume:', resumeSessionId || '(new)');

    // 모델 선택 (--model)
    const modelFlag = (model && model !== 'default') ? `--model ${model}` : '';
    console.log('[claude] model:', model || 'default');

    // 툴 단위 승인 (hooks) — perToolApproval true 일 때만 활성화
    let settingsFlag = '';
    let settingsTmp = '';
    let hookScriptPath = '';
    if (perToolApproval) {
      await startMcpControl();
      hookScriptPath = path.join(os.tmpdir(), 'pepe-claude-hook.cjs');
      try {
        const existing = fs.existsSync(hookScriptPath) ? fs.readFileSync(hookScriptPath, 'utf-8') : '';
        if (existing !== claudeHookScript) fs.writeFileSync(hookScriptPath, claudeHookScript, 'utf-8');
      } catch (err) { console.error('[claude] hook script extract failed:', err); }
      // 환경변수를 hook 프로세스에 전달 (settings 에서 직접 env 주입 불가하므로 래퍼 배치 사용)
      const wrapperPath = path.join(os.tmpdir(), 'pepe-claude-hook-wrap.cmd');
      const wrapperContent = `@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\nset "PEPE_CTRL_PORT=${mcpControlPort}"\r\nset "PEPE_CTRL_TOKEN=${mcpControlToken}"\r\n"${process.execPath}" "${hookScriptPath}"\r\n`;
      try { fs.writeFileSync(wrapperPath, wrapperContent, 'utf-8'); } catch (err) { console.error('[claude] hook wrapper write failed:', err); }

      const settings = {
        hooks: {
          PreToolUse: [{
            matcher: 'Bash|Edit|Write|Create|Delete|Move|Rename|mcp__.*',
            hooks: [{
              type: 'command',
              command: isWin ? `"${wrapperPath}"` : `node "${hookScriptPath}"`,
            }],
          }],
        },
      };
      settingsTmp = path.join(os.tmpdir(), `claude-settings-${Date.now()}.json`);
      fs.writeFileSync(settingsTmp, JSON.stringify(settings, null, 2), 'utf-8');
      settingsFlag = `--settings "${settingsTmp}"`;
      console.log('[claude] per-tool approval enabled. settings:', settingsTmp);
    }

    // shell 커맨드로 파이프 구성 (claude 는 PATHEXT 로 .cmd 자동 해석)
    // Windows: chcp 65001 로 UTF-8 코드페이지 전환 (한글 깨짐 방지)
    const shellCmd = isWin
      ? `chcp 65001 >nul && type "${tmpFile}" | claude -p ${resumeFlag} ${modelFlag} ${permFlag} ${allowedFlag} ${settingsFlag} ${mcpConfigArg} ${addDirArgs} --output-format stream-json --verbose`
      : `cat "${tmpFile}" | claude -p ${resumeFlag} ${modelFlag} ${permFlag} ${allowedFlag} ${settingsFlag} ${mcpConfigArg} ${addDirArgs} --output-format stream-json --verbose`;
    console.log('[claude] shell cmd:', shellCmd);
    console.log('[claude] PATH has npm:', augmentedPath.toLowerCase().includes('npm'));

    const proc = spawn(shellCmd, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: spawnEnv });
    claudeProcesses.set(sessionId, proc);

    // 임시 파일 정리 (프로세스 종료 후)
    const cleanupTmp = () => {
      try { fs.unlinkSync(tmpFile); } catch {}
      if (mcpCfgTmp) { try { fs.unlinkSync(mcpCfgTmp); } catch {} }
      if (settingsTmp) { try { fs.unlinkSync(settingsTmp); } catch {} }
    };

    let stdoutBuf = '';
    proc.stdout.setEncoding('utf-8');
    proc.stdout.on('data', (data: string) => {
      stdoutBuf += data;
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() || ''; // 마지막 불완전 라인은 보류
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        console.log('[claude] stdout line:', trimmed.slice(0, 200));
        try {
          const msg = JSON.parse(trimmed);
          mainWindow?.webContents.send('claude:stream', { sessionId, message: msg });
        } catch {
          mainWindow?.webContents.send('claude:stream', { sessionId, message: { type: 'text', text: trimmed } });
        }
      }
    });
    proc.stderr.on('data', (data: Buffer) => {
      const err = data.toString();
      console.log('[claude] stderr:', err);
      mainWindow?.webContents.send('claude:stream', { sessionId, message: { type: 'error', text: err } });
    });
    proc.on('error', (err: any) => {
      console.log('[claude] spawn error:', err);
      mainWindow?.webContents.send('claude:stream', { sessionId, message: { type: 'error', text: String(err) } });
    });
    proc.on('close', (code: number) => {
      console.log('[claude] close, code:', code);
      cleanupTmp();
      claudeProcesses.delete(sessionId);
      mainWindow?.webContents.send('claude:stream', { sessionId, message: { type: 'done', code } });
    });
    return { success: true };
  } catch (err: any) {
    console.log('[claude] exception:', err);
    return { success: false, error: String(err) };
  }
});

ipcMain.handle('claude:stop', (_e, { sessionId }: { sessionId: string }) => {
  const proc = claudeProcesses.get(sessionId);
  if (proc) { try { proc.kill(); } catch {} claudeProcesses.delete(sessionId); }
  return { success: true };
});

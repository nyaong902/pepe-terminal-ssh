// electron/main.ts
import { app, BrowserWindow, ipcMain, dialog, Menu, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import * as pty from 'node-pty';
import { fileURLToPath } from 'url';
import { loadSessionsData, saveSessionsData, getSessionsPath, saveCustomPath, loadUIPrefs, saveUIPrefs, Session, Folder, SessionsData } from './sessionsStore';
import { getSSHBridge } from './sshBridge';

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
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  // 타이틀바 더블클릭 → 최대화 토글
  mainWindow.on('maximize', () => { isMaximized = true; mainWindow?.webContents.send('window:maximized', true); });
  mainWindow.on('unmaximize', () => { isMaximized = false; mainWindow?.webContents.send('window:maximized', false); });

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
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8'));
    const imported: SessionsData = Array.isArray(raw)
      ? { folders: [], sessions: raw }
      : { folders: raw.folders ?? [], sessions: raw.sessions ?? [] };
    // 기존 데이터에 머지 (중복 ID는 덮어쓰기)
    for (const f of imported.folders) {
      const idx = sessionsData.folders.findIndex(x => x.id === f.id);
      if (idx >= 0) sessionsData.folders[idx] = f;
      else sessionsData.folders.push(f);
    }
    for (const s of imported.sessions) {
      const idx = sessionsData.sessions.findIndex(x => x.id === s.id);
      if (idx >= 0) sessionsData.sessions[idx] = s;
      else sessionsData.sessions.push(s);
    }
    saveSessionsData(sessionsData);
    return sessionsData;
  } catch { return null; }
});

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

ipcMain.handle('sftp:download', async (_e, { panelId, remotePath }: { panelId: string; remotePath: string }) => {
  if (!mainWindow) return null;
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '원격 파일 저장',
    defaultPath: remotePath.split('/').pop() || 'download',
  });
  if (result.canceled || !result.filePath) return null;
  try {
    const bridge = getSSHBridge();
    await bridge.handleSFTPDownload(panelId, remotePath, result.filePath);
    return { success: true, localPath: result.filePath };
  } catch (err: any) {
    return { success: false, error: String(err) };
  }
});

ipcMain.handle('sftp:upload', async (_e, { panelId, remotePath }: { panelId: string; remotePath: string }) => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '업로드할 파일 선택',
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const localPath = result.filePaths[0];
  const filename = localPath.replace(/\\/g, '/').split('/').pop() || '';
  const fullRemote = remotePath.endsWith('/') ? remotePath + filename : remotePath + '/' + filename;
  try {
    const bridge = getSSHBridge();
    await bridge.handleSFTPUpload(panelId, localPath, fullRemote);
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



// ── 창 제어 ──
let isMaximized = false;
let savedBounds = { x: 100, y: 100, width: 1400, height: 900 };

let dragStartPos: { x: number; y: number } | null = null;

ipcMain.on('window:start-drag', (_e, { mouseX, mouseY }: any) => {
  if (!mainWindow) return;
  const [wx, wy] = mainWindow.getPosition();
  dragStartPos = { x: mouseX - wx, y: mouseY - wy };
});

ipcMain.on('window:drag-move', (_e, { mouseX, mouseY }: any) => {
  if (!mainWindow || !dragStartPos) return;
  // 최대화 상태에서 드래그하면 자동 복원 (마우스 위치를 기준으로 복원 창 좌표 재계산)
  if (isMaximized) {
    const restoreW = savedBounds.width;
    const restoreH = savedBounds.height;
    // 마우스가 타이틀바의 중앙쯤(상대 위치)에 오도록 복원
    const offsetX = Math.min(dragStartPos.x, restoreW - 80);
    const newX = mouseX - offsetX;
    const newY = mouseY - Math.min(dragStartPos.y, 20);
    mainWindow.setBounds({ x: newX, y: newY, width: restoreW, height: restoreH });
    dragStartPos = { x: offsetX, y: Math.min(dragStartPos.y, 20) };
    isMaximized = false;
    mainWindow.webContents.send('window:maximized', false);
    return;
  }
  mainWindow.setPosition(mouseX - dragStartPos.x, mouseY - dragStartPos.y);
});

ipcMain.on('window:end-drag', () => { dragStartPos = null; });

ipcMain.handle('window:minimize', () => mainWindow?.minimize());
ipcMain.handle('window:toggle-maximize', () => {
  if (!mainWindow) return;
  dragStartPos = null;
  const { screen: s } = require('electron');
  if (isMaximized) {
    // 현재 창이 위치한 디스플레이로 복원 좌표를 보정 (드래그로 다른 모니터에 옮긴 경우 대응)
    const curBounds = mainWindow.getBounds();
    const curDisplay = s.getDisplayMatching(curBounds);
    const savedDisplay = s.getDisplayMatching(savedBounds);
    let restore = { ...savedBounds };
    if (curDisplay.id !== savedDisplay.id) {
      const wa = curDisplay.workArea;
      // 사이즈 유지, 위치는 현재 모니터 작업영역의 중앙으로
      restore.width = Math.min(savedBounds.width, wa.width);
      restore.height = Math.min(savedBounds.height, wa.height);
      restore.x = wa.x + Math.max(0, Math.floor((wa.width - restore.width) / 2));
      restore.y = wa.y + Math.max(0, Math.floor((wa.height - restore.height) / 2));
    }
    mainWindow.setBounds(restore);
    isMaximized = false;
  } else {
    savedBounds = mainWindow.getBounds();
    const currentDisplay = s.getDisplayMatching(savedBounds);
    const wa = currentDisplay.workArea;
    mainWindow.setBounds({ x: wa.x, y: wa.y, width: wa.width, height: wa.height });
    isMaximized = true;
  }
  mainWindow.webContents.send('window:maximized', isMaximized);
});
ipcMain.handle('window:is-maximized', () => isMaximized);
ipcMain.handle('window:close', () => mainWindow?.close());

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

  connectingPanels.add(panelId);

  const bridge = getSSHBridge();
  bridge.handleConnect(panelId, session, cols, rows);
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

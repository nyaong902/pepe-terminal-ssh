// electron/preload.ts — updated with folder support
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  // Sessions
  getSessionsPath: () => ipcRenderer.invoke('sessions:path'),
  openSessionsFolder: () => ipcRenderer.invoke('sessions:open-folder'),
  openSessionsEditor: () => ipcRenderer.invoke('sessions:open-editor'),
  setSessionsPath: () => ipcRenderer.invoke('sessions:set-path'),
  resetSessionsPath: () => ipcRenderer.invoke('sessions:reset-path'),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  saveSession: (s: any) => ipcRenderer.invoke('sessions:save', s),
  deleteSession: (id: string) => ipcRenderer.invoke('sessions:delete', id),
  moveToFolder: (sessionId: string, targetFolderId: string | null) => ipcRenderer.invoke('sessions:move-to-folder', { sessionId, targetFolderId }),
  reorderSession: (id: string, type: 'session' | 'folder', direction: 'up' | 'down' | 'top' | 'bottom') => ipcRenderer.invoke('sessions:reorder', { id, type, direction }),

  // UI Prefs (config.json 에 저장 — sessionData 멀티인스턴스 분리와 무관하게 영속)
  getUIPrefs: () => ipcRenderer.invoke('ui-prefs:get'),
  setUIPrefs: (prefs: Record<string, any>) => ipcRenderer.invoke('ui-prefs:set', prefs),

  // Folders
  saveFolder: (f: any) => ipcRenderer.invoke('folders:save', f),
  deleteFolder: (id: string) => ipcRenderer.invoke('folders:delete', id),

  // Export/Import
  exportSessions: () => ipcRenderer.invoke('sessions:export'),
  importSessions: () => ipcRenderer.invoke('sessions:import'),

  // File Explorer
  feListDir: (mode: string, dirPath: string, termId?: string) => ipcRenderer.invoke('fe:list-dir', { mode, termId, dirPath }),
  feGetDrives: () => ipcRenderer.invoke('fe:get-drives'),
  feGetHome: () => ipcRenderer.invoke('fe:get-home'),
  feTransfer: (src: any, dst: any, filename: string) => ipcRenderer.invoke('fe:transfer', { src, dst, filename }),
  feMkdir: (mode: string, dirPath: string, termId?: string) => ipcRenderer.invoke('fe:mkdir', { mode, termId, dirPath }),
  feDelete: (mode: string, filePath: string, termId?: string) => ipcRenderer.invoke('fe:delete', { mode, termId, filePath }),
  feRename: (mode: string, oldPath: string, newPath: string, termId?: string) => ipcRenderer.invoke('fe:rename', { mode, termId, oldPath, newPath }),
  feHomeDir: (mode: string, termId?: string) => ipcRenderer.invoke('fe:home-dir', { mode, termId }),
  feSftpConnect: (connId: string, host: string, port: number, username: string, auth?: any, jumpOpts?: { host: string; user?: string; port?: number; password?: string }) => ipcRenderer.invoke('fe:sftp-connect', { connId, host, port, username, auth, jumpOpts }),
  pickFiles: (multi?: boolean) => ipcRenderer.invoke('dialog:pick-files', { multi }),
  pickFolder: () => ipcRenderer.invoke('dialog:pick-folder'),
  feSftpDisconnect: (connId: string) => ipcRenderer.invoke('fe:sftp-disconnect', { connId }),
  feConnectedSessions: () => ipcRenderer.invoke('fe:connected-sessions'),

  // SFTP
  sftpDownload: (panelId: string, remotePath: string, isDir?: boolean) => ipcRenderer.invoke('sftp:download', { panelId, remotePath, isDir }),
  sftpDownloadMulti: (panelId: string, items: { path: string; isDir: boolean }[]) => ipcRenderer.invoke('sftp:download-multi', { panelId, items }),
  sftpUpload: (panelId: string, remotePath: string, kind?: 'file' | 'folder' | 'multi-file') => ipcRenderer.invoke('sftp:upload', { panelId, remotePath, kind }),
  sftpListDir: (panelId: string, remotePath: string) => ipcRenderer.invoke('sftp:list-dir', { panelId, remotePath }),
  sftpReadFile: (panelId: string, remotePath: string, encoding?: string) => ipcRenderer.invoke('sftp:read-file', { panelId, remotePath, encoding }),
  sftpWriteFile: (panelId: string, remotePath: string, content: string, encoding?: string) => ipcRenderer.invoke('sftp:write-file', { panelId, remotePath, content, encoding }),
  onSFTPProgress: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('sftp:progress', handler);
    return () => ipcRenderer.removeListener('sftp:progress', handler);
  },
  onSFTPComplete: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('sftp:complete', handler);
    return () => ipcRenderer.removeListener('sftp:complete', handler);
  },

  // Window
  windowStartDrag: (mouseX: number, mouseY: number) => ipcRenderer.send('window:start-drag', { mouseX, mouseY }),
  windowDragMove: (mouseX: number, mouseY: number) => ipcRenderer.send('window:drag-move', { mouseX, mouseY }),
  windowEndDrag: () => ipcRenderer.send('window:end-drag'),
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowToggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  windowIsMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  onWindowMaximized: (cb: (m: boolean) => void) => {
    const listener = (_e: any, m: boolean) => cb(m);
    ipcRenderer.on('window:maximized', listener);
    return () => ipcRenderer.removeListener('window:maximized', listener);
  },
  onDebugLog: (cb: (msg: string) => void) => {
    const listener = (_e: any, msg: string) => cb(msg);
    ipcRenderer.on('debug:log', listener);
    return () => ipcRenderer.removeListener('debug:log', listener);
  },

  // SSH control
  resetSSHState: (panelId: string) => ipcRenderer.invoke('ssh:reset-state', panelId),
  connectSSH: (panelId: string, sessionId: string, cols?: number, rows?: number) =>
    ipcRenderer.invoke('ssh:connect', { panelId, sessionId, cols, rows }),
  connectSSHWithPassword: (panelId: string, sessionId: string, password: string, cols?: number, rows?: number) =>
    ipcRenderer.invoke('ssh:connect-with-password', { panelId, sessionId, password, cols, rows }),
  quickConnectSSH: (panelId: string, session: any, cols?: number, rows?: number) =>
    ipcRenderer.invoke('ssh:quick-connect', { panelId, session, cols, rows }),
  isSSHConnected: (panelId: string) =>
    ipcRenderer.invoke('ssh:is-connected', panelId),
  sendSSHInput: (panelId: string, data?: string, b64?: string) =>
    ipcRenderer.send('ssh:input', { panelId, data, b64 }),
  disconnectSSH: (panelId: string) =>
    ipcRenderer.send('ssh:disconnect', { panelId }),
  resizeSSH: (panelId: string, cols: number, rows: number) =>
    ipcRenderer.send('ssh:resize', { panelId, cols, rows }),
  setSSHEncoding: (panelId: string, encoding: string) =>
    ipcRenderer.invoke('ssh:set-encoding', { panelId, encoding }),
  getSSHEncoding: (panelId: string) =>
    ipcRenderer.invoke('ssh:get-encoding', panelId),

  // App
  getStartupCwd: () => ipcRenderer.invoke('app:startup-cwd'),
  clearStartupCwd: () => ipcRenderer.invoke('app:clear-startup-cwd'),
  registerContextMenu: () => ipcRenderer.invoke('app:register-context-menu'),
  unregisterContextMenu: () => ipcRenderer.invoke('app:unregister-context-menu'),
  checkContextMenu: () => ipcRenderer.invoke('app:check-context-menu'),

  // Local Shell (PTY)
  ptyListShells: () => ipcRenderer.invoke('pty:list-shells'),
  ptySpawn: (panelId: string, shell?: string, cols?: number, rows?: number, cwd?: string) =>
    ipcRenderer.invoke('pty:spawn', { panelId, shell, cols, rows, cwd }),
  ptyInput: (panelId: string, data: string) =>
    ipcRenderer.send('pty:input', { panelId, data }),
  ptyResize: (panelId: string, cols: number, rows: number) =>
    ipcRenderer.send('pty:resize', { panelId, cols, rows }),
  ptyKill: (panelId: string) =>
    ipcRenderer.send('pty:kill', { panelId }),
  onPtyData: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('pty:data', handler);
    return () => ipcRenderer.removeListener('pty:data', handler);
  },
  onPtyExit: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('pty:exit', handler);
    return () => ipcRenderer.removeListener('pty:exit', handler);
  },

  // SSH events
  onSSHData: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('ssh:data', handler);
    return () => ipcRenderer.removeListener('ssh:data', handler);
  },
  onSSHConnected: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('ssh:connected', handler);
    return () => ipcRenderer.removeListener('ssh:connected', handler);
  },
  onSSHClosed: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('ssh:closed', handler);
    return () => ipcRenderer.removeListener('ssh:closed', handler);
  },
  onSSHError: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('ssh:error', handler);
    return () => ipcRenderer.removeListener('ssh:error', handler);
  },
  onSSHAuthPrompt: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('ssh:auth-prompt', handler);
    return () => ipcRenderer.removeListener('ssh:auth-prompt', handler);
  },
  sshAuthResponse: (panelId: string, responses: string[]) =>
    ipcRenderer.invoke('ssh:auth-response', { panelId, responses }),

  // Claude Code CLI
  claudeCheck: () => ipcRenderer.invoke('claude:check'),
  claudeSend: (sessionId: string, prompt: string, addDirs?: string[], disallowBash?: boolean, sshTermId?: string, resumeSessionId?: string | null, permissionMode?: string, model?: string, perToolApproval?: boolean) =>
    ipcRenderer.invoke('claude:send', { sessionId, prompt, addDirs, disallowBash, sshTermId, resumeSessionId, permissionMode, model, perToolApproval }),
  claudeHookRespond: (approvalId: string, decision: 'allow' | 'deny', reason?: string) =>
    ipcRenderer.invoke('claude:hook-respond', { approvalId, decision, reason }),
  onClaudeHookApprovalRequest: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('claude:hook-approval-request', handler);
    return () => ipcRenderer.removeListener('claude:hook-approval-request', handler);
  },
  claudeRegisterMount: (panelId: string, sessionLabel: string) =>
    ipcRenderer.invoke('claude:register-mount', { panelId, sessionLabel }),
  claudeUnregisterMount: (panelId: string) =>
    ipcRenderer.invoke('claude:unregister-mount', { panelId }),
  claudeGetMountPath: (panelId: string, remotePath: string) =>
    ipcRenderer.invoke('claude:get-mount-path', { panelId, remotePath }),
  claudeStop: (sessionId: string) => ipcRenderer.invoke('claude:stop', { sessionId }),
  onClaudeStream: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('claude:stream', handler);
    return () => ipcRenderer.removeListener('claude:stream', handler);
  },
});

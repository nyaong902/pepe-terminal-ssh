// electron/sessionsStore.ts
import fs from 'fs';
import path from 'path';
import { app } from 'electron';

export type LoginScriptRule = {
  expect: string;
  send: string;
  isRegex?: boolean;
};

export type Session = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth?: { type: 'password'; password: string } | { type: 'key'; keyPath: string };
  encoding?: string;
  folderId?: string;
  loginScript?: LoginScriptRule[];
  theme?: string;
  fontFamily?: string;
  fontSize?: number;
  scrollback?: number;
  icon?: string;
  initialPath?: string; // SSH 연결 시 파일 트리 초기 경로 (없으면 홈 디렉토리)
};

export type Folder = {
  id: string;
  name: string;
  parentId?: string;
};

export type SessionsData = {
  folders: Folder[];
  sessions: Session[];
  childOrder?: Record<string, string[]>; // parentId → 자식 ID 목록 (폴더+세션 혼합 순서)
};

let customSessionsPath: string | null = null;

function getConfigPath(): string {
  try { return path.join(app.getPath('userData'), 'config.json'); }
  catch { return path.join(process.cwd(), 'config.json'); }
}

export function loadCustomPath(): string | null {
  try {
    const cfg = JSON.parse(fs.readFileSync(getConfigPath(), 'utf8'));
    return cfg.sessionsPath || null;
  } catch { return null; }
}

export function saveCustomPath(p: string | null) {
  customSessionsPath = p;
  const cfgPath = getConfigPath();
  let cfg: any = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
  cfg.sessionsPath = p || undefined;
  const dir = path.dirname(cfgPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
}

export function loadUIPrefs(): Record<string, any> {
  try {
    const cfg = JSON.parse(fs.readFileSync(getConfigPath(), 'utf8'));
    return (cfg && typeof cfg.uiPrefs === 'object' && cfg.uiPrefs) ? cfg.uiPrefs : {};
  } catch { return {}; }
}

export function saveUIPrefs(prefs: Record<string, any>) {
  const cfgPath = getConfigPath();
  let cfg: any = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
  cfg.uiPrefs = { ...(cfg.uiPrefs || {}), ...prefs };
  const dir = path.dirname(cfgPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
}

export function getSessionsPath(): string {
  if (customSessionsPath) return customSessionsPath;
  const loaded = loadCustomPath();
  if (loaded) { customSessionsPath = loaded; return loaded; }
  try {
    return path.join(app.getPath('userData'), 'sessions.json');
  } catch {
    return path.join(process.cwd(), 'sessions.json');
  }
}

export function loadSessionsData(): SessionsData {
  const filePath = getSessionsPath();
  if (!fs.existsSync(filePath)) return { folders: [], sessions: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    // 기존 flat array 마이그레이션
    if (Array.isArray(raw)) return { folders: [], sessions: raw };
    return { folders: raw.folders ?? [], sessions: raw.sessions ?? [], childOrder: raw.childOrder ?? undefined };
  } catch {
    return { folders: [], sessions: [] };
  }
}

export function saveSessionsData(data: SessionsData) {
  const filePath = getSessionsPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

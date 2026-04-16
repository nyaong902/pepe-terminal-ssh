// src/components/SessionEditor.tsx
import React, { useState, useEffect } from 'react';
import { getThemeList } from '../utils/terminalThemes';
import { getAvailableMonoFonts } from '../utils/monoFonts';
import { isValidHost, normalizeHost } from '../utils/hostValidate';

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
  auth?: { type: string; password?: string; keyPath?: string };
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
  session?: Session | null;
  folders?: Folder[];
  onSave: (s: Session) => void;
  onCancel: () => void;
};

export const SessionEditor: React.FC<Props> = ({ session, folders = [], onSave, onCancel }) => {
  const [id] = useState(session?.id ?? `sess-${Date.now()}`);
  const [name, setName] = useState(session?.name ?? 'New Session');
  const [host, setHost] = useState(session?.host ?? '');
  const [port, setPort] = useState(session?.port ?? 22);
  const [username, setUsername] = useState(session?.username ?? '');
  const [authType, setAuthType] = useState(session?.auth?.type ?? 'password');
  const [password, setPassword] = useState(session?.auth?.password ?? '');
  const [keyPath, setKeyPath] = useState(session?.auth?.keyPath ?? '');
  const [encoding, setEncoding] = useState(session?.encoding ?? 'utf-8');
  const [folderId, setFolderId] = useState(session?.folderId ?? '');
  const [loginScript, setLoginScript] = useState<LoginScriptRule[]>(session?.loginScript ?? []);
  const [theme, setTheme] = useState(session?.theme ?? '');
  const [fontFamily, setFontFamily] = useState(session?.fontFamily ?? '');
  const [fontSize, setFontSize] = useState(session?.fontSize ?? 0);
  const [scrollback, setScrollback] = useState(session?.scrollback ?? 0);
  const [icon, setIcon] = useState(session?.icon ?? '🖥️');
  const [showIconPicker, setShowIconPicker] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    setName(session?.name ?? 'New Session');
    setHost(session?.host ?? '');
    setPort(session?.port ?? 22);
    setUsername(session?.username ?? '');
    setAuthType(session?.auth?.type ?? 'password');
    setPassword(session?.auth?.password ?? '');
    setKeyPath(session?.auth?.keyPath ?? '');
    setEncoding(session?.encoding ?? 'utf-8');
    setFolderId(session?.folderId ?? '');
    setLoginScript(session?.loginScript ?? []);
    setTheme(session?.theme ?? '');
    setFontFamily(session?.fontFamily ?? '');
    setFontSize(session?.fontSize ?? 0);
    setScrollback(session?.scrollback ?? 0);
    setIcon(session?.icon ?? '🖥️');
  }, [session]);

  const getFolderPath = (f: Folder): string => {
    const parts: string[] = [f.name];
    let current = f;
    while (current.parentId) {
      const parent = folders.find(x => x.id === current.parentId);
      if (!parent) break;
      parts.unshift(parent.name);
      current = parent;
    }
    return parts.join(' / ');
  };

  const iconList = ['🖥️','💻','🌐','🔒','📡','🐧','🪟','🍎','☁️','🗄️','🔧','📂','🏠','🏢','🧪','🚀','⚙️','🛡️','📊','🎯','💾','🔌','📟','🖧'];

  const addRule = () => setLoginScript(prev => [...prev, { expect: '', send: '' }]);
  const removeRule = (idx: number) => setLoginScript(prev => prev.filter((_, i) => i !== idx));
  const updateRule = (idx: number, field: keyof LoginScriptRule, value: any) => {
    setLoginScript(prev => prev.map((r, i) => i === idx ? { ...r, [field]: value } : r));
  };
  const moveRule = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= loginScript.length) return;
    setLoginScript(prev => {
      const arr = [...prev];
      [arr[idx], arr[target]] = [arr[target], arr[idx]];
      return arr;
    });
  };

  const save = () => {
    if (!host || !username) {
      setSaveError('Host and username are required');
      return;
    }
    if (!isValidHost(host)) {
      setSaveError('유효한 IPv4/IPv6 또는 호스트명을 입력하세요.');
      return;
    }
    setSaveError('');
    const auth = authType === 'password' ? { type: 'password', password } : { type: 'key', keyPath };
    const script = loginScript.filter(r => r.expect.trim() !== '' || r.send.trim() !== '');
    onSave({ id, name, host: normalizeHost(host), port, username, auth, encoding, folderId: folderId || undefined, loginScript: script.length > 0 ? script : undefined, theme: theme || undefined, fontFamily: fontFamily || undefined, fontSize: fontSize || undefined, scrollback: scrollback || undefined, icon: icon || undefined } as Session);
  };

  return (
    <div className="session-editor-backdrop">
      <div className="session-editor" onClick={e => e.stopPropagation()}>
        <h3>Session Editor</h3>
        <div className="session-editor-grid">
          <label>Icon</label>
          <div className="icon-picker-wrapper">
            <button className="icon-picker-btn" onClick={() => setShowIconPicker(p => !p)} type="button">
              {icon || '—'}
            </button>
            {icon && <button className="icon-clear-btn" onClick={() => setIcon('')} type="button">&times;</button>}
            {showIconPicker && (
              <div className="icon-picker-grid">
                {iconList.map(ic => (
                  <span key={ic} className={`icon-picker-item ${icon === ic ? 'active' : ''}`} onClick={() => { setIcon(ic); setShowIconPicker(false); }}>{ic}</span>
                ))}
              </div>
            )}
          </div>

          <label>Name</label>
          <input value={name} onChange={e => setName(e.target.value)} />

          <label>Folder</label>
          <select value={folderId} onChange={e => setFolderId(e.target.value)}>
            <option value="">(Root)</option>
            {folders.map(f => (
              <option key={f.id} value={f.id}>{getFolderPath(f)}</option>
            ))}
          </select>

          <label>Host</label>
          <input
            className={host && !isValidHost(host) ? 'invalid' : ''}
            value={host}
            onChange={e => setHost(e.target.value)}
            placeholder="IPv4 / IPv6 / 도메인"
            title={host && !isValidHost(host) ? '유효한 IPv4/IPv6/호스트명을 입력하세요' : ''}
          />

          <label>Port</label>
          <input type="number" value={port} onChange={e => setPort(Number(e.target.value) || 22)} />

          <label>Username</label>
          <input value={username} onChange={e => setUsername(e.target.value)} placeholder="root" />

          <label>Auth</label>
          <div className="session-editor-auth">
            <label>
              <input type="radio" checked={authType === 'password'} onChange={() => setAuthType('password')} />
              Password
            </label>
            <label>
              <input type="radio" checked={authType === 'key'} onChange={() => setAuthType('key')} />
              Key
            </label>
          </div>

          {authType === 'password' ? (
            <>
              <label>Password</label>
              <div className="password-field">
                <input type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} />
                <button type="button" className="password-toggle" onClick={() => setShowPassword(p => !p)} title={showPassword ? '숨기기' : '보기'}>
                  {showPassword ? '🙈' : '👁'}
                </button>
              </div>
            </>
          ) : (
            <>
              <label>Key Path</label>
              <input value={keyPath} onChange={e => setKeyPath(e.target.value)} placeholder="~/.ssh/id_rsa" />
            </>
          )}

          <label>Encoding</label>
          <select value={encoding} onChange={e => setEncoding(e.target.value)}>
            <option value="utf-8">utf-8</option>
            <option value="cp949">cp949</option>
            <option value="euc-kr">euc-kr</option>
            <option value="latin1">latin1</option>
          </select>

          <label>Theme</label>
          <select value={theme} onChange={e => setTheme(e.target.value)}>
            <option value="">(Global Default)</option>
            {getThemeList().map(t => <option key={t} value={t}>{t}</option>)}
          </select>

          <label>Font</label>
          <select value={fontFamily} onChange={e => setFontFamily(e.target.value)}>
            <option value="">(Global Default)</option>
            {getAvailableMonoFonts().map(f => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
          </select>

          <label>Font Size</label>
          <input type="number" value={fontSize || ''} onChange={e => setFontSize(Number(e.target.value) || 0)} placeholder="(Global Default)" min={8} max={40} />

          <label>Scrollback</label>
          <input type="number" value={scrollback || ''} onChange={e => setScrollback(Number(e.target.value) || 0)} placeholder="(Global Default)" min={1000} max={1000000} step={1000} />
        </div>

        {/* ── 로그인 스크립트 ── */}
        <div className="login-script-section">
          <div className="login-script-header">
            <span className="login-script-title">Login Script (Expect/Send)</span>
            <button className="login-script-add" onClick={addRule}>+ Add Rule</button>
          </div>
          {loginScript.length > 0 && (
            <div className="login-script-list">
              <div className="login-script-labels">
                <span>Expect</span>
                <span>Send</span>
                <span></span>
              </div>
              {loginScript.map((rule, idx) => (
                <div key={idx} className="login-script-rule">
                  <input
                    className="login-script-input"
                    value={rule.expect}
                    onChange={e => updateRule(idx, 'expect', e.target.value)}
                    placeholder='e.g. password:'
                  />
                  <input
                    className="login-script-input"
                    value={rule.send}
                    onChange={e => updateRule(idx, 'send', e.target.value)}
                    placeholder='e.g. mypassword'
                  />
                  <div className="login-script-rule-actions">
                    <label className="login-script-regex" title="Use regex for expect">
                      <input type="checkbox" checked={rule.isRegex ?? false} onChange={e => updateRule(idx, 'isRegex', e.target.checked)} />
                      <span>.*</span>
                    </label>
                    <button className="login-script-move" onClick={() => moveRule(idx, -1)} disabled={idx === 0} title="Move up">&#9650;</button>
                    <button className="login-script-move" onClick={() => moveRule(idx, 1)} disabled={idx === loginScript.length - 1} title="Move down">&#9660;</button>
                    <button className="login-script-remove" onClick={() => removeRule(idx)} title="Remove">&times;</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="session-editor-actions">
          {saveError && <span className="session-editor-error">{saveError}</span>}
          <button className="btn-cancel" onClick={onCancel}>Cancel</button>
          <button className="btn-save" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
};

// src/components/QuickConnectDialog.tsx
import React, { useState } from 'react';
import { isValidHost, normalizeHost } from '../utils/hostValidate';

export type QuickConnectResult = {
  name: string;
  host: string;
  port: number;
  username: string;
  auth: { type: 'password'; password: string };
  encoding: string;
  protocol: 'ssh' | 'sftp';
};

type Props = {
  onConnect: (s: QuickConnectResult) => void;
  onCancel: () => void;
  forceProtocol?: 'ssh' | 'sftp';
};

export const QuickConnectBar: React.FC<Props> = ({ onConnect, onCancel, forceProtocol }) => {
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [encoding, setEncoding] = useState(() => localStorage.getItem('quickConnectEncoding') || 'utf-8');
  const [showPassword, setShowPassword] = useState(false);
  const [protocolState, setProtocol] = useState<'ssh' | 'sftp'>(() => (localStorage.getItem('quickConnectProtocol') as 'ssh' | 'sftp') || 'ssh');
  const protocol = forceProtocol ?? protocolState;

  const hostValid = host.trim() === '' || isValidHost(host);
  const canConnect = !!host.trim() && !!username.trim() && hostValid;

  const submit = () => {
    if (!canConnect) return;
    localStorage.setItem('quickConnectEncoding', encoding);
    localStorage.setItem('quickConnectProtocol', protocol);
    const normHost = normalizeHost(host);
    onConnect({
      name: `${username}@${normHost}`,
      host: normHost,
      port: Number(port) || 22,
      username: username.trim(),
      auth: { type: 'password', password },
      encoding,
      protocol,
    });
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
  };

  return (
    <div className="quick-connect-bar" onKeyDown={onKey}>
      <button className="quick-connect-close" onClick={onCancel} title="닫기">✕</button>
      <span className="quick-connect-label">빠른 연결</span>
      <select
        className="quick-connect-input quick-connect-proto"
        value={protocol}
        onChange={e => setProtocol(e.target.value as 'ssh' | 'sftp')}
        disabled={!!forceProtocol}
        title={forceProtocol ? '파일 전송 워크스페이스에서는 SFTP 고정' : '프로토콜'}
      >
        <option value="ssh">SSH</option>
        <option value="sftp">SFTP</option>
      </select>
      <input
        className={`quick-connect-input quick-connect-host ${hostValid ? '' : 'invalid'}`}
        placeholder="host (IPv4/IPv6/도메인)"
        value={host}
        onChange={e => setHost(e.target.value)}
        title={hostValid ? '' : '유효한 IPv4/IPv6/호스트명을 입력하세요'}
      />
      <span className="quick-connect-sep">:</span>
      <input
        className="quick-connect-input quick-connect-port"
        placeholder="22"
        value={port}
        onChange={e => setPort(e.target.value.replace(/[^0-9]/g, ''))}
      />
      <input
        className="quick-connect-input quick-connect-user"
        placeholder="username"
        value={username}
        onChange={e => setUsername(e.target.value)}
      />
      <div className="quick-connect-pw-wrap">
        <input
          className="quick-connect-input quick-connect-pw"
          type={showPassword ? 'text' : 'password'}
          placeholder="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
        />
        <button
          type="button"
          className="quick-connect-eye"
          onClick={() => setShowPassword(p => !p)}
          title={showPassword ? '숨기기' : '보기'}
        >
          {showPassword ? '🙈' : '👁'}
        </button>
      </div>
      <select
        className="quick-connect-input quick-connect-enc"
        value={encoding}
        onChange={e => setEncoding(e.target.value)}
        title="인코딩"
      >
        <option value="utf-8">utf-8</option>
        <option value="cp949">cp949</option>
        <option value="euc-kr">euc-kr</option>
        <option value="latin1">latin1</option>
      </select>
      <button
        className="quick-connect-go"
        onClick={submit}
        disabled={!canConnect}
      >
        연결
      </button>
    </div>
  );
};

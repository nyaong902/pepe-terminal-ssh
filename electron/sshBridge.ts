// electron/sshBridge.ts
import { Client } from 'ssh2';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import iconv from 'iconv-lite';
import type { LoginScriptRule } from './sessionsStore';

interface ClientRecord {
  conn: any;
  stream?: any;
  encoding?: string;
}

interface BridgeMessage {
  type: 'data' | 'connected' | 'closed' | 'error' | 'sftp-progress' | 'sftp-complete' | 'sftp-error';
  panelId: string;
  data?: string;
  error?: string;
}

class SSHBridge extends EventEmitter {
  private clients: Map<string, ClientRecord> = new Map();
  private sftpCache: Map<string, any> = new Map();
  private scriptRunners: Map<string, ExpectSendRunner> = new Map();

  onMessage(fn: (m: BridgeMessage) => void) {
    this.on('message', fn);
    return () => this.off('message', fn);
  }

  async handleConnect(panelId: string, session: any, cols?: number, rows?: number) {
    if (this.clients.has(panelId)) return;

    const conn = new Client();

    conn.on('ready', () => {
      this.emit('message', { type: 'connected', panelId });

      const shellCols = typeof cols === 'number' ? cols : 120;
      const shellRows = typeof rows === 'number' ? rows : 24;

      conn.shell({ cols: shellCols, rows: shellRows, term: 'xterm-256color' }, (err: any, stream: any) => {
        if (err) {
          this.emit('message', { type: 'error', panelId, error: String(err) });
          return;
        }

        const initialEncoding = session?.encoding || 'utf-8';

        // Expect/Send 로그인 스크립트 설정
        if (session.loginScript && session.loginScript.length > 0) {
          const runner = new ExpectSendRunner(stream, session.loginScript);
          this.scriptRunners.set(panelId, runner);
          runner.start();
        }

        stream.on('data', (data: Buffer) => {
          try {
            // 런타임 인코딩 변경 지원: 매번 현재 record의 encoding을 읽음
            const cur = (this.clients.get(panelId)?.encoding || initialEncoding).toLowerCase();
            const str = cur === 'utf-8' || cur === 'utf8'
              ? data.toString('utf8')
              : iconv.decode(data, cur);
            this.emit('message', { type: 'data', panelId, data: str });

            // 스크립트 실행 중이면 데이터 전달
            const runner = this.scriptRunners.get(panelId);
            if (runner && runner.isRunning()) {
              runner.feed(str);
            }
          } catch {
            this.emit('message', { type: 'data', panelId, data: data.toString('utf8') });
          }
        });

        stream.on('close', () => {
          this.clients.delete(panelId);
          this.sftpCache.delete(panelId);
          this.scriptRunners.delete(panelId);
          this.emit('message', { type: 'closed', panelId });
          conn.end();
        });

        this.clients.set(panelId, { conn, stream, encoding: initialEncoding });
      });
    });

    conn.on('error', (err: any) => {
      this.clients.delete(panelId);
      this.sftpCache.delete(panelId);
      this.scriptRunners.delete(panelId);
      this.emit('message', { type: 'error', panelId, error: String(err) });
    });

    const cfg: any = {
      host: session.host,
      port: session.port || 22,
      username: session.username,
      tryKeyboard: false,
      readyTimeout: 15000,
      keepaliveInterval: 10000,
      keepaliveCountMax: 3,
    } as any;

    if (session.auth?.type === 'password') {
      cfg.password = session.auth.password;
    } else if (session.auth?.type === 'key') {
      try {
        cfg.privateKey = fs.readFileSync(session.auth.keyPath);
      } catch {
        // key file not found - connect will fail with auth error
      }
    }

    conn.connect(cfg);
  }

  handleInput(panelId: string, data?: string, b64?: string) {
    const rec = this.clients.get(panelId);
    if (!rec?.stream) return;

    const enc = (rec.encoding || 'utf-8').toLowerCase();
    const isUtf8 = enc === 'utf-8' || enc === 'utf8';

    // 세션 인코딩이 UTF-8이 아닌 경우(euc-kr/cp949 등),
    // 렌더러가 보낸 UTF-8 바이트를 문자열로 디코드한 뒤 대상 인코딩으로 재인코딩해야 한다.
    if (!isUtf8) {
      let str: string | undefined;
      if (b64) {
        try { str = Buffer.from(b64, 'base64').toString('utf8'); } catch {}
      }
      if (str === undefined && data !== undefined) str = data;
      if (str !== undefined) {
        try {
          rec.stream.write(iconv.encode(str, enc));
          return;
        } catch {
          // fall through to raw write
        }
      }
    }

    if (b64) {
      rec.stream.write(Buffer.from(b64, 'base64'));
    } else if (data) {
      rec.stream.write(data);
    }
  }

  setEncoding(panelId: string, encoding: string) {
    const rec = this.clients.get(panelId);
    if (!rec) return false;
    rec.encoding = encoding || 'utf-8';
    return true;
  }

  getEncoding(panelId: string): string | null {
    const rec = this.clients.get(panelId);
    return rec?.encoding || null;
  }

  handleResize(panelId: string, cols: number, rows: number) {
    const rec = this.clients.get(panelId);
    if (!rec?.stream) return;
    try {
      rec.stream.setWindow(rows, cols, rows, cols);
    } catch {
      // stream may already be closed
    }
  }

  handleDisconnect(panelId: string) {
    const rec = this.clients.get(panelId);
    if (!rec) return;
    try {
      rec.conn.end();
    } catch {
      // already closed
    }
    this.clients.delete(panelId);
    this.sftpCache.delete(panelId);
    this.scriptRunners.delete(panelId);
  }

  // ── SFTP ──

  private getSftp(panelId: string): Promise<any> {
    const cached = this.sftpCache.get(panelId);
    if (cached) return Promise.resolve(cached);
    return new Promise((resolve, reject) => {
      const rec = this.clients.get(panelId);
      if (!rec?.conn) return reject(new Error('연결되지 않음'));
      rec.conn.sftp((err: any, sftp: any) => {
        if (err) return reject(err);
        this.sftpCache.set(panelId, sftp);
        sftp.on('close', () => this.sftpCache.delete(panelId));
        sftp.on('end', () => this.sftpCache.delete(panelId));
        resolve(sftp);
      });
    });
  }

  async handleSFTPDownload(panelId: string, remotePath: string, localPath: string): Promise<void> {
    const sftp = await this.getSftp(panelId);
    const filename = remotePath.split('/').pop() || remotePath;
    // 0바이트 파일 처리
    try {
      const stat: any = await new Promise((res, rej) => sftp.stat(remotePath, (e: any, s: any) => e ? rej(e) : res(s)));
      if (stat.size === 0) {
        fs.writeFileSync(localPath, Buffer.alloc(0));
        this.emit('message', { type: 'sftp-complete', panelId, data: JSON.stringify({ filename, direction: 'download', localPath }) });
        return;
      }
    } catch { /* stat 실패하면 일반 다운로드 시도 */ }
    return new Promise((resolve, reject) => {
      sftp.fastGet(remotePath, localPath, {
        concurrency: 64,
        chunkSize: 32768,
        step: (transferred: number, _chunk: number, total: number) => {
          this.emit('message', { type: 'sftp-progress', panelId, data: JSON.stringify({ transferred, total, filename, direction: 'download' }) });
        },
      }, (err: any) => {
        if (err) {
          this.emit('message', { type: 'sftp-error', panelId, error: String(err) });
          return reject(err);
        }
        this.emit('message', { type: 'sftp-complete', panelId, data: JSON.stringify({ filename, direction: 'download', localPath }) });
        resolve();
      });
    });
  }

  async handleSFTPUpload(panelId: string, localPath: string, remotePath: string): Promise<void> {
    const sftp = await this.getSftp(panelId);
    const filename = localPath.replace(/\\/g, '/').split('/').pop() || localPath;
    // 0바이트 파일 처리
    try {
      const localStat = fs.statSync(localPath);
      if (localStat.size === 0) {
        await new Promise<void>((res, rej) => {
          sftp.open(remotePath, 'w', (err: any, handle: any) => {
            if (err) return rej(err);
            sftp.close(handle, (e: any) => e ? rej(e) : res());
          });
        });
        this.emit('message', { type: 'sftp-complete', panelId, data: JSON.stringify({ filename, direction: 'upload', remotePath }) });
        return;
      }
    } catch { /* stat 실패하면 일반 업로드 시도 */ }
    return new Promise((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, {
        concurrency: 64,
        chunkSize: 32768,
        step: (transferred: number, _chunk: number, total: number) => {
          this.emit('message', { type: 'sftp-progress', panelId, data: JSON.stringify({ transferred, total, filename, direction: 'upload' }) });
        },
      }, (err: any) => {
        if (err) {
          this.emit('message', { type: 'sftp-error', panelId, error: String(err) });
          return reject(err);
        }
        this.emit('message', { type: 'sftp-complete', panelId, data: JSON.stringify({ filename, direction: 'upload', remotePath }) });
        resolve();
      });
    });
  }

  async handleSFTPListDir(panelId: string, remotePath: string): Promise<any[]> {
    const sftp = await this.getSftp(panelId);
    return new Promise((resolve, reject) => {
      sftp.readdir(remotePath, (err: any, list: any[]) => {
        if (err) return reject(err);
        resolve(list.map((item: any) => ({
          name: item.filename,
          isDir: item.attrs.isDirectory(),
          size: item.attrs.size,
          mtime: item.attrs.mtime,
        })));
      });
    });
  }

  // ── 로컬 파일 조작 ──

  async handleLocalListDir(dirPath: string): Promise<any[]> {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      try {
        const fullPath = path.join(dirPath, entry.name);
        const stat = await fs.promises.stat(fullPath);
        result.push({
          name: entry.name,
          isDir: entry.isDirectory(),
          size: stat.size,
          mtime: Math.floor(stat.mtimeMs / 1000),
        });
      } catch { /* skip inaccessible */ }
    }
    return result;
  }

  async handleLocalDelete(filePath: string): Promise<void> {
    const stat = await fs.promises.stat(filePath);
    if (stat.isDirectory()) {
      await fs.promises.rm(filePath, { recursive: true });
    } else {
      await fs.promises.unlink(filePath);
    }
  }

  async handleLocalMkdir(dirPath: string): Promise<void> {
    await fs.promises.mkdir(dirPath, { recursive: true });
  }

  async handleLocalRename(oldPath: string, newPath: string): Promise<void> {
    await fs.promises.rename(oldPath, newPath);
  }

  async handleSFTPDelete(panelId: string, filePath: string): Promise<void> {
    const sftp = await this.getSftp(panelId);
    return new Promise((resolve, reject) => {
      sftp.stat(filePath, (err: any, stats: any) => {
        if (err) return reject(err);
        if (stats.isDirectory()) {
          sftp.rmdir(filePath, (e: any) => e ? reject(e) : resolve());
        } else {
          sftp.unlink(filePath, (e: any) => e ? reject(e) : resolve());
        }
      });
    });
  }

  async handleSFTPMkdir(panelId: string, dirPath: string): Promise<void> {
    const sftp = await this.getSftp(panelId);
    return new Promise((resolve, reject) => {
      sftp.mkdir(dirPath, (err: any) => err ? reject(err) : resolve());
    });
  }

  async handleSFTPRename(panelId: string, oldPath: string, newPath: string): Promise<void> {
    const sftp = await this.getSftp(panelId);
    return new Promise((resolve, reject) => {
      sftp.rename(oldPath, newPath, (err: any) => err ? reject(err) : resolve());
    });
  }

  // ── 범용 전송 (4가지 조합) ──

  private async getSrcStat(src: { mode: string; termId?: string; path: string }): Promise<{ size: number; atime: number; mtime: number }> {
    if (src.mode === 'local') {
      const s = await fs.promises.stat(src.path);
      return { size: s.size, atime: Math.floor(s.atimeMs / 1000), mtime: Math.floor(s.mtimeMs / 1000) };
    } else {
      const sftp = await this.getSftp(src.termId!);
      const s: any = await new Promise((res, rej) => sftp.stat(src.path, (e: any, st: any) => e ? rej(e) : res(st)));
      return { size: s.size, atime: s.atime, mtime: s.mtime };
    }
  }

  private async createEmptyFile(dst: { mode: string; termId?: string; path: string }): Promise<void> {
    if (dst.mode === 'local') {
      await fs.promises.writeFile(dst.path, Buffer.alloc(0));
    } else {
      const sftp = await this.getSftp(dst.termId!);
      await new Promise<void>((res, rej) => {
        sftp.open(dst.path, 'w', (err: any, handle: any) => {
          if (err) return rej(err);
          sftp.close(handle, (e: any) => e ? rej(e) : res());
        });
      });
    }
  }

  private async setDstTimestamp(dst: { mode: string; termId?: string; path: string }, atime: number, mtime: number): Promise<void> {
    try {
      if (dst.mode === 'local') {
        await fs.promises.utimes(dst.path, atime, mtime);
      } else {
        const sftp = await this.getSftp(dst.termId!);
        await new Promise<void>((res, rej) => {
          sftp.utimes(dst.path, atime, mtime, (e: any) => e ? rej(e) : res());
        });
      }
    } catch { /* 타임스탬프 설정 실패해도 무시 */ }
  }

  async handleTransfer(
    src: { mode: string; termId?: string; path: string },
    dst: { mode: string; termId?: string; path: string },
    filename: string,
  ): Promise<void> {
    // 소스 파일 속성 가져오기
    let srcStat: { size: number; atime: number; mtime: number };
    try { srcStat = await this.getSrcStat(src); } catch { srcStat = { size: -1, atime: 0, mtime: 0 }; }

    // 0바이트 파일 처리
    if (srcStat.size === 0) {
      await this.createEmptyFile(dst);
      await this.setDstTimestamp(dst, srcStat.atime, srcStat.mtime);
      this.emit('message', { type: 'sftp-complete', panelId: 'transfer', data: JSON.stringify({ filename, direction: 'zero-byte' }) });
      return;
    }

    const srcLocal = src.mode === 'local';
    const dstLocal = dst.mode === 'local';

    if (srcLocal && dstLocal) {
      // 로컬 → 로컬
      await fs.promises.copyFile(src.path, dst.path);
      await this.setDstTimestamp(dst, srcStat.atime, srcStat.mtime);
      this.emit('message', { type: 'sftp-complete', panelId: 'transfer', data: JSON.stringify({ filename, direction: 'local-copy' }) });
    } else if (srcLocal && !dstLocal) {
      // 로컬 → 원격
      await this.handleSFTPUpload(dst.termId!, src.path, dst.path);
      await this.setDstTimestamp(dst, srcStat.atime, srcStat.mtime);
    } else if (!srcLocal && dstLocal) {
      // 원격 → 로컬
      await this.handleSFTPDownload(src.termId!, src.path, dst.path);
      await this.setDstTimestamp(dst, srcStat.atime, srcStat.mtime);
    } else {
      // 원격 → 원격 (스트림 파이프)
      const srcSftp = await this.getSftp(src.termId!);
      const dstSftp = await this.getSftp(dst.termId!);
      return new Promise((resolve, reject) => {
        const readStream = srcSftp.createReadStream(src.path);
        const writeStream = dstSftp.createWriteStream(dst.path);
        let transferred = 0;
        readStream.on('data', (chunk: Buffer) => {
          transferred += chunk.length;
          this.emit('message', { type: 'sftp-progress', panelId: 'transfer', data: JSON.stringify({ transferred, total: 0, filename, direction: 'remote-remote' }) });
        });
        readStream.on('error', (err: any) => reject(err));
        writeStream.on('error', (err: any) => reject(err));
        writeStream.on('close', async () => {
          await this.setDstTimestamp(dst, srcStat.atime, srcStat.mtime);
          this.emit('message', { type: 'sftp-complete', panelId: 'transfer', data: JSON.stringify({ filename, direction: 'remote-remote' }) });
          resolve();
        });
        readStream.pipe(writeStream);
      });
    }
  }

  async handleSFTPRealPath(panelId: string, remotePath: string): Promise<string> {
    const sftp = await this.getSftp(panelId);
    return new Promise((resolve, reject) => {
      sftp.realpath(remotePath, (err: any, absPath: string) => {
        if (err) return reject(err);
        resolve(absPath);
      });
    });
  }

  async handleSFTPConnect(connId: string, host: string, port: number, username: string, auth?: any): Promise<void> {
    if (this.clients.has(connId)) return;
    return new Promise((resolve, reject) => {
      const conn = new Client();
      conn.on('ready', () => {
        this.clients.set(connId, { conn });
        resolve();
      });
      conn.on('error', (err: any) => reject(err));
      const cfg: any = { host, port, username, tryKeyboard: false, readyTimeout: 15000 };
      if (auth?.type === 'password') {
        cfg.password = auth.password;
      } else if (auth?.type === 'key') {
        try { cfg.privateKey = fs.readFileSync(auth.keyPath); } catch {}
      }
      conn.connect(cfg);
    });
  }

  handleSFTPDisconnect(connId: string) {
    const rec = this.clients.get(connId);
    if (!rec) return;
    try { rec.conn.end(); } catch {}
    this.clients.delete(connId);
    this.sftpCache.delete(connId);
  }

  getConnectedPanelIds(): string[] {
    return [...this.clients.keys()];
  }
}

// ── Expect/Send 실행기 ──

class ExpectSendRunner {
  private stream: any;
  private rules: LoginScriptRule[];
  private currentIdx = 0;
  private buffer = '';
  private running = true;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(stream: any, rules: LoginScriptRule[]) {
    this.stream = stream;
    this.rules = rules;
  }

  start() {
    // 전체 타임아웃: 30초
    this.timer = setTimeout(() => this.stop(), 30000);
    // expect가 빈 규칙은 즉시 실행
    this.runImmediate();
  }

  private runImmediate() {
    while (this.currentIdx < this.rules.length && this.rules[this.currentIdx].expect.trim() === '') {
      try { this.stream.write(this.rules[this.currentIdx].send + '\n'); } catch {}
      this.currentIdx++;
    }
    if (this.currentIdx >= this.rules.length) this.stop();
  }

  isRunning() { return this.running; }

  feed(data: string) {
    if (!this.running) return;
    this.buffer += data;
    this.tryMatch();
  }

  private tryMatch() {
    if (this.currentIdx >= this.rules.length) { this.stop(); return; }

    const rule = this.rules[this.currentIdx];
    let matched = false;

    if (rule.isRegex) {
      try {
        matched = new RegExp(rule.expect).test(this.buffer);
      } catch { matched = false; }
    } else {
      matched = this.buffer.includes(rule.expect);
    }

    if (matched) {
      // 매칭 → send 전송
      try {
        this.stream.write(rule.send + '\n');
      } catch {}
      this.buffer = '';
      this.currentIdx++;
      // expect 빈 규칙 즉시 실행
      this.runImmediate();
    }
  }

  private stop() {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
}

let instance: SSHBridge | null = null;

export function getSSHBridge(): SSHBridge {
  if (!instance) instance = new SSHBridge();
  return instance;
}

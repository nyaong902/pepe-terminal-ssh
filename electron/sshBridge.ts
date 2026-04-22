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
  type: 'data' | 'connected' | 'closed' | 'error' | 'auth-prompt' | 'sftp-progress' | 'sftp-complete' | 'sftp-error';
  panelId: string;
  data?: string;
  error?: string;
  prompts?: string[];
}

class SSHBridge extends EventEmitter {
  private clients: Map<string, ClientRecord> = new Map();
  private sftpCache: Map<string, any> = new Map();
  private scriptRunners: Map<string, ExpectSendRunner> = new Map();
  private pendingAuth: Map<string, (responses: string[]) => void> = new Map();

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
            let str = cur === 'utf-8' || cur === 'utf8'
              ? data.toString('utf8')
              : iconv.decode(data, cur);

            // 셸 검출 OSC 9 응답 가로채기 (화면에는 보내지 않음)
            const shellDetectRe = /\x1b\]9;pepe-shell:([^\x1b\x07]*)(?:\x1b\\|\x07)/;
            const m = str.match(shellDetectRe);
            if (m) {
              const shellPath = m[1].trim();
              str = str.replace(shellDetectRe, '');
              this._installOsc7Hook(panelId, shellPath);
            }

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

        // OSC 7 hook 주입 전에 셸 검출 필요 (bash/zsh/tcsh 문법이 달라서).
        // 단계:
        //   1) 'printf ... $0' 로 셸 이름을 OSC 9 페이로드로 실어 보내게 함 (화면엔 안 보임).
        //      tcsh 도 미정의 변수 에러 없이 $0 은 참조 가능.
        //   2) 데이터 스트림 파싱해서 pepe-shell:<shell> 감지하면 알맞은 hook 주입.
        //   3) 이후 매 프롬프트마다 OSC 7 이 자동 방출됨.
        const injectDelay = session.loginScript && session.loginScript.length > 0 ? 3500 : 800;
        setTimeout(() => {
          try {
            // $SHELL 은 로그인 셸 경로 — bash/zsh/tcsh 모두 env var 로 노출.
            // tcsh 는 interactive 모드에서 $0 미정의로 에러내므로 $SHELL 이 더 안전.
            // 단일 인용부호로 감싸 printf format 은 어느 셸에서도 그대로 전달.
            const detect = ` printf '\\033]9;pepe-shell:%s\\033\\134' "$SHELL"\n`;
            stream.write(detect);
          } catch {}
        }, injectDelay);
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
      tryKeyboard: true,
      readyTimeout: 15000,
      keepaliveInterval: 10000,
      keepaliveCountMax: 3,
    } as any;

    if (session.auth?.type === 'password' && session.auth.password) {
      cfg.password = session.auth.password;
    } else if (session.auth?.type === 'key') {
      try {
        cfg.privateKey = fs.readFileSync(session.auth.keyPath);
      } catch {
        // key file not found - connect will fail with auth error
      }
    }

    // keyboard-interactive 인증 지원 (비밀번호 미저장 세션용)
    conn.on('keyboard-interactive', (_name: string, _instructions: string, _lang: string, prompts: any[], finish: (responses: string[]) => void) => {
      // 비밀번호가 있으면 자동 응답, 없으면 빈 응답 (renderer에서 처리)
      if (cfg.password) {
        finish([cfg.password]);
      } else {
        // renderer에 비밀번호 요청
        this.emit('message', { type: 'auth-prompt', panelId, prompts: prompts.map((p: any) => p.prompt) });
        this.pendingAuth.set(panelId, finish);
      }
    });

    conn.connect(cfg);
  }

  handleAuthResponse(panelId: string, responses: string[]) {
    const finish = this.pendingAuth.get(panelId);
    if (finish) {
      finish(responses);
      this.pendingAuth.delete(panelId);
    }
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

  // 셸 검출 결과로 적절한 OSC 7 hook 주입. 매 프롬프트마다 원격 쉘이 현재 디렉토리를
  // OSC 7 (file://host/path) 시퀀스로 보내게 함.
  private _installOsc7Hook(panelId: string, shellPath: string) {
    const rec = this.clients.get(panelId);
    if (!rec) return;
    const shell = (shellPath || '').toLowerCase();
    let cmd = '';
    // 순서 중요: zsh/csh/tcsh 모두 'sh' 문자열 포함 → 구체적 셸부터 검사.
    // 호스트명은 localhost 로 고정 — 파서는 path 부분만 사용하므로 무관하고,
    // tcsh 의 $HOST 미정의 에러를 피하려는 목적.
    if (shell.includes('zsh')) {
      cmd = ` precmd_pepe_osc7(){ printf '\\033]7;file://localhost%s\\033\\134' "$PWD" }; typeset -ga precmd_functions; precmd_functions+=(precmd_pepe_osc7)\n`;
    } else if (shell.includes('tcsh') || shell.includes('csh')) {
      // csh / tcsh — alias precmd 는 tcsh 기능.
      cmd = ` alias precmd 'printf "\\033]7;file://localhost%s\\033\\134" "$cwd"'\n`;
    } else if (shell.includes('bash') || shell.endsWith('/sh') || shell === 'sh') {
      cmd = ` PROMPT_COMMAND='printf "\\033]7;file://localhost%s\\033\\134" "$PWD"'\n`;
    } else {
      // 지원 안 하는 셸 (fish 등) — 조용히 무시
      return;
    }
    try { rec.stream.write(cmd); } catch {}
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

  public getSftp(panelId: string): Promise<any> {
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

  async handleSFTPReadFile(panelId: string, remotePath: string): Promise<Buffer> {
    const sftp = await this.getSftp(panelId);
    return new Promise((resolve, reject) => {
      sftp.readFile(remotePath, (err: any, data: Buffer) => {
        if (err) return reject(err);
        resolve(data);
      });
    });
  }

  async handleSFTPWriteFile(panelId: string, remotePath: string, content: Buffer | string): Promise<void> {
    const sftp = await this.getSftp(panelId);
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
    return new Promise((resolve, reject) => {
      sftp.writeFile(remotePath, buf, (err: any) => err ? reject(err) : resolve());
    });
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

  // 소스가 디렉토리인지 확인
  private async isSrcDirectory(src: { mode: string; termId?: string; path: string }): Promise<boolean> {
    try {
      if (src.mode === 'local') {
        const s = await fs.promises.stat(src.path);
        return s.isDirectory();
      } else {
        const sftp = await this.getSftp(src.termId!);
        const s: any = await new Promise((res, rej) => sftp.stat(src.path, (e: any, st: any) => e ? rej(e) : res(st)));
        return s.isDirectory();
      }
    } catch { return false; }
  }

  // 대상 디렉토리 생성 (없으면)
  private async ensureDstDir(dst: { mode: string; termId?: string; path: string }): Promise<void> {
    try {
      if (dst.mode === 'local') {
        await fs.promises.mkdir(dst.path, { recursive: true });
      } else {
        const sftp = await this.getSftp(dst.termId!);
        try {
          await new Promise<void>((res, rej) => sftp.stat(dst.path, (e: any) => e ? rej(e) : res()));
          return; // 이미 존재
        } catch {}
        await new Promise<void>((res, rej) => sftp.mkdir(dst.path, (e: any) => e ? rej(e) : res()));
      }
    } catch (err) { /* 이미 존재하면 무시 */ }
  }

  // 소스 디렉토리 내용 나열
  private async listSrcDir(src: { mode: string; termId?: string; path: string }): Promise<string[]> {
    if (src.mode === 'local') {
      return await fs.promises.readdir(src.path);
    } else {
      const sftp = await this.getSftp(src.termId!);
      const list: any[] = await new Promise((res, rej) => sftp.readdir(src.path, (e: any, l: any) => e ? rej(e) : res(l)));
      return list.map((item: any) => item.filename);
    }
  }

  async handleTransfer(
    src: { mode: string; termId?: string; path: string },
    dst: { mode: string; termId?: string; path: string },
    filename: string,
  ): Promise<void> {
    // 디렉토리면 재귀 복사
    if (await this.isSrcDirectory(src)) {
      await this.ensureDstDir(dst);
      const entries = await this.listSrcDir(src);
      const sep = (p: string) => (p.endsWith('/') || p.endsWith('\\')) ? '' : (src.mode === 'local' ? '\\' : '/');
      const dsep = (p: string) => (p.endsWith('/') || p.endsWith('\\')) ? '' : (dst.mode === 'local' ? '\\' : '/');
      for (const entry of entries) {
        const childSrc = { ...src, path: src.path + sep(src.path) + entry };
        const childDst = { ...dst, path: dst.path + dsep(dst.path) + entry };
        await this.handleTransfer(childSrc, childDst, entry);
      }
      this.emit('message', { type: 'sftp-complete', panelId: 'transfer', data: JSON.stringify({ filename, direction: 'dir-done' }) });
      return;
    }

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

  // SSH exec: 원격에서 쉘 명령 실행하고 stdout/stderr/exitCode 반환
  // 세션 인코딩(utf-8/cp949/euc-kr 등)에 맞춰 command 바이트 변환 + 출력 디코딩
  public async handleExec(panelId: string, command: string, timeoutMs = 60000): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    const entry = this.clients.get(panelId);
    if (!entry) throw new Error(`SSH session not connected: ${panelId}`);
    const conn: any = entry.conn;
    const enc = (entry.encoding || 'utf-8').toLowerCase();
    const iconv = require('iconv-lite');
    const useIconv = iconv.encodingExists(enc) && enc !== 'utf-8' && enc !== 'utf8';

    // 명령 문자열을 세션 인코딩 바이트로 변환해서 전달 (한글 깨짐 방지)
    const commandBuf: Buffer = useIconv ? iconv.encode(command, enc) : Buffer.from(command, 'utf-8');
    const commandToSend: string | Buffer = useIconv ? commandBuf : command;

    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('exec timeout')), timeoutMs);
      conn.exec(commandToSend as any, { pty: false }, (err: any, stream: any) => {
        if (err) { clearTimeout(to); return reject(err); }
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let exitCode: number | null = null;
        stream.on('data', (data: Buffer) => { stdoutChunks.push(data); });
        stream.stderr.on('data', (data: Buffer) => { stderrChunks.push(data); });
        stream.on('exit', (code: number) => { exitCode = code; });
        stream.on('close', () => {
          clearTimeout(to);
          const outBuf = Buffer.concat(stdoutChunks);
          const errBuf = Buffer.concat(stderrChunks);
          const stdout = useIconv ? iconv.decode(outBuf, enc) : outBuf.toString('utf-8');
          const stderr = useIconv ? iconv.decode(errBuf, enc) : errBuf.toString('utf-8');
          resolve({ stdout, stderr, exitCode });
        });
      });
    });
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

// electron/sshBridge.ts
import { Client } from 'ssh2';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import iconv from 'iconv-lite';
import type { LoginScriptRule } from './sessionsStore';

interface ClientRecord {
  conn: any;           // 활성 SSH 연결 (점프 미사용 시 primary, 사용 시 jumpConn)
  stream?: any;
  encoding?: string;
  primaryConn?: any;   // 점프 사용 시 transport 로 쓰이는 primary 연결 (세션 종료 시 함께 해제)
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
  // 연결 중(아직 ready 안 된) Client — handleDisconnect 가 찾을 수 있도록 별도 추적.
  // ready 시점에 삭제 + clients 에 등록. error 시에도 삭제.
  private pendingConnects: Map<string, any> = new Map();
  private sftpCache: Map<string, any> = new Map();
  private scriptRunners: Map<string, ExpectSendRunner> = new Map();
  private pendingAuth: Map<string, (responses: string[]) => void> = new Map();

  onMessage(fn: (m: BridgeMessage) => void) {
    this.on('message', fn);
    return () => this.off('message', fn);
  }

  async handleConnect(panelId: string, session: any, cols?: number, rows?: number) {
    if (this.clients.has(panelId)) return;
    // 이전 pending 연결이 있으면 먼저 정리 (retry 시 이중 연결 방지)
    const prev = this.pendingConnects.get(panelId);
    if (prev) {
      try { prev.end(); } catch {}
      this.pendingConnects.delete(panelId);
    }

    const conn = new Client();
    this.pendingConnects.set(panelId, conn);

    conn.on('ready', async () => {
      this.pendingConnects.delete(panelId);
      this.emit('message', { type: 'connected', panelId });
      // 점프 호스트 설정이 있으면 primary 위에 터널 + 두번째 SSH 열고 그쪽에서 shell + SFTP
      const jumpHost = session.jumpTargetHost?.trim();
      if (jumpHost) {
        try {
          await this._setupJumpedSession(panelId, session, conn, cols, rows);
        } catch (err: any) {
          this.emit('message', { type: 'error', panelId, error: `점프 호스트 연결 실패: ${err?.message || String(err)}` });
          try { conn.end(); } catch {}
        }
      } else {
        this._openShellOnConn(panelId, session, conn, cols, rows, undefined);
      }
    });

    conn.on('error', (err: any) => {
      console.log(`[ssh-error] panelId=${panelId} host=${session?.host} msg=${err?.message || err} code=${err?.code || ''} level=${err?.level || ''}`);
      try { require('electron').BrowserWindow.getAllWindows()[0]?.webContents.send('debug:log', `[ssh-error] ${session?.host} ${err?.message || err}`); } catch {}
      this.pendingConnects.delete(panelId);
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

  // 점프 호스트 설정: primary 연결 위에 TCP 터널 생성 + 두번째 SSH 핸드셰이크 + 셸 오픈.
  // primary 의 ~/.ssh/ 에 있는 키 파일(id_rsa/id_ed25519/id_ecdsa)을 SFTP 로 읽어
  // 점프 타겟 인증에 재사용 (EMS→MPM01 passwordless 설정 그대로 활용).
  private async _setupJumpedSession(panelId: string, session: any, primaryConn: any, cols?: number, rows?: number): Promise<void> {
    const jumpHost = session.jumpTargetHost.trim();
    const jumpUser = (session.jumpTargetUser || 'root').trim();
    const jumpPort = Number(session.jumpTargetPort) || 22;
    const jumpPassword = typeof session.jumpTargetPassword === 'string' ? session.jumpTargetPassword : '';
    const t0 = Date.now();
    const stage = (name: string) => {
      const msg = `[jump-${panelId.slice(-6)}] ${name} +${Date.now() - t0}ms`;
      console.log(msg);
      try { require('electron').BrowserWindow.getAllWindows()[0]?.webContents.send('debug:log', msg); } catch {}
    };
    stage('start');

    // 1. 인증 방법 결정: 비밀번호 우선, 없으면 primary 의 ~/.ssh/ 키 자동 사용
    const authCfg: any = {};
    if (jumpPassword) {
      authCfg.password = jumpPassword;
    } else {
      const keyBuf = await this._readSshKeyFromConn(primaryConn);
      if (!keyBuf) {
        throw new Error(`${session.host} 의 ~/.ssh/ 에서 사용 가능한 SSH 키(id_rsa/id_ed25519/id_ecdsa) 미발견. 점프 타겟 비밀번호를 입력하거나 키 파일을 등록하세요.`);
      }
      authCfg.privateKey = keyBuf;
    }

    stage('key-read done');
    // 2. primary 위에 TCP 포워딩 — 점프 타겟:port 로
    const sock: any = await new Promise((resolve, reject) => {
      primaryConn.forwardOut('127.0.0.1', 0, jumpHost, jumpPort, (err: any, s: any) => {
        if (err) return reject(err);
        resolve(s);
      });
    });
    stage('forwardOut done');
    // sock 스트림에도 error 핸들러 — 미처리 시 main 프로세스 크래시
    sock.on('error', (e: any) => {
      console.log(`[jump-${panelId.slice(-6)}] tunnel sock error:`, e?.message || e);
    });

    // 3. 그 소켓 위에 두번째 SSH Client 연결
    //    점프 타겟이 Solaris/레거시 OpenSSH 등 구버전일 수 있어서 기본 알고리즘 외
    //    레거시까지 허용. SUPPORTED_* 는 ssh2 가 현재 시스템 crypto 기준으로 이미
    //    필터한 목록이라, unsupported algorithm 에러 없이 안전하게 넓혀 쓸 수 있음.
    const ssh2Constants = require('ssh2/lib/protocol/constants');
    const LEGACY_ALGORITHMS = {
      kex: ssh2Constants.SUPPORTED_KEX,
      serverHostKey: ssh2Constants.SUPPORTED_SERVER_HOST_KEY,
      cipher: ssh2Constants.SUPPORTED_CIPHER,
      hmac: ssh2Constants.SUPPORTED_MAC,
    };
    const jumpConn = new Client();
    // 영구 에러 핸들러 — handshake 이후 tunnel 이 끊겨도 uncaught exception 안 나게.
    // 에러 발생 시 해당 panel 로 error 메시지 전달.
    jumpConn.on('error', (e: any) => {
      console.log(`[jump-${panelId.slice(-6)}] jumpConn error:`, e?.message || e);
      try { this.emit('message', { type: 'error', panelId, error: `점프 연결 오류: ${e?.message || String(e)}` }); } catch {}
    });
    await new Promise<void>((resolve, reject) => {
      const onReady = () => { cleanup(); resolve(); };
      const onErr = (e: any) => { cleanup(); reject(e); };
      // 영구 error 핸들러는 위에서 이미 걸었으니 여기선 한번만 reject 용으로 래핑
      const wrappedErr = (e: any) => onErr(e);
      const cleanup = () => { jumpConn.removeListener('ready', onReady); jumpConn.removeListener('error', wrappedErr); };
      jumpConn.once('ready', onReady);
      jumpConn.once('error', wrappedErr);
      jumpConn.connect({
        sock,
        username: jumpUser,
        ...authCfg,
        algorithms: LEGACY_ALGORITHMS,
        tryKeyboard: !!jumpPassword, // 비밀번호 모드면 keyboard-interactive 도 허용
        // Solaris 레거시 KEX 는 CPU 집약적이라 동시 접속 시 15초로 부족. 30초로 늘림.
        readyTimeout: 30000,
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
      } as any);
    });

    stage('jumpConn ready');
    // 4. 점프 타겟에서 shell + SFTP. primary 는 transport 로 유지.
    this._openShellOnConn(panelId, session, jumpConn, cols, rows, primaryConn);
  }

  private async _readSshKeyFromConn(conn: any): Promise<Buffer | null> {
    const sftp: any = await new Promise((resolve, reject) => {
      conn.sftp((err: any, s: any) => err ? reject(err) : resolve(s));
    });
    const candidates = ['.ssh/id_rsa', '.ssh/id_ed25519', '.ssh/id_ecdsa'];
    // 병렬 시도 — 네트워크 왕복 1회 만큼의 시간에 모든 후보 확인
    const attempts = candidates.map(rel => new Promise<Buffer | null>((resolve) => {
      sftp.readFile(rel, (err: any, d: Buffer) => {
        if (err || !d || d.length === 0) return resolve(null);
        resolve(d);
      });
    }));
    const results = await Promise.all(attempts);
    // id_rsa 우선순위 — 먼저 나타난 non-null 반환
    for (const r of results) { if (r) return r; }
    return null;
  }

  // 주어진 연결 위에 shell 을 열고 스트림·핸들러 연결. jump 사용 시 primaryConn 도 함께 받아
  // close 시 둘 다 정리.
  private _openShellOnConn(panelId: string, session: any, conn: any, cols: number | undefined, rows: number | undefined, primaryConn: any | undefined): void {
    const shellCols = typeof cols === 'number' ? cols : 120;
    const shellRows = typeof rows === 'number' ? rows : 24;

    conn.shell({ cols: shellCols, rows: shellRows, term: 'xterm-256color' }, (err: any, stream: any) => {
      if (err) {
        this.emit('message', { type: 'error', panelId, error: String(err) });
        try { primaryConn?.end(); } catch {}
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
          const cur = (this.clients.get(panelId)?.encoding || initialEncoding).toLowerCase();
          let str = cur === 'utf-8' || cur === 'utf8'
            ? data.toString('utf8')
            : iconv.decode(data, cur);

          const shellDetectRe = /\x1b\]9;pepe-shell:([^\x1b\x07]*)(?:\x1b\\|\x07)/;
          const m = str.match(shellDetectRe);
          if (m) {
            const shellPath = m[1].trim();
            str = str.replace(shellDetectRe, '');
            this._installOsc7Hook(panelId, shellPath);
          }

          this.emit('message', { type: 'data', panelId, data: str });

          const runner = this.scriptRunners.get(panelId);
          if (runner && runner.isRunning()) {
            runner.feed(str);
          }
        } catch {
          this.emit('message', { type: 'data', panelId, data: data.toString('utf8') });
        }
      });

      // stream error 핸들러 — 미등록 시 unhandled exception → main 프로세스 크래시.
      stream.on('error', (e: any) => {
        console.log(`[shell-${panelId.slice(-6)}] stream error:`, e?.message || e);
        // close 이벤트도 뒤이어 오므로 여기선 따로 정리 안 함
      });
      stream.stderr?.on?.('error', (e: any) => {
        console.log(`[shell-${panelId.slice(-6)}] stderr error:`, e?.message || e);
      });

      stream.on('close', () => {
        this.clients.delete(panelId);
        this.sftpCache.delete(panelId);
        this.scriptRunners.delete(panelId);
        this.emit('message', { type: 'closed', panelId });
        try { conn.end(); } catch {}
        try { primaryConn?.end(); } catch {}
      });

      this.clients.set(panelId, { conn, stream, encoding: initialEncoding, primaryConn });

      // 세션 옵션 autoTrackPwd 가 켜져 있으면 OSC 9/7 hook 주입 — 터미널에서 cd 하면 파일 트리 자동 추적.
      // 옵션 꺼져 있으면(기본) 주입하지 않아 화면에 명령 노출 없음, MOTD 완전 보존.
      if (session.autoTrackPwd) {
        const injectDelay = session.loginScript && session.loginScript.length > 0 ? 3500 : 800;
        setTimeout(() => {
          try {
            const detect = ` printf '\\033]9;pepe-shell:%s\\033\\134\\033[1A\\033[2K\\r' "$SHELL"\n`;
            stream.write(detect);
          } catch {}
        }, injectDelay);
      }
    });
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
    // 명령 끝에 ; printf '\033[1A\033[2K\r' 로 주입 명령 echo 1줄 erase (MOTD 보존).
    const clearLine = `; printf '\\033[1A\\033[2K\\r'`;
    if (shell.includes('zsh')) {
      cmd = ` precmd_pepe_osc7(){ printf '\\033]7;file://localhost%s\\033\\134' "$PWD" }; typeset -ga precmd_functions; precmd_functions+=(precmd_pepe_osc7)${clearLine}\n`;
    } else if (shell.includes('tcsh') || shell.includes('csh')) {
      cmd = ` alias precmd 'printf "\\033]7;file://localhost%s\\033\\134" "$cwd"'${clearLine}\n`;
    } else if (shell.includes('bash') || shell.endsWith('/sh') || shell === 'sh') {
      cmd = ` PROMPT_COMMAND='printf "\\033]7;file://localhost%s\\033\\134" "$PWD"'${clearLine}\n`;
    } else {
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
    // 연결 완료 상태
    const rec = this.clients.get(panelId);
    if (rec) {
      try { rec.conn.end(); } catch {}
      this.clients.delete(panelId);
    }
    // 아직 ready 안 된 pending 연결도 정리
    const pending = this.pendingConnects.get(panelId);
    if (pending) {
      try { pending.end(); } catch {}
      this.pendingConnects.delete(panelId);
    }
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
    // 재귀 구현 — 폴더는 내부 파일/하위폴더 먼저 삭제 후 rmdir
    const deleteRecursive = async (p: string): Promise<void> => {
      const stats: any = await new Promise((res, rej) => sftp.stat(p, (e: any, s: any) => e ? rej(e) : res(s)));
      if (stats.isDirectory()) {
        const entries: any[] = await new Promise((res, rej) => sftp.readdir(p, (e: any, l: any) => e ? rej(e) : res(l)));
        for (const entry of entries) {
          if (entry.filename === '.' || entry.filename === '..') continue;
          const childPath = p.endsWith('/') ? p + entry.filename : p + '/' + entry.filename;
          await deleteRecursive(childPath);
        }
        await new Promise<void>((res, rej) => sftp.rmdir(p, (e: any) => e ? rej(e) : res()));
      } else {
        await new Promise<void>((res, rej) => sftp.unlink(p, (e: any) => e ? rej(e) : res()));
      }
    };
    await deleteRecursive(filePath);
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
      // 로컬은 OS 네이티브 separator(path.sep), 원격(SFTP)은 항상 '/'
      const joinPath = (base: string, name: string, mode: string): string => {
        if (mode === 'local') return path.join(base, name);
        if (base.endsWith('/')) return base + name;
        return base + '/' + name;
      };
      for (const entry of entries) {
        const childSrc = { ...src, path: joinPath(src.path, entry, src.mode) };
        const childDst = { ...dst, path: joinPath(dst.path, entry, dst.mode) };
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

  // jumpOpts 가 주어지면 primary(host) 를 경유해서 점프 타겟에 SFTP 직결.
  // 터미널 세션의 handleConnect 와 동일한 ProxyJump 패턴이지만 shell 대신 SFTP 채널만 유지.
  async handleSFTPConnect(
    connId: string,
    host: string,
    port: number,
    username: string,
    auth?: any,
    jumpOpts?: { host: string; user?: string; port?: number; password?: string }
  ): Promise<void> {
    if (this.clients.has(connId)) return;
    const log = (msg: string) => {
      console.log(`[sftp-connect-${connId}] ${msg}`);
      try { require('electron').BrowserWindow.getAllWindows()[0]?.webContents.send('debug:log', `[sftp-connect] ${msg}`); } catch {}
    };
    log(`start host=${host} user=${username} jump=${jumpOpts?.host || '(none)'}`);
    return new Promise((resolve, reject) => {
      const primaryConn = new Client();
      primaryConn.on('error', (err: any) => {
        log(`primary error: ${err?.message || err}`);
        reject(err);
      });
      // 비밀번호 미저장 세션 대비 keyboard-interactive 도 허용
      primaryConn.on('keyboard-interactive', (_n: any, _i: any, _l: any, prompts: any[], finish: (r: string[]) => void) => {
        if (auth?.type === 'password' && auth.password) finish([auth.password]);
        else finish(prompts.map(() => ''));
      });
      primaryConn.on('ready', async () => {
        log(`primary ready`);
        if (!jumpOpts?.host) {
          this.clients.set(connId, { conn: primaryConn });
          log(`no jump, saved as ${connId}`);
          resolve();
          return;
        }
        try {
          const jumpHost = jumpOpts.host;
          const jumpUser = jumpOpts.user || 'root';
          const jumpPort = jumpOpts.port || 22;
          const authCfg: any = {};
          if (jumpOpts.password) {
            authCfg.password = jumpOpts.password;
            log(`jump auth: password`);
          } else {
            log(`jump auth: reading key from primary...`);
            const keyBuf = await this._readSshKeyFromConn(primaryConn);
            if (!keyBuf) throw new Error(`${host} 의 ~/.ssh/ 에서 사용 가능한 키 미발견`);
            authCfg.privateKey = keyBuf;
            log(`jump auth: key read (${keyBuf.length}B)`);
          }
          log(`forwardOut → ${jumpHost}:${jumpPort}`);
          const sock: any = await new Promise((res, rej) => {
            primaryConn.forwardOut('127.0.0.1', 0, jumpHost, jumpPort, (e: any, s: any) => e ? rej(e) : res(s));
          });
          sock.on('error', (e: any) => log(`sock error: ${e?.message}`));
          log(`forwardOut done, opening jump SSH`);
          const ssh2Constants = require('ssh2/lib/protocol/constants');
          const jumpConn = new Client();
          jumpConn.on('error', (e: any) => log(`jumpConn error: ${e?.message}`));
          await new Promise<void>((res, rej) => {
            const onReady = () => { cleanup(); res(); };
            const onErr = (e: any) => { cleanup(); rej(e); };
            const cleanup = () => { jumpConn.removeListener('ready', onReady); jumpConn.removeListener('error', onErr); };
            jumpConn.once('ready', onReady);
            jumpConn.once('error', onErr);
            jumpConn.connect({
              sock,
              username: jumpUser,
              ...authCfg,
              algorithms: {
                kex: ssh2Constants.SUPPORTED_KEX,
                serverHostKey: ssh2Constants.SUPPORTED_SERVER_HOST_KEY,
                cipher: ssh2Constants.SUPPORTED_CIPHER,
                hmac: ssh2Constants.SUPPORTED_MAC,
              },
              tryKeyboard: !!jumpOpts.password,
              readyTimeout: 30000,
            } as any);
          });
          log(`jumpConn ready`);
          this.clients.set(connId, { conn: jumpConn, primaryConn });
          resolve();
        } catch (err: any) {
          log(`jump setup FAILED: ${err?.message || err}`);
          try { primaryConn.end(); } catch {}
          reject(err);
        }
      });
      // tryKeyboard: true 로 확장 — 비밀번호 모저장 세션 등 대비
      const cfg: any = { host, port, username, tryKeyboard: true, readyTimeout: 15000 };
      if (auth?.type === 'password') {
        cfg.password = auth.password;
      } else if (auth?.type === 'key') {
        try { cfg.privateKey = fs.readFileSync(auth.keyPath); } catch (e: any) { log(`key read fail: ${e?.message}`); }
      }
      log(`primary connect...`);
      primaryConn.connect(cfg);
    });
  }

  handleSFTPDisconnect(connId: string) {
    const rec = this.clients.get(connId);
    if (!rec) return;
    try { rec.conn.end(); } catch {}
    try { rec.primaryConn?.end(); } catch {}
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

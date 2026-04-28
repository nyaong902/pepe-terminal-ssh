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
  type: 'data' | 'connected' | 'closed' | 'error' | 'auth-prompt' | 'sftp-progress' | 'sftp-complete' | 'sftp-error' | 'auto-track';
  panelId: string;
  data?: string;
  error?: string;
  prompts?: string[];
  enabled?: boolean;
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

    // 연결 진행 상황을 터미널에 출력하는 헬퍼
    const logLine = (color: string, msg: string) => {
      this.emit('message', { type: 'data', panelId, data: `\r\n\x1b[${color}m${msg}\x1b[0m\r\n` });
    };
    const logInline = (color: string, msg: string) => {
      this.emit('message', { type: 'data', panelId, data: `\x1b[${color}m${msg}\x1b[0m` });
    };

    logLine('96', `▶ ${session.host}:${session.port || 22} (${session.username}) 연결 중...`);

    conn.on('handshake', () => logInline('90', '  [handshake OK] '));
    conn.on('banner', () => logInline('90', '[banner] '));

    conn.on('ready', async () => {
      this.pendingConnects.delete(panelId);
      logInline('92', '[SSH 연결 완료]\r\n');
      this.emit('message', { type: 'connected', panelId });
      const jumpHost = session.jumpTargetHost?.trim();
      if (jumpHost) {
        logLine('96', `▶ 점프 호스트 ${jumpHost}:${session.jumpTargetPort || 22} (${session.jumpTargetUser || 'root'}) 연결 중...`);
        try {
          await this._setupJumpedSession(panelId, session, conn, cols, rows);
        } catch (err: any) {
          logLine('91', `✕ 점프 호스트 연결 실패: ${err?.message || String(err)}`);
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
      logLine('91', `✕ 연결 오류: ${err?.message || String(err)}`);
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
    this.termCols.set(panelId, shellCols);

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

          // 자동추적 명령 echo 차단 (지금은 거의 안 쓰이지만 안전 장치로 유지)
          str = this._consumeEchoPrefix(panelId, str);

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

      // 세션 옵션 autoTrackPwd 가 켜져 있으면 백그라운드 PID 탐지 + cwd 폴링 시작 — 셸에 명령 안 보냄.
      if (session.autoTrackPwd) {
        const injectDelay = session.loginScript && session.loginScript.length > 0 ? 3500 : 800;
        setTimeout(() => {
          this._installOsc7Hook(panelId, '');
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

  // 검출된 shell path 캐시 (런타임 토글 시 hook 재설치/제거용)
  private detectedShells: Map<string, string> = new Map();
  // 마지막 알려진 터미널 cols (wrap 계산용)
  private termCols: Map<string, number> = new Map();
  // panel → 인터랙티브 셸 PID (백그라운드 cwd 폴링용)
  private shellPids: Map<string, number> = new Map();
  // panel → 마지막으로 알려진 cwd (변경 감지용)
  private lastCwd: Map<string, string> = new Map();
  // panel → 폴링 timer
  private cwdPollers: Map<string, ReturnType<typeof setInterval>> = new Map();

  // 호환성용 no-op: 백그라운드 폴링 방식으로 전환 후 사용 안 함.
  private _consumeEchoPrefix(_panelId: string, str: string): string {
    return str;
  }

  // 셸 PID 를 백그라운드로 탐지하고 cwd 폴링 시작 (셸 stdin 에 명령 안 보냄).
  // 다중 전략으로 시도. 셸 종류 무관.
  private _installOsc7Hook(panelId: string, shellPath: string) {
    const rec = this.clients.get(panelId);
    if (!rec?.conn) return;
    this.detectedShells.set(panelId, shellPath || '');
    // SSH_CONNECTION env 로 우리 연결의 셸 후보들을 모두 찾고, 그 중 가장 큰 PID 선택
    // (= 가장 최근 = 사용자의 foreground 셸. nested shell 케이스도 정확히 추적).
    // 스크립트는 base64 로 전달해 csh 의 quote/redirect 이슈 우회.
    const innerScript = `_c="$SSH_CONNECTION"
candidates=""
for f in /proc/[0-9]*/environ; do
  [ -r "$f" ] || continue
  # SSH_CONNECTION 일치 + TERM env 있음 (interactive PTY) + tty_nr != 0 (controlling TTY 보유)
  if grep -aqz "SSH_CONNECTION=$_c" "$f" 2>/dev/null && grep -aqz "TERM=" "$f" 2>/dev/null; then
    p=$(basename $(dirname "$f"))
    [ -e "/proc/$p/stat" ] || continue
    tty_nr=$(awk '{print $7}' /proc/$p/stat 2>/dev/null)
    [ -n "$tty_nr" ] && [ "$tty_nr" != "0" ] || continue
    n=$(cat /proc/$p/comm 2>/dev/null)
    case "$n" in
      csh|tcsh|bash|zsh|sh|ksh|dash|fish)
        candidates="$candidates $p"
        ;;
    esac
  fi
done
# 후보 중 가장 큰 PID 선택 (최신 셸 = foreground)
best=""
for p in $candidates; do
  if [ -z "$best" ] || [ "$p" -gt "$best" ]; then
    best="$p"
  fi
done
if [ -n "$best" ]; then
  printf '<<PEPE>>%s<<END>>' "$best"
  # 디버그: 모든 후보와 cwd 출력
  for p in $candidates; do
    cwd=$(readlink /proc/$p/cwd 2>/dev/null)
    n=$(cat /proc/$p/comm 2>/dev/null)
    echo "DBG candidate pid=$p comm=$n cwd=$cwd" >&2
  done
  exit 0
fi
# fallback: ps 기반 etime 정렬
pid2=$(ps -u "$USER" -o pid,etime,comm 2>/dev/null | awk '$3 ~ /^-?(csh|tcsh|bash|zsh|sh|ksh|dash|fish)$/ {print $1, $2}' | sort -k2 -r | head -1 | awk '{print $1}')
printf '<<PEPE>>%s<<END>>' "$pid2"`;
    const b64 = Buffer.from(innerScript).toString('base64');
    const findPidScript = `echo ${b64} | base64 -d | /bin/sh`;
    rec.conn.exec(findPidScript, (err: any, stream: any) => {
      if (err) {
        console.log(`[autotrack-${panelId.slice(-6)}] PID detect exec failed:`, err);
        return;
      }
      let out = '';
      let errOut = '';
      stream.on('data', (d: Buffer) => { out += d.toString('utf8'); });
      stream.stderr.on('data', (d: Buffer) => { errOut += d.toString('utf8'); });
      stream.on('close', () => {
        const m = out.match(/<<PEPE>>([\s\S]*?)<<END>>/);
        const trimmed = m ? m[1].trim() : out.trim();
        console.log(`[autotrack-${panelId.slice(-6)}] PID detect output: "${trimmed}" stderr: "${errOut.trim().slice(0, 200)}"`);
        const pid = parseInt(trimmed, 10);
        if (pid > 0) {
          this.shellPids.set(panelId, pid);
          console.log(`[autotrack-${panelId.slice(-6)}] shell PID=${pid}`);
          this._startCwdPolling(panelId);
          this.emit('message', { type: 'auto-track', panelId, enabled: true });
        } else {
          console.log(`[autotrack-${panelId.slice(-6)}] PID not found`);
        }
      });
    });
  }

  // 백그라운드 cwd 폴링 — separate exec 채널로 readlink /proc/PID/cwd 를 주기적으로 실행.
  // 셸에 일체 명령 보내지 않음. cwd 변경되면 fake OSC 7 emit.
  private _startCwdPolling(panelId: string): void {
    this._stopCwdPolling(panelId); // 중복 방지
    const interval = 400;
    const pid = this.shellPids.get(panelId);
    if (!pid) return;
    const tick = () => {
      const rec = this.clients.get(panelId);
      if (!rec?.conn) { this._stopCwdPolling(panelId); return; }
      const curPid = this.shellPids.get(panelId);
      if (!curPid) return;
      // 사용자 로그인 셸(csh) 의 rc 파일이 stdout 에 출력을 추가할 수 있어 — 고유 마커로 readlink 결과만 추출
      const cmd = `/bin/sh -c 'printf "<<PEPE>>"; readlink /proc/${curPid}/cwd 2>/dev/null; printf "<<END>>"'`;
      rec.conn.exec(cmd, (err: any, stream: any) => {
        if (err) {
          console.log(`[autotrack-${panelId.slice(-6)}] poll exec err:`, err);
          return;
        }
        let out = '';
        stream.on('data', (d: Buffer) => { out += d.toString('utf8'); });
        stream.on('close', () => {
          const m = out.match(/<<PEPE>>([\s\S]*?)<<END>>/);
          const inner = (m ? m[1] : out).trim();
          // path 추출 — / 로 시작 (root `/` 단독도 허용)
          let path = '';
          if (inner === '/') {
            path = '/';
          } else {
            const pathMatch = inner.match(/\/[A-Za-z0-9_\-./~]+/);
            if (pathMatch) path = pathMatch[0];
          }
          if (!path) {
            console.log(`[autotrack-${panelId.slice(-6)}] poll: no path in "${inner.slice(0, 100)}"`);
            return;
          }
          const last = this.lastCwd.get(panelId);
          if (path !== last) {
            console.log(`[autotrack-${panelId.slice(-6)}] cwd changed: ${last} → ${path}`);
            this.lastCwd.set(panelId, path);
            const oscSeq = `\x1b]7;file://localhost${path}\x1b\\`;
            this.emit('message', { type: 'data', panelId, data: oscSeq });
          }
        });
      });
    };
    tick(); // 즉시 한 번
    const t = setInterval(tick, interval);
    this.cwdPollers.set(panelId, t);
  }

  private _stopCwdPolling(panelId: string): void {
    const t = this.cwdPollers.get(panelId);
    if (t) { clearInterval(t); this.cwdPollers.delete(panelId); }
  }

  // 런타임 PWD 자동추적 토글 — 백그라운드 폴링 시작/중지. 셸 stdin 에 명령 절대 안 보냄.
  // 첫 호출이면 exec 채널로 PID 탐지.
  setAutoTrack(panelId: string, enabled: boolean): { success: boolean; error?: string } {
    const rec = this.clients.get(panelId);
    if (!rec?.conn) return { success: false, error: 'not connected' };
    if (enabled) {
      if (this.shellPids.has(panelId)) {
        // PID 이미 알려짐 — 폴링만 시작
        this._startCwdPolling(panelId);
        this.emit('message', { type: 'auto-track', panelId, enabled: true });
      } else {
        // PID 미탐지 — exec 채널로 백그라운드 탐지 (셸에 명령 안 보냄)
        this._installOsc7Hook(panelId, '');
      }
    } else {
      // 폴링만 중지
      this._stopCwdPolling(panelId);
      this.emit('message', { type: 'auto-track', panelId, enabled: false });
    }
    return { success: true };
  }

  handleResize(panelId: string, cols: number, rows: number) {
    const rec = this.clients.get(panelId);
    if (!rec?.stream) return;
    if (cols > 0) this.termCols.set(panelId, cols);
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
    this._stopCwdPolling(panelId);
    this.shellPids.delete(panelId);
    this.lastCwd.delete(panelId);
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

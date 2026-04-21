// electron/webdavBridge.ts
// WebDAV 서버를 로컬호스트에 띄우고, 각 SSH 세션을 /<panelId>/ 하위 경로로 매핑.
// Claude CLI 등 외부 프로세스는 UNC 경로 \\127.0.0.1@PORT\DavWWWRoot\<panelId>\<remotePath> 로 SSH 파일에 실시간 접근 가능.
//
// 내부 구현: webdav-server v2 의 커스텀 FileSystem 을 SFTP 래핑으로 구현.
// 읽기/쓰기/삭제/이동 지원. 락/속성 매니저는 기본(메모리).

import { v2 as webdav } from 'webdav-server';
import { Readable, Writable } from 'stream';

type SSHBridge = {
  getSftp: (panelId: string) => Promise<any>;
};

// SFTP-backed FileSystem serializer (세션 복원용 - 우린 동적 등록이라 사용 안 함)
class SFTPSerializer implements webdav.FileSystemSerializer {
  uid() { return 'pepe-sftp-fs-serializer'; }
  serialize(_fs: webdav.FileSystem, cb: webdav.ReturnCallback<any>) { cb(undefined, {}); }
  unserialize(_data: any, cb: webdav.ReturnCallback<webdav.FileSystem>) { cb(new Error('not serializable')); }
}

/**
 * 단일 SSH 세션(panelId)의 SFTP 를 WebDAV FileSystem 으로 노출.
 * 경로는 SFTP 루트 "/" 기준.
 */
class SFTPFileSystem extends webdav.FileSystem {
  private sshBridge: SSHBridge;
  private panelId: string;
  private propsMgr = new webdav.LocalPropertyManager();
  private locksMgr = new webdav.LocalLockManager();
  // stat 캐시 — Windows WebDAV 가 한 파일당 여러 메타 쿼리를 날려 SFTP 라운드트립이 폭증하는 문제 완화
  private statCache: Map<string, { stats: any; expiresAt: number }> = new Map();
  private readonly STAT_TTL = 30 * 1000; // 30초
  // readdir 캐시 (디렉토리 리스팅도 반복되는 경향)
  private readdirCache: Map<string, { entries: string[]; expiresAt: number }> = new Map();
  private readonly READDIR_TTL = 15 * 1000; // 15초

  constructor(sshBridge: SSHBridge, panelId: string) {
    super(new SFTPSerializer());
    this.sshBridge = sshBridge;
    this.panelId = panelId;
  }

  private toRemote(p: webdav.Path): string {
    const parts = p.paths.filter(s => s.length > 0);
    return '/' + parts.join('/');
  }

  private async sftp() {
    return await this.sshBridge.getSftp(this.panelId);
  }

  // stat 캐시 유틸 — 동일 경로 stat 을 30초 재사용 (쓰기 후 해당 경로 캐시는 무효화)
  private cachedStat(remotePath: string): Promise<any> {
    const now = Date.now();
    const cached = this.statCache.get(remotePath);
    if (cached && cached.expiresAt > now) return Promise.resolve(cached.stats);
    return this.sftp().then(sftp => new Promise((resolve, reject) => {
      sftp.stat(remotePath, (err: any, stats: any) => {
        if (err) return reject(err);
        this.statCache.set(remotePath, { stats, expiresAt: Date.now() + this.STAT_TTL });
        resolve(stats);
      });
    }));
  }

  private invalidateStat(remotePath: string) {
    this.statCache.delete(remotePath);
    // 부모 디렉토리의 readdir 도 무효화
    const parent = remotePath.replace(/\/[^/]+\/?$/, '') || '/';
    this.readdirCache.delete(parent);
  }

  // ── 기본 매니저 ──
  _lockManager(_path: webdav.Path, _info: webdav.LockManagerInfo, cb: webdav.ReturnCallback<webdav.ILockManager>) {
    cb(undefined, this.locksMgr);
  }
  _propertyManager(_path: webdav.Path, _info: webdav.PropertyManagerInfo, cb: webdav.ReturnCallback<webdav.IPropertyManager>) {
    cb(undefined, this.propsMgr);
  }

  // ── 메타 / 디렉토리 (stat 캐시 사용) ──
  _type(path: webdav.Path, _info: webdav.TypeInfo, cb: webdav.ReturnCallback<webdav.ResourceType>) {
    const remote = this.toRemote(path);
    this.cachedStat(remote)
      .then((stats: any) => cb(undefined, stats.isDirectory() ? webdav.ResourceType.Directory : webdav.ResourceType.File))
      .catch(() => cb(webdav.Errors.ResourceNotFound));
  }

  _size(path: webdav.Path, _info: webdav.SizeInfo, cb: webdav.ReturnCallback<number>) {
    const remote = this.toRemote(path);
    this.cachedStat(remote)
      .then((stats: any) => cb(undefined, stats.size || 0))
      .catch(() => cb(webdav.Errors.ResourceNotFound));
  }

  _lastModifiedDate(path: webdav.Path, _info: webdav.LastModifiedDateInfo, cb: webdav.ReturnCallback<number>) {
    const remote = this.toRemote(path);
    this.cachedStat(remote)
      .then((stats: any) => cb(undefined, (stats.mtime || 0) * 1000))
      .catch(() => cb(webdav.Errors.ResourceNotFound));
  }

  _creationDate(path: webdav.Path, info: webdav.CreationDateInfo, cb: webdav.ReturnCallback<number>) {
    this._lastModifiedDate(path, info as any, cb);
  }

  _fastExistCheck(_ctx: webdav.RequestContext, path: webdav.Path, cb: (exists: boolean) => void) {
    const remote = this.toRemote(path);
    this.cachedStat(remote).then(() => cb(true)).catch(() => cb(false));
  }

  _readDir(path: webdav.Path, _info: webdav.ReadDirInfo, cb: webdav.ReturnCallback<string[] | webdav.Path[]>) {
    const remote = this.toRemote(path);
    const now = Date.now();
    const cached = this.readdirCache.get(remote);
    if (cached && cached.expiresAt > now) {
      cb(undefined, cached.entries.slice());
      return;
    }
    this.sftp().then(sftp => {
      sftp.readdir(remote, (err: any, list: any[]) => {
        if (err) return cb(webdav.Errors.ResourceNotFound);
        const names = list
          .map((e: any) => e.filename)
          .filter((n: string) => n !== '.' && n !== '..');
        // readdir 결과로부터 각 항목의 stat 도 미리 캐시 (longname/attrs 파싱)
        for (const e of list) {
          if (e.filename === '.' || e.filename === '..') continue;
          const childPath = remote.endsWith('/') ? remote + e.filename : remote + '/' + e.filename;
          if (e.attrs) {
            const stats = {
              ...e.attrs,
              isDirectory: () => ((e.attrs.mode & 0o170000) === 0o040000),
              isFile: () => ((e.attrs.mode & 0o170000) === 0o100000),
              isSymbolicLink: () => ((e.attrs.mode & 0o170000) === 0o120000),
            };
            this.statCache.set(childPath, { stats, expiresAt: Date.now() + this.STAT_TTL });
          }
        }
        this.readdirCache.set(remote, { entries: names, expiresAt: Date.now() + this.READDIR_TTL });
        cb(undefined, names);
      });
    }).catch(() => cb(webdav.Errors.ResourceNotFound));
  }

  _displayName(path: webdav.Path, _info: webdav.DisplayNameInfo, cb: webdav.ReturnCallback<string>) {
    cb(undefined, path.fileName());
  }

  _mimeType(path: webdav.Path, _info: webdav.MimeTypeInfo, cb: webdav.ReturnCallback<string>) {
    const ext = path.fileName().split('.').pop()?.toLowerCase() || '';
    const map: Record<string, string> = {
      txt: 'text/plain', md: 'text/markdown', json: 'application/json',
      js: 'application/javascript', ts: 'application/typescript',
      html: 'text/html', css: 'text/css', xml: 'application/xml',
      py: 'text/x-python', c: 'text/x-c', h: 'text/x-c', cpp: 'text/x-c++',
      java: 'text/x-java', go: 'text/x-go', rs: 'text/x-rust',
      sh: 'text/x-shellscript', yml: 'text/yaml', yaml: 'text/yaml',
    };
    cb(undefined, map[ext] || 'application/octet-stream');
  }

  _etag(path: webdav.Path, _info: webdav.ETagInfo, cb: webdav.ReturnCallback<string>) {
    const remote = this.toRemote(path);
    this.cachedStat(remote)
      .then((stats: any) => cb(undefined, `"${stats.size}-${stats.mtime}"`))
      .catch(() => cb(webdav.Errors.ResourceNotFound));
  }

  // ── 스트림 ──
  _openReadStream(path: webdav.Path, _info: webdav.OpenReadStreamInfo, cb: webdav.ReturnCallback<Readable>) {
    const remote = this.toRemote(path);
    this.sftp().then(sftp => {
      try {
        const stream = sftp.createReadStream(remote);
        cb(undefined, stream);
      } catch (err: any) {
        cb(webdav.Errors.ResourceNotFound);
      }
    }).catch(() => cb(webdav.Errors.ResourceNotFound));
  }

  _openWriteStream(path: webdav.Path, _info: webdav.OpenWriteStreamInfo, cb: webdav.ReturnCallback<Writable>) {
    const remote = this.toRemote(path);
    this.invalidateStat(remote);
    this.sftp().then(sftp => {
      try {
        const stream = sftp.createWriteStream(remote);
        stream.on('close', () => this.invalidateStat(remote));
        cb(undefined, stream);
      } catch (err: any) {
        cb(webdav.Errors.Forbidden);
      }
    }).catch(() => cb(webdav.Errors.Forbidden));
  }

  // ── 생성 ──
  _create(path: webdav.Path, info: webdav.CreateInfo, cb: webdav.SimpleCallback) {
    const remote = this.toRemote(path);
    this.invalidateStat(remote);
    this.sftp().then(sftp => {
      if (info.type.isDirectory) {
        sftp.mkdir(remote, (err: any) => {
          if (err) return cb(webdav.Errors.Forbidden);
          cb(undefined);
        });
      } else {
        // 빈 파일 생성
        sftp.writeFile(remote, Buffer.alloc(0), (err: any) => {
          if (err) return cb(webdav.Errors.Forbidden);
          cb(undefined);
        });
      }
    }).catch(() => cb(webdav.Errors.Forbidden));
  }

  // ── 삭제 ──
  _delete(path: webdav.Path, _info: webdav.DeleteInfo, cb: webdav.SimpleCallback) {
    const remote = this.toRemote(path);
    this.invalidateStat(remote);
    this.sftp().then(sftp => {
      sftp.stat(remote, (err: any, stats: any) => {
        if (err) return cb(webdav.Errors.ResourceNotFound);
        if (stats.isDirectory()) {
          // 재귀 삭제
          const rmrf = (p: string, done: (e?: any) => void) => {
            sftp.readdir(p, (e: any, list: any[]) => {
              if (e) return done(e);
              const entries = list.filter((x: any) => x.filename !== '.' && x.filename !== '..');
              let i = 0;
              const next = () => {
                if (i >= entries.length) return sftp.rmdir(p, done);
                const ent = entries[i++];
                const cp = p.endsWith('/') ? p + ent.filename : p + '/' + ent.filename;
                sftp.stat(cp, (se: any, st: any) => {
                  if (se) return done(se);
                  if (st.isDirectory()) rmrf(cp, (re: any) => re ? done(re) : next());
                  else sftp.unlink(cp, (ue: any) => ue ? done(ue) : next());
                });
              };
              next();
            });
          };
          rmrf(remote, (rerr: any) => cb(rerr ? webdav.Errors.Forbidden : undefined));
        } else {
          sftp.unlink(remote, (uerr: any) => cb(uerr ? webdav.Errors.Forbidden : undefined));
        }
      });
    }).catch(() => cb(webdav.Errors.Forbidden));
  }

  // ── 이동 ──
  _move(from: webdav.Path, to: webdav.Path, _info: webdav.MoveInfo, cb: webdav.ReturnCallback<boolean>) {
    const r1 = this.toRemote(from);
    const r2 = this.toRemote(to);
    this.invalidateStat(r1);
    this.invalidateStat(r2);
    this.sftp().then(sftp => {
      sftp.rename(r1, r2, (err: any) => {
        if (err) return cb(webdav.Errors.Forbidden, false);
        cb(undefined, true);
      });
    }).catch(() => cb(webdav.Errors.Forbidden, false));
  }

  _rename(from: webdav.Path, newName: string, _info: webdav.RenameInfo, cb: webdav.ReturnCallback<boolean>) {
    const r1 = this.toRemote(from);
    const parts = from.paths.slice();
    parts.pop();
    parts.push(newName);
    const r2 = '/' + parts.join('/');
    this.invalidateStat(r1);
    this.invalidateStat(r2);
    this.sftp().then(sftp => {
      sftp.rename(r1, r2, (err: any) => {
        if (err) return cb(webdav.Errors.Forbidden, false);
        cb(undefined, true);
      });
    }).catch(() => cb(webdav.Errors.Forbidden, false));
  }
}

export function createWebDAVBridge(sshBridge: SSHBridge) {
  let server: webdav.WebDAVServer | null = null;
  let port = 0;
  const sessions = new Map<string, { fs: SFTPFileSystem; label: string }>();

  const ensureStarted = async (): Promise<void> => {
    if (server) return;
    server = new webdav.WebDAVServer({
      port: 0, // 랜덤 포트
      requireAuthentification: false,
      https: undefined,
      hostname: '127.0.0.1',
    });
    await new Promise<void>((resolve, reject) => {
      server!.start((httpServer: any) => {
        try {
          const addr = httpServer.address();
          port = typeof addr === 'object' && addr ? addr.port : 0;
          console.log(`[webdav] started on 127.0.0.1:${port}`);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });

    // Windows: WebClient 서비스 자동 시작 시도 (UNC WebDAV 접근에 필요)
    if (process.platform === 'win32') {
      try {
        const { exec } = require('child_process');
        exec('sc query WebClient', (_e: any, stdout: string) => {
          if (stdout && !/RUNNING/i.test(stdout)) {
            console.log('[webdav] WebClient service not running, attempting to start...');
            exec('net start WebClient', (serr: any, sout: string) => {
              if (serr) {
                console.warn('[webdav] WebClient start failed (may need admin):', String(serr).slice(0, 200));
              } else {
                console.log('[webdav] WebClient started:', sout.slice(0, 200));
              }
            });
          }
        });
      } catch {}
    }
  };

  const registerSession = (panelId: string, label: string) => {
    if (!server) throw new Error('server not started');
    if (sessions.has(panelId)) return;
    const fs = new SFTPFileSystem(sshBridge, panelId);
    server.setFileSystem('/' + panelId, fs, (success?: boolean) => {
      if (success === false) console.error(`[webdav] setFileSystem failed for ${panelId}`);
    });
    sessions.set(panelId, { fs, label });
    console.log(`[webdav] registered session ${panelId} (${label})`);
  };

  const unregisterSession = (panelId: string) => {
    if (!server) return;
    server.removeFileSystem('/' + panelId, () => {});
    sessions.delete(panelId);
    console.log(`[webdav] unregistered session ${panelId}`);
  };

  const hasSession = (panelId: string) => sessions.has(panelId);
  const getPort = () => port;

  const getMountRoot = (panelId: string) => `\\\\127.0.0.1@${port}\\DavWWWRoot\\${panelId}`;

  const toUncPath = (panelId: string, remotePath: string) => {
    const clean = remotePath.replace(/^\/+/, '').replace(/\//g, '\\');
    return `${getMountRoot(panelId)}\\${clean}`;
  };

  const toHttpUrl = (panelId: string, remotePath: string) => {
    const clean = remotePath.replace(/^\/+/, '');
    return `http://127.0.0.1:${port}/${panelId}/${clean}`;
  };

  return {
    ensureStarted,
    registerSession,
    unregisterSession,
    hasSession,
    getPort,
    getMountRoot,
    toUncPath,
    toHttpUrl,
  };
}

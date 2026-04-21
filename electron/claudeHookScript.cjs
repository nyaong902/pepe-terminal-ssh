#!/usr/bin/env node
// Claude Code PreToolUse hook — 각 툴 호출 직전에 실행되어 승인 요청
// Env: PEPE_CTRL_PORT, PEPE_CTRL_TOKEN, PEPE_APPROVAL_REQ_TIMEOUT_MS
// stdin: hook event JSON (tool_name, tool_input, session_id, etc)
// stdout: decision JSON 또는 exit code 2 (block)

'use strict';
const net = require('net');

const CTRL_PORT = parseInt(process.env.PEPE_CTRL_PORT || '0', 10);
const CTRL_TOKEN = process.env.PEPE_CTRL_TOKEN || '';
const TIMEOUT_MS = parseInt(process.env.PEPE_APPROVAL_REQ_TIMEOUT_MS || '300000', 10); // 5분

function log(...args) {
  try { process.stderr.write('[hook] ' + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n'); } catch {}
}

let inputBuf = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', c => { inputBuf += c; });
process.stdin.on('end', () => {
  let event = {};
  try { event = JSON.parse(inputBuf); } catch (e) { log('parse err', e); process.exit(0); return; }
  const toolName = event.tool_name || event.toolName || 'unknown';
  const toolInput = event.tool_input || event.toolInput || {};

  // 읽기 전용 툴은 자동 허용 (사용자 피로도 감소)
  const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch']);
  if (READ_ONLY_TOOLS.has(toolName)) { process.exit(0); return; }

  // 파괴적/편집 툴은 승인 요청
  log('requesting approval for', toolName);
  const sock = net.createConnection(CTRL_PORT, '127.0.0.1');
  let buf = '';
  sock.setEncoding('utf-8');
  let done = false;
  const finish = (decision, reason) => {
    if (done) return;
    done = true;
    try { sock.end(); } catch {}
    if (decision === 'allow') {
      // 허용 → exit 0 (아무 출력 없이 진행)
      process.exit(0);
    } else {
      // 거부 → exit 2 with stderr
      process.stderr.write(reason || 'User denied');
      process.exit(2);
    }
  };
  const to = setTimeout(() => finish('deny', 'User approval timeout'), TIMEOUT_MS);
  sock.on('connect', () => {
    const req = { id: Date.now(), token: CTRL_TOKEN, op: 'hook-approve', toolName, toolInput, sessionId: event.session_id };
    sock.write(JSON.stringify(req) + '\n');
  });
  sock.on('data', d => {
    buf += d;
    const idx = buf.indexOf('\n');
    if (idx < 0) return;
    const line = buf.slice(0, idx);
    try {
      const msg = JSON.parse(line);
      clearTimeout(to);
      if (msg.result === 'allow') finish('allow');
      else finish('deny', msg.reason || 'Denied');
    } catch (e) {
      clearTimeout(to);
      finish('deny', 'Bad response');
    }
  });
  sock.on('error', e => {
    clearTimeout(to);
    log('sock err', e);
    // 제어 서버 연결 실패 시 안전하게 허용 (사용자 환경 보호 목적으로 거부해도 됨)
    finish('allow');
  });
});

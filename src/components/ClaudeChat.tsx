// src/components/ClaudeChat.tsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { marked } from 'marked';
import mermaid from 'mermaid';
import { adjustClaudeFontSize } from '../utils/claudeFont';

// Mermaid 다이어그램 초기화 (모듈 로드 시 1회)
mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  securityLevel: 'loose',
  fontFamily: '"Malgun Gothic", "맑은 고딕", "Apple SD Gothic Neo", "Noto Sans KR", "Segoe UI", sans-serif',
  themeVariables: {
    fontFamily: '"Malgun Gothic", "맑은 고딕", "Apple SD Gothic Neo", "Noto Sans KR", "Segoe UI", sans-serif',
    fontSize: '14px',
  },
  flowchart: { htmlLabels: false, useMaxWidth: true, curve: 'basis' },
  sequence: { useMaxWidth: true },
});

// Mermaid 다이어그램 키워드 — 이 패턴으로 시작하면 mermaid 블록으로 간주
const MERMAID_START_RE = /^(graph\s+(TB|TD|BT|RL|LR)|flowchart\s+(TB|TD|BT|RL|LR)|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|gantt|pie|journey|gitGraph|mindmap|timeline|quadrantChart)\b/;

// fence 없는 mermaid 블록을 ```mermaid 로 감싸기
function autoFenceMermaid(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;
  let inFence = false;
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*```/.test(l)) { inFence = !inFence; out.push(l); i++; continue; }
    if (!inFence && MERMAID_START_RE.test(l.trim())) {
      // mermaid 블록 시작 — 빈줄이 2번 연속 나오거나 ## 헤더 만나기 전까지
      const block: string[] = [l];
      let j = i + 1;
      let blankRun = 0;
      while (j < lines.length) {
        const next = lines[j];
        if (/^#{1,6}\s/.test(next)) break;
        if (/^\s*```/.test(next)) break;
        if (next.trim() === '') {
          blankRun++;
          if (blankRun >= 2) break;
        } else {
          blankRun = 0;
        }
        block.push(next);
        j++;
      }
      // 끝 빈줄들 제거
      while (block.length > 0 && block[block.length - 1].trim() === '') block.pop();
      out.push('```mermaid');
      for (const b of block) out.push(b);
      out.push('```');
      i = j;
      continue;
    }
    out.push(l);
    i++;
  }
  return out.join('\n');
}

// 탭 또는 2칸 이상 공백으로 정렬된 텍스트 블록을 GFM 테이블로 자동 변환
function autoConvertTablesInMd(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;
  // 코드 블록 안은 건너뜀
  let inCode = false;
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*```/.test(l)) { inCode = !inCode; out.push(l); i++; continue; }
    if (inCode) { out.push(l); i++; continue; }

    // 탭 기반 블록 탐지 (2줄 이상)
    if (l.includes('\t')) {
      const block: string[] = [];
      let j = i;
      while (j < lines.length && lines[j].includes('\t') && !/^\s*```/.test(lines[j])) {
        block.push(lines[j]);
        j++;
      }
      if (block.length >= 2) {
        const rows = block.map(s => s.split('\t').map(c => c.trim()));
        const cols = Math.max(...rows.map(r => r.length));
        rows.forEach(r => { while (r.length < cols) r.push(''); });
        out.push('| ' + rows[0].join(' | ') + ' |');
        out.push('| ' + Array(cols).fill('---').join(' | ') + ' |');
        for (let r = 1; r < rows.length; r++) out.push('| ' + rows[r].join(' | ') + ' |');
        i = j;
        continue;
      }
    }
    out.push(l);
    i++;
  }
  return out.join('\n');
}

function renderMd(content: string): string {
  return marked.parse(autoConvertTablesInMd(autoFenceMermaid(content)), { breaks: true }) as string;
}

type Message = {
  role: 'user' | 'assistant';
  content: string;
  id: string;
  seq?: number; // 발생 순서 (타임라인 인터리브용)
};
type ToolTimelineItem = { id: string; label: string; status: 'running' | 'done' | 'error'; resultPreview?: string; seq?: number };
type ChatHistoryEntry = {
  id: string; // 로컬 고유 id
  claudeSessionId?: string | null; // Claude CLI session_id (resume 용)
  title: string;
  pinned: boolean;
  updatedAt: number;
  messages: Message[];
  pendingRequestId?: string | null; // 진행 중 send 의 requestId
  streaming?: boolean; // 진행 중인지
  toolTimeline?: ToolTimelineItem[]; // 툴 호출 타임라인 (대화별 영속)
};

export type FileContextItem = { fileName: string; remotePath: string; content: string };
export type MountEntry = { termId: string; remotePath: string; uncPath: string; isDir: boolean };

type Props = {
  onClose?: () => void;
  pendingContext: FileContextItem[] | null;
  onContextConsumed: () => void;
  mountEntries?: MountEntry[];
  onClearMounted?: () => void;
  onRemoveMountedEntry?: (remotePath: string, termId: string) => void;
  connectedSessions?: { termId: string; label: string }[];
  defaultSshSession?: { termId: string; label: string } | null;
  pinned?: boolean;
  onTogglePin?: () => void;
};

let sessionCounter = 0;

export const ClaudeChat: React.FC<Props> = ({ onClose, pendingContext, onContextConsumed, mountEntries = [], onClearMounted, onRemoveMountedEntry, connectedSessions = [], defaultSshSession, pinned = true, onTogglePin }) => {
  // 사용자가 선택한 활성 SSH 세션 (드롭다운). 처음엔 defaultSshSession.
  const [selectedSshTermId, setSelectedSshTermId] = useState<string | null>(defaultSshSession?.termId || null);
  useEffect(() => {
    // defaultSshSession 변경 시 선택된 적 없으면 반영
    if (defaultSshSession && !selectedSshTermId) {
      setSelectedSshTermId(defaultSshSession.termId);
    }
  }, [defaultSshSession?.termId]);
  // 실제로 selected termId 가 connectedSessions 에 존재하는지 확인 (세션 종료 시 리셋)
  useEffect(() => {
    if (selectedSshTermId && !connectedSessions.find(s => s.termId === selectedSshTermId)) {
      setSelectedSshTermId(connectedSessions[0]?.termId || null);
    }
  }, [connectedSessions.map(s => s.termId).join(',')]);
  const activeSshSession = selectedSshTermId
    ? (connectedSessions.find(s => s.termId === selectedSshTermId) || null)
    : null;
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [version, setVersion] = useState<string>('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  // 현재 진행 중 활동(툴 이름 등) — 스트리밍 인디케이터 옆에 표시
  const [activity, setActivity] = useState<string>('');
  // 툴 호출 타임라인 (각 호출을 별도 항목으로)
  const [toolTimeline, setToolTimeline] = useState<ToolTimelineItem[]>([]);
  // 승인 대기 중인 계획 (ExitPlanMode 수신 시)
  const [pendingPlan, setPendingPlan] = useState<string | null>(null);
  // 툴 단위 승인 모드 (hooks)
  const [perToolApproval, setPerToolApproval] = useState(false);
  // 현재 대기 중인 툴 승인 요청 (hook 에서 전달)
  const [pendingToolApproval, setPendingToolApproval] = useState<{ approvalId: string; toolName: string; toolInput: any } | null>(null);
  const [sessionId] = useState(() => `claude-${Date.now()}-${sessionCounter++}`);
  // 사용자가 전송 버튼을 누를 때까지 파일 컨텍스트를 로컬에서 보관 (다중 첨부)
  const [attachments, setAttachments] = useState<FileContextItem[]>([]);
  // 활성 SSH 세션의 WebDAV 마운트 루트 (세션 전체 파일시스템 접근용)
  const [activeMount, setActiveMount] = useState<{ termId: string; mountRoot: string; label: string } | null>(null);
  // Claude CLI 대화 세션 ID (이전 대화 컨텍스트 유지용 --resume)
  const claudeSessionIdRef = useRef<string | null>(null);
  // 대화 이력 목록 (UIPrefs 영속화)
  const [chatHistory, setChatHistory] = useState<ChatHistoryEntry[]>([]);
  const [activeHistoryId, setActiveHistoryId] = useState<string | null>(null);
  const [showHistoryPanel, setShowHistoryPanel] = useState(false);
  // 메시지 우클릭 컨텍스트 메뉴
  const [msgCtxMenu, setMsgCtxMenu] = useState<{ x: number; y: number; msgId: string; content: string } | null>(null);
  useEffect(() => {
    if (!msgCtxMenu) return;
    const close = () => setMsgCtxMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
      window.removeEventListener('keydown', close);
    };
  }, [msgCtxMenu]);
  const chatHistoryLoadedRef = useRef(false);
  // 대화 세대 카운터 — clear() / loadHistory / stop 호출 시 증가. 진행 중 stream 이벤트가 새 대화에 섞이는 것 방지
  const conversationGenRef = useRef(0);
  // 마지막 send 시점의 세대값. 이 값이 conversationGenRef 와 다르면 stream 이벤트 무시
  const activeGenRef = useRef(0);
  // 현재 활성 send 의 requestId — main 프로세스가 echo back. 이게 일치하지 않는 stream 은 무시
  const activeRequestIdRef = useRef<string | null>(null);
  // requestId → historyId 매핑. 비활성 대화의 stream 도 해당 history 항목에 계속 반영하기 위함.
  const requestToHistoryRef = useRef<Map<string, string>>(new Map());
  // activeHistoryId 의 ref 미러 — stream listener 가 stale closure 없이 즉시 현재값 사용
  const activeHistoryIdRef = useRef<string | null>(null);
  // 메시지/툴 호출 순서 카운터 — 둘을 발생 순서대로 인터리브 렌더링
  const seqCounterRef = useRef(0);
  const nextSeq = () => ++seqCounterRef.current;
  // 로드된 history 의 최대 seq 보다 카운터를 높여 새 항목이 항상 뒤에 정렬되도록 보정
  const bumpSeqFor = (msgs: Message[], tools: ToolTimelineItem[]) => {
    let maxSeq = seqCounterRef.current;
    for (const m of msgs) if (typeof m.seq === 'number' && m.seq > maxSeq) maxSeq = m.seq;
    for (const t of tools) if (typeof t.seq === 'number' && t.seq > maxSeq) maxSeq = t.seq;
    seqCounterRef.current = maxSeq;
  };

  // 이력 로드
  useEffect(() => {
    (async () => {
      try {
        const prefs = await (window as any).api?.getUIPrefs?.();
        if (prefs && Array.isArray(prefs.claudeChatHistory)) {
          setChatHistory(prefs.claudeChatHistory);
        }
      } catch {}
      chatHistoryLoadedRef.current = true;
    })();
  }, []);
  // 이력 저장
  useEffect(() => {
    if (!chatHistoryLoadedRef.current) return;
    try { (window as any).api?.setUIPrefs?.({ claudeChatHistory: chatHistory }); } catch {}
  }, [chatHistory]);
  // 최근 대화에서 언급된 로컬 Windows 경로들 — 이후 턴에서도 --add-dir 로 유지
  const recentLocalPathsRef = useRef<Set<string>>(new Set());
  // 권한 모드: default(기본, 요청 시) / acceptEdits(편집만 자동) / plan(실행 없이 계획만) / bypassPermissions(모두 허용)
  const [permissionMode, setPermissionMode] = useState<'bypassPermissions' | 'acceptEdits' | 'plan' | 'default'>('default');
  // 모델 선택 — claude CLI --model 플래그
  const [model, setModel] = useState<string>('default');
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const [commandFilter, setCommandFilter] = useState('');
  const [commandHighlight, setCommandHighlight] = useState(0);
  const commandFilterRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!commandMenuOpen) return;
    setCommandFilter('');
    setCommandHighlight(0);
    setTimeout(() => commandFilterRef.current?.focus(), 30);
    const close = () => setCommandMenuOpen(false);
    const t = setTimeout(() => window.addEventListener('click', close), 0);
    return () => { clearTimeout(t); window.removeEventListener('click', close); };
  }, [commandMenuOpen]);
  const fileUploadRef = useRef<HTMLInputElement | null>(null);
  const folderUploadRef = useRef<HTMLInputElement | null>(null);
  // 로컬 파일 첨부 (사용자 PC 파일 내용)
  const [localFileAttachments, setLocalFileAttachments] = useState<{ name: string; content: string }[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  // ClaudeChat 은 installed 상태에 따라 여러 return 분기를 가져서 ref 부착 시점이 변함.
  // 안정적으로 listener 를 붙이기 위해 document 전체에서 target 이 claude-chat-container 내부인지
  // 확인하는 방식으로 wheel 을 처리.
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      const t = e.target as HTMLElement | null;
      if (!t || !t.closest || !t.closest('.claude-chat-sidebar, .claude-chat-container')) return;
      e.preventDefault();
      adjustClaudeFontSize(e.deltaY < 0 ? 1 : -1);
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => { window.removeEventListener('wheel', onWheel); };
  }, []);
  const currentAsstIdRef = useRef<string | null>(null);

  // setActiveHistoryId wrapper — ref 도 즉시 동기화 (stream listener race 방지)
  const setActiveHist = useCallback((id: string | null) => {
    activeHistoryIdRef.current = id;
    setActiveHistoryId(id);
  }, []);

  // CLI 설치 확인
  useEffect(() => {
    (async () => {
      const res = await (window as any).api?.claudeCheck?.();
      setInstalled(!!res?.installed);
      setVersion(res?.version || '');
    })();
  }, []);

  // Hook 승인 요청 리스너
  useEffect(() => {
    const dispose = (window as any).api?.onClaudeHookApprovalRequest?.((p: any) => {
      setPendingToolApproval({ approvalId: p.approvalId, toolName: p.toolName, toolInput: p.toolInput });
    });
    return () => { if (dispose) dispose(); };
  }, []);

  // 활성 SSH 세션이 변경되면 WebDAV 마운트 등록 + 루트 경로 저장
  useEffect(() => {
    (async () => {
      if (!activeSshSession) { setActiveMount(null); return; }
      if (activeMount?.termId === activeSshSession.termId) return; // 이미 등록됨
      try {
        const reg: any = await (window as any).api?.claudeRegisterMount?.(activeSshSession.termId, activeSshSession.label);
        if (!reg?.success) { setActiveMount(null); return; }
        const pathRes: any = await (window as any).api?.claudeGetMountPath?.(activeSshSession.termId, '/');
        if (!pathRes?.success) { setActiveMount(null); return; }
        // "/" 에 대한 uncPath 가 세션 루트
        setActiveMount({ termId: activeSshSession.termId, mountRoot: pathRes.uncPath.replace(/\\$/, ''), label: activeSshSession.label });
      } catch (err) {
        console.error('[ClaudeChat] auto-mount failed:', err);
        setActiveMount(null);
      }
    })();
  }, [activeSshSession?.termId, activeSshSession?.label]);

  // 스트리밍 응답 리스너
  useEffect(() => {
    const dispose = (window as any).api?.onClaudeStream?.((p: any) => {
      if (p.sessionId !== sessionId) return;
      const reqId: string | undefined = p.requestId;
      // requestId → historyId 매핑으로 어느 대화에 속하는 이벤트인지 판별
      const targetHistoryId = reqId ? requestToHistoryRef.current.get(reqId) : null;
      if (!targetHistoryId) return; // 추적 불가 이벤트 무시
      const msg = p.message;
      const isActive = targetHistoryId === activeHistoryIdRef.current;
      // 비활성 대화의 stream — chatHistory 만 직접 갱신 (사용자가 돌아왔을 때 메시지 + streaming 상태 보존)
      if (!isActive) {
        setChatHistory(hList => hList.map(h => {
          if (h.id !== targetHistoryId) return h;
          let newMsgs = h.messages;
          let newStreaming = h.streaming;
          let newSessId = h.claudeSessionId;
          let newTimeline: ToolTimelineItem[] = h.toolTimeline ? [...h.toolTimeline] : [];
          if (msg.session_id && !newSessId) newSessId = msg.session_id;
          if (msg.type === 'assistant' && msg.message?.content) {
            const msgId = msg.message.id || `asst-${Date.now()}`;
            const texts = msg.message.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
            const toolUses = msg.message.content.filter((c: any) => c.type === 'tool_use');
            if (texts) {
              const ex = newMsgs.find(m => m.id === msgId);
              newMsgs = ex ? newMsgs.map(m => m.id === msgId ? { ...m, content: texts } : m)
                           : [...newMsgs, { role: 'assistant', content: texts, id: msgId, seq: nextSeq() }];
            }
            for (const t of toolUses) {
              if (newTimeline.find(x => x.id === t.id)) continue;
              const args = JSON.stringify(t.input).slice(0, 120);
              newTimeline.push({ id: t.id, label: `🔧 ${t.name}(${args}${args.length >= 120 ? '…' : ''})`, status: 'running', seq: nextSeq() });
            }
          } else if (msg.type === 'user' && msg.message?.content) {
            const results = Array.isArray(msg.message.content) ? msg.message.content.filter((c: any) => c.type === 'tool_result') : [];
            if (results.length > 0) {
              newTimeline = newTimeline.map(t => {
                const match = results.find((r: any) => r.tool_use_id === t.id);
                if (!match) return t;
                const content = typeof match.content === 'string' ? match.content : JSON.stringify(match.content);
                const preview = content.slice(0, 1500).replace(/\n/g, ' ');
                return { ...t, status: match.is_error ? 'error' : 'done', resultPreview: preview };
              });
            }
          } else if (msg.type === 'result' || msg.type === 'done') {
            newStreaming = false;
          } else if (msg.type === 'error') {
            newMsgs = [...newMsgs, { role: 'assistant', content: `❌ ${msg.text}`, id: `err-${Date.now()}`, seq: nextSeq() }];
            newStreaming = false;
          }
          const done = (msg.type === 'result' || msg.type === 'done' || msg.type === 'error');
          return { ...h, messages: newMsgs, toolTimeline: newTimeline, streaming: newStreaming, pendingRequestId: done ? null : h.pendingRequestId, claudeSessionId: newSessId, updatedAt: Date.now() };
        }));
        if (msg.type === 'result' || msg.type === 'done' || msg.type === 'error') {
          if (reqId) requestToHistoryRef.current.delete(reqId);
        }
        return;
      }
      // Claude CLI session_id 캡처 (첫 init 또는 아무 메시지에서)
      if (msg.session_id && !claudeSessionIdRef.current) {
        claudeSessionIdRef.current = msg.session_id;
        console.log('[ClaudeChat] captured claude session_id:', msg.session_id);
      }
      if (msg.type === 'assistant' && msg.message?.content) {
        const msgId = msg.message.id || `asst-${Date.now()}`;
        const texts = msg.message.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
        const toolUses = msg.message.content.filter((c: any) => c.type === 'tool_use');
        const thinkings = msg.message.content.filter((c: any) => c.type === 'thinking');

        // 툴 호출을 타임라인에 추가 (각 tool_use id 별)
        if (toolUses.length > 0) {
          setToolTimeline(prev => {
            const next = [...prev];
            for (const t of toolUses) {
              if (next.find(x => x.id === t.id)) continue;
              const args = JSON.stringify(t.input).slice(0, 120);
              next.push({ id: t.id, label: `🔧 ${t.name}(${args}${args.length >= 120 ? '…' : ''})`, status: 'running', seq: nextSeq() });
            }
            return next;
          });
          setActivity(`🔧 ${toolUses[toolUses.length - 1].name}`);
          // ExitPlanMode 감지 → 승인 다이얼로그 표시
          const exitPlan = toolUses.find((t: any) => t.name === 'ExitPlanMode');
          if (exitPlan && exitPlan.input?.plan) {
            setPendingPlan(String(exitPlan.input.plan));
          }
        }

        // 텍스트가 있으면 메시지로 표시
        if (texts) {
          setMessages(prev => {
            const existing = prev.find(m => m.id === msgId);
            if (existing) {
              return prev.map(m => m.id === msgId ? { ...m, content: texts } : m);
            }
            currentAsstIdRef.current = msgId;
            return [...prev, { role: 'assistant', content: texts, id: msgId, seq: nextSeq() }];
          });
        } else if (thinkings.length > 0 && toolUses.length === 0) {
          setActivity('🤔 생각 중...');
        }
      } else if (msg.type === 'user' && msg.message?.content) {
        // tool_result 수신 → 타임라인 업데이트
        const results = Array.isArray(msg.message.content) ? msg.message.content.filter((c: any) => c.type === 'tool_result') : [];
        if (results.length > 0) {
          setToolTimeline(prev => prev.map(t => {
            const match = results.find((r: any) => r.tool_use_id === t.id);
            if (!match) return t;
            const content = typeof match.content === 'string' ? match.content : JSON.stringify(match.content);
            const preview = content.slice(0, 80).replace(/\n/g, ' ');
            return { ...t, status: match.is_error ? 'error' : 'done', resultPreview: preview };
          }));
          setActivity('');
        }
      } else if (msg.type === 'result' || msg.type === 'done') {
        setStreaming(false);
        setActivity('');
        currentAsstIdRef.current = null;
        activeRequestIdRef.current = null;
        if (reqId) requestToHistoryRef.current.delete(reqId);
        // history 의 streaming/pendingRequestId 정리
        const aid = activeHistoryIdRef.current;
        if (aid) {
          setChatHistory(hList => hList.map(h => h.id === aid ? { ...h, streaming: false, pendingRequestId: null } : h));
        }
      } else if (msg.type === 'error') {
        setMessages(prev => [...prev, { role: 'assistant', content: `❌ ${msg.text}`, id: `err-${Date.now()}`, seq: nextSeq() }]);
        setStreaming(false);
        activeRequestIdRef.current = null;
        if (reqId) requestToHistoryRef.current.delete(reqId);
        const aid = activeHistoryIdRef.current;
        if (aid) {
          setChatHistory(hList => hList.map(h => h.id === aid ? { ...h, streaming: false, pendingRequestId: null } : h));
        }
      } else if (msg.type === 'text' && msg.text) {
        setMessages(prev => {
          const asstId = currentAsstIdRef.current;
          if (asstId) return prev.map(m => m.id === asstId ? { ...m, content: m.content + msg.text } : m);
          const newId = `asst-${Date.now()}`;
          currentAsstIdRef.current = newId;
          return [...prev, { role: 'assistant', content: msg.text, id: newId, seq: nextSeq() }];
        });
      }
    });
    return () => { if (dispose) dispose(); };
  }, [sessionId]);

  // 자동 스크롤
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  // Mermaid 다이어그램 렌더링 — messages 변경 / pendingPlan 시 미렌더 mermaid 코드블록을 SVG 로 변환
  useEffect(() => {
    // 메시지 영역 + plan 모달 본문 모두 스캔
    const roots: HTMLElement[] = [];
    if (scrollRef.current) roots.push(scrollRef.current);
    document.querySelectorAll<HTMLElement>('.claude-chat-plan-body').forEach(el => roots.push(el));
    const codeBlocks: HTMLElement[] = [];
    for (const r of roots) {
      r.querySelectorAll<HTMLElement>('code.language-mermaid:not([data-mermaid-rendered])').forEach(el => codeBlocks.push(el));
    }
    if (codeBlocks.length === 0) return;
    (async () => {
      for (let i = 0; i < codeBlocks.length; i++) {
        const codeEl = codeBlocks[i];
        const pre = codeEl.parentElement; // <pre>
        const source = codeEl.textContent || '';
        const id = `mermaid-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`;
        try {
          const { svg } = await mermaid.render(id, source);
          const wrap = document.createElement('div');
          wrap.className = 'claude-chat-mermaid';
          wrap.setAttribute('data-mermaid-rendered', '1');
          // 액션 툴바
          const toolbar = document.createElement('div');
          toolbar.className = 'claude-chat-mermaid-toolbar';
          const mkBtn = (label: string, title: string, onClick: () => void) => {
            const b = document.createElement('button');
            b.className = 'claude-chat-mermaid-btn';
            b.textContent = label;
            b.title = title;
            b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); onClick(); };
            return b;
          };
          const svgHolder = document.createElement('div');
          svgHolder.className = 'claude-chat-mermaid-svg';
          svgHolder.innerHTML = svg;
          // helper: SVG → PNG Blob (data URL 사용 — Electron CSP/blob 이슈 회피)
          const svgToPngBlob = async (scale = 2): Promise<Blob> => {
            const svgEl = svgHolder.querySelector('svg') as SVGSVGElement | null;
            if (!svgEl) throw new Error('svg not found');
            const cloned = svgEl.cloneNode(true) as SVGSVGElement;
            // 크기 결정: viewBox > width/height attr > clientWidth/Height > getBBox > default
            const vb = svgEl.viewBox && svgEl.viewBox.baseVal;
            let w = (vb && vb.width) || 0;
            let h = (vb && vb.height) || 0;
            if (!w || !h) {
              const wAttr = parseFloat(svgEl.getAttribute('width') || '0');
              const hAttr = parseFloat(svgEl.getAttribute('height') || '0');
              if (wAttr) w = wAttr;
              if (hAttr) h = hAttr;
            }
            if (!w || !h) {
              w = svgEl.clientWidth || 0;
              h = svgEl.clientHeight || 0;
            }
            if (!w || !h) {
              try { const bb = svgEl.getBBox(); w = bb.width || 800; h = bb.height || 600; } catch { w = 800; h = 600; }
            }
            cloned.setAttribute('width', String(w));
            cloned.setAttribute('height', String(h));
            if (!cloned.getAttribute('xmlns')) cloned.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
            if (!cloned.getAttribute('xmlns:xlink')) cloned.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
            const xml = new XMLSerializer().serializeToString(cloned);
            // base64 data URL 로 변환 — blob URL 대비 CSP 친화적
            const b64 = btoa(unescape(encodeURIComponent(xml)));
            const dataUrl = `data:image/svg+xml;base64,${b64}`;
            const img = new Image();
            // CORS 회피
            img.crossOrigin = 'anonymous';
            await new Promise<void>((resolve, reject) => {
              img.onload = () => resolve();
              img.onerror = (ev) => reject(new Error('SVG → Image 변환 실패: ' + String(ev)));
              img.src = dataUrl;
            });
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(w * scale));
            canvas.height = Math.max(1, Math.round(h * scale));
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('canvas 2d context 생성 실패');
            ctx.fillStyle = '#0d1320';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            return await new Promise<Blob>((resolve, reject) => {
              canvas.toBlob(b => b ? resolve(b) : reject(new Error('canvas → PNG blob 실패')), 'image/png');
            });
          };
          const downloadBlob = (blob: Blob, filename: string) => {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          };
          const flash = (btn: HTMLButtonElement, text: string) => {
            const orig = btn.textContent;
            btn.textContent = text;
            setTimeout(() => { btn.textContent = orig; }, 1200);
          };
          const ts = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const copySvgBtn = mkBtn('📋 SVG', 'SVG 코드 클립보드 복사', async () => {
            try { await navigator.clipboard.writeText(svg); flash(copySvgBtn, '✓ 복사됨'); } catch {}
          });
          const copyPngBtn = mkBtn('📋 PNG', '이미지 클립보드 복사', async () => {
            try {
              const blob = await svgToPngBlob(2);
              // 1차: Electron native clipboard (가장 신뢰성 있음)
              try {
                const dataUrl: string = await new Promise((resolve, reject) => {
                  const r = new FileReader();
                  r.onload = () => resolve(String(r.result));
                  r.onerror = () => reject(r.error);
                  r.readAsDataURL(blob);
                });
                const ipcRes: any = await (window as any).api?.clipboardWriteImage?.(dataUrl);
                if (ipcRes?.success) { flash(copyPngBtn, '✓ 복사됨'); return; }
              } catch (e) { console.warn('[mermaid] ipc clipboard failed', e); }
              // 2차: Web Clipboard API
              try {
                await (navigator.clipboard as any).write([new (window as any).ClipboardItem({ 'image/png': blob })]);
                flash(copyPngBtn, '✓ 복사됨');
                return;
              } catch (e) { console.warn('[mermaid] web clipboard failed', e); }
              flash(copyPngBtn, '✕ 실패');
            } catch (e) { flash(copyPngBtn, '✕ 실패'); console.error('[mermaid] copy png error', e); }
          });
          const saveSvgBtn = mkBtn('💾 SVG', 'SVG 파일 저장', () => {
            downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `diagram-${ts()}.svg`);
          });
          const savePngBtn = mkBtn('💾 PNG', 'PNG 파일 저장 (2x)', async () => {
            try {
              const blob = await svgToPngBlob(2);
              downloadBlob(blob, `diagram-${ts()}.png`);
            } catch (e) { flash(savePngBtn, '✕ 실패'); console.error(e); }
          });
          toolbar.appendChild(copySvgBtn);
          toolbar.appendChild(copyPngBtn);
          toolbar.appendChild(saveSvgBtn);
          toolbar.appendChild(savePngBtn);
          wrap.appendChild(toolbar);
          wrap.appendChild(svgHolder);
          // 우클릭 컨텍스트 메뉴
          wrap.oncontextmenu = (e) => {
            e.preventDefault();
            e.stopPropagation();
            // 기존 떠있는 메뉴 제거
            document.querySelectorAll('.claude-chat-mermaid-ctx-menu').forEach(m => m.remove());
            const menu = document.createElement('div');
            menu.className = 'claude-chat-mermaid-ctx-menu';
            menu.style.left = `${(e as MouseEvent).clientX}px`;
            menu.style.top = `${(e as MouseEvent).clientY}px`;
            const mkItem = (label: string, onClick: () => void) => {
              const it = document.createElement('div');
              it.className = 'claude-chat-mermaid-ctx-item';
              it.textContent = label;
              it.onclick = (ev) => { ev.stopPropagation(); menu.remove(); onClick(); };
              return it;
            };
            menu.appendChild(mkItem('📋 이미지(PNG) 복사', () => copyPngBtn.click()));
            menu.appendChild(mkItem('📋 SVG 코드 복사', () => copySvgBtn.click()));
            menu.appendChild(mkItem('💾 PNG 으로 저장', () => savePngBtn.click()));
            menu.appendChild(mkItem('💾 SVG 으로 저장', () => saveSvgBtn.click()));
            const closeMenu = () => { menu.remove(); document.removeEventListener('click', closeMenu); document.removeEventListener('contextmenu', closeMenu); };
            setTimeout(() => {
              document.addEventListener('click', closeMenu);
              document.addEventListener('contextmenu', closeMenu);
            }, 0);
            document.body.appendChild(menu);
          };
          if (pre && pre.parentElement) {
            pre.parentElement.replaceChild(wrap, pre);
          }
        } catch (err) {
          codeEl.setAttribute('data-mermaid-rendered', 'error');
          const err1 = document.createElement('div');
          err1.className = 'claude-chat-mermaid-error';
          err1.textContent = `[Mermaid 렌더 실패] ${String(err).slice(0, 200)}`;
          if (pre && pre.parentElement) pre.parentElement.insertBefore(err1, pre);
        }
      }
    })();
  }, [messages, toolTimeline, pendingPlan]);

  // 메시지/세션ID 변경 시 활성 이력 항목에 동기화
  // 단, 활성 이력이 막 전환되었을 때(loadHistory 직후) 의 첫 실행은 스킵 — 그렇지 않으면
  // 이전 messages 값이 새 active 항목으로 흘러들어가 이력 내용을 덮어씀
  const lastSyncedHistoryIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeHistoryId) {
      lastSyncedHistoryIdRef.current = null;
      return;
    }
    if (lastSyncedHistoryIdRef.current !== activeHistoryId) {
      // 전환 직후 — 이번 effect 는 sync 스킵, 다음 messages 변경부터 실제 동기화
      lastSyncedHistoryIdRef.current = activeHistoryId;
      return;
    }
    setChatHistory(h => h.map(x => x.id === activeHistoryId
      ? { ...x, messages, toolTimeline, updatedAt: Date.now(), claudeSessionId: claudeSessionIdRef.current ?? x.claudeSessionId }
      : x));
  }, [messages, toolTimeline, activeHistoryId]);

  const send = useCallback(async (text: string, contextItems: FileContextItem[]) => {
    if (!text.trim() || streaming) return;
    // 이번 send 의 대화 세대 기록 — 이후 도착하는 stream 이벤트가 이 세대에 속한 경우만 처리
    activeGenRef.current = conversationGenRef.current;
    // 이번 send 의 고유 requestId
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    activeRequestIdRef.current = requestId;
    let prompt = text;
    let attachBadge = '';
    const addDirsSet = new Set<string>();
    const contextLines: string[] = [];

    // 0.A) 포크/이력 후속 질문이면 작업 대상을 prompt 최상단 + user text 에 직접 명시
    let forkOriginalRequest: string | null = null;
    let forkTargetPath: string | null = null;
    if (!claudeSessionIdRef.current && messages.length > 0) {
      const firstUserMsg = messages.find(m => m.role === 'user');
      if (firstUserMsg) {
        const cleaned = firstUserMsg.content
          .split('\n')
          .filter(l => !/^(🔗|📂|📎|📁)\s/.test(l) && l.trim() !== '')
          .join('\n')
          .trim();
        if (cleaned) {
          forkOriginalRequest = cleaned;
          // Unix 절대경로(/foo/bar)나 Windows UNC 패턴 추출 — 가장 그럴듯한 작업 대상 path
          const pathMatch = cleaned.match(/(\/[A-Za-z0-9_\-./]+|\\\\127\.0\.0\.1@\d+\\DavWWWRoot\\[^\s"')]+)/);
          if (pathMatch) forkTargetPath = pathMatch[0];
          contextLines.push(
            `# ⚠ 이번 질문의 작업 대상 (반드시 준수)`,
            `사용자는 이전 대화의 연속으로 후속 질문을 합니다. 이전 대화의 **첫 요청**은:`,
            ``,
            `> ${cleaned.replace(/\n/g, '\n> ')}`,
            ``,
            forkTargetPath ? `**작업 대상 절대 경로: \`${forkTargetPath}\`** (모든 파일 탐색/읽기는 이 경로 하위로 한정)` : '',
            `**이번 후속 질문은 위 요청에서 다룬 그 코드/시스템에 대한 것입니다.**`,
            `다른 프로젝트(특히 Claude 의 cwd, 사용자 home 의 다른 프로젝트, 무관한 디렉토리)를 절대 분석/탐색하지 마세요.`,
            `\`ls\` / \`find\` / \`pwd\` 등으로 cwd 나 home 을 탐색하지 마세요. 작업 대상은 이미 위에 명시되었습니다.`,
            ``,
          );
        }
      }
    }

    // 0) 활성 SSH 세션: 전체 파일시스템이 WebDAV 에 마운트됨 — 자동 context 주입
    if (activeMount) {
      addDirsSet.add(activeMount.mountRoot);

      // 사용자 메시지에서 Unix 절대 경로 추출 → UNC 번역 매핑 생성
      const unixPathRegex = /\/[A-Za-z0-9_\-./]+/g;
      const matches = Array.from(new Set(text.match(unixPathRegex) || []));
      const pathMappings = matches
        .filter(p => p.length > 2 && !p.startsWith('//'))
        .map(p => {
          const uncRel = p.replace(/^\/+/, '').replace(/\//g, '\\');
          return { unix: p, unc: `${activeMount.mountRoot}\\${uncRel}` };
        });

      contextLines.push(
        `# 중요: 원격 SSH 파일 접근 규칙`,
        ``,
        `현재 SSH 세션: **${activeMount.label}**`,
        `이 세션의 원격 Linux 파일시스템 전체가 로컬 WebDAV 에 마운트되어 있습니다.`,
        ``,
        `## 경로 매핑 규칙`,
        `- 원격 Unix 루트 \`/\` ↔ 로컬 UNC \`${activeMount.mountRoot}\\\``,
        `- 원격 \`/a/b/c.txt\` ↔ 로컬 \`${activeMount.mountRoot}\\a\\b\\c.txt\``,
        ``,
        `## 도구 사용 규칙 (반드시 준수)`,
        `❌ **로컬 Bash 툴을 쓰지 마세요** — 이 시스템은 Windows 이며 Unix 경로 \`/view/...\` 를 Bash 로 접근할 수 없습니다.`,
        `✅ **파일 읽기/탐색**: Read / Glob / Grep / LS 툴을 UNC 경로로 호출`,
        `✅ **파일 편집/작성**: Edit / Write 툴을 UNC 경로로 호출 (실제 원격 SSH 서버에 실시간 반영됨)`,
        `✅ **원격 명령 실행 (cleartool, ctco, make, git 등)**: \`mcp__pepe_ssh__ssh_exec\` 툴 사용 — command 만 원격 Unix 경로로 전달 (UNC 변환 NO). 예: \`ssh_exec(command="ctco /view/.../file.c")\``,
        `✅ 파일 경로가 언급되면: 파일 I/O 는 UNC 변환, 쉘 명령 argument 는 Unix 경로 그대로`,
        ``,
      );

      if (pathMappings.length > 0) {
        contextLines.push(`## 이번 질문에서 감지된 경로 (미리 번역됨)`);
        for (const m of pathMappings) {
          contextLines.push(`- 원격: \`${m.unix}\` → 로컬 UNC: \`${m.unc}\``);
        }
        contextLines.push('');
      }

      contextLines.push(`분석 결과를 말할 때는 **원격 Unix 경로 기준**으로 설명해주세요 (사용자가 이해하기 쉽게).`);
    }

    // 0.5) 사용자 메시지에서 Windows 로컬 절대 경로 자동 감지 → --add-dir 추가
    // 예: C:\IPAGEON, D:\Work\file.txt → 부모 디렉토리까지 포함
    const winPathRegex = /[A-Za-z]:[\\/][^\s"'<>|?*\n]+/g;
    const newWinPaths = Array.from(new Set((text.match(winPathRegex) || []).map(p => p.replace(/[/]/g, '\\'))));
    // 이번 메시지에서 발견된 경로를 누적 저장. --add-dir 는 디렉토리만 허용하므로
    // 항상 부모 디렉토리를 저장 (파일이 대상이어도 Claude 는 부모 dir 안에서 접근 가능)
    for (const p of newWinPaths) {
      const parent = p.replace(/\\[^\\]+$/, '');
      // 최상위 드라이브(C:\)만 있으면 그대로
      if (/^[A-Za-z]:\\?$/.test(p)) {
        recentLocalPathsRef.current.add(p.replace(/\\?$/, '\\'));
        continue;
      }
      if (parent && /^[A-Za-z]:\\/.test(parent)) {
        recentLocalPathsRef.current.add(parent);
      }
    }
    // 누적된 모든 로컬 경로를 --add-dir 에 추가
    const winPaths = Array.from(recentLocalPathsRef.current);
    if (winPaths.length > 0) {
      for (const lp of winPaths) addDirsSet.add(lp);
      const localPathLines = winPaths.slice(0, 10).map(p => `- \`${p}\``);
      contextLines.push(
        `[로컬 경로 접근 허용]`,
        `다음 로컬 경로들이 작업 범위에 포함되어 있습니다:`,
        ...localPathLines,
        `이 경로에 대해 Read/Write/Edit/LS/Bash 툴을 정상 사용할 수 있습니다. 대화 중 언급된 이전 경로들도 계속 유효합니다.`,
        ``,
      );
    }

    // 0.9) 다이어그램/플로우차트는 반드시 Mermaid 코드 블록으로 — ASCII 박스 드로잉 금지
    contextLines.push(
      `# 다이어그램 출력 규칙 (반드시 준수)`,
      `다이어그램(DFD, 플로우차트, 시퀀스, 클래스 등)을 그릴 때는 **반드시 \`\`\`mermaid 코드 블록**으로 출력하세요.`,
      `**절대 금지**: ASCII 박스 드로잉(─│┌┐└┘╔╗╚╝═║▶◀ 등) 으로 그리지 마세요.`,
      `이유: 사용자 환경은 Mermaid 를 자동으로 SVG 로 렌더링합니다. ASCII 아트는 한글-라틴 혼합 시 정렬이 깨져 보입니다.`,
      `예시: 플로우차트 → \`\`\`mermaid\\nflowchart TB\\n  A[Application] --> B[UEnc Library]\\n\`\`\``,
      ``,
    );

    // 1) 개별 WebDAV 마운트 첨부 (파일/폴더 우클릭 → Claude 첨부)
    if (mountEntries.length > 0) {
      for (const m of mountEntries) addDirsSet.add(m.uncPath);
      const pathMap = mountEntries.map(m =>
        `- \`${m.remotePath}\`${m.isDir ? '/' : ''} ← \`${m.uncPath}\``
      ).join('\n');
      contextLines.push('', '[명시적으로 첨부된 파일/폴더]', pathMap);
      attachBadge = `📂 첨부 ${mountEntries.length}개:\n${mountEntries.slice(0, 5).map(m => `• ${m.remotePath}${m.isDir ? '/' : ''}`).join('\n')}${mountEntries.length > 5 ? `\n외 ${mountEntries.length - 5}개` : ''}\n\n`;
    } else if (activeMount) {
      attachBadge = `🔗 활성 SSH: ${activeMount.label}\n\n`;
    }

    // 0.7) 포크/리로드된 대화 — claudeSessionId 가 없는데 이전 메시지가 있으면 컨텍스트로 inject.
    // (--resume 가 없으므로 Claude 는 이전 대화를 모름. 이를 prompt 에 명시해야 일관성 유지.)
    if (!claudeSessionIdRef.current && messages.length > 0) {
      // 메시지와 툴 호출을 seq 순으로 인터리브
      type TItem = { seq: number; kind: 'msg'; m: Message } | { seq: number; kind: 'tool'; t: ToolTimelineItem };
      const items: TItem[] = [
        ...messages.map((m, i) => ({ seq: m.seq ?? i * 2, kind: 'msg' as const, m })),
        ...toolTimeline.map((t, i) => ({ seq: t.seq ?? (messages.length * 2 + i * 2 + 1), kind: 'tool' as const, t })),
      ];
      items.sort((a, b) => a.seq - b.seq);
      // 오래된 transcript 안의 UNC mountRoot 는 현재 세션과 다를 수 있음 (포트/termId 매 세션 변경).
      // 현재 active mountRoot 가 있으면 모든 옛 \\127.0.0.1@PORT\DavWWWRoot\term-XXX 패턴을 현재 것으로 치환.
      const sanitizeUNC = (s: string): string => {
        if (!activeMount) return s;
        const oldUncRe = /\\\\127\.0\.0\.1@\d+\\DavWWWRoot\\term-[^\\\s"')]+/g;
        return s.replace(oldUncRe, activeMount.mountRoot);
      };
      const transcriptLines: string[] = [];
      for (const it of items) {
        if (it.kind === 'msg') {
          const who = it.m.role === 'user' ? '사용자' : 'Claude';
          transcriptLines.push(`### ${who}`, sanitizeUNC(it.m.content), '');
        } else {
          const status = it.t.status === 'done' ? '✓' : it.t.status === 'error' ? '✕' : '⏳';
          transcriptLines.push(`### [툴 호출 ${status}] ${sanitizeUNC(it.t.label)}`);
          if (it.t.resultPreview) transcriptLines.push(`결과: ${sanitizeUNC(it.t.resultPreview)}`);
          transcriptLines.push('');
        }
      }
      contextLines.push(
        `# 이전 대화 내역 (포크/이어쓰기 — 매우 중요)`,
        `당신(Claude)은 새 CLI 세션에서 시작했지만, 사용자는 아래 대화의 연속으로 이번 질문을 합니다.`,
        `**핵심 지침:**`,
        `- 이번 질문의 작업/분석 **대상은 아래 transcript 에서 사용자가 다루던 그 코드/시스템**입니다 (transcript 의 Claude 답변 안에 명시된 경로/모듈/구조).`,
        `- 절대로 다른 프로젝트(특히 Claude 프로세스의 cwd 인 Electron 앱)를 분석/탐색하지 마세요.`,
        `- 이전에 분석/탐색한 내용은 이미 알고 있는 것으로 간주하고 그 결과를 활용하세요.`,
        `- 동일한 파일/디렉토리를 다시 읽거나 탐색하지 마세요. 필요하면 이전 결과를 참조하세요.`,
        `- 사용자에게 "이전 대화를 다시 알려주세요" 같은 요청을 하지 마세요.`,
        `- **AskUserQuestion 같은 명료화 도구를 절대 사용하지 마세요.** 정보가 부족하면 transcript 에서 가장 합리적인 가정을 세우고 그 가정을 명시한 채 답변을 진행하세요.`,
        `- 사용자가 짧은 후속 질문을 했다면(예: "DFD 그려줘", "정리해줘", "구조 보여줘") 그것은 transcript 에서 다룬 시스템에 대한 추가 작업입니다.`,
        `- 이번 질문은 위 분석/대화의 연장입니다.`,
        ``,
        ...transcriptLines,
        `---`,
        ``,
      );
    }

    if (contextLines.length > 0) {
      // 포크 후속 질문이면 user text 자체에 작업 대상을 prepend (system context 외에도 user msg 단에서 명시)
      const userTextWithTarget = forkTargetPath
        ? `[이전 대화에서 다룬 작업 대상: ${forkTargetPath}\n원래 요청: "${forkOriginalRequest?.replace(/\n/g, ' ').slice(0, 200)}"]\n\n위 작업의 후속 질문:\n${text}`
        : text;
      prompt = `${contextLines.join('\n')}\n\n---\n\n${userTextWithTarget}`;
    }

    // 2) 인라인 파일 컨텍스트 (FileEditor Claude 버튼용 - 레거시)
    if (contextItems.length > 0) {
      const fileBlocks = contextItems.map(c => `파일 \`${c.remotePath}\`:\n\`\`\`\n${c.content}\n\`\`\``).join('\n\n');
      prompt = `${fileBlocks}\n\n${prompt}`;
      attachBadge += `📎 인라인 ${contextItems.length}개 파일\n\n`;
    }

    // 3) 로컬 PC 파일 첨부
    if (localFileAttachments.length > 0) {
      const fileBlocks = localFileAttachments.map(c => `로컬 파일 \`${c.name}\`:\n\`\`\`\n${c.content}\n\`\`\``).join('\n\n');
      prompt = `${fileBlocks}\n\n${prompt}`;
      attachBadge += `📁 로컬 ${localFileAttachments.length}개 파일\n\n`;
    }

    const userMsg: Message = { role: 'user', content: attachBadge + text, id: `user-${Date.now()}`, seq: nextSeq() };
    // 활성 이력 없으면 새 이력 생성 (setMessages updater 밖에서 — strict mode 중복 방지)
    // 클로저 stale 방지 — 현재 활성 history 는 ref 에서 읽기 (포크/이력전환 직후 send 시점 보정)
    let targetHid = activeHistoryIdRef.current;
    if (!targetHid) {
      const newId = `hist-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const newHist: ChatHistoryEntry = {
        id: newId,
        claudeSessionId: claudeSessionIdRef.current,
        title: text.slice(0, 60).replace(/\n/g, ' '),
        pinned: false,
        updatedAt: Date.now(),
        messages: [userMsg],
        pendingRequestId: requestId,
        streaming: true,
      };
      setChatHistory(h => [newHist, ...h]);
      setActiveHist(newId);
      targetHid = newId;
    } else {
      // 기존 이력에 진행 상태 마킹
      setChatHistory(h => h.map(x => x.id === targetHid ? { ...x, pendingRequestId: requestId, streaming: true } : x));
    }
    // requestId → historyId 매핑 등록 (활성 전환 후에도 stream 이 정확한 history 에 도달하도록)
    requestToHistoryRef.current.set(requestId, targetHid);
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setStreaming(true);
    setActivity('🚀 시작');
    setToolTimeline([]);
    currentAsstIdRef.current = null;

    const addDirs = addDirsSet.size > 0 ? Array.from(addDirsSet) : undefined;
    // 활성 SSH 세션이 선택되어 있으면 Bash 금지 + MCP ssh_exec 툴 제공
    // (activeMount 가 아직 준비 전이라도 MCP 는 사용 가능해야 함)
    const sshTermId = activeSshSession?.termId || activeMount?.termId;
    const disallowBash = !!sshTermId;
    const resumeSessionId = claudeSessionIdRef.current;
    // 비대화형 모드(-p)에서는 'default' 권한이 항상 거부됨 → 대신 'plan' 모드로 변환
    // (Claude 가 계획을 설명하지만 실행은 하지 않음 — 사용자는 다음 턴에 "실행해" 등으로 승인)
    const approveKeywords = ['실행', '진행', '좋아', 'yes', 'ok', '승인', 'approve', '해줘', 'go ahead', '네'];
    const isApproval = approveKeywords.some(k => text.toLowerCase().includes(k.toLowerCase()));
    let effectivePermMode: string = permissionMode;
    if (permissionMode === 'default') {
      effectivePermMode = (isApproval && claudeSessionIdRef.current) ? 'bypassPermissions' : 'plan';
    }
    console.log('[ClaudeChat] permissionMode', permissionMode, '→ effective', effectivePermMode, 'isApproval', isApproval);

    // Plan 모드에서는 Claude 에게 ExitPlanMode 툴 사용을 명확히 지시
    if (effectivePermMode === 'plan') {
      contextLines.push(
        `# Plan 모드 지침 (반드시 준수)`,
        `- 당신은 현재 Plan 모드로 실행되고 있습니다. 이것은 비대화형 모드이므로 사용자가 "/plan" 토글이나 모드 전환을 할 수 없습니다.`,
        `- 파일 수정/생성/명령 실행이 필요하면 **반드시 ExitPlanMode 툴을 호출**해서 plan 파라미터에 계획을 담아 제시하세요.`,
        `- ExitPlanMode 툴이 호출되면 외부 UI 에서 사용자에게 승인 모달이 표시되고, 승인 시 다음 턴에 실제로 실행됩니다.`,
        `- 사용자에게 "/plan 을 입력하세요" / "Plan 모드를 종료하세요" 같은 안내를 하지 마세요. 당신이 직접 ExitPlanMode 를 호출해야 합니다.`,
        `- 변경이 필요 없으면 ExitPlanMode 없이 정보만 응답하세요.`,
        ``,
      );
    }
    // 전송 후 로컬 파일 첨부는 해제
    setLocalFileAttachments([]);
    try {
      await (window as any).api?.claudeSend?.(sessionId, prompt, addDirs, disallowBash, sshTermId, resumeSessionId, effectivePermMode, model, perToolApproval, requestId);
    } catch (err: any) {
      setMessages(prev => [...prev, { role: 'assistant', content: `❌ ${err}`, id: `err-${Date.now()}`, seq: nextSeq() }]);
      setStreaming(false);
    }
  }, [sessionId, streaming, mountEntries, activeMount, localFileAttachments, permissionMode, model, perToolApproval, messages, toolTimeline]);

  // 외부에서 컨텍스트 전달되면 추가 (기존 첨부에 append, 중복 제거)
  useEffect(() => {
    if (pendingContext && pendingContext.length > 0) {
      setAttachments(prev => {
        const map = new Map(prev.map(p => [p.remotePath, p]));
        for (const c of pendingContext) map.set(c.remotePath, c);
        return Array.from(map.values());
      });
      if (!input.trim()) setInput(`이 파일을 분석해주세요.`);
      onContextConsumed();
    }
  }, [pendingContext, onContextConsumed]);

  const handleSend = () => {
    send(input, attachments);
    setAttachments([]);
  };

  const removeAttachment = (path: string) => {
    setAttachments(prev => prev.filter(a => a.remotePath !== path));
  };
  const clearAllAttachments = () => setAttachments([]);

  const stop = () => {
    // 명시적 중단 — 활성 대화의 프로세스만 죽임
    const reqId = activeRequestIdRef.current;
    try { (window as any).api?.claudeStop?.(sessionId, reqId || undefined); } catch {}
    if (reqId) requestToHistoryRef.current.delete(reqId);
    activeRequestIdRef.current = null;
    setStreaming(false);
    setActivity('');
    currentAsstIdRef.current = null;
    if (activeHistoryId) {
      setChatHistory(h => h.map(x => x.id === activeHistoryId ? { ...x, streaming: false, pendingRequestId: null } : x));
    }
  };

  const clear = () => {
    // 새 대화 시작 — 진행 중 백그라운드 프로세스는 살려두고 (그 history 에서 계속 응답 받도록) UI 만 리셋
    activeRequestIdRef.current = null;
    setMessages([]);
    setToolTimeline([]);
    setActivity('');
    setPendingPlan(null);
    setStreaming(false);
    claudeSessionIdRef.current = null;
    recentLocalPathsRef.current.clear();
    currentAsstIdRef.current = null;
    setActiveHist(null);
  };
  const startNewConversation = () => {
    clear();
    setShowHistoryPanel(false);
  };
  const loadHistory = (h: ChatHistoryEntry) => {
    // 동일 대화 재선택 — 진행 중 상태 그대로 유지하고 패널만 닫는다
    if (activeHistoryId === h.id) {
      setShowHistoryPanel(false);
      return;
    }
    // 다른 대화로 전환 — 백그라운드 프로세스는 죽이지 않고 진행 상태 복원
    setMessages(h.messages);
    bumpSeqFor(h.messages, h.toolTimeline || []);
    // 옛 Claude CLI session_id 는 만료되었을 수 있어 --resume 실패함.
    // null 로 두면 send() 가 transcript 를 inject 해 새 세션으로 안전하게 진행. 첫 send 후 새 session_id 자동 캡처.
    claudeSessionIdRef.current = null;
    // 이전 대화에서 누적된 로컬 경로 — 다른 대화로 전환 시 클리어
    recentLocalPathsRef.current.clear();
    setActiveHist(h.id);
    setToolTimeline(h.toolTimeline || []);
    // h.streaming 이 true 라도 실제 진행 중 프로세스 매핑(requestToHistoryRef) 에 없으면 stale → 입력 잠김 방지
    const reallyStreaming = !!(h.streaming && h.pendingRequestId && requestToHistoryRef.current.get(h.pendingRequestId) === h.id);
    setStreaming(reallyStreaming);
    setActivity(reallyStreaming ? '🤔 생각 중...' : '');
    setPendingPlan(null);
    activeRequestIdRef.current = reallyStreaming ? (h.pendingRequestId ?? null) : null;
    // stale streaming 이면 history 도 정리
    if (h.streaming && !reallyStreaming) {
      setChatHistory(hList => hList.map(x => x.id === h.id ? { ...x, streaming: false, pendingRequestId: null } : x));
    }
    currentAsstIdRef.current = null;
    setShowHistoryPanel(false);
  };
  const deleteHistory = (id: string) => {
    // 삭제 대상 history 의 진행 중 프로세스 종료 + 매핑 정리
    for (const [reqId, hid] of Array.from(requestToHistoryRef.current.entries())) {
      if (hid === id) {
        try { (window as any).api?.claudeStop?.(sessionId, reqId); } catch {}
        requestToHistoryRef.current.delete(reqId);
      }
    }
    setChatHistory(h => h.filter(x => x.id !== id));
    if (activeHistoryId === id) clear();
  };
  const togglePinHistory = (id: string) => {
    setChatHistory(h => h.map(x => x.id === id ? { ...x, pinned: !x.pinned } : x));
  };
  const renameHistory = (id: string, newTitle: string) => {
    setChatHistory(h => h.map(x => x.id === id ? { ...x, title: newTitle } : x));
  };

  // 계획 승인 — "진행해줘" 메시지로 bypass 모드 send 자동 실행
  // streaming 상태 race 방지용 — 승인 시점에 streaming 이 아직 true 면 끝나기를 기다렸다 send
  const pendingApprovalSendRef = useRef<string | null>(null);
  const approvePlan = () => {
    setPendingPlan(null);
    const text = '위 계획대로 진행해줘';
    console.log('[ClaudeChat] approvePlan, streaming=', streaming);
    if (streaming) {
      pendingApprovalSendRef.current = text;
      // claudeStop 으로 진행 중 프로세스 종료 (있다면) — end_turn 이미 됐으면 no-op
      const reqId = activeRequestIdRef.current;
      if (reqId) { try { (window as any).api?.claudeStop?.(sessionId, reqId); } catch {} }
    } else {
      send(text, []);
    }
  };
  // streaming 이 false 가 되면 큐잉된 승인 메시지 자동 전송
  useEffect(() => {
    if (!streaming && pendingApprovalSendRef.current) {
      const t = pendingApprovalSendRef.current;
      pendingApprovalSendRef.current = null;
      // 다음 tick 에 send (현재 render cycle 영향 회피)
      setTimeout(() => send(t, []), 0);
    }
  }, [streaming, send]);
  const rejectPlan = () => {
    setPendingPlan(null);
    setMessages(prev => [...prev, { role: 'assistant', content: '❌ 계획이 거부되었습니다. 다시 요청하시거나 수정 사항을 말씀해 주세요.', id: `reject-${Date.now()}` }]);
  };

  // 툴 단위 승인/거부
  const approveTool = () => {
    if (!pendingToolApproval) return;
    (window as any).api?.claudeHookRespond?.(pendingToolApproval.approvalId, 'allow');
    setPendingToolApproval(null);
  };
  const denyTool = () => {
    if (!pendingToolApproval) return;
    (window as any).api?.claudeHookRespond?.(pendingToolApproval.approvalId, 'deny', '사용자가 거부함');
    setPendingToolApproval(null);
  };

  // 로컬 PC 파일/폴더 업로드 → 인라인 첨부
  const BINARY_LOCAL_EXT = new Set(['png','jpg','jpeg','gif','bmp','ico','webp','zip','gz','tar','bz2','7z','rar','exe','dll','so','dylib','bin','pdf','mp3','mp4','avi','mkv','wav','flac','ogg','class','o','a','obj','lib','pyc','woff','woff2','ttf','otf','eot']);
  const EXCLUDE_FOLDER_DIR = new Set(['node_modules','.git','.svn','dist','build','__pycache__','.venv','venv','.next','target','coverage','.cache','.idea','.vscode']);

  const onFilePicked = async (files: FileList | null, opts: { fromFolder?: boolean; maxFiles?: number; maxPerFileKB?: number; maxTotalMB?: number } = {}) => {
    if (!files || files.length === 0) return;
    const { fromFolder = false, maxFiles = fromFolder ? 50 : 20, maxPerFileKB = 500, maxTotalMB = 5 } = opts;
    const added: { name: string; content: string }[] = [];
    const skipped: string[] = [];
    let totalBytes = 0;
    for (const f of Array.from(files)) {
      if (added.length >= maxFiles) { skipped.push(`${(f as any).webkitRelativePath || f.name} (개수 제한 ${maxFiles})`); continue; }
      if (totalBytes > maxTotalMB * 1024 * 1024) { skipped.push(`${f.name} (총 크기 제한)`); continue; }
      const relPath = (f as any).webkitRelativePath || f.name;
      // 폴더 업로드 시 제외 디렉토리 스킵
      if (fromFolder) {
        const parts = relPath.split(/[\\/]/);
        if (parts.some((p: string) => EXCLUDE_FOLDER_DIR.has(p))) { skipped.push(`${relPath} (제외 폴더)`); continue; }
      }
      const ext = f.name.split('.').pop()?.toLowerCase() || '';
      if (BINARY_LOCAL_EXT.has(ext)) { skipped.push(`${relPath} (바이너리)`); continue; }
      if (f.size > maxPerFileKB * 1024) { skipped.push(`${relPath} (${(f.size / 1024).toFixed(0)}KB > ${maxPerFileKB}KB)`); continue; }
      try {
        const text = await f.text();
        added.push({ name: relPath, content: text });
        totalBytes += f.size;
      } catch (err: any) {
        skipped.push(`${relPath} (읽기 실패)`);
      }
    }
    if (added.length > 0) setLocalFileAttachments(prev => [...prev, ...added]);
    if (skipped.length > 0) console.log(`[local-attach] 제외 ${skipped.length}개:`, skipped);
    if (added.length === 0 && skipped.length > 0) {
      setMessages(prev => [...prev, { role: 'assistant', content: `❌ 첨부할 텍스트 파일이 없습니다 (${skipped.length}개 제외). 자세한 내용은 DevTools Console 확인.`, id: `err-${Date.now()}`, seq: nextSeq() }]);
    }
  };

  // 슬래시 명령 프리셋
  const commandPresets: { label: string; insert: string; desc: string }[] = [
    { label: '/explain', insert: '이 코드를 설명해줘: ', desc: '코드 설명' },
    { label: '/refactor', insert: '이 코드를 리팩토링해줘: ', desc: '리팩토링 제안' },
    { label: '/fix', insert: '이 버그를 수정해줘: ', desc: '버그 수정' },
    { label: '/test', insert: '이 함수에 대한 테스트 코드를 작성해줘: ', desc: '테스트 작성' },
    { label: '/review', insert: '이 코드를 리뷰해줘 (버그/성능/스타일): ', desc: '코드 리뷰' },
    { label: '/doc', insert: '이 함수/모듈에 대한 문서를 작성해줘: ', desc: '문서 작성' },
    { label: '/trace', insert: '이 함수의 호출 흐름을 추적해줘: ', desc: '호출 흐름 추적' },
    { label: '/analyze', insert: '이 모듈의 구조를 분석해줘: ', desc: '구조 분석' },
    { label: '/optimize', insert: '이 코드의 성능을 최적화해줘: ', desc: '성능 최적화' },
    { label: '/security', insert: '이 코드의 보안 취약점을 검토해줘: ', desc: '보안 검토' },
  ];

  // 명령 팔레트 전체 액션 (섹션별)
  type PaletteAction = { id: string; section: string; label: string; desc?: string; shortcut?: string; run: () => void };
  const paletteActions: PaletteAction[] = [
    // Context
    { id: 'attach-file', section: 'Context', label: 'Attach file...', desc: '로컬 파일 첨부', run: () => fileUploadRef.current?.click() },
    { id: 'attach-folder', section: 'Context', label: 'Attach folder...', desc: '로컬 폴더 첨부 (재귀)', run: () => folderUploadRef.current?.click() },
    { id: 'clear', section: 'Context', label: 'Clear conversation', desc: '대화 및 컨텍스트 초기화', run: () => clear() },
    // Model
    { id: 'model-default', section: 'Model', label: 'Model: 기본', run: () => setModel('default') },
    { id: 'model-opus', section: 'Model', label: 'Model: Opus', desc: '최고 성능', run: () => setModel('opus') },
    { id: 'model-sonnet', section: 'Model', label: 'Model: Sonnet', desc: '균형', run: () => setModel('sonnet') },
    { id: 'model-haiku', section: 'Model', label: 'Model: Haiku', desc: '빠름', run: () => setModel('haiku') },
    { id: 'model-opusplan', section: 'Model', label: 'Model: Opus Plan', desc: '계획 Opus', run: () => setModel('opusplan') },
    // Permission
    { id: 'perm-default', section: 'Permission', label: '🖐 편집 전 확인', run: () => setPermissionMode('default') },
    { id: 'perm-accept', section: 'Permission', label: '✏️ 편집 자동 수락', run: () => setPermissionMode('acceptEdits') },
    { id: 'perm-plan', section: 'Permission', label: '🗺 계획 모드', run: () => setPermissionMode('plan') },
    { id: 'perm-bypass', section: 'Permission', label: '⚡ 모두 허용', run: () => setPermissionMode('bypassPermissions') },
    // Slash Commands (프롬프트 삽입)
    ...commandPresets.map(p => ({
      id: `slash-${p.label}`,
      section: 'Slash Commands',
      label: p.label,
      desc: p.desc,
      run: () => {
        setInput(prev => {
          const trimmed = prev.trim();
          const startsWithPreset = commandPresets.some(pp => trimmed.startsWith(pp.insert.trim()));
          if (!trimmed || startsWithPreset) return p.insert;
          return p.insert + trimmed;
        });
      },
    })),
  ];

  // 필터링된 액션 리스트
  const filteredPalette = (() => {
    const q = commandFilter.trim().toLowerCase();
    if (!q) return paletteActions;
    return paletteActions.filter(a =>
      a.label.toLowerCase().includes(q) ||
      (a.desc || '').toLowerCase().includes(q) ||
      a.section.toLowerCase().includes(q)
    );
  })();

  const runPaletteAction = (a: PaletteAction) => {
    a.run();
    setCommandMenuOpen(false);
  };

  if (installed === null) {
    return <div className="claude-chat-container"><div className="claude-chat-loading">Claude CLI 확인 중...</div></div>;
  }
  if (!installed) {
    return (
      <div className="claude-chat-container">
        <div className="claude-chat-header">
          <span>🤖 Claude</span>
          {onClose && <button className="claude-chat-close" onClick={onClose}>×</button>}
        </div>
        <div className="claude-chat-notinstalled">
          <p>Claude Code CLI가 설치되지 않았습니다.</p>
          <p>설치: <code>npm install -g @anthropic-ai/claude-code</code></p>
          <p>로그인: 터미널에서 <code>claude</code> 실행</p>
        </div>
      </div>
    );
  }

  const totalAttachSize = attachments.reduce((a, c) => a + c.content.length, 0);

  return (
    <div className="claude-chat-container">
      <div className="claude-chat-header">
        <span>🤖 Claude <span className="claude-chat-version">{version}</span></span>
        <div className="claude-chat-header-actions">
          <button onClick={startNewConversation} title="새 대화">＋</button>
          <button onClick={() => setShowHistoryPanel(v => !v)} title="대화 이력" className={showHistoryPanel ? 'active' : ''}>≡</button>
          {onTogglePin && (
            <button
              className={`claude-chat-pin ${pinned ? 'pinned' : ''}`}
              onClick={onTogglePin}
              title={pinned ? 'Unpin (자동 숨김)' : 'Pin (고정)'}
            >📌</button>
          )}
          <button onClick={clear} title="대화 지우기">🗑</button>
          {onClose && <button className="claude-chat-close" onClick={onClose} title="닫기">×</button>}
        </div>
      </div>
      {pendingToolApproval && (
        <div className="claude-chat-plan-overlay">
          <div className="claude-chat-plan-modal">
            <div className="claude-chat-plan-title">Claude가 <code>{pendingToolApproval.toolName}</code> 하도록 허용하시겠습니까?</div>
            <div className="claude-chat-plan-body">
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
{JSON.stringify(pendingToolApproval.toolInput, null, 2).slice(0, 2000)}
              </pre>
            </div>
            <div className="claude-chat-plan-actions">
              <button className="claude-chat-plan-btn reject" onClick={denyTool}>❌ 거부</button>
              <button className="claude-chat-plan-btn approve" onClick={approveTool} autoFocus>✅ 한 번만 허용</button>
            </div>
          </div>
        </div>
      )}
      {pendingPlan && (
        <div className="claude-chat-plan-overlay" onClick={rejectPlan}>
          <div className="claude-chat-plan-modal" onClick={e => e.stopPropagation()}
            onKeyDown={e => { if (e.key === 'Enter') approvePlan(); else if (e.key === 'Escape') rejectPlan(); }}
            tabIndex={0}
          >
            <div className="claude-chat-plan-title">🗺 작업 계획 승인</div>
            <div className="claude-chat-plan-body"
              dangerouslySetInnerHTML={{ __html: renderMd(pendingPlan) }}
            />
            <div className="claude-chat-plan-actions">
              <button className="claude-chat-plan-btn reject" onClick={rejectPlan}>❌ 거부</button>
              <button className="claude-chat-plan-btn approve" onClick={approvePlan} autoFocus>✅ 진행</button>
            </div>
          </div>
        </div>
      )}
      <div className="claude-chat-active-session">
        🔗 SSH 컨텍스트:
        <select
          className="claude-chat-session-select"
          value={selectedSshTermId || ''}
          onChange={e => setSelectedSshTermId(e.target.value || null)}
        >
          <option value="">(선택 안 함)</option>
          {connectedSessions.map(s => (
            <option key={s.termId} value={s.termId}>{s.label}</option>
          ))}
        </select>
        {activeMount ? (
          <span className="claude-chat-active-session-hint" title={`WebDAV 마운트: ${activeMount.mountRoot}`}>✓ 마운트됨 — Unix 경로 직접 사용 가능</span>
        ) : selectedSshTermId ? (
          <span className="claude-chat-active-session-hint" style={{ color: '#fa6' }}>⏳ 마운트 준비 중...</span>
        ) : connectedSessions.length === 0 ? (
          <span className="claude-chat-active-session-hint" style={{ color: '#a66' }}>연결된 SSH 세션 없음</span>
        ) : (
          <span className="claude-chat-active-session-hint">세션을 선택하면 Unix 경로 분석이 가능합니다</span>
        )}
      </div>
      {showHistoryPanel && (() => {
        const pinnedHist = chatHistory.filter(h => h.pinned).sort((a, b) => b.updatedAt - a.updatedAt);
        const recentHist = chatHistory.filter(h => !h.pinned).sort((a, b) => b.updatedAt - a.updatedAt);
        const renderItem = (h: ChatHistoryEntry) => (
          <div
            key={h.id}
            className={`claude-chat-history-item ${activeHistoryId === h.id ? 'active' : ''}`}
            onClick={() => loadHistory(h)}
          >
            <span className="claude-chat-history-title" title={h.title}>○ {h.title || '(제목 없음)'}</span>
            <div className="claude-chat-history-actions">
              <button title={h.pinned ? '핀 해제' : '핀 고정'} onClick={e => { e.stopPropagation(); togglePinHistory(h.id); }}>
                {h.pinned ? '📍' : '📌'}
              </button>
              <button title="이름 변경" onClick={e => {
                e.stopPropagation();
                const v = prompt('새 제목', h.title);
                if (v && v.trim()) renameHistory(h.id, v.trim());
              }}>✎</button>
              <button title="삭제" onClick={e => {
                e.stopPropagation();
                if (confirm(`"${h.title}" 대화를 삭제할까요?`)) deleteHistory(h.id);
              }}>×</button>
            </div>
          </div>
        );
        return (
          <div className="claude-chat-history-panel">
            <div className="claude-chat-history-section-title">📌 Pinned</div>
            {pinnedHist.length === 0 ? <div className="claude-chat-history-empty">고정된 대화 없음</div> : pinnedHist.map(renderItem)}
            <div className="claude-chat-history-section-title">🕒 Recents</div>
            {recentHist.length === 0 ? <div className="claude-chat-history-empty">최근 대화 없음</div> : recentHist.map(renderItem)}
          </div>
        );
      })()}
      <div className="claude-chat-messages" ref={scrollRef} style={showHistoryPanel ? { display: 'none' } : undefined}>
        {messages.length === 0 && (
          <div className="claude-chat-empty">
            <p>Claude에게 질문하세요.</p>
            <p>에디터의 "🤖 Claude" 버튼이나, 파일 트리에서 파일/폴더를 우클릭 → "Claude에 첨부"로 컨텍스트를 전달할 수 있습니다.</p>
          </div>
        )}
        {(() => {
          // 메시지 + 툴 호출을 발생 순서(seq) 로 인터리브
          type Item = { kind: 'msg'; m: Message; seq: number } | { kind: 'tool'; t: ToolTimelineItem; seq: number };
          const items: Item[] = [
            ...messages.map((m, i) => ({ kind: 'msg' as const, m, seq: m.seq ?? i * 2 })),
            ...toolTimeline.map((t, i) => ({ kind: 'tool' as const, t, seq: t.seq ?? (messages.length * 2 + i * 2 + 1) })),
          ];
          items.sort((a, b) => a.seq - b.seq);
          return items.map(item => item.kind === 'msg' ? (
            <div
              key={`m-${item.m.id}`}
              className={`claude-chat-msg ${item.m.role}`}
              onContextMenu={e => {
                // mermaid 다이어그램 영역은 자체 컨텍스트 메뉴를 갖고 있으므로 무시
                const t = e.target as HTMLElement | null;
                if (t && t.closest && t.closest('.claude-chat-mermaid')) return;
                e.preventDefault();
                e.stopPropagation();
                setMsgCtxMenu({ x: e.clientX, y: e.clientY, msgId: item.m.id, content: item.m.content });
              }}
              onMouseDown={e => {
                if (e.button === 2) {
                  const t = e.target as HTMLElement | null;
                  if (t && t.closest && t.closest('.claude-chat-mermaid')) return;
                  e.preventDefault();
                  e.stopPropagation();
                  setMsgCtxMenu({ x: e.clientX, y: e.clientY, msgId: item.m.id, content: item.m.content });
                }
              }}
            >
              <div className="claude-chat-msg-role">{item.m.role === 'user' ? '👤 You' : '🤖 Claude'}</div>
              <div
                className="claude-chat-msg-content"
                dangerouslySetInnerHTML={{ __html: renderMd(item.m.content) }}
              />
            </div>
          ) : (
            <div key={`t-${item.t.id}`} className={`claude-chat-timeline-item inline ${item.t.status}`}>
              <span className="claude-chat-timeline-status">
                {item.t.status === 'running' ? '⏳' : item.t.status === 'done' ? '✓' : '✕'}
              </span>
              <span className="claude-chat-timeline-label" title={item.t.label}>{item.t.label}</span>
              {item.t.resultPreview && <span className="claude-chat-timeline-preview" title={item.t.resultPreview}>→ {item.t.resultPreview}</span>}
            </div>
          ));
        })()}
      </div>
      {streaming && !showHistoryPanel && (
        <div className="claude-chat-streaming">
          <span className="claude-chat-streaming-dots">●●●</span>
          <span className="claude-chat-streaming-activity">{activity || '🤔 생각 중...'}</span>
          <button className="claude-chat-streaming-stop" onClick={stop} title="응답 중단">중단</button>
        </div>
      )}
      <div className="claude-chat-input-area" style={showHistoryPanel ? { display: 'none' } : undefined}>
        {mountEntries.length > 0 && (
          <div className="claude-chat-attachments staged">
            <div className="claude-chat-attachments-header">
              <span>📂 WebDAV 마운트 {mountEntries.length}개 (실시간 SSH)</span>
              {onClearMounted && <button className="claude-chat-attachments-clear" onClick={onClearMounted} title="첨부 해제">전체 제거</button>}
            </div>
            <div className="claude-chat-attachments-list">
              {mountEntries.map(m => (
                <div key={`${m.termId}:${m.remotePath}`} className="claude-chat-attachment">
                  {m.isDir ? '📁' : '📄'}
                  <span className="claude-chat-attachment-path" title={`${m.remotePath}\n↓ UNC:\n${m.uncPath}`}>{m.remotePath}</span>
                  {onRemoveMountedEntry && <button className="claude-chat-attachment-remove" onClick={() => onRemoveMountedEntry(m.remotePath, m.termId)} title="제거">×</button>}
                </div>
              ))}
            </div>
          </div>
        )}
        {attachments.length > 0 && (
          <div className="claude-chat-attachments">
            <div className="claude-chat-attachments-header">
              <span>📎 첨부 {attachments.length}개 ({(totalAttachSize / 1024).toFixed(1)} KB)</span>
              <button className="claude-chat-attachments-clear" onClick={clearAllAttachments} title="모두 제거">전체 제거</button>
            </div>
            <div className="claude-chat-attachments-list">
              {attachments.map(a => (
                <div key={a.remotePath} className="claude-chat-attachment">
                  📄 <span className="claude-chat-attachment-path" title={a.remotePath}>{a.remotePath}</span>
                  <button className="claude-chat-attachment-remove" onClick={() => removeAttachment(a.remotePath)} title="제거">×</button>
                </div>
              ))}
            </div>
          </div>
        )}
        {localFileAttachments.length > 0 && (
          <div className="claude-chat-attachments">
            <div className="claude-chat-attachments-header">
              <span>📁 로컬 {localFileAttachments.length}개 파일</span>
              <button className="claude-chat-attachments-clear" onClick={() => setLocalFileAttachments([])}>전체 제거</button>
            </div>
            <div className="claude-chat-attachments-list">
              {localFileAttachments.map((f, i) => (
                <div key={`${f.name}-${i}`} className="claude-chat-attachment">
                  📄 <span className="claude-chat-attachment-path">{f.name}</span>
                  <span style={{ color: '#888', fontSize: 10 }}>{(f.content.length / 1024).toFixed(1)}KB</span>
                  <button className="claude-chat-attachment-remove" onClick={() => setLocalFileAttachments(prev => prev.filter((_, x) => x !== i))}>×</button>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="claude-chat-toolbar">
          <button
            className="claude-chat-tool-btn"
            title="로컬 파일 첨부"
            onClick={() => fileUploadRef.current?.click()}
          >📄+</button>
          <input
            ref={fileUploadRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={e => { onFilePicked(e.target.files, { fromFolder: false }); if (fileUploadRef.current) fileUploadRef.current.value = ''; }}
          />
          <button
            className="claude-chat-tool-btn"
            title="로컬 폴더 첨부 (텍스트 파일만, 재귀)"
            onClick={() => folderUploadRef.current?.click()}
          >📁+</button>
          <input
            ref={folderUploadRef}
            type="file"
            multiple
            // @ts-ignore — webkitdirectory 는 Chromium/Electron 에서 지원
            webkitdirectory=""
            directory=""
            style={{ display: 'none' }}
            onChange={e => { onFilePicked(e.target.files, { fromFolder: true }); if (folderUploadRef.current) folderUploadRef.current.value = ''; }}
          />
          <div className="claude-chat-cmd-wrap">
            <button
              className="claude-chat-tool-btn"
              title="슬래시 명령 메뉴"
              onClick={e => { e.stopPropagation(); setCommandMenuOpen(v => !v); }}
            >/</button>
            {commandMenuOpen && (
              <div className="claude-chat-cmd-menu" onClick={e => e.stopPropagation()}>
                <input
                  ref={commandFilterRef}
                  className="claude-chat-cmd-filter"
                  placeholder="Filter actions..."
                  value={commandFilter}
                  onChange={e => { setCommandFilter(e.target.value); setCommandHighlight(0); }}
                  onKeyDown={e => {
                    if (e.key === 'Escape') { setCommandMenuOpen(false); }
                    else if (e.key === 'ArrowDown') { e.preventDefault(); setCommandHighlight(h => Math.min(h + 1, filteredPalette.length - 1)); }
                    else if (e.key === 'ArrowUp') { e.preventDefault(); setCommandHighlight(h => Math.max(h - 1, 0)); }
                    else if (e.key === 'Enter') {
                      e.preventDefault();
                      const a = filteredPalette[commandHighlight];
                      if (a) runPaletteAction(a);
                    }
                  }}
                />
                <div className="claude-chat-cmd-list">
                  {filteredPalette.length === 0 && (
                    <div className="claude-chat-cmd-empty">일치하는 항목 없음</div>
                  )}
                  {(() => {
                    const rows: React.ReactNode[] = [];
                    let lastSection = '';
                    filteredPalette.forEach((a, idx) => {
                      if (a.section !== lastSection) {
                        rows.push(<div key={`sec-${a.section}`} className="claude-chat-cmd-section">{a.section}</div>);
                        lastSection = a.section;
                      }
                      rows.push(
                        <div
                          key={a.id}
                          className={`claude-chat-cmd-item ${idx === commandHighlight ? 'highlight' : ''}`}
                          onMouseEnter={() => setCommandHighlight(idx)}
                          onClick={() => runPaletteAction(a)}
                        >
                          <span className="claude-chat-cmd-label">{a.label}</span>
                          {a.desc && <span className="claude-chat-cmd-desc">{a.desc}</span>}
                        </div>
                      );
                    });
                    return rows;
                  })()}
                </div>
              </div>
            )}
          </div>
          <select
            className="claude-chat-perm-select"
            value={model}
            onChange={e => setModel(e.target.value)}
            title="모델 선택"
          >
            <option value="default">🧠 기본 모델</option>
            <option value="opus">🟣 Opus (최고 성능)</option>
            <option value="sonnet">🔵 Sonnet (균형)</option>
            <option value="haiku">⚡ Haiku (빠름)</option>
            <option value="opusplan">🎯 Opus Plan (계획 Opus)</option>
          </select>
          <label className="claude-chat-tool-approval-label" title="각 Bash/Edit/Write 툴 호출마다 승인 요청">
            <input type="checkbox" checked={perToolApproval} onChange={e => setPerToolApproval(e.target.checked)} />
            툴별 승인
          </label>
          <select
            className="claude-chat-perm-select"
            value={permissionMode}
            onChange={e => setPermissionMode(e.target.value as any)}
            title="권한 모드 — 편집 전 확인(기본)은 계획을 먼저 보여주고, '실행' 또는 '진행' 등으로 답하면 실행합니다"
          >
            <option value="default">🖐 편집 전 확인 (계획 → 승인)</option>
            <option value="acceptEdits">✏️ 편집 자동 수락</option>
            <option value="plan">🗺 계획 모드 (실행 X)</option>
            <option value="bypassPermissions">⚡ 자동 모드 (모두 허용)</option>
          </select>
        </div>
        <textarea
          className="claude-chat-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="질문을 입력하세요 (Shift+Enter 줄바꿈)"
          rows={3}
          disabled={streaming}
        />
        <div className="claude-chat-input-actions">
          {streaming ? (
            <button className="claude-chat-btn stop" onClick={stop}>중단</button>
          ) : (
            <button className="claude-chat-btn send" onClick={handleSend} disabled={!input.trim()}>전송 (Enter)</button>
          )}
        </div>
      </div>
      {msgCtxMenu && (() => {
        const idx = messages.findIndex(m => m.id === msgCtxMenu.msgId);
        const copyPlain = () => {
          // marked 로 HTML 변환 후 텍스트만 추출
          try {
            const html = marked.parse(msgCtxMenu.content, { breaks: true }) as string;
            const tmp = document.createElement('div');
            tmp.innerHTML = html;
            const text = tmp.textContent || tmp.innerText || msgCtxMenu.content;
            navigator.clipboard.writeText(text);
          } catch {
            navigator.clipboard.writeText(msgCtxMenu.content);
          }
          setMsgCtxMenu(null);
        };
        const copyMarkdown = () => {
          navigator.clipboard.writeText(msgCtxMenu.content);
          setMsgCtxMenu(null);
        };
        const attachAsContext = () => {
          const block = `이전 메시지 컨텍스트:\n\n${msgCtxMenu.content}\n\n---\n\n`;
          setInput(prev => block + prev);
          setMsgCtxMenu(null);
        };
        const forkHere = () => {
          if (idx < 0) { setMsgCtxMenu(null); return; }
          const upTo = messages.slice(0, idx + 1);
          // 우클릭한 메시지의 seq 까지의 toolTimeline 도 복사 — 시각적 연속성 유지
          const cutSeq = messages[idx].seq ?? Number.MAX_SAFE_INTEGER;
          const upToTools = toolTimeline.filter(t => (t.seq ?? Number.MAX_SAFE_INTEGER) <= cutSeq);
          const newId = `hist-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const sourceTitle = chatHistory.find(h => h.id === activeHistoryId)?.title || '대화';
          const newHist: ChatHistoryEntry = {
            id: newId,
            claudeSessionId: null, // 새 fork — Claude resume 끊고 새 컨텍스트 (대화 분기)
            title: `🍴 ${sourceTitle}`,
            pinned: false,
            updatedAt: Date.now(),
            messages: upTo,
            toolTimeline: upToTools,
          };
          setChatHistory(h => [newHist, ...h]);
          // 새 fork 로 전환
          setMessages(upTo);
          bumpSeqFor(upTo, upToTools);
          claudeSessionIdRef.current = null;
          // 누적된 로컬 Windows 경로 클리어 — 원격 SSH 작업 시 로컬 경로 우선시되는 것 방지
          recentLocalPathsRef.current.clear();
          setActiveHist(newId);
          setToolTimeline(upToTools);
          setStreaming(false);
          setActivity('');
          setPendingPlan(null);
          activeRequestIdRef.current = null;
          currentAsstIdRef.current = null;
          setMsgCtxMenu(null);
        };
        return (
          <div
            className="claude-chat-msg-ctx-menu"
            style={{ left: msgCtxMenu.x, top: msgCtxMenu.y }}
            onContextMenu={e => e.preventDefault()}
            onClick={e => e.stopPropagation()}
          >
            <div className="claude-chat-msg-ctx-item" onClick={copyPlain}>메시지 복사</div>
            <div className="claude-chat-msg-ctx-item" onClick={copyMarkdown}>마크다운으로 복사</div>
            <div className="claude-chat-msg-ctx-item" onClick={attachAsContext}>메시지를 컨텍스트로 첨부</div>
            <div className="claude-chat-msg-ctx-sep" />
            <div className="claude-chat-msg-ctx-item" onClick={forkHere}>여기서 포크하기</div>
          </div>
        );
      })()}
    </div>
  );
};

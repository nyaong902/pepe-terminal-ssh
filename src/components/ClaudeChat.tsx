// src/components/ClaudeChat.tsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { marked } from 'marked';

type Message = {
  role: 'user' | 'assistant';
  content: string;
  id: string;
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
  const [toolTimeline, setToolTimeline] = useState<{ id: string; label: string; status: 'running' | 'done' | 'error'; resultPreview?: string }[]>([]);
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
  const currentAsstIdRef = useRef<string | null>(null);

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
      const msg = p.message;
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
              next.push({ id: t.id, label: `🔧 ${t.name}(${args}${args.length >= 120 ? '…' : ''})`, status: 'running' });
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
            return [...prev, { role: 'assistant', content: texts, id: msgId }];
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
      } else if (msg.type === 'result') {
        setStreaming(false);
        setActivity('');
        currentAsstIdRef.current = null;
      } else if (msg.type === 'done') {
        setStreaming(false);
        setActivity('');
        currentAsstIdRef.current = null;
      } else if (msg.type === 'error') {
        setMessages(prev => [...prev, { role: 'assistant', content: `❌ ${msg.text}`, id: `err-${Date.now()}` }]);
        setStreaming(false);
      } else if (msg.type === 'text' && msg.text) {
        setMessages(prev => {
          const asstId = currentAsstIdRef.current;
          if (asstId) return prev.map(m => m.id === asstId ? { ...m, content: m.content + msg.text } : m);
          const newId = `asst-${Date.now()}`;
          currentAsstIdRef.current = newId;
          return [...prev, { role: 'assistant', content: msg.text, id: newId }];
        });
      }
    });
    return () => { if (dispose) dispose(); };
  }, [sessionId]);

  // 자동 스크롤
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const send = useCallback(async (text: string, contextItems: FileContextItem[]) => {
    if (!text.trim() || streaming) return;
    let prompt = text;
    let attachBadge = '';
    const addDirsSet = new Set<string>();
    const contextLines: string[] = [];

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

    if (contextLines.length > 0) {
      prompt = `${contextLines.join('\n')}\n\n---\n\n${text}`;
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

    const userMsg: Message = { role: 'user', content: attachBadge + text, id: `user-${Date.now()}` };
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
      await (window as any).api?.claudeSend?.(sessionId, prompt, addDirs, disallowBash, sshTermId, resumeSessionId, effectivePermMode, model, perToolApproval);
    } catch (err: any) {
      setMessages(prev => [...prev, { role: 'assistant', content: `❌ ${err}`, id: `err-${Date.now()}` }]);
      setStreaming(false);
    }
  }, [sessionId, streaming, mountEntries, activeMount, localFileAttachments, permissionMode, model, perToolApproval]);

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
    (window as any).api?.claudeStop?.(sessionId);
    setStreaming(false);
  };

  const clear = () => {
    setMessages([]);
    setToolTimeline([]);
    setActivity('');
    setPendingPlan(null);
    claudeSessionIdRef.current = null;
    recentLocalPathsRef.current.clear();
  };

  // 계획 승인 — "진행해줘" 메시지로 bypass 모드 send 자동 실행
  const approvePlan = () => {
    setPendingPlan(null);
    // 사용자 메시지로 "위 계획대로 진행해줘" 를 send — default 모드면 approval 키워드 → bypass 로 자동 전환
    send('위 계획대로 진행해줘', []);
  };
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
      setMessages(prev => [...prev, { role: 'assistant', content: `❌ 첨부할 텍스트 파일이 없습니다 (${skipped.length}개 제외). 자세한 내용은 DevTools Console 확인.`, id: `err-${Date.now()}` }]);
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
              dangerouslySetInnerHTML={{ __html: marked.parse(pendingPlan, { breaks: true }) as string }}
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
      <div className="claude-chat-messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="claude-chat-empty">
            <p>Claude에게 질문하세요.</p>
            <p>에디터의 "🤖 Claude" 버튼이나, 파일 트리에서 파일/폴더를 우클릭 → "Claude에 첨부"로 컨텍스트를 전달할 수 있습니다.</p>
          </div>
        )}
        {messages.map(m => (
          <div key={m.id} className={`claude-chat-msg ${m.role}`}>
            <div className="claude-chat-msg-role">{m.role === 'user' ? '👤 You' : '🤖 Claude'}</div>
            <div
              className="claude-chat-msg-content"
              dangerouslySetInnerHTML={{ __html: marked.parse(m.content, { breaks: true }) as string }}
            />
          </div>
        ))}
        {toolTimeline.length > 0 && (
          <div className="claude-chat-timeline">
            {toolTimeline.map(t => (
              <div key={t.id} className={`claude-chat-timeline-item ${t.status}`}>
                <span className="claude-chat-timeline-status">
                  {t.status === 'running' ? '⏳' : t.status === 'done' ? '✓' : '✕'}
                </span>
                <span className="claude-chat-timeline-label" title={t.label}>{t.label}</span>
                {t.resultPreview && <span className="claude-chat-timeline-preview" title={t.resultPreview}>→ {t.resultPreview}</span>}
              </div>
            ))}
          </div>
        )}
        {streaming && (
          <div className="claude-chat-streaming">
            <span className="claude-chat-streaming-dots">●●●</span>
            <span className="claude-chat-streaming-activity">{activity || '응답 대기 중...'}</span>
          </div>
        )}
      </div>
      <div className="claude-chat-input-area">
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
    </div>
  );
};

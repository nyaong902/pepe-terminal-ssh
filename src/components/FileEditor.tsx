// src/components/FileEditor.tsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import Editor, { OnMount } from '@monaco-editor/react';

type Props = {
  termId: string;
  remotePath: string;
  fileName: string;
  onDirtyChange?: (dirty: boolean) => void;
  onAnalyzeWithClaude?: (ctx: { fileName: string; remotePath: string; content: string }) => void;
};

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

// 확장자 → Monaco 언어
function detectLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
    c: 'c', cc: 'cpp', cpp: 'cpp', h: 'c', hpp: 'cpp',
    cs: 'csharp', swift: 'swift', kt: 'kotlin', scala: 'scala',
    sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
    ps1: 'powershell', psm1: 'powershell',
    json: 'json', xml: 'xml', yaml: 'yaml', yml: 'yaml', toml: 'ini',
    html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
    md: 'markdown', markdown: 'markdown',
    sql: 'sql', graphql: 'graphql',
    dockerfile: 'dockerfile',
    conf: 'ini', ini: 'ini', cfg: 'ini',
    log: 'plaintext', txt: 'plaintext',
    php: 'php', lua: 'lua', r: 'r', pl: 'perl',
    vue: 'html', svelte: 'html',
  };
  return map[ext] || 'plaintext';
}

// 바이너리 파일 감지
const BINARY_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'zip', 'gz', 'tar', 'bz2', '7z', 'rar', 'exe', 'dll', 'so', 'dylib', 'bin', 'pdf', 'mp3', 'mp4', 'avi', 'mkv', 'wav', 'flac', 'ogg']);
function isBinaryFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return BINARY_EXT.has(ext);
}

export const FileEditor: React.FC<Props> = ({ termId, remotePath, fileName, onDirtyChange, onAnalyzeWithClaude }) => {
  const [content, setContent] = useState<string>('');
  const [originalContent, setOriginalContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
  const editorRef = useRef<any>(null);

  const dirty = content !== originalContent;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const [encoding, setEncoding] = useState<string>('utf-8');

  // 파일 로드
  useEffect(() => {
    if (isBinaryFile(fileName)) {
      setError('바이너리 파일은 편집할 수 없습니다.');
      setLoading(false);
      return;
    }
    (async () => {
      try {
        setLoading(true);
        // 세션 encoding 조회
        let enc = 'utf-8';
        try {
          const sessEnc = await (window as any).api?.getSSHEncoding?.(termId);
          if (sessEnc && typeof sessEnc === 'string') enc = sessEnc;
        } catch {}
        setEncoding(enc);
        const result = await (window as any).api?.sftpReadFile?.(termId, remotePath, enc);
        if (!result?.success) {
          setError(result?.error || '파일을 읽을 수 없습니다.');
          setLoading(false);
          return;
        }
        if (result.size > MAX_FILE_SIZE) {
          setError(`파일이 너무 큽니다 (${(result.size / 1024 / 1024).toFixed(1)}MB > 5MB).`);
          setLoading(false);
          return;
        }
        const text = result.text || '';
        setContent(text);
        setOriginalContent(text);
        setLoading(false);
      } catch (err: any) {
        setError(String(err));
        setLoading(false);
      }
    })();
  }, [termId, remotePath, fileName]);

  const save = useCallback(async () => {
    if (saving || !dirty) return;
    setSaving(true);
    try {
      const result = await (window as any).api?.sftpWriteFile?.(termId, remotePath, content, encoding);
      if (result?.success) {
        setOriginalContent(content);
        setNotice({ text: '저장됨', kind: 'ok' });
        setTimeout(() => setNotice(null), 2000);
      } else {
        setNotice({ text: `저장 실패: ${result?.error || '알 수 없는 오류'}`, kind: 'err' });
        setTimeout(() => setNotice(null), 4000);
      }
    } catch (err: any) {
      setNotice({ text: `저장 실패: ${err}`, kind: 'err' });
      setTimeout(() => setNotice(null), 4000);
    }
    setSaving(false);
  }, [saving, dirty, termId, remotePath, content]);

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    // Ctrl+S 저장
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { save(); });
  };

  if (loading) return <div className="file-editor-loading">파일을 불러오는 중...</div>;
  if (error) return <div className="file-editor-error">⚠ {error}</div>;

  return (
    <div className="file-editor">
      <div className="file-editor-header">
        <span className="file-editor-path">{remotePath}</span>
        {dirty && <span className="file-editor-dirty">●</span>}
        {onAnalyzeWithClaude && (
          <button className="file-editor-claude" onClick={() => onAnalyzeWithClaude({ fileName, remotePath, content })} title="Claude로 분석">
            🤖 Claude
          </button>
        )}
        <button className="file-editor-save" onClick={save} disabled={!dirty || saving}>
          {saving ? '저장 중...' : '저장 (Ctrl+S)'}
        </button>
        {notice && <span className={`file-editor-notice ${notice.kind}`}>{notice.text}</span>}
      </div>
      <div className="file-editor-body">
        <Editor
          height="100%"
          theme="vs-dark"
          language={detectLanguage(fileName)}
          value={content}
          onChange={v => setContent(v ?? '')}
          onMount={handleEditorMount}
          options={{
            automaticLayout: true,
            fontSize: 13,
            minimap: { enabled: true },
            scrollBeyondLastLine: false,
            wordWrap: 'on',
          }}
        />
      </div>
    </div>
  );
};

// Claude 채팅 전용 폰트/크기 — 터미널과 독립 관리.
// localStorage 에 저장 + :root CSS 변수 (--claude-font-family, --claude-font-size) 갱신.
// 변경 시 'claude-font-changed' 커스텀 이벤트 디스패치 → UI 리렌더링 동기화용.

export const CLAUDE_FONT_SIZE_DEFAULT = 13;
const MIN_SIZE = 9;
const MAX_SIZE = 32;

export function getClaudeFontFamily(): string {
  return localStorage.getItem('claudeChatFontFamily') || '';
}

export function getClaudeFontSize(): number {
  const n = Number(localStorage.getItem('claudeChatFontSize'));
  return Number.isFinite(n) && n > 0 ? n : CLAUDE_FONT_SIZE_DEFAULT;
}

export function applyClaudeFontVars() {
  const ff = getClaudeFontFamily();
  const fs = getClaudeFontSize();
  const root = document.documentElement;
  if (ff) root.style.setProperty('--claude-font-family', ff);
  else root.style.removeProperty('--claude-font-family');
  root.style.setProperty('--claude-font-size', `${fs}px`);
}

export function setClaudeFontFamily(ff: string) {
  if (ff) localStorage.setItem('claudeChatFontFamily', ff);
  else localStorage.removeItem('claudeChatFontFamily');
  applyClaudeFontVars();
  window.dispatchEvent(new Event('claude-font-changed'));
}

export function setClaudeFontSize(fs: number) {
  const clamped = Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(fs)));
  localStorage.setItem('claudeChatFontSize', String(clamped));
  applyClaudeFontVars();
  window.dispatchEvent(new Event('claude-font-changed'));
}

export function adjustClaudeFontSize(delta: number) {
  setClaudeFontSize(getClaudeFontSize() + delta);
}

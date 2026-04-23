// Default keybindings map
export const DEFAULT_KEYBINDINGS: Record<string, string> = {
  'fullscreen': 'Alt+Enter',
  'splitSessionH': 'Alt+Shift+H',
  'splitSessionV': 'Alt+Shift+V',
  'nextTab': 'Ctrl+Tab',
  'prevTab': 'Ctrl+Shift+Tab',
  'cloneSplitH': 'Ctrl+Shift+H',
  'cloneSplitV': 'Ctrl+Shift+V',
  'find': 'Ctrl+Shift+F',
  'clearScrollback': 'Ctrl+Shift+B',
  'clearScreen': 'Ctrl+Shift+L',
  'clearAll': 'Ctrl+Shift+A',
  'toggleFileTree': 'Ctrl+Shift+E',
};

// Action labels for UI
export const KEYBINDING_LABELS: Record<string, string> = {
  'fullscreen': '전체화면 토글',
  'splitSessionH': '연결된 세션 가로 분할',
  'splitSessionV': '연결된 세션 세로 분할',
  'nextTab': '다음 미니탭',
  'prevTab': '이전 미니탭',
  'cloneSplitH': '세션 복제 가로 분할',
  'cloneSplitV': '세션 복제 세로 분할',
  'find': '찾기',
  'clearScrollback': '스크롤백 지우기',
  'clearScreen': '화면 지우기',
  'clearAll': '전체 지우기',
  'toggleFileTree': '파일 트리 토글',
};

// Current keybindings (merged with defaults)
let currentKeybindings: Record<string, string> = { ...DEFAULT_KEYBINDINGS };

// 단축키 변경 중 플래그 (글로벌 핸들러/TerminalPanel에서 참조)
let isListeningMode = false;
export function setKeybindingListening(v: boolean) { isListeningMode = v; }
export function isKeybindingListening(): boolean { return isListeningMode; }

export function loadKeybindings(saved: Record<string, string> | undefined) {
  currentKeybindings = { ...DEFAULT_KEYBINDINGS, ...(saved || {}) };
}

export function getKeybindings(): Record<string, string> {
  return currentKeybindings;
}

export function getKeybinding(actionId: string): string {
  return currentKeybindings[actionId] || DEFAULT_KEYBINDINGS[actionId] || '';
}

// Convert KeyboardEvent to combo string like "Ctrl+Shift+F"
export function keyEventToCombo(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');

  // Normalize key code to readable name — modifier 키 자체는 무시
  if (/^(Control|Alt|Shift|Meta)(Left|Right)?$/.test(e.code)) {
    // modifier 키만 누른 상태 — 아직 조합 키가 아님
    return parts.join('+');
  }
  const key = normalizeKeyCode(e.code, e.key);
  if (key) parts.push(key);
  return parts.join('+');
}

function normalizeKeyCode(code: string, key: string): string {
  // Special keys
  if (code === 'Enter' || code === 'NumpadEnter') return 'Enter';
  if (code === 'Tab') return 'Tab';
  if (code === 'Escape') return 'Escape';
  if (code === 'Space') return 'Space';
  if (code === 'Backspace') return 'Backspace';
  if (code === 'Delete') return 'Delete';
  if (code === 'ArrowUp') return 'Up';
  if (code === 'ArrowDown') return 'Down';
  if (code === 'ArrowLeft') return 'Left';
  if (code === 'ArrowRight') return 'Right';
  if (code === 'Backslash') return '\\';
  // Letter keys
  if (code.startsWith('Key')) return code.slice(3);
  // Digit keys
  if (code.startsWith('Digit')) return code.slice(5);
  // F keys
  if (code.startsWith('F') && /^F\d+$/.test(code)) return code;
  return key || code;
}

// Check if a KeyboardEvent matches a combo string
export function matchKeybinding(e: KeyboardEvent, actionId: string): boolean {
  const combo = getKeybinding(actionId);
  if (!combo) return false;
  return keyEventToCombo(e) === combo;
}

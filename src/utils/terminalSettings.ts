// src/utils/terminalSettings.ts

export type TerminalSettings = {
  autoCopyOnSelect: boolean;
  includeTrailingNewline: boolean;
  trimTrailingWhitespace: boolean;
  multiLinePaste: 'dialog' | 'direct';
  scrollback: number;
};

const DEFAULTS: TerminalSettings = {
  autoCopyOnSelect: true,
  includeTrailingNewline: false,
  trimTrailingWhitespace: true,
  multiLinePaste: 'dialog',
  scrollback: 10000,
};

let cached: TerminalSettings | null = null;

export function getTerminalSettings(): TerminalSettings {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem('terminalSettings');
    if (raw) { cached = { ...DEFAULTS, ...JSON.parse(raw) }; return cached!; }
  } catch {}
  cached = { ...DEFAULTS };
  return cached;
}

export function saveTerminalSettings(s: TerminalSettings) {
  cached = { ...s };
  localStorage.setItem('terminalSettings', JSON.stringify(s));
}

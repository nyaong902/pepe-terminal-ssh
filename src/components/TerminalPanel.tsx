// src/components/TerminalPanel.tsx
import React, { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import type { Panel, PanelSession } from '../utils/layoutUtils';
import { ContextMenu } from './ContextMenu';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { SearchAddon } from 'xterm-addon-search';
import { Unicode11Addon } from 'xterm-addon-unicode11';
import { getThemeByName } from '../utils/terminalThemes';
import { getTerminalSettings } from '../utils/terminalSettings';
import { matchKeybinding, isKeybindingListening } from '../utils/keybindings';
import 'xterm/css/xterm.css';

// ── 모듈 레벨: 컴포넌트 lifecycle과 독립 ──

let currentThemeName = localStorage.getItem('terminalTheme') || 'Default Dark';
const defaultFontSize = Number(localStorage.getItem('terminalFontSize')) || 14;
const termOpacity: Map<string, number> = new Map();
const termThemeCache: Map<string, string> = new Map(); // termId → 적용된 테마 이름
function applyTermOpacity(termId: string, containerEl?: HTMLElement | null) {
  const opacity = termOpacity.get(termId) ?? 1.0;
  const entry = termStore.get(termId);
  const themeName = termThemeCache.get(termId) || currentThemeName;
  const theme = getThemeByName(themeName) as any;
  const themeBg = theme?.background || '#000000';

  if (entry) {
    if (opacity >= 1) {
      entry.term.options.theme = { ...theme } as any;
    } else {
      const hex6 = themeBg.startsWith('#') && themeBg.length === 7 ? themeBg.slice(1) : '000000';
      const a = Math.round(opacity * 255).toString(16).padStart(2, '0');
      entry.term.options.theme = { ...theme, background: `#${hex6}${a}` } as any;
    }
  }
  if (containerEl) {
    containerEl.style.background = opacity >= 1 ? themeBg : 'transparent';
  }
  // 하나라도 투명한 터미널이 있으면 전체 투명 모드 CSS 클래스 토글
  const anyTransparent = [...termOpacity.values()].some(v => v < 1);
  document.documentElement.classList.toggle('term-transparent-active', anyTransparent);
}
const DEFAULT_WORD_SEPARATORS = ' ./\\()"\'-:,.;<>~!@#$%^&*|+=[]{}`~?';
let currentWordSeparator = localStorage.getItem('terminalWordSeparator') ?? DEFAULT_WORD_SEPARATORS;
// termId별 폰트 크기
const termFontSizes: Map<string, number> = new Map();

const termStore: Map<string, { term: Terminal; fit: FitAddon; search: SearchAddon }> = new Map();
const sshInitialized = new Set<string>();
const globalConnected = new Set<string>();
const connectedListeners = new Set<() => void>();
// IME 조합 상태: 조합 중에는 onData를 건너뛰고, 완료 시 최종 텍스트를 1회 전송
const termIMEComposing: Map<string, boolean> = new Map();
// 조합 완료 직후 xterm이 동일 문자열로 onData를 한 번 더 발화할 수 있어 중복 차단용
const termJustComposed: Map<string, { text: string; at: number }> = new Map();

function notifyConnectedChange() { connectedListeners.forEach(fn => fn()); }

export function isTermConnected(termId: string): boolean {
  return globalConnected.has(termId);
}

export function subscribeConnectedChange(fn: () => void): () => void {
  connectedListeners.add(fn);
  return () => { connectedListeners.delete(fn); };
}

let fontOsdTimer: ReturnType<typeof setTimeout> | null = null;
let fontOsdEl: HTMLDivElement | null = null;


function showFontSizeOSD(parent: HTMLElement, size: number) {
  if (fontOsdTimer) clearTimeout(fontOsdTimer);
  if (!fontOsdEl) {
    fontOsdEl = document.createElement('div');
    fontOsdEl.className = 'font-size-osd';
    document.body.appendChild(fontOsdEl);
  }
  fontOsdEl.textContent = `${size}pt`;
  fontOsdEl.style.display = 'flex';
  fontOsdEl.style.opacity = '1';
  // 위치: 화면 중앙
  const rect = parent.getBoundingClientRect();
  fontOsdEl.style.top = `${rect.top + rect.height / 2 - 25}px`;
  fontOsdEl.style.left = `${rect.left + rect.width / 2 - 40}px`;
  fontOsdTimer = setTimeout(() => {
    if (fontOsdEl) { fontOsdEl.style.opacity = '0'; }
    fontOsdTimer = setTimeout(() => {
      if (fontOsdEl) fontOsdEl.style.display = 'none';
    }, 300);
  }, 800);
}

function getOrCreateTerm(termId: string): { term: Terminal; fit: FitAddon; search: SearchAddon } {
  let entry = termStore.get(termId);
  if (!entry) {
    // 세션 복제 등으로 미리 설정된 값이 있으면 우선 적용
    const initThemeName = termThemeCache.get(termId) || currentThemeName;
    const initFontSize = termFontSizes.get(termId) ?? defaultFontSize;
    const initScrollback = termScrollbackOverride.get(termId) ?? getTerminalSettings().scrollback;
    const savedFont = localStorage.getItem('terminalFontFamily') || '';
    const term = new Terminal({
      cursorBlink: true,
      fontSize: initFontSize,
      fontFamily: savedFont || "'Cascadia Mono', Consolas, monospace",
      theme: getThemeByName(initThemeName) as any,
      allowProposedApi: true,
      allowTransparency: true,
      customGlyphs: true,
      wordSeparator: currentWordSeparator,
      scrollback: initScrollback,
    });
    if (!termFontSizes.has(termId)) termFontSizes.set(termId, defaultFontSize);
    const fit = new FitAddon();
    const search = new SearchAddon();
    const unicode11 = new Unicode11Addon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(unicode11);
    term.unicode.activeVersion = '11';
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      // 단축키 변경 중이면 모든 키 통과
      if (isKeybindingListening()) return true;
      // Alt+1..9: 미니탭 전환 (앱 전역 핸들러로 위임) — 범위이므로 커스터마이즈 대상 아님
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code)) return false;
      // 전체화면 토글 (앱 전역 핸들러)
      if (matchKeybinding(e, 'fullscreen')) return false;
      // 미니탭 전환 (앱 전역 핸들러로 위임)
      if (matchKeybinding(e, 'nextTab') || matchKeybinding(e, 'prevTab')) return false;
      if (!(e.ctrlKey || e.metaKey)) return true;
      // Ctrl+L (Shift 없이): 커서 라인 위 내용을 스크롤 버퍼로 보존하며 밀어냄
      if (!e.shiftKey && e.code === 'KeyL') {
        const buf = term.buffer.active;
        const cursorY = buf.cursorY;
        const cursorX = buf.cursorX;
        if (cursorY > 0) {
          const rows = (term as any).rows || 24;
          // 커서 라인부터 아래의 현재 화면 내용 저장
          const lines: string[] = [];
          for (let r = cursorY; r < rows; r++) {
            const line = buf.getLine(buf.baseY + r);
            lines.push(line ? line.translateToString(true) : '');
          }
          // 화면을 빈 줄로 밀어서 전체 화면을 스크롤 버퍼로
          term.write('\r\n'.repeat(rows));
          // 커서를 맨 위로 이동 + 화면 클리어
          term.write('\x1b[H\x1b[2J');
          // 저장한 내용을 다시 출력
          for (let i = 0; i < lines.length; i++) {
            if (i > 0) term.write('\r\n');
            term.write(lines[i]);
          }
          // 커서를 원래 X 위치로
          term.write(`\x1b[1;${cursorX + 1}H`);
        }
        return false;
      }
      // 찾기/클리어 관련 단축키를 터미널에서 가로채지 않고 앱으로 전달
      if (matchKeybinding(e, 'find') || matchKeybinding(e, 'clearScrollback') || matchKeybinding(e, 'clearScreen') || matchKeybinding(e, 'clearAll')) return false;
      // 세션 복제 분할 단축키도 앱으로 전달
      if (matchKeybinding(e, 'cloneSplitH') || matchKeybinding(e, 'cloneSplitV')) return false;
      // 연결된 세션 분할 단축키도 앱으로 전달
      if (matchKeybinding(e, 'splitSessionH') || matchKeybinding(e, 'splitSessionV')) return false;
      if (!e.shiftKey) return true;
      return true;
    });
    // Ctrl+마우스휠로 폰트 크기 조절
    term.onRender(() => {
      const el = (term as any).element as HTMLElement | undefined;
      if (!el || (el as any).__zoomAttached) return;
      (el as any).__zoomAttached = true;
      el.addEventListener('wheel', (e: WheelEvent) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        // Ctrl+Wheel → 폰트 크기 조절
        const curSize = termFontSizes.get(termId) ?? defaultFontSize;
        const delta = e.deltaY < 0 ? 1 : -1;
        const newSize = Math.max(8, Math.min(40, curSize + delta));
        if (newSize === curSize) return;
        termFontSizes.set(termId, newSize);
        term.options.fontSize = newSize;
        try {
          fit.fit();
          const c = (term as any).cols || 80;
          const r = (term as any).rows || 24;
          if (ptyConnected.has(termId)) {
            (window as any).api?.ptyResize?.(termId, c, r);
          } else {
            (window as any).api?.resizeSSH?.(termId, c, r);
          }
        } catch {}
        showFontSizeOSD(el, newSize);
      }, { passive: false });
      // 빈 셀 더블클릭 시 해당 줄 전체 선택
      el.addEventListener('dblclick', (e: MouseEvent) => {
        const screen = el.querySelector('.xterm-screen') as HTMLElement;
        if (!screen) return;
        const rect = screen.getBoundingClientRect();
        const cols = (term as any).cols || 80;
        const rows = (term as any).rows || 24;
        const cellW = rect.width / cols;
        const cellH = rect.height / rows;
        const col = Math.floor((e.clientX - rect.left) / cellW);
        const row = Math.floor((e.clientY - rect.top) / cellH);
        const buf = term.buffer.active;
        const vp = el.querySelector('.xterm-viewport') as HTMLElement;
        const scrollRow = vp ? Math.round(vp.scrollTop / cellH) : 0;
        const bufRow = scrollRow + row;
        const line = buf.getLine(bufRow);
        if (!line) return;
        const text = line.translateToString(true);
        if (col >= text.length && text.length > 0) {
          // 빈 영역 더블클릭 → 줄 전체 선택
          term.select(0, bufRow, text.length);
        }
      });
      // Ctrl+V / 브라우저 paste 가로채기 — 여러 줄 붙여넣기 다이얼로그
      el.addEventListener('paste', (e: ClipboardEvent) => {
        const text = e.clipboardData?.getData('text');
        if (text && text.includes('\n')) {
          const settings = getTerminalSettings();
          if (settings.multiLinePaste === 'dialog') {
            e.preventDefault();
            e.stopPropagation();
            el.dispatchEvent(new CustomEvent('term-multi-paste', { detail: { termId, text }, bubbles: true }));
          }
        }
      }, true);
      // 우클릭 → 컨텍스트 메뉴 이벤트 발행 (컴포넌트에서 처리)
      el.addEventListener('contextmenu', (e: MouseEvent) => {
        e.preventDefault();
        el.dispatchEvent(new CustomEvent('term-contextmenu', { detail: { x: e.clientX, y: e.clientY }, bubbles: true }));
      });
    });
    // 선택 시 자동 클립보드 복사 (설정에 따라)
    term.onSelectionChange(() => {
      const settings = getTerminalSettings();
      if (!settings.autoCopyOnSelect) return;
      let sel = term.getSelection();
      if (!sel) return;
      if (settings.trimTrailingWhitespace) sel = sel.split('\n').map(l => l.trimEnd()).join('\n');
      if (!settings.includeTrailingNewline) sel = sel.replace(/\n$/, '');
      navigator.clipboard.writeText(sel).catch(() => {});
      window.dispatchEvent(new CustomEvent('status-copy', { detail: { charCount: sel.length, lineCount: sel.split('\n').length } }));
    });
    entry = { term, fit, search };
    termStore.set(termId, entry);
  }
  return entry;
}

// ── 검색 헬퍼 (외부에서 사용) ──

// DOM 기반 하이라이트 오버레이
const highlightOverlays: Map<string, HTMLDivElement> = new Map();

function getHighlightContainer(termId: string): HTMLDivElement | null {
  let container = highlightOverlays.get(termId);
  if (container && container.parentElement) return container;
  const entry = termStore.get(termId);
  if (!entry) return null;
  const xtermEl = (entry.term as any).element as HTMLElement | undefined;
  if (!xtermEl) return null;
  // panel-terminal-area (xterm의 부모)에 오버레이 삽입
  const termArea = xtermEl.closest('.panel-terminal-area') as HTMLElement;
  if (!termArea) return null;
  termArea.style.position = 'relative';
  container = document.createElement('div');
  container.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none;z-index:100;overflow:hidden;';
  termArea.appendChild(container);
  highlightOverlays.set(termId, container);
  return container;
}

function renderHighlightOverlay(termId: string, query: string, regex: boolean, caseSensitive = false) {
  const container = getHighlightContainer(termId);
  if (container) container.innerHTML = '';
  if (!container || !query) return;

  const entry = termStore.get(termId);
  if (!entry) return;
  const term = entry.term;
  const buf = term.buffer.active;

  let re: RegExp;
  try {
    const flags = caseSensitive ? 'g' : 'gi';
    re = regex ? new RegExp(query, flags) : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  } catch { return; }

  // 셀 크기 계산 — xterm 내부 _core._renderService.dimensions 에서 정확한 값 추출,
  // 없으면 screen 크기 기반 fallback
  const xtermEl = (term as any).element as HTMLElement | undefined;
  if (!xtermEl) return;
  const screen = xtermEl.querySelector('.xterm-screen') as HTMLElement;
  if (!screen) return;
  const rows = (term as any).rows || 24;
  const cols = (term as any).cols || 80;

  const dims = (term as any)._core?._renderService?.dimensions;
  const cellW = dims?.css?.cell?.width || (screen.offsetWidth / cols);
  const cellH = dims?.css?.cell?.height || (screen.offsetHeight / rows);
  if (cellW <= 0 || cellH <= 0) return;

  // xterm-screen 의 실제 좌상단 오프셋 (패딩 보정)
  const containerRect = container.parentElement!.getBoundingClientRect();
  const screenRect = screen.getBoundingClientRect();
  const offsetLeft = screenRect.left - containerRect.left;
  const offsetTop = screenRect.top - containerRect.top;

  // 뷰포트 시작: scrollTop 기반
  const viewport = xtermEl.querySelector('.xterm-viewport') as HTMLElement;
  const scrollTop = viewport ? viewport.scrollTop : 0;
  const vStart = Math.max(0, Math.round(scrollTop / cellH));

  for (let row = 0; row < rows; row++) {
    const bufLine = buf.getLine(vStart + row);
    if (!bufLine) continue;
    const text = bufLine.translateToString();

    // charIndex → cellColumn 매핑 (한글 등 wide char 보정)
    const charToCell: number[] = [];
    let cellCol = 0;
    for (let ci = 0; ci < bufLine.length; ci++) {
      const cell = bufLine.getCell(ci);
      if (!cell) break;
      const ch = cell.getChars();
      if (ch === '') continue; // wide char의 두 번째 셀은 건너뜀
      charToCell.push(cellCol);
      const w = cell.getWidth();
      cellCol += w || 1;
    }

    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      if (match[0].length === 0) { re.lastIndex++; continue; }
      const startCell = charToCell[match.index] ?? match.index;
      const endCharIdx = match.index + match[0].length;
      const endCell = endCharIdx < charToCell.length ? charToCell[endCharIdx] : (charToCell[charToCell.length - 1] ?? endCharIdx) + 1;
      const span = document.createElement('div');
      span.className = 'search-highlight-mark';
      span.style.cssText = `position:absolute;top:${offsetTop + row * cellH}px;left:${offsetLeft + startCell * cellW}px;width:${(endCell - startCell) * cellW}px;height:${cellH}px;`;
      container.appendChild(span);
    }
  }
}


export function applyThemeToAll(themeName: string) {
  currentThemeName = themeName;
  localStorage.setItem('terminalTheme', themeName);
  for (const [tid, entry] of termStore) {
    // 세션별 테마가 없는 터미널만 글로벌 테마 적용
    if (!termThemeCache.has(tid) || termThemeCache.get(tid) === currentThemeName) {
      termThemeCache.set(tid, themeName);
    }
    // 투명도가 적용된 상태면 테마+투명도 함께 반영
    const containerEl = (entry.term as any).element?.closest?.('.xterm-container') || null;
    applyTermOpacity(tid, containerEl);
  }
}

export function getCurrentThemeName(): string {
  return currentThemeName;
}

export function getWordSeparator(): string {
  return currentWordSeparator;
}

export function setWordSeparator(sep: string) {
  currentWordSeparator = sep;
  localStorage.setItem('terminalWordSeparator', sep);
  for (const [, entry] of termStore) {
    entry.term.options.wordSeparator = sep;
  }
}

export function applyScrollbackToAll(scrollback: number) {
  for (const [, entry] of termStore) {
    entry.term.options.scrollback = scrollback;
  }
}

// 특정 터미널에 스크롤백을 실시간으로 반영. 터미널이 아직 생성되지 않았다면
// 맵에 기록해 두고 getOrCreateTerm이 생성 시점에 참조하도록 한다.
const termScrollbackOverride: Map<string, number> = new Map();
export function applyScrollbackToTerm(termId: string, scrollback: number) {
  if (!scrollback) return;
  termScrollbackOverride.set(termId, scrollback);
  const entry = termStore.get(termId);
  if (entry) entry.term.options.scrollback = scrollback;
}
export function getScrollbackForTerm(termId: string): number {
  const entry = termStore.get(termId);
  return (entry?.term.options.scrollback as number) ?? termScrollbackOverride.get(termId) ?? getTerminalSettings().scrollback;
}

// 소스 터미널의 스타일(테마/폰트/불투명도/단어구분)을 대상 termId로 복사.
// 대상 터미널은 호출 이후 getOrCreateTerm/mount 시 이 값들을 적용받는다.
export function cloneTermStyle(srcTermId: string, dstTermId: string) {
  const srcEntry = termStore.get(srcTermId);
  // 테마
  const themeName = termThemeCache.get(srcTermId);
  if (themeName) termThemeCache.set(dstTermId, themeName);
  // 불투명도
  const op = termOpacity.get(srcTermId);
  if (op !== undefined) termOpacity.set(dstTermId, op);
  // 폰트 크기
  const fs = termFontSizes.get(srcTermId) ?? (srcEntry?.term.options.fontSize as number | undefined);
  if (fs !== undefined) termFontSizes.set(dstTermId, fs);
  // 스크롤백
  const sb = termScrollbackOverride.get(srcTermId) ?? (srcEntry?.term.options.scrollback as number | undefined);
  if (sb !== undefined) termScrollbackOverride.set(dstTermId, sb);
  // 대상 터미널이 이미 생성되어 있으면 즉시 반영
  const dstEntry = termStore.get(dstTermId);
  if (dstEntry && srcEntry) {
    if (themeName) {
      const theme = getThemeByName(themeName) as any;
      dstEntry.term.options.theme = { ...theme };
    }
    const ff = srcEntry.term.options.fontFamily as string | undefined;
    if (ff) dstEntry.term.options.fontFamily = ff;
    if (fs !== undefined) dstEntry.term.options.fontSize = fs;
    if (sb !== undefined) dstEntry.term.options.scrollback = sb;
    try { dstEntry.fit.fit(); } catch {}
  }
}

export function applyFontToAll(fontFamily?: string, fontSize?: number) {
  if (fontFamily) localStorage.setItem('terminalFontFamily', fontFamily);
  if (fontSize) localStorage.setItem('terminalFontSize', String(fontSize));
  for (const [tid, entry] of termStore) {
    if (fontFamily) entry.term.options.fontFamily = fontFamily;
    if (fontSize) { entry.term.options.fontSize = fontSize; termFontSizes.set(tid, fontSize); }
    try {
      entry.fit.fit();
      const c = (entry.term as any).cols;
      const r = (entry.term as any).rows;
      if (ptyConnected.has(tid)) {
        (window as any).api?.ptyResize?.(tid, c, r);
      } else {
        (window as any).api?.resizeSSH?.(tid, c, r);
      }
    } catch {}
  }
}

// 드래그 중 PTY resize 억제 플래그 (분할 divider 드래그 동안 shell 재그리기 최소화)
let suppressPtyResize = false;
export function setSuppressPtyResize(v: boolean) { suppressPtyResize = v; }
export function isPtyResizeSuppressed() { return suppressPtyResize; }

export function refitAllTerms() {
  for (const [tid, entry] of termStore) {
    try {
      entry.fit.fit();
      const newCols = (entry.term as any).cols;
      const newRows = (entry.term as any).rows;
      if (ptyConnected.has(tid)) {
        (window as any).api?.ptyResize?.(tid, newCols, newRows);
      } else {
        (window as any).api?.resizeSSH?.(tid, newCols, newRows);
      }
    } catch {}
  }
}

export function getGlobalFontFamily(): string {
  return localStorage.getItem('terminalFontFamily') || '';
}

export function applyFontToTerm(termId: string, fontFamily?: string, fontSize?: number) {
  const entry = termStore.get(termId);
  if (!entry) return;
  if (fontFamily) entry.term.options.fontFamily = fontFamily;
  if (fontSize) { entry.term.options.fontSize = fontSize; termFontSizes.set(termId, fontSize); }
  try { entry.fit.fit(); } catch {}
}

export function applyThemeToTerm(termId: string, themeName: string) {
  const entry = termStore.get(termId);
  if (!entry) return;
  termThemeCache.set(termId, themeName);
  // 투명도가 적용된 상태면 테마+투명도 함께 반영
  const containerEl = (entry.term as any).element?.closest?.('.xterm-container') || null;
  applyTermOpacity(termId, containerEl);
}

export function clearHighlights(termId: string) {
  const container = highlightOverlays.get(termId);
  if (container) container.innerHTML = '';
  const cleanup = highlightListeners.get(termId);
  if (cleanup) { cleanup(); highlightListeners.delete(termId); }
}

// 활성 하이라이트 리스너 저장 (termId → cleanup 함수)
const highlightListeners: Map<string, () => void> = new Map();

export function highlightAllMatches(termId: string, query: string, regex: boolean, caseSensitive = false) {
  // 기존 리스너 정리
  const prevCleanup = highlightListeners.get(termId);
  if (prevCleanup) prevCleanup();

  renderHighlightOverlay(termId, query, regex, caseSensitive);

  const entry = termStore.get(termId);
  if (!entry) return;

  const handler = () => renderHighlightOverlay(termId, query, regex, caseSensitive);

  // 스크롤 시 갱신
  const xtermEl = (entry.term as any).element as HTMLElement | undefined;
  const viewport = xtermEl?.querySelector('.xterm-viewport');
  if (viewport) viewport.addEventListener('scroll', handler);

  // 새 데이터 수신 시 갱신 (debounce)
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  const onRenderDisp = entry.term.onRender(() => {
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(handler, 100);
  });

  // cleanup 함수 저장
  highlightListeners.set(termId, () => {
    if (viewport) viewport.removeEventListener('scroll', handler);
    onRenderDisp.dispose();
    if (renderTimer) clearTimeout(renderTimer);
  });
}

export function searchFromTop(termId: string, query: string, regex = false, caseSensitive = false): boolean {
  try {
    const entry = termStore.get(termId);
    if (!entry || !query) return false;
    entry.search.clearDecorations();
    // 선택 해제 → findNext가 버퍼 맨 위부터 검색
    entry.term.clearSelection();
    entry.term.scrollToTop();
    return entry.search.findNext(query, { regex, caseSensitive });
  } catch { return false; }
}

export function searchInTerm(termId: string, query: string, regex = false, caseSensitive = false): boolean {
  try {
    const entry = termStore.get(termId);
    if (!entry || !query) return false;
    entry.search.clearDecorations();
    return entry.search.findNext(query, { regex, caseSensitive });
  } catch { return false; }
}

export function searchNextInTerm(termId: string, query: string, regex = false, caseSensitive = false): boolean {
  try {
    const entry = termStore.get(termId);
    if (!entry || !query) return false;
    return entry.search.findNext(query, { regex, caseSensitive });
  } catch { return false; }
}

export function searchPrevInTerm(termId: string, query: string, regex = false, caseSensitive = false): boolean {
  try {
    const entry = termStore.get(termId);
    if (!entry || !query) return false;
    return entry.search.findPrevious(query, { regex, caseSensitive });
  } catch { return false; }
}

export function clearSearchInTerm(termId: string) {
  try {
    clearHighlights(termId);
    const entry = termStore.get(termId);
    if (entry) entry.search.clearDecorations();
  } catch {}
}

export function getAllTermIds(): string[] {
  return [...termStore.keys()];
}

// Ctrl+Shift+B: 현재 보이는 화면은 유지, 안 보이는 스크롤 버퍼만 삭제
export function clearScrollbackInTerm(termId: string) {
  try {
    const entry = termStore.get(termId);
    if (!entry) return;
    const term = entry.term;
    const savedScrollback = term.options.scrollback;
    term.options.scrollback = 0;
    term.options.scrollback = savedScrollback;
  } catch {}
}

// Ctrl+Shift+L: 현재 화면만 지우기 (스크롤 버퍼는 유지 — 빈 줄로 밀어냄)
export function clearScreenInTerm(termId: string) {
  try {
    const entry = termStore.get(termId);
    if (!entry) return;
    const term = entry.term;
    const rows = (term as any).rows || 24;
    term.write('\r\n'.repeat(rows));
    term.write('\x1b[H');
  } catch {}
}

// Ctrl+Shift+A: 현재 화면 + 스크롤 버퍼 모두 지우기
export function clearAllInTerm(termId: string) {
  try {
    const entry = termStore.get(termId);
    if (!entry) return;
    entry.term.clear();
  } catch {}
}

// 활성 비밀번호 프롬프트 추적 (중복 방지)
const activePasswordPrompt: Map<string, { dispose: () => void }> = new Map();

/** 비밀번호 미저장 세션: 터미널에서 비밀번호 입력 후 연결 */
export function promptPasswordAndConnect(termId: string, sessionId: string, cols?: number, rows?: number) {
  // 이미 프롬프트가 활성화 중이면 스킵
  if (activePasswordPrompt.has(termId)) return;

  const rec = termStore.get(termId);
  if (!rec) return;
  const { term } = rec;
  const c = cols ?? (term as any).cols ?? 80;
  const r = rows ?? (term as any).rows ?? 24;
  term.write('\x1b[93mPassword: \x1b[0m');
  let pwBuf = '';
  const cleanup = () => { disposable.dispose(); activePasswordPrompt.delete(termId); };
  const disposable = term.onData((data: string) => {
    if (data === '\r' || data === '\n') {
      cleanup();
      term.write('\r\n');
      termPasswordCache.set(termId, pwBuf);
      sshConnecting.add(termId);
      window.api?.connectSSHWithPassword?.(termId, sessionId, pwBuf, c, r);
    } else if (data === '\x7f' || data === '\b') {
      if (pwBuf.length > 0) { pwBuf = pwBuf.slice(0, -1); term.write('\b \b'); }
    } else if (data === '\x03') {
      cleanup();
      term.write('\r\n\x1b[90m취소\x1b[0m\r\n');
    } else {
      pwBuf += data;
      term.write('*');
    }
  });
  activePasswordPrompt.set(termId, { dispose: () => disposable.dispose() });
}

/** termId별로 SSH 리스너를 한 번만 설정 (컴포넌트 lifecycle 밖) */
function ensureSSHSetup(termId: string) {
  if (sshInitialized.has(termId)) return;
  sshInitialized.add(termId);

  const { term, fit } = getOrCreateTerm(termId);

  window.api?.onSSHConnected?.((p: any) => {
    if (p.panelId !== termId) return;
    // 같은 termId에 PTY가 실행 중이면 종료 (Local Shell → SSH 전환)
    if (ptyConnected.has(termId)) {
      window.api?.ptyKill?.(termId);
      ptyConnected.delete(termId);
      ptyInitialized.delete(termId);
      try { term.clear(); } catch {}
    }
    if (reconnectState.has(termId)) {
      console.warn('[ssh] connected event during active reconnect countdown', { termId, sshConnecting: sshConnecting.has(termId) });
    }
    globalConnected.add(termId);
    cancelReconnect(termId);
    reconnectUserCancelled.delete(termId);
    notifyConnectedChange();
    try { fit.fit(); } catch {}
    try {
      window.api?.resizeSSH?.(termId, (term as any).cols, (term as any).rows);
      setTimeout(() => { try { window.api?.resizeSSH?.(termId, (term as any).cols, (term as any).rows); } catch {} }, 200);
    } catch {}
  });

  window.api?.onSSHData?.((p: any) => {
    if (p.panelId !== termId) return;
    try { term.write(p.data); } catch {}
  });

  window.api?.onSSHClosed?.((p: any) => {
    if (p.panelId !== termId) return;
    console.log('[onSSHClosed]', termId, { globalConnected: globalConnected.has(termId), sshConnecting: sshConnecting.has(termId), reconnectUserCancelled: reconnectUserCancelled.has(termId) });
    // 이미 종료 처리 완료된 경우 (연결 상태 아닌데 close 중복) 무시
    if (!globalConnected.has(termId) && !sshConnecting.has(termId)) return;
    globalConnected.delete(termId);
    sshConnecting.delete(termId);
    notifyConnectedChange();
    try { term.write('\r\n\x1b[90m연결이 종료되었습니다.\x1b[0m\r\n'); } catch {}
    // 세션이 등록되어 있으면 재연결 카운트다운 시작
    if (termSessionMap.has(termId)) {
      startReconnectCountdown(termId);
    }
  });

  // SSH 에러를 터미널에 표시
  window.api?.onSSHError?.((p: any) => {
    if (p.panelId !== termId) return;
    console.log('[onSSHError]', termId, p.error);
    sshConnecting.delete(termId);
    globalConnected.delete(termId);
    notifyConnectedChange();
    try { term.write(`\r\n\x1b[91mSSH 오류: ${p.error || 'Unknown error'}\x1b[0m\r\n`); } catch {}
  });

  // 비밀번호 미저장 세션: keyboard-interactive 인증 프롬프트
  window.api?.onSSHAuthPrompt?.((p: any) => {
    if (p.panelId !== termId) return;
    const promptText = p.prompts?.[0] || 'Password:';
    // prompt() 대신 터미널에 비밀번호 입력 UI
    try {
      term.write(`\r\n\x1b[93m${promptText}\x1b[0m `);
    } catch {}
    let pwBuf = '';
    const disposable = term.onData((data: string) => {
      if (data === '\r' || data === '\n') {
        disposable.dispose();
        term.write('\r\n');
        window.api?.sshAuthResponse?.(termId, [pwBuf]);
      } else if (data === '\x7f' || data === '\b') {
        if (pwBuf.length > 0) { pwBuf = pwBuf.slice(0, -1); term.write('\b \b'); }
      } else if (data === '\x03') {
        // Ctrl+C → 취소
        disposable.dispose();
        term.write('\r\n\x1b[90m인증 취소\x1b[0m\r\n');
        window.api?.disconnectSSH?.(termId);
      } else {
        pwBuf += data;
        term.write('*');
      }
    });
  });
}

// ── 로컬 셸 (PTY) ──
const ptyInitialized = new Set<string>();
const ptyConnected = new Set<string>();

function ensurePtySetup(termId: string) {
  if (ptyInitialized.has(termId)) return;
  ptyInitialized.add(termId);

  const { term } = getOrCreateTerm(termId);

  window.api?.onPtyData?.((p: any) => {
    if (p.panelId !== termId) return;
    try { term.write(p.data); } catch {}
  });

  window.api?.onPtyExit?.((p: any) => {
    if (p.panelId !== termId) return;
    ptyConnected.delete(termId);
    try { term.write('\r\n\x1b[90m셸이 종료되었습니다.\x1b[0m\r\n'); } catch {}
  });
}

export function pasteToTerm(termId: string, text: string) {
  try {
    const entry = termStore.get(termId);
    if (entry) { entry.term.paste(text); return; }
  } catch {}
  // fallback
  try {
    if (ptyConnected.has(termId)) (window as any).api?.ptyInput?.(termId, text);
    else (window as any).api?.sendSSHInput?.(termId, text);
  } catch {}
}

export function isTermPty(termId: string): boolean {
  return ptyConnected.has(termId);
}

// SSH 연결 시작 추적
const sshConnecting = new Set<string>();
// 사용자가 재연결을 명시적으로 취소한 termId (자동 재연결 방지)
const reconnectUserCancelled = new Set<string>();

const reconnectState: Map<string, { timer: ReturnType<typeof setInterval> | null; fireTimer?: ReturnType<typeof setTimeout> | null; cancelled: boolean; disp?: any }> = new Map();
// termId → 세션 정보 매핑 (재연결 + 표시용)
const termSessionMap: Map<string, { sessionId: string; sessionName: string; host: string; quickSession?: any }> = new Map();
// termId → 마지막 사용 비밀번호 (메모리 only, 재연결용)
const termPasswordCache: Map<string, string> = new Map();

export function getTermSessionInfo(termId: string) {
  return termSessionMap.get(termId);
}

export function registerTermSession(termId: string, sessionId: string, sessionName?: string, host?: string, quickSession?: any) {
  termSessionMap.set(termId, { sessionId, sessionName: sessionName ?? '', host: host ?? '', quickSession });
}

function startReconnectCountdown(termId: string) {
  const sessInfo = termSessionMap.get(termId);
  if (!sessInfo) return;
  const { sessionId, sessionName, host } = sessInfo;

  const entry = termStore.get(termId);
  if (!entry) return;
  const term = entry.term;

  // 이전 재연결 취소
  cancelReconnect(termId);

  const now = new Date();
  const timeStr = now.toTimeString().split(' ')[0]; // HH:MM:SS

  const TOTAL_MS = 30000;
  const startAt = Date.now();
  const deadline = startAt + TOTAL_MS;
  let lastSecond = 30;
  const state: any = { timer: null, fireTimer: null, cancelled: false, disp: null };
  reconnectState.set(termId, state);

  term.write(`\r\n\x1b[91m원격 호스트 연결 끊김 (${sessionName} ${host}) ${timeStr}\x1b[0m\r\n`);
  term.write(`\r\n\x1b[33m30초 후 재연결합니다. 아무 키나 누르면 취소됩니다.\x1b[0m\r\n`);

  // 시각적 카운트다운(점)만 setInterval 로 갱신. 실제 재연결 발사는 단일 setTimeout 으로 처리해
  // 패널 전환/쓰로틀 등에 영향 없이 정확히 30초 후에만 1회 발동.
  state.timer = setInterval(() => {
    if (state.cancelled) { clearInterval(state.timer); return; }
    const remainingMs = deadline - Date.now();
    const remainSec = Math.max(0, Math.ceil(remainingMs / 1000));
    while (lastSecond > remainSec && lastSecond > 0) {
      term.write('.');
      lastSecond--;
    }
    if (remainingMs <= 0) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }, 250);

  state.fireTimer = setTimeout(async () => {
    // 발사 시점에 취소되었거나 이미 다시 연결된 경우 실행하지 않음
    if (state.cancelled) return;
    const cur = reconnectState.get(termId);
    if (cur !== state) return; // 다른 countdown 으로 대체된 경우
    if (globalConnected.has(termId)) { reconnectState.delete(termId); return; }
    if (state.disp) { state.disp.dispose(); state.disp = null; }
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    reconnectState.delete(termId);
    term.write('\r\n\x1b[33m재연결 중...\x1b[0m\r\n');
    sshConnecting.delete(termId);
    globalConnected.delete(termId);
    try {
      if (!sessionId && sessInfo.quickSession) {
        (window as any).api.quickConnectSSH(termId, sessInfo.quickSession);
      } else {
        const r = await (window as any).api.connectSSH(termId, sessionId);
        if (r === 'need-password') {
          sshConnecting.delete(termId);
          const cachedPw = termPasswordCache.get(termId);
          const cols = (term as any).cols || 80;
          const rows = (term as any).rows || 24;
          if (cachedPw) {
            sshConnecting.add(termId);
            (window as any).api.connectSSHWithPassword(termId, sessionId, cachedPw, cols, rows);
          } else {
            promptPasswordAndConnect(termId, sessionId, cols, rows);
          }
          return;
        }
      }
    } catch {}
  }, TOTAL_MS);

  const disp = term.onData(() => {
    if (!state.cancelled) {
      state.cancelled = true;
      if (state.timer) { clearInterval(state.timer); state.timer = null; }
      if (state.fireTimer) { clearTimeout(state.fireTimer); state.fireTimer = null; }
      reconnectState.delete(termId);
      reconnectUserCancelled.add(termId);
      term.write('\r\n\x1b[90m재연결이 취소되었습니다.\x1b[0m\r\n');
    }
    disp.dispose();
    state.disp = null;
  });
  state.disp = disp;
}

function cancelReconnect(termId: string) {
  const state = reconnectState.get(termId);
  if (state) {
    state.cancelled = true;
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    if (state.fireTimer) { clearTimeout(state.fireTimer); state.fireTimer = null; }
    if (state.disp) { state.disp.dispose(); state.disp = null; }
    reconnectState.delete(termId);
  }
}

export function focusTerm(termId: string) {
  const entry = termStore.get(termId);
  if (entry) try { entry.term.focus(); } catch {}
}

/** 외부에서 termId의 연결 추적 상태를 리셋 (재연결 허용) */
export function resetTermConnectState(termId: string) {
  sshConnecting.delete(termId);
  globalConnected.delete(termId);
}

type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center';

function getDropZone(e: React.DragEvent, el: HTMLElement): DropZone {
  const rect = el.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;
  const threshold = 0.25;
  if (x < threshold) return 'left';
  if (x > 1 - threshold) return 'right';
  if (y < threshold) return 'top';
  if (y > 1 - threshold) return 'bottom';
  return 'center';
}

type Props = {
  nodeId: string;
  panel: Panel;
  onSplit: (nodeId: string, dir: 'row' | 'column') => void;
  onClose: (nodeId: string) => void;
  onSelect?: (nodeId: string) => void;
  onSwitchSession?: (nodeId: string, idx: number) => void;
  onCloseSession?: (nodeId: string, termId: string) => void;
  onMoveSession?: (fromNodeId: string, termId: string, toNodeId: string) => void;
  onSplitMoveSession?: (fromNodeId: string, termId: string, toNodeId: string, zone: 'left' | 'right' | 'top' | 'bottom') => void;
  onReorderSession?: (nodeId: string, fromIdx: number, toIdx: number) => void;
  onAddSession?: (nodeId: string, shellName?: string, shellPath?: string) => void;
  availableShells?: { name: string; path: string; icon?: string }[];
  onRenameSession?: (nodeId: string, termId: string, name: string) => void;
  onConnectDrop?: (nodeId: string, sessionId: string) => void;
  onDuplicateSession?: (nodeId: string, termId: string) => void;
};

export const TerminalPanel: React.FC<Props> = ({
  nodeId, panel, onSplit, onClose, onSelect, onSwitchSession, onCloseSession, onMoveSession, onSplitMoveSession, onReorderSession, onAddSession, onRenameSession, onConnectDrop, onDuplicateSession, availableShells,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mountedTermRef = useRef<string | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const [, forceUpdate] = useState(0);

  const activeSession: PanelSession | undefined = panel.sessions[panel.activeIdx];
  const activeTermId = activeSession?.termId;

  // 글로벌 연결 상태 변경 구독
  useEffect(() => {
    const listener = () => forceUpdate(n => n + 1);
    connectedListeners.add(listener);
    return () => { connectedListeners.delete(listener); };
  }, []);

  // SSH 리스너 설정
  useEffect(() => {
    for (const sess of panel.sessions) {
      ensureSSHSetup(sess.termId);
    }
  }, [panel.sessions.map(s => s.termId).join(',')]);

  // 패널이 비어 있으면 자동으로 새 세션(미니탭) 생성 (중복 호출 방지)
  const autoAddedRef = useRef(false);
  useEffect(() => {
    if (panel.sessions.length === 0) {
      if (autoAddedRef.current) return;
      autoAddedRef.current = true;
      onAddSession?.(nodeId);
    } else {
      autoAddedRef.current = false;
    }
  }, [panel.sessions.length, nodeId]);

  // Active 터미널을 컨테이너에 마운트 + SSH 연결
  useEffect(() => {
    if (!activeTermId || !containerRef.current) return;

    // 이미 같은 터미널이 마운트되어 있으면 다시 그리지 않음
    if (mountedTermRef.current === activeTermId) return;
    mountedTermRef.current = activeTermId;

    const { term, fit } = getOrCreateTerm(activeTermId);

    containerRef.current.innerHTML = '';
    term.open(containerRef.current);
    applyTermOpacity(activeTermId, containerRef.current);

    // IME(한글 등) 조합 처리
    try {
      const ta = containerRef.current.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
      if (ta && !(ta as any).__imeBound) {
        (ta as any).__imeBound = true;
        const tid = activeTermId;
        ta.addEventListener('compositionstart', () => {
          if (ptyConnected.has(tid)) return;
          termIMEComposing.set(tid, true);
        });
        ta.addEventListener('compositionend', (e: CompositionEvent) => {
          if (ptyConnected.has(tid)) return;
          termIMEComposing.set(tid, false);
          const finalText = (e.data ?? '') || '';
          if (finalText) {
            try {
              const bytes = new TextEncoder().encode(finalText);
              const b64 = typeof Buffer !== 'undefined'
                ? Buffer.from(bytes).toString('base64')
                : btoa(String.fromCharCode(...bytes));
              window.api?.sendSSHInput?.(tid, finalText, b64);
              termJustComposed.set(tid, { text: finalText, at: Date.now() });
            } catch {}
          }
        });
      }
    } catch {}

    // DOM 마운트 후 fit → 정확한 cols/rows로 연결
    const initConnect = async () => {
      // 컨테이너 크기 확인 (보통 즉시 통과, 초기 탭만 약간 대기)
      if (!(containerRef.current && containerRef.current.offsetWidth > 0 && containerRef.current.offsetHeight > 0)) {
        for (let i = 0; i < 15; i++) {
          await new Promise(res => setTimeout(res, 30));
          if (containerRef.current && containerRef.current.offsetWidth > 0 && containerRef.current.offsetHeight > 0) break;
        }
      }
      await new Promise(requestAnimationFrame);
      try { fit.fit(); } catch {}
      await new Promise(requestAnimationFrame);
      try { fit.fit(); } catch {}

      const cols = (term as any).cols || 80;
      const rows = (term as any).rows || 24;
      try { term.focus(); } catch {}

      console.log('[initConnect]', activeTermId, {
        hasSession: !!activeSession,
        sessionId: activeSession?.sessionId,
        sshConnecting: sshConnecting.has(activeTermId),
        globalConnected: globalConnected.has(activeTermId),
        reconnectState: reconnectState.has(activeTermId),
        reconnectUserCancelled: reconnectUserCancelled.has(activeTermId),
        ptyConnected: ptyConnected.has(activeTermId),
        cachedPw: termPasswordCache.has(activeTermId),
      });
      if (activeSession && activeSession.sessionId && !sshConnecting.has(activeTermId) && !globalConnected.has(activeTermId) && !reconnectState.has(activeTermId) && !reconnectUserCancelled.has(activeTermId)) {
        // 같은 termId에 PTY가 실행 중이면 종료 (Local Shell → SSH 전환)
        if (ptyConnected.has(activeTermId)) {
          window.api?.ptyKill?.(activeTermId);
          ptyConnected.delete(activeTermId);
          ptyInitialized.delete(activeTermId);
          term.clear();
        }
        sshConnecting.add(activeTermId);
        try {
          const result = await window.api?.connectSSH?.(activeTermId, activeSession.sessionId, cols, rows);
          console.log('[initConnect] connectSSH result:', result);
          if (result === 'need-password') {
            sshConnecting.delete(activeTermId);
            const cachedPw = termPasswordCache.get(activeTermId);
            console.log('[initConnect] need-password, cachedPw:', !!cachedPw);
            if (cachedPw) {
              sshConnecting.add(activeTermId);
              window.api?.connectSSHWithPassword?.(activeTermId, activeSession.sessionId, cachedPw, cols, rows);
            } else {
              promptPasswordAndConnect(activeTermId, activeSession.sessionId, cols, rows);
            }
          }
        } catch (err) { console.error('[initConnect] error:', err); }
        setTimeout(() => { try { window.api?.resizeSSH?.(activeTermId, cols, rows); } catch {} }, 200);
      } else if (globalConnected.has(activeTermId)) {
        try { window.api?.resizeSSH?.(activeTermId, cols, rows); } catch {}
      } else if (activeSession && !activeSession.sessionId && !ptyConnected.has(activeTermId)) {
        (term.options as any).windowsPty = { backend: 'conpty', buildNumber: 26200 };
        ensurePtySetup(activeTermId);
        try {
          // shellCwd가 없으면 startupCwd(탐색기 우클릭 경로)를 가져옴
          let cwd = activeSession.shellCwd;
          if (!cwd) {
            try { cwd = await (window as any).api?.getStartupCwd?.() || undefined; } catch {}
          }
          await window.api?.ptySpawn?.(activeTermId, activeSession.shellPath || undefined, cols, rows, cwd || undefined);
          // startupCwd는 최초 1회만 사용
          if (cwd) { try { (window as any).api?.clearStartupCwd?.(); } catch {} }
          ptyConnected.add(activeTermId);
          setTimeout(() => {
            try {
              fit.fit();
              const c = (term as any).cols || 80;
              const r = (term as any).rows || 24;
              window.api?.ptyResize?.(activeTermId, c, r);
            } catch {}
          }, 200);
        } catch {}
      } else if (ptyConnected.has(activeTermId)) {
        try { window.api?.ptyResize?.(activeTermId, cols, rows); } catch {}
      }
    };
    initConnect();

    return () => { mountedTermRef.current = null; };
  }, [activeTermId, nodeId]);

  // 패널 선택 핸들러 (텍스트 드래그로 선택해도 클릭이 발생하지 않을 수 있어
  // mousedown에서 즉시 패널 선택을 반영한다. 포커스는 클릭 시점에 준다.)
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const onMouseDown = () => {
      onSelectRef.current?.(nodeId);
    };
    const onClick = () => {
      if (activeTermId) { try { getOrCreateTerm(activeTermId).term.focus(); } catch {} }
      onSelectRef.current?.(nodeId);
    };
    el.addEventListener('mousedown', onMouseDown);
    el.addEventListener('click', onClick);
    return () => {
      el.removeEventListener('mousedown', onMouseDown);
      el.removeEventListener('click', onClick);
    };
  }, [activeTermId, nodeId]);

  // 키보드 입력 핸들러
  useEffect(() => {
    if (!activeTermId) return;
    const { term } = getOrCreateTerm(activeTermId);
    const disp = term.onData((data: string) => {
      // PTY(로컬 셸): IME 가로채기 없이 그대로 전달
      if (ptyConnected.has(activeTermId)) {
        window.api?.ptyInput?.(activeTermId, data);
        return;
      }
      // IME 조합 중이면 파편 입력 차단
      if (termIMEComposing.get(activeTermId)) return;
      // 조합 완료 직후 xterm이 동일 문자열을 다시 보내면 1회 차단 (compositionend에서 이미 전송)
      const jc = termJustComposed.get(activeTermId);
      if (jc && jc.text === data && Date.now() - jc.at < 500) {
        termJustComposed.delete(activeTermId);
        return;
      }
      {
        try {
          const normalized = data.replace(/\x7f/g, '\x08');
          const bytes = new TextEncoder().encode(normalized);
          const b64 = typeof Buffer !== 'undefined'
            ? Buffer.from(bytes).toString('base64')
            : btoa(String.fromCharCode(...bytes));
          window.api?.sendSSHInput?.(activeTermId, normalized, b64);
        } catch { window.api?.sendSSHInput?.(activeTermId, data); }
      }
    });
    return () => disp.dispose();
  }, [activeTermId]);

  // 빈 패널 처리
  useEffect(() => {
    if (panel.sessions.length === 0 && containerRef.current) {
      containerRef.current.innerHTML = '';
    }
  }, [panel.sessions.length]);

  // 여러 줄 붙여넣기 이벤트 수신
  useEffect(() => {
    if (!containerRef.current) return;
    const handler = (e: Event) => {
      const { termId: tid, text } = (e as CustomEvent).detail;
      setMultiPaste({ termId: tid, text });
    };
    containerRef.current.addEventListener('term-multi-paste', handler);
    return () => containerRef.current?.removeEventListener('term-multi-paste', handler);
  }, [activeTermId]);

  // 터미널 우클릭 컨텍스트 메뉴
  useEffect(() => {
    if (!containerRef.current) return;
    const handler = (e: Event) => {
      const { x, y } = (e as CustomEvent).detail;
      setTermCtx({ x, y });
    };
    containerRef.current.addEventListener('term-contextmenu', handler);
    return () => containerRef.current?.removeEventListener('term-contextmenu', handler);
  }, [activeTermId]);

  // Resize (debounce로 연쇄 리사이즈 방지)
  useEffect(() => {
    if (!activeTermId || !containerRef.current) return;
    const { fit } = getOrCreateTerm(activeTermId);
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;

    const doFit = () => {
      // 드래그 중에는 fit 자체를 건너뜀 (버퍼 reflow 방지)
      if (suppressPtyResize) return;
      try {
        const e = termStore.get(activeTermId);
        if (!e) return;
        fit.fit();
        const newCols = (e.term as any).cols;
        const newRows = (e.term as any).rows;
        if (ptyConnected.has(activeTermId)) {
          window.api?.ptyResize?.(activeTermId, newCols, newRows);
        } else {
          window.api?.resizeSSH?.(activeTermId, newCols, newRows);
        }
      } catch {}
    };

    const debouncedFit = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(doFit, 80);
    };

    const ro = new ResizeObserver(debouncedFit);
    ro.observe(containerRef.current);
    window.addEventListener('resize', debouncedFit);

    const timers = [100, 300].map(ms => setTimeout(doFit, ms));
    setTimeout(() => { try { getOrCreateTerm(activeTermId).term.focus(); } catch {} }, 100);

    return () => { ro.disconnect(); window.removeEventListener('resize', debouncedFit); timers.forEach(clearTimeout); if (resizeTimer) clearTimeout(resizeTimer); };
  }, [activeTermId]);

  const [dropZone, setDropZone] = useState<DropZone | null>(null);
  const [miniCtx, setMiniCtx] = useState<{ x: number; y: number; termId: string; name: string } | null>(null);
  const [termCtx, setTermCtx] = useState<{ x: number; y: number } | null>(null);
  const [encodingCtx, setEncodingCtx] = useState<{ x: number; y: number; current: string } | null>(null);
  const [scrollbackDialog, setScrollbackDialog] = useState<{ value: string } | null>(null);
  const [multiPaste, setMultiPaste] = useState<{ termId: string; text: string } | null>(null);
  const [shellMenu, setShellMenu] = useState<{ x: number; y: number } | null>(null);
  const [fontDialog, setFontDialog] = useState<{ termId: string; family: string; size: number } | null>(null);
  const showMultiLinePasteDialog = (tid: string, text: string) => setMultiPaste({ termId: tid, text });
  const [renamingTermId, setRenamingTermId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  return (
    <div
      style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', position: 'relative' }}
      onDragOver={e => {
        if (e.dataTransfer.types.includes('text/mini-session') || e.dataTransfer.types.includes('text/session-id')) {
          e.preventDefault();
          e.stopPropagation();
          if (e.dataTransfer.types.includes('text/mini-session')) {
            const zone = getDropZone(e, e.currentTarget as HTMLElement);
            setDropZone(prev => prev === zone ? prev : zone);
          } else {
            setDropZone('center');
          }
        }
      }}
      onDragLeave={e => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropZone(null);
      }}
      onDrop={e => {
        // 세션 목록에서 드래그 → 패널에 연결
        const sessId = e.dataTransfer?.getData('text/session-id');
        if (sessId) {
          e.preventDefault();
          e.stopPropagation();
          setDropZone(null);
          onConnectDrop?.(nodeId, sessId);
          return;
        }
        const raw = e.dataTransfer?.getData('text/mini-session');
        if (raw) {
          e.preventDefault();
          e.stopPropagation();
          const { nodeId: fromNodeId, termId } = JSON.parse(raw);
          if (fromNodeId === nodeId && panel.sessions.length <= 1) { setDropZone(null); return; }
          const zone = getDropZone(e, e.currentTarget as HTMLElement);
          if (zone === 'center') {
            if (fromNodeId !== nodeId) onMoveSession?.(fromNodeId, termId, nodeId);
          } else {
            onSplitMoveSession?.(fromNodeId, termId, nodeId, zone);
          }
        }
        setDropZone(null);
      }}
    >
      {dropZone && <div className={`drop-zone-overlay drop-zone-${dropZone}`} />}
      <div
        className="panel-header"
        onClick={() => onSelect?.(nodeId)}
        onDragOver={e => {
          if (e.dataTransfer.types.includes('text/mini-session')) { e.preventDefault(); e.stopPropagation(); setDropZone('center'); }
        }}
        onDrop={e => {
          const raw = e.dataTransfer?.getData('text/mini-session');
          if (raw) {
            e.preventDefault(); e.stopPropagation();
            const { nodeId: fromNodeId, termId } = JSON.parse(raw);
            if (fromNodeId !== nodeId) onMoveSession?.(fromNodeId, termId, nodeId);
          }
          setDropZone(null);
        }}
      >
        {panel.sessions.length > 0 ? (
          <div className="panel-session-tabs-wrapper">
            <div className="panel-session-tabs" data-panel-tabs={nodeId} onWheel={e => {
              e.currentTarget.scrollLeft += e.deltaY > 0 ? 60 : -60;
            }}>
            {panel.sessions.map((sess, idx) => (
              <span
                key={sess.termId}
                className={`panel-session-tab ${idx === panel.activeIdx ? 'active' : ''}`}
                draggable
                onDragStart={e => {
                  e.stopPropagation();
                  e.dataTransfer.setData('text/mini-session', JSON.stringify({ nodeId, termId: sess.termId, idx }));
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={e => {
                  if (e.dataTransfer.types.includes('text/mini-session')) { e.preventDefault(); e.stopPropagation(); }
                }}
                onDrop={e => {
                  const raw = e.dataTransfer?.getData('text/mini-session');
                  if (!raw) return;
                  e.preventDefault(); e.stopPropagation();
                  const data = JSON.parse(raw);
                  if (data.nodeId === nodeId && data.idx !== undefined && data.idx !== idx) {
                    onReorderSession?.(nodeId, data.idx, idx);
                  } else if (data.nodeId !== nodeId) {
                    onMoveSession?.(data.nodeId, data.termId, nodeId);
                  }
                  setDropZone(null);
                }}
                onClick={e => { e.stopPropagation(); onSwitchSession?.(nodeId, idx); }}
                onDoubleClick={e => { e.stopPropagation(); onDuplicateSession?.(nodeId, sess.termId); }}
                onAuxClick={e => { if (e.button === 1) { e.preventDefault(); e.stopPropagation(); window.api?.disconnectSSH?.(sess.termId); onCloseSession?.(nodeId, sess.termId); } }}
                onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setMiniCtx({ x: e.clientX, y: e.clientY, termId: sess.termId, name: sess.sessionName }); }}
              >
                <span className={`panel-status-dot ${globalConnected.has(sess.termId) ? 'connected' : 'disconnected'}`} />
                {renamingTermId === sess.termId ? (
                  <input
                    className="mini-tab-rename-input"
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onBlur={() => { if (renameValue.trim()) onRenameSession?.(nodeId, sess.termId, renameValue.trim()); setRenamingTermId(null); }}
                    onKeyDown={e => {
                      e.stopPropagation();
                      if (e.key === 'Enter') { if (renameValue.trim()) onRenameSession?.(nodeId, sess.termId, renameValue.trim()); setRenamingTermId(null); }
                      if (e.key === 'Escape') setRenamingTermId(null);
                    }}
                    autoFocus
                    onClick={e => e.stopPropagation()}
                  />
                ) : (
                  <span className="panel-session-tab-name">{sess.sessionName}</span>
                )}
                <span className="panel-session-tab-close" onClick={e => {
                  e.stopPropagation();
                  window.api?.disconnectSSH?.(sess.termId);
                  onCloseSession?.(nodeId, sess.termId);
                }}>&times;</span>
              </span>
            ))}
            <span className="panel-session-tab-add" onClick={e => { e.stopPropagation(); onAddSession?.(nodeId); }} title="새 세션">+</span>
            {availableShells && availableShells.length > 0 && (
              <span className="panel-session-tab-add panel-shell-btn" onClick={e => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setShellMenu(prev => prev ? null : { x: r.left, y: r.bottom }); }} title="쉘 선택">∨</span>
            )}
          </div>
            <button className="panel-tabs-scroll-btn" onClick={() => {
              const el = document.querySelector(`[data-panel-tabs="${nodeId}"]`);
              if (el) el.scrollBy({ left: -100, behavior: 'smooth' });
            }}>‹</button>
            <button className="panel-tabs-scroll-btn" onClick={() => {
              const el = document.querySelector(`[data-panel-tabs="${nodeId}"]`);
              if (el) el.scrollBy({ left: 100, behavior: 'smooth' });
            }}>›</button>
          </div>
        ) : (
          <span className="panel-header-label" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            Empty
            <span className="panel-session-tab-add" onClick={e => { e.stopPropagation(); onAddSession?.(nodeId); }} title="새 세션">+</span>
            {availableShells && availableShells.length > 0 && (
              <span className="panel-session-tab-add panel-shell-btn" onClick={e => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setShellMenu(prev => prev ? null : { x: r.left, y: r.bottom }); }} title="쉘 선택">∨</span>
            )}
          </span>
        )}

        <div className="panel-opacity-hslider" onClick={e => e.stopPropagation()}>
          {[0,20,40,60,80,100].map(v => {
            const cur = Math.round((termOpacity.get(activeTermId || nodeId) ?? 1.0) * 100);
            return <div key={v}
              className={`panel-opacity-hstep ${cur === v ? 'active' : ''} ${v <= cur ? 'filled' : ''}`}
              onClick={() => {
                const val = v / 100;
                termOpacity.set(activeTermId || nodeId, val);
                if (activeTermId) applyTermOpacity(activeTermId, containerRef.current);
                else if (containerRef.current) containerRef.current.style.background = `rgba(0,0,0,${val})`;
                forceUpdate(n => n + 1);
              }}
              title={`${v}%`}
            />;
          })}
        </div>
        <button className="panel-btn" onClick={() => onSplit(nodeId, 'row')} title="Split Horizontal">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="1" y="1" width="12" height="12" rx="1.5" /><line x1="7" y1="1" x2="7" y2="13" />
          </svg>
        </button>
        <button className="panel-btn" onClick={() => onSplit(nodeId, 'column')} title="Split Vertical">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="1" y="1" width="12" height="12" rx="1.5" /><line x1="1" y1="7" x2="13" y2="7" />
          </svg>
        </button>
        <button
          className="panel-btn panel-btn-close"
          onClick={() => {
            // 미니탭이 2개 이상이면 현재 선택된 미니탭만 닫기, 1개면 패널 자체 닫기.
            if (panel.sessions.length > 1 && activeTermId) {
              window.api?.disconnectSSH?.(activeTermId);
              onCloseSession?.(nodeId, activeTermId);
            } else {
              onClose(nodeId);
            }
          }}
          title="Close"
        >&times;</button>
      </div>
      <div ref={containerRef} className="panel-terminal-area" />
      {miniCtx && (
        <ContextMenu
          x={miniCtx.x} y={miniCtx.y}
          onClose={() => setMiniCtx(null)}
          items={[
            { label: '이름 변경', onClick: () => { setRenamingTermId(miniCtx.termId); setRenameValue(miniCtx.name); } },
            { label: '세션 복제', onClick: () => { onDuplicateSession?.(nodeId, miniCtx.termId); } },
            { label: '세션 재연결', onClick: async () => {
              const tid = miniCtx.termId;
              const info = termSessionMap.get(tid);
              if (!info) return;
              try {
                // 재연결 상태 초기화 + 기존 연결 종료
                reconnectUserCancelled.delete(tid);
                if (globalConnected.has(tid) || sshConnecting.has(tid)) {
                  window.api?.disconnectSSH?.(tid);
                  await new Promise(res => setTimeout(res, 300));
                }
                sshConnecting.delete(tid);
                globalConnected.delete(tid);
                // reset-state IPC로 main.ts 상태도 초기화
                try { await (window as any).api?.resetSSHState?.(tid); } catch {}
                sshConnecting.add(tid);
                const entry = termStore.get(tid);
                const cols = entry ? (entry.term as any).cols : 80;
                const rows = entry ? (entry.term as any).rows : 24;
                if (info.sessionId) {
                  await window.api?.connectSSH?.(tid, info.sessionId, cols, rows);
                } else if (info.quickSession) {
                  await (window as any).api?.quickConnectSSH?.(tid, info.quickSession, cols, rows);
                }
              } catch {}
            }},
            { label: '닫기', onClick: () => { window.api?.disconnectSSH?.(miniCtx.termId); onCloseSession?.(nodeId, miniCtx.termId); } },
          ]}
        />
      )}
      {multiPaste && ReactDOM.createPortal(
        <div className="session-editor-backdrop"
          onMouseDown={e => { (e.currentTarget as any).__clickedBackdrop = (e.target === e.currentTarget); }}
          onMouseUp={e => { if ((e.currentTarget as any).__clickedBackdrop && e.target === e.currentTarget) setMultiPaste(null); }}
        >
          <div className="session-editor" onClick={e => e.stopPropagation()} style={{ width: 480 }}>
            <h3>여러 줄 붙여넣기</h3>
            <p style={{ color: '#888', fontSize: 12, margin: '0 0 8px' }}>다음 텍스트에 여러 줄이 포함되어 있습니다. 붙여넣을까요?</p>
            <textarea
              value={multiPaste.text}
              onChange={e => setMultiPaste(prev => prev ? { ...prev, text: e.target.value } : null)}
              onKeyDown={e => e.stopPropagation()}
              style={{ width: '100%', height: 150, background: '#111', color: '#eee', border: '1px solid #333', borderRadius: 4, padding: 8, fontSize: 12, fontFamily: 'monospace', resize: 'vertical', boxSizing: 'border-box' }}
            />
            <div className="session-editor-actions">
              <button className="btn-cancel" onClick={() => setMultiPaste(null)}>취소</button>
              <button className="btn-save" onClick={() => {
                try {
                  const entry = termStore.get(multiPaste.termId);
                  if (entry) {
                    // xterm.paste() — bracketed paste mode 활성 시 자동으로 \e[200~...\e[201~ 래핑
                    entry.term.paste(multiPaste.text);
                  } else if (ptyConnected.has(multiPaste.termId)) {
                    (window as any).api.ptyInput(multiPaste.termId, multiPaste.text);
                  } else {
                    (window as any).api.sendSSHInput(multiPaste.termId, multiPaste.text);
                  }
                } catch {}
                setMultiPaste(null);
              }}>붙여넣기</button>
            </div>
          </div>
        </div>,
        document.body
      )}
      {termCtx && activeTermId && (
        <ContextMenu
          x={termCtx.x} y={termCtx.y}
          onClose={() => setTermCtx(null)}
          items={[
            { label: '복사', onClick: () => {
              const entry = termStore.get(activeTermId);
              if (!entry) return;
              const settings = getTerminalSettings();
              let sel = entry.term.getSelection();
              if (!sel) return;
              if (settings.trimTrailingWhitespace) sel = sel.split('\n').map(l => l.trimEnd()).join('\n');
              if (!settings.includeTrailingNewline) sel = sel.replace(/\n$/, '');
              navigator.clipboard.writeText(sel).catch(() => {});
            }},
            { label: '붙여넣기', onClick: () => {
              navigator.clipboard.readText().then(text => {
                if (!text) return;
                const settings = getTerminalSettings();
                if (text.includes('\n') && settings.multiLinePaste === 'dialog') {
                  showMultiLinePasteDialog(activeTermId, text);
                } else {
                  try {
                    const entry = termStore.get(activeTermId);
                    if (entry) entry.term.paste(text);
                  } catch {}
                }
              }).catch(() => {});
            }},
            { label: '전체 선택', onClick: () => {
              const entry = termStore.get(activeTermId);
              if (entry) entry.term.selectAll();
            }},
            { label: '화면 지우기', onClick: () => clearScreenInTerm(activeTermId) },
            { label: '스크롤 버퍼 지우기', onClick: () => clearScrollbackInTerm(activeTermId) },
            { label: '스크롤 버퍼 크기 변경...', onClick: () => {
              const cur = getScrollbackForTerm(activeTermId);
              setScrollbackDialog({ value: String(cur) });
            }},
            { label: '인코딩 변경...', onClick: async () => {
              let current = 'utf-8';
              try { current = (await (window as any).api?.getSSHEncoding?.(activeTermId)) || 'utf-8'; } catch {}
              setEncodingCtx({ x: termCtx.x, y: termCtx.y, current: current.toLowerCase() });
            }},
            { label: '글꼴...', onClick: () => {
              const entry = termStore.get(activeTermId);
              const curFamily = entry ? (entry.term.options.fontFamily || '') : '';
              const curSize = entry ? (entry.term.options.fontSize || 14) : 14;
              setFontDialog({ termId: activeTermId, family: curFamily, size: curSize });
            }},
          ]}
        />
      )}
      {encodingCtx && activeTermId && (
        <ContextMenu
          x={encodingCtx.x} y={encodingCtx.y}
          onClose={() => setEncodingCtx(null)}
          items={(['utf-8','euc-kr','cp949','shift_jis','gb2312','gbk','big5','iso-8859-1']).map(enc => ({
            label: (encodingCtx.current === enc ? '● ' : '   ') + enc,
            onClick: async () => {
              try {
                await (window as any).api?.setSSHEncoding?.(activeTermId, enc);
              } catch {}
            },
          }))}
        />
      )}
      {scrollbackDialog && activeTermId && ReactDOM.createPortal(
        <div className="session-editor-backdrop" onClick={() => setScrollbackDialog(null)}>
          <div className="session-editor" style={{ width: 320 }} onClick={e => e.stopPropagation()}>
            <h3>스크롤 버퍼 크기 변경</h3>
            <div style={{ padding: '8px 0', color: '#aaa', fontSize: 12 }}>줄 수 (1000 ~ 1000000)</div>
            <input
              type="number"
              autoFocus
              min={1000}
              max={1000000}
              step={1000}
              value={scrollbackDialog.value}
              onChange={e => setScrollbackDialog({ value: e.target.value })}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  const n = Math.max(1000, Math.min(1000000, Number(scrollbackDialog.value) || 0));
                  if (n) applyScrollbackToTerm(activeTermId, n);
                  setScrollbackDialog(null);
                } else if (e.key === 'Escape') {
                  setScrollbackDialog(null);
                }
              }}
              style={{ width: '100%', background: '#1a1a1a', color: '#eee', border: '1px solid #333', borderRadius: 4, padding: '8px', fontSize: 14, fontFamily: 'monospace', boxSizing: 'border-box' }}
            />
            <div className="session-editor-actions" style={{ marginTop: 12 }}>
              <button className="btn-cancel" onClick={() => setScrollbackDialog(null)}>취소</button>
              <button className="btn-save" onClick={() => {
                const n = Math.max(1000, Math.min(1000000, Number(scrollbackDialog.value) || 0));
                if (n) applyScrollbackToTerm(activeTermId, n);
                setScrollbackDialog(null);
              }}>적용</button>
            </div>
          </div>
        </div>,
        document.body
      )}
      {fontDialog && ReactDOM.createPortal(
        <div className="session-editor-backdrop"
          onMouseDown={e => { (e.currentTarget as any).__bg = (e.target === e.currentTarget); }}
          onMouseUp={e => { if ((e.currentTarget as any).__bg && e.target === e.currentTarget) setFontDialog(null); }}
        >
          <div className="session-editor" onClick={e => e.stopPropagation()} style={{ width: 360 }}>
            <h3>글꼴 설정</h3>
            <div style={{ marginBottom: 12 }}>
              <div style={{ color: '#ccc', fontSize: 12, marginBottom: 4 }}>글꼴</div>
              <select
                style={{ width: '100%', background: '#1a1a1a', color: '#eee', border: '1px solid #333', borderRadius: 4, padding: '6px 8px', fontSize: 13, cursor: 'pointer' }}
                value={fontDialog.family}
                onChange={e => {
                  const f = e.target.value;
                  setFontDialog(prev => prev ? { ...prev, family: f } : null);
                  applyFontToTerm(fontDialog.termId, f || undefined, fontDialog.size);
                }}
              >
                <option value="">기본 (Cascadia Mono)</option>
                {(() => {
                  const fonts = ['Cascadia Mono','Cascadia Code','Consolas','Courier New','D2Coding','D2Coding ligature','Fira Code','Fira Mono','JetBrains Mono','Source Code Pro','Ubuntu Mono','IBM Plex Mono','Hack','Inconsolata','Noto Sans Mono','Roboto Mono','NanumGothicCoding','Malgun Gothic','Lucida Console','DejaVu Sans Mono'];
                  return fonts.filter(f => { try { return document.fonts.check(`12px "${f}"`); } catch { return false; } })
                    .map(f => <option key={f} value={f}>{f}</option>);
                })()}
              </select>
            </div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ color: '#ccc', fontSize: 12, marginBottom: 4 }}>크기</div>
              <input type="number" min={8} max={40} step={1}
                style={{ width: 80, background: '#1a1a1a', color: '#eee', border: '1px solid #333', borderRadius: 4, padding: '6px 8px', fontSize: 13, fontFamily: 'monospace' }}
                value={fontDialog.size}
                onChange={e => {
                  const s = Math.max(8, Math.min(40, Number(e.target.value) || 14));
                  setFontDialog(prev => prev ? { ...prev, size: s } : null);
                  applyFontToTerm(fontDialog.termId, fontDialog.family || undefined, s);
                }}
              />
            </div>
            <div className="session-editor-actions">
              <button className="btn-save" onClick={() => setFontDialog(null)}>확인</button>
            </div>
          </div>
        </div>,
        document.body
      )}
      {shellMenu && availableShells && availableShells.length > 0 && (
        <ContextMenu
          x={shellMenu.x} y={shellMenu.y}
          onClose={() => setShellMenu(null)}
          items={availableShells.map(sh => ({
            label: `${sh.icon || ''} ${sh.name}`.trim(),
            onClick: () => onAddSession?.(nodeId, sh.name, sh.path),
          }))}
        />
      )}
    </div>
  );
};

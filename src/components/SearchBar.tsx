// src/components/SearchBar.tsx
import React, { useState, useRef, useEffect } from 'react';
import type { Tab } from '../App';
import { collectAllSessions } from '../utils/layoutUtils';
import {
  searchInTerm,
  searchNextInTerm,
  searchPrevInTerm,
  clearSearchInTerm,
  getAllTermIds,
  highlightAllMatches,
  clearHighlights,
  searchFromTop,
} from './TerminalPanel';

type Props = {
  tabs: Tab[];
  activeTab: Tab;
  selectedPanelId: string | null;
  onClose: () => void;
};

type MatchResult = { termId: string; sessionName: string; tabTitle: string };

// 앱 실행 중 검색 이력 (최대 50개, 중복 제거, 최근 우선)
const searchHistory: string[] = [];
const MAX_HISTORY = 50;
function addSearchHistory(q: string) {
  if (!q.trim()) return;
  const idx = searchHistory.indexOf(q);
  if (idx !== -1) searchHistory.splice(idx, 1);
  searchHistory.unshift(q);
  if (searchHistory.length > MAX_HISTORY) searchHistory.pop();
}

export const SearchBar: React.FC<Props> = ({ tabs, activeTab, selectedPanelId, onClose }) => {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'current' | 'all'>('current');
  const [useRegex, setUseRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [matches, setMatches] = useState<MatchResult[]>([]);
  const [activeMatchIdx, setActiveMatchIdx] = useState(0);
  const [showHistory, setShowHistory] = useState(false);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // 모드 변경 시에만 자동 검색
  useEffect(() => {
    if (!query) return;
    try {
      if (mode === 'current') {
        searchCurrent();
      } else {
        searchAll();
      }
    } catch {}
  }, [mode]);

  // query/regex/caseSensitive 변경 시 모든 매치 하이라이트 + 맨 위부터 검색 시작
  useEffect(() => {
    if (!query) {
      for (const tid of getAllTermIds()) clearHighlights(tid);
      return;
    }
    if (mode === 'current') {
      const termId = getActiveTermId();
      if (termId) {
        highlightAllMatches(termId, query, useRegex, caseSensitive);
        searchFromTop(termId, query, useRegex, caseSensitive);
      }
    } else {
      for (const tab of tabs) {
        const sessions = collectAllSessions(tab.layout);
        for (const sess of sessions) {
          highlightAllMatches(sess.termId, query, useRegex, caseSensitive);
        }
      }
    }
  }, [query, useRegex, caseSensitive, mode]);

  const getActiveTermId = (): string | null => {
    if (!selectedPanelId) return null;
    const findInLayout = (node: any): string | null => {
      if (node.type === 'leaf' && node.id === selectedPanelId) {
        const sess = node.panel.sessions[node.panel.activeIdx];
        return sess?.termId ?? null;
      }
      if (node.children) {
        for (const c of node.children) { const r = findInLayout(c); if (r) return r; }
      }
      return null;
    };
    return findInLayout(activeTab.layout);
  };

  const searchCurrent = () => {
    const termId = getActiveTermId();
    if (!termId || !query) return;
    searchInTerm(termId, query, useRegex, caseSensitive);
  };

  const searchAll = () => {
    try {
      const results: MatchResult[] = [];
      for (const tab of tabs) {
        const sessions = collectAllSessions(tab.layout);
        for (const sess of sessions) {
          try {
            const found = searchInTerm(sess.termId, query, useRegex, caseSensitive);
            if (found) {
              results.push({ termId: sess.termId, sessionName: sess.sessionName, tabTitle: tab.title });
            }
          } catch {}
        }
      }
      setMatches(results);
      setActiveMatchIdx(0);
    } catch {}
  };

  const clearAll = () => {
    for (const termId of getAllTermIds()) {
      clearSearchInTerm(termId);
    }
  };

  const handleNext = () => {
    if (mode === 'current') {
      const termId = getActiveTermId();
      if (termId && query) searchNextInTerm(termId, query, useRegex, caseSensitive);
    } else {
      if (matches.length === 0) return;
      const nextIdx = (activeMatchIdx + 1) % matches.length;
      setActiveMatchIdx(nextIdx);
      searchNextInTerm(matches[nextIdx].termId, query, useRegex, caseSensitive);
    }
  };

  const handlePrev = () => {
    if (mode === 'current') {
      const termId = getActiveTermId();
      if (termId && query) searchPrevInTerm(termId, query, useRegex, caseSensitive);
    } else {
      if (matches.length === 0) return;
      const prevIdx = (activeMatchIdx - 1 + matches.length) % matches.length;
      setActiveMatchIdx(prevIdx);
      searchPrevInTerm(matches[prevIdx].termId, query, useRegex, caseSensitive);
    }
  };

  const handleClose = () => {
    clearAll();
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      if (showHistory) { setShowHistory(false); setHistoryIdx(-1); return; }
      handleClose(); return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (searchHistory.length === 0) return;
      if (!showHistory) { setShowHistory(true); setHistoryIdx(0); setQuery(searchHistory[0]); return; }
      const next = Math.min(historyIdx + 1, searchHistory.length - 1);
      setHistoryIdx(next);
      setQuery(searchHistory[next]);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!showHistory) return;
      const next = historyIdx - 1;
      if (next < 0) { setHistoryIdx(-1); setShowHistory(false); return; }
      setHistoryIdx(next);
      setQuery(searchHistory[next]);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      setShowHistory(false); setHistoryIdx(-1);
      if (!query) return;
      addSearchHistory(query);
      if (e.shiftKey) handlePrev();
      else handleNext();
    }
  };

  // 검색바 내 모든 키/마우스 이벤트가 터미널로 전파되지 않도록 차단
  const stopProp = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <div className="search-bar" onKeyDown={stopProp} onKeyUp={stopProp} onKeyPress={stopProp} onMouseDown={stopProp} onClick={stopProp} onDoubleClick={stopProp}>
      <div className="search-bar-inner">
        <span className="search-icon">🔍</span>
        <div style={{ position: 'relative', display: 'inline-block' }}>
          <div style={{ display: 'flex' }}>
            <input
              ref={inputRef}
              className="search-input"
              type="text"
              value={query}
              onChange={e => { setQuery(e.target.value); setShowHistory(false); setHistoryIdx(-1); }}
              onKeyDown={handleKeyDown}
              onFocus={() => { if (searchHistory.length > 0) setShowHistory(true); }}
              onBlur={() => { setTimeout(() => setShowHistory(false), 150); }}
              placeholder="검색..."
              autoComplete="off"
            />
            <button
              className="search-history-toggle"
              onClick={() => { setShowHistory(prev => !prev); inputRef.current?.focus(); }}
              title="검색 이력"
              tabIndex={-1}
            >▾</button>
          </div>
          {showHistory && searchHistory.length > 0 && (
            <div className="search-history-dropdown">
              {searchHistory.map((h, i) => (
                <div
                  key={`${h}-${i}`}
                  className={`search-history-item ${i === historyIdx ? 'active' : ''}`}
                  onMouseDown={e => { e.preventDefault(); setQuery(h); setShowHistory(false); setHistoryIdx(-1); inputRef.current?.focus(); }}
                >{h}</div>
              ))}
            </div>
          )}
        </div>
        <button className="search-btn" onClick={handlePrev} title="Previous (Shift+Enter)">&#9650;</button>
        <button className="search-btn" onClick={handleNext} title="Next (Enter)">&#9660;</button>
        <button
          className={`search-regex-btn ${caseSensitive ? 'active' : ''}`}
          onClick={() => setCaseSensitive(prev => !prev)}
          title="Case Sensitive"
        >Aa</button>
        <button
          className={`search-regex-btn ${useRegex ? 'active' : ''}`}
          onClick={() => setUseRegex(prev => !prev)}
          title="Regular Expression"
        >.*</button>
        <div className="search-mode-toggle">
          <button
            className={`search-mode-btn ${mode === 'current' ? 'active' : ''}`}
            onClick={() => setMode('current')}
          >
            현재탭
          </button>
          <button
            className={`search-mode-btn ${mode === 'all' ? 'active' : ''}`}
            onClick={() => setMode('all')}
          >
            전체
          </button>
        </div>
        {mode === 'all' && matches.length > 0 && (
          <span className="search-match-count">{activeMatchIdx + 1}/{matches.length}</span>
        )}
        <button className="search-btn search-close-btn" onClick={handleClose} title="Close (Esc)">&times;</button>
      </div>
      {mode === 'all' && matches.length > 0 && (
        <div className="search-match-list">
          {matches.map((m, i) => (
            <span
              key={m.termId}
              className={`search-match-item ${i === activeMatchIdx ? 'active' : ''}`}
              onClick={() => { setActiveMatchIdx(i); searchInTerm(m.termId, query, useRegex, caseSensitive); }}
            >
              {m.tabTitle} &gt; {m.sessionName}
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

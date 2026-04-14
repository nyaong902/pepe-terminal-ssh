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
  const [matches, setMatches] = useState<MatchResult[]>([]);
  const [activeMatchIdx, setActiveMatchIdx] = useState(0);
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

  // query/regex 변경 시 모든 매치 하이라이트 + 맨 위부터 검색 시작
  useEffect(() => {
    if (!query) {
      for (const tid of getAllTermIds()) clearHighlights(tid);
      return;
    }
    if (mode === 'current') {
      const termId = getActiveTermId();
      if (termId) {
        highlightAllMatches(termId, query, useRegex);
        searchFromTop(termId, query, useRegex);
      }
    } else {
      for (const tab of tabs) {
        const sessions = collectAllSessions(tab.layout);
        for (const sess of sessions) {
          highlightAllMatches(sess.termId, query, useRegex);
        }
      }
    }
  }, [query, useRegex, mode]);

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
    searchInTerm(termId, query, useRegex);
  };

  const searchAll = () => {
    try {
      const results: MatchResult[] = [];
      for (const tab of tabs) {
        const sessions = collectAllSessions(tab.layout);
        for (const sess of sessions) {
          try {
            const found = searchInTerm(sess.termId, query, useRegex);
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
      if (termId && query) searchNextInTerm(termId, query, useRegex);
    } else {
      if (matches.length === 0) return;
      const nextIdx = (activeMatchIdx + 1) % matches.length;
      setActiveMatchIdx(nextIdx);
      searchNextInTerm(matches[nextIdx].termId, query, useRegex);
    }
  };

  const handlePrev = () => {
    if (mode === 'current') {
      const termId = getActiveTermId();
      if (termId && query) searchPrevInTerm(termId, query, useRegex);
    } else {
      if (matches.length === 0) return;
      const prevIdx = (activeMatchIdx - 1 + matches.length) % matches.length;
      setActiveMatchIdx(prevIdx);
      searchPrevInTerm(matches[prevIdx].termId, query, useRegex);
    }
  };

  const handleClose = () => {
    clearAll();
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape') { handleClose(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!query) return;
      addSearchHistory(query);
      if (e.shiftKey) handlePrev();
      else handleNext();
    }
  };

  // 검색바 내 모든 키/마우스 이벤트가 터미널로 전파되지 않도록 차단
  const stopProp = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <div className="search-bar" onKeyDown={stopProp} onKeyUp={stopProp} onKeyPress={stopProp} onMouseDown={stopProp} onClick={stopProp}>
      <div className="search-bar-inner">
        <span className="search-icon">🔍</span>
        <input
          ref={inputRef}
          className="search-input"
          type="text"
          list="search-history-list"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="검색..."
          autoComplete="off"
        />
        <datalist id="search-history-list">
          {searchHistory.map((h, i) => <option key={`${h}-${i}`} value={h} />)}
        </datalist>
        <button className="search-btn" onClick={handlePrev} title="Previous (Shift+Enter)">&#9650;</button>
        <button className="search-btn" onClick={handleNext} title="Next (Enter)">&#9660;</button>
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
              onClick={() => { setActiveMatchIdx(i); searchInTerm(m.termId, query, useRegex); }}
            >
              {m.tabTitle} &gt; {m.sessionName}
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

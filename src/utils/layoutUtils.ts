// src/utils/layoutUtils.ts
// 레이아웃 트리 조작 유틸리티

export type PanelSession = {
  termId: string;      // 터미널 인스턴스 & SSH 연결 고유 키
  sessionId: string;   // sessions.json의 세션 ID
  sessionName: string; // 표시 이름 (예: "My Server #1")
  shellPath?: string;  // 로컬 셸 경로 (PTY용, 예: 'powershell.exe')
  shellCwd?: string;   // 로컬 셸 시작 디렉토리
};

export type Panel = {
  id: string;
  sessions: PanelSession[];
  activeIdx: number;
};

export type LeafNode = { id: string; type: 'leaf'; panel: Panel };
export type ContainerNode = { id: string; type: 'row' | 'column'; children: LayoutNode[] };
export type LayoutNode = LeafNode | ContainerNode;

export function makeId(prefix = 'id') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createEmptyPanel(): Panel {
  return { id: makeId('panel'), sessions: [], activeIdx: 0 };
}

export function splitNodeWithSessions(
  root: LayoutNode,
  targetId: string,
  direction: 'row' | 'column',
  sessions: PanelSession[],
  insertBefore: boolean,
): LayoutNode {
  if (root.id === targetId && root.type === 'leaf') {
    const existing: LeafNode = { id: root.id, type: 'leaf', panel: { ...root.panel } };
    const newLeaf: LeafNode = { id: makeId('node'), type: 'leaf', panel: { id: makeId('panel'), sessions, activeIdx: 0 } };
    const children = insertBefore ? [newLeaf, existing] : [existing, newLeaf];
    return { id: makeId('container'), type: direction, children };
  }
  if (root.type === 'leaf') return root;
  return { ...root, children: root.children.map(child => splitNodeWithSessions(child, targetId, direction, sessions, insertBefore)) };
}

/**
 * 타겟 leaf 를 grid(행×열) 타일 레이아웃으로 교체. 첫 세션은 기존 leaf 의 panel 에
 * minitab 으로 추가되어 기존 세션들을 보존. 나머지 세션들은 각각 새 leaf 로 배치.
 * 차원 계산: cols = ceil(sqrt(N)), rows = ceil(N/cols). 마지막 행은 적을 수 있음.
 *   N=2 → 1×2 (좌우)
 *   N=3 → 2행(위2/아래1)
 *   N=4 → 2×2
 *   N=6 → 2×3
 *   N=9 → 3×3
 */
export function addSessionsAsTile(
  root: LayoutNode,
  targetLeafId: string,
  firstSession: PanelSession,
  extraSessions: PanelSession[],
): LayoutNode {
  const N = 1 + extraSessions.length;
  const cols = Math.ceil(Math.sqrt(N));
  const rows = Math.ceil(N / cols);

  const makeExtraLeaf = (sess: PanelSession): LeafNode => ({
    id: makeId('node'),
    type: 'leaf',
    panel: { id: makeId('panel'), sessions: [sess], activeIdx: 0 },
  });

  const walk = (node: LayoutNode): LayoutNode => {
    if (node.type === 'leaf' && node.id === targetLeafId) {
      // 기존 panel + 첫 세션을 minitab 으로 추가 (기존 세션 보존)
      const firstLeaf: LeafNode = {
        id: node.id,
        type: 'leaf',
        panel: {
          ...node.panel,
          sessions: [...node.panel.sessions, firstSession],
          activeIdx: node.panel.sessions.length,
        },
      };
      if (N === 1) return firstLeaf;
      const allLeaves: LeafNode[] = [firstLeaf, ...extraSessions.map(makeExtraLeaf)];
      const rowNodes: LayoutNode[] = [];
      for (let r = 0; r < rows; r++) {
        const start = r * cols;
        const rowLeaves = allLeaves.slice(start, start + cols);
        if (rowLeaves.length === 0) continue;
        if (rowLeaves.length === 1) {
          rowNodes.push(rowLeaves[0]);
        } else {
          rowNodes.push({ id: makeId('container'), type: 'row', children: rowLeaves });
        }
      }
      if (rowNodes.length === 1) return rowNodes[0];
      return { id: makeId('container'), type: 'column', children: rowNodes };
    }
    if (node.type === 'leaf') return node;
    return { ...node, children: node.children.map(walk) };
  };

  return walk(root);
}

export function splitNode(
  root: LayoutNode,
  targetId: string,
  direction: 'row' | 'column',
): LayoutNode {
  if (root.id === targetId && root.type === 'leaf') {
    const first: LeafNode = { id: root.id, type: 'leaf', panel: { ...root.panel } };
    const second: LeafNode = { id: makeId('node'), type: 'leaf', panel: createEmptyPanel() };
    return { id: makeId('container'), type: direction, children: [first, second] };
  }
  if (root.type === 'leaf') return root;
  return { ...root, children: root.children.map(child => splitNode(child, targetId, direction)) };
}

export function removeLeafNode(root: LayoutNode, targetId: string): LayoutNode {
  if (root.type === 'leaf') return root;
  const children = root.children
    .map(child => removeLeafNode(child, targetId))
    .filter(child => !(child.type === 'leaf' && child.id === targetId));
  if (children.length === 0) return root;
  if (children.length === 1) return children[0];
  return { ...root, children };
}

/** 패널에 새 세션 추가 (새 termId 생성) */
export function addSessionToPanel(
  root: LayoutNode,
  targetNodeId: string,
  sessionId: string,
  sessionName: string,
): { layout: LayoutNode; termId: string } {
  const termId = makeId('term');

  function walk(node: LayoutNode): LayoutNode {
    if (node.type === 'leaf') {
      if (node.id !== targetNodeId) return node;
      const newSession: PanelSession = { termId, sessionId, sessionName };
      const newSessions = [...node.panel.sessions, newSession];
      return {
        ...node,
        panel: { ...node.panel, sessions: newSessions, activeIdx: newSessions.length - 1 },
      };
    }
    return { ...node, children: node.children.map(walk) };
  }

  return { layout: walk(root), termId };
}

/** 기존 PanelSession 들을 패널에 그대로 추가 (termId 유지) */
export function appendSessionsToPanel(
  root: LayoutNode,
  targetNodeId: string,
  sessions: PanelSession[],
  switchToNew = true,
): LayoutNode {
  function walk(node: LayoutNode): LayoutNode {
    if (node.type === 'leaf') {
      if (node.id !== targetNodeId) return node;
      const newSessions = [...node.panel.sessions, ...sessions];
      return {
        ...node,
        panel: { ...node.panel, sessions: newSessions, activeIdx: switchToNew ? newSessions.length - 1 : node.panel.activeIdx },
      };
    }
    return { ...node, children: node.children.map(walk) };
  }
  return walk(root);
}

/** 기존 PanelSession으로 새 레이아웃 생성 (termId 유지) */
export function createLayoutWithSession(session: PanelSession): LayoutNode {
  return {
    id: makeId('node-root'),
    type: 'leaf',
    panel: { id: makeId('panel'), sessions: [session], activeIdx: 0 },
  };
}

/** 패널에서 세션 탭 제거 */
export function removeSessionFromPanel(
  root: LayoutNode,
  targetNodeId: string,
  termId: string,
): LayoutNode {
  function walk(node: LayoutNode): LayoutNode {
    if (node.type === 'leaf') {
      if (node.id !== targetNodeId) return node;
      const newSessions = node.panel.sessions.filter(s => s.termId !== termId);
      const newIdx = Math.min(node.panel.activeIdx, Math.max(0, newSessions.length - 1));
      return { ...node, panel: { ...node.panel, sessions: newSessions, activeIdx: newIdx } };
    }
    return { ...node, children: node.children.map(walk) };
  }
  return walk(root);
}

/** 패널 내 세션 순서 변경 (드래그로 재정렬) */
export function reorderPanelSession(
  root: LayoutNode,
  targetNodeId: string,
  fromIdx: number,
  toIdx: number,
): LayoutNode {
  function walk(node: LayoutNode): LayoutNode {
    if (node.type === 'leaf') {
      if (node.id !== targetNodeId) return node;
      const sessions = [...node.panel.sessions];
      const [moved] = sessions.splice(fromIdx, 1);
      sessions.splice(toIdx, 0, moved);
      // activeIdx가 이동한 세션을 따라가도록 조정
      let activeIdx = node.panel.activeIdx;
      if (activeIdx === fromIdx) activeIdx = toIdx;
      else if (fromIdx < activeIdx && toIdx >= activeIdx) activeIdx--;
      else if (fromIdx > activeIdx && toIdx <= activeIdx) activeIdx++;
      return { ...node, panel: { ...node.panel, sessions, activeIdx } };
    }
    return { ...node, children: node.children.map(walk) };
  }
  return walk(root);
}

/** 패널의 활성 세션 탭 전환 */
export function switchPanelSession(
  root: LayoutNode,
  targetNodeId: string,
  idx: number,
): LayoutNode {
  function walk(node: LayoutNode): LayoutNode {
    if (node.type === 'leaf') {
      if (node.id !== targetNodeId) return node;
      return { ...node, panel: { ...node.panel, activeIdx: idx } };
    }
    return { ...node, children: node.children.map(walk) };
  }
  return walk(root);
}

export function countLeaves(node: LayoutNode): number {
  if (node.type === 'leaf') return 1;
  return node.children.reduce((sum, child) => sum + countLeaves(child), 0);
}

export function findFirstLeafId(node: LayoutNode): string | null {
  if (node.type === 'leaf') return node.id;
  for (const child of node.children) {
    const found = findFirstLeafId(child);
    if (found) return found;
  }
  return null;
}

/** 트리에서 세션이 없는(빈) 첫 번째 leaf의 id를 반환 */
export function findEmptyLeafId(node: LayoutNode): string | null {
  if (node.type === 'leaf') return node.panel.sessions.length === 0 ? node.id : null;
  for (const child of node.children) {
    const found = findEmptyLeafId(child);
    if (found) return found;
  }
  return null;
}

/** 전체 트리에서 특정 sessionId가 연결된 수를 셈 */
export function countSessionInTree(node: LayoutNode, sessionId: string): number {
  if (node.type === 'leaf') return node.panel.sessions.filter(s => s.sessionId === sessionId).length;
  return node.children.reduce((sum, c) => sum + countSessionInTree(c, sessionId), 0);
}

/** 전체 트리에서 모든 PanelSession 수집 */
export function collectAllSessions(node: LayoutNode): PanelSession[] {
  if (node.type === 'leaf') return [...node.panel.sessions];
  return node.children.flatMap(collectAllSessions);
}

export function createInitialLayout(_tabId: string, shellName?: string, shellPath?: string): LayoutNode {
  const termId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id: makeId('node-root'),
    type: 'leaf',
    panel: {
      id: makeId('panel'),
      sessions: [{ termId, sessionId: '', sessionName: shellName || 'Local Shell', shellPath }],
      activeIdx: 0,
    },
  };
}

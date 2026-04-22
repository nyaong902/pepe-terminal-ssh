// src/components/Layout.tsx
import React, { useState, useRef, useEffect } from 'react';
import type { LayoutNode, ContainerNode } from '../utils/layoutUtils';
import { TerminalPanel, refitAllTerms, setSuppressPtyResize } from './TerminalPanel';

type CommonHandlers = {
  selectedPanelId?: string | null;
  onSplit: (nodeId: string, dir: 'row' | 'column') => void;
  onClose: (nodeId: string) => void;
  onSelectPanel?: (nodeId: string) => void;
  onMovePanel?: (fromPanelId: string, toPanelId: string | null, position?: 'before' | 'after' | 'inside') => void;
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
  treeWidth?: number;
  onTreeWidthChange?: (w: number) => void;
  onOpenRemoteFile?: (termId: string, remotePath: string, fileName: string) => void;
  onAttachToClaude?: (termId: string, remotePath: string, fileName: string, isDir: boolean) => void;
  floatingPanelId?: string | null;
  onToggleFloat?: (nodeId: string) => void;
};

type Props = CommonHandlers & { root: LayoutNode };
type NodeProps = CommonHandlers & { node: LayoutNode };
type CProps = CommonHandlers & { node: ContainerNode };

export const Layout: React.FC<Props> = ({ root, ...h }) => (
  <div className="layout-root">
    <NodeView node={root} {...h} />
  </div>
);

const NodeView: React.FC<NodeProps> = ({ node, ...h }) => {
  if (node.type === 'leaf') {
    const handleDrop = (e: React.DragEvent) => {
      // text/mini-session is handled by TerminalPanel (with stopPropagation)
      const from = e.dataTransfer?.getData('text/panel-id');
      if (from && h.onMovePanel) h.onMovePanel(from, node.id, 'inside');
    };
    const activeTermId = node.panel.sessions[node.panel.activeIdx]?.termId || '';
    const isFloating = h.floatingPanelId === node.id;
    return (
      <div className={`layout-leaf ${isFloating ? 'floating' : ''}`} data-active-term={activeTermId}>
        <div className={`layout-leaf-inner ${h.selectedPanelId === node.id ? 'selected' : ''}`}
          onDragOver={e => e.preventDefault()} onDrop={handleDrop}
        >
          <TerminalPanel
            nodeId={node.id} panel={node.panel}
            onSplit={h.onSplit} onClose={h.onClose} onSelect={h.onSelectPanel}
            onSwitchSession={h.onSwitchSession} onCloseSession={h.onCloseSession}
            onMoveSession={h.onMoveSession} onSplitMoveSession={h.onSplitMoveSession}
            onReorderSession={h.onReorderSession} onAddSession={h.onAddSession}
            onRenameSession={h.onRenameSession} onConnectDrop={h.onConnectDrop}
            onDuplicateSession={h.onDuplicateSession} availableShells={h.availableShells}
            treeWidth={h.treeWidth} onTreeWidthChange={h.onTreeWidthChange}
            onOpenRemoteFile={h.onOpenRemoteFile} onAttachToClaude={h.onAttachToClaude}
            isFloating={isFloating} onToggleFloat={h.onToggleFloat}
          />
        </div>
      </div>
    );
  }
  return <ContainerNodeView node={node} {...h} />;
};

function ContainerNodeView({ node, ...h }: CProps) {
  const isRow = node.type === 'row';
  const [sizes, setSizes] = useState<number[]>(() => node.children.map(() => 1));
  const prevCountRef = useRef(node.children.length);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef<{ index: number; start: number; sizes: number[] } | null>(null);

  useEffect(() => {
    const prev = prevCountRef.current, cur = node.children.length;
    if (prev !== cur) {
      const ns = new Array(cur).fill(1);
      for (let i = 0; i < Math.min(prev, cur); i++) ns[i] = sizes[i];
      const ps = sizes.reduce((a, b) => a + b, 0) || 1;
      const s = ns.reduce((a, b) => a + b, 0) || 1;
      for (let i = 0; i < ns.length; i++) ns[i] = (ns[i] / s) * ps;
      setSizes(ns); prevCountRef.current = cur;
    }
  }, [node.children.length]);

  const onMouseDown = (e: React.MouseEvent, index: number) => {
    e.preventDefault();
    dragging.current = { index, start: isRow ? e.clientX : e.clientY, sizes: [...sizes] };
    setSuppressPtyResize(true);
    window.addEventListener('mousemove', onMouseMove); window.addEventListener('mouseup', onMouseUp);
  };
  const onMouseMove = (ev: MouseEvent) => {
    if (!dragging.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const { index, start, sizes: ps } = dragging.current;
    const delta = (isRow ? ev.clientX : ev.clientY) - start;
    const total = isRow ? rect.width : rect.height;
    if (total <= 0) return;
    const pSum = ps.reduce((a, b) => a + b, 0);
    let nL = (ps[index] / pSum) * total + delta, nR = (ps[index + 1] / pSum) * total - delta;
    const min = 40, comb = (ps[index] / pSum + ps[index + 1] / pSum) * total;
    if (nL < min) { nL = min; nR = comb - min; } if (nR < min) { nR = min; nL = comb - min; }
    const ns = [...ps]; ns[index] = (nL / total) * pSum; ns[index + 1] = (nR / total) * pSum; setSizes(ns);
  };
  const onMouseUp = () => {
    dragging.current = null;
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    setSuppressPtyResize(false);
    // 드래그 종료 후 단 한 번만 PTY에 최종 cols/rows 전달
    setTimeout(() => { window.dispatchEvent(new Event('resize')); refitAllTerms(); }, 80);
  };

  return (
    <div ref={containerRef} className="layout-container" style={{ flexDirection: isRow ? 'row' : 'column' }}>
      {node.children.map((child: LayoutNode, i: number) => (
        <React.Fragment key={child.id}>
          <div className="layout-child" style={{ flex: sizes[i] }}>
            <NodeView node={child} {...h} />
          </div>
          {i < node.children.length - 1 && (
            <div className={`layout-divider ${isRow ? 'row' : 'column'}`} onMouseDown={e => onMouseDown(e, i)}>
              <div className="layout-divider-line" />
            </div>
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

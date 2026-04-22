// src/components/ContextMenu.tsx
import React, { useEffect, useRef } from 'react';

export type MenuItem = {
  label: string;
  onClick: () => void;
};

type Props = {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
};

export const ContextMenu: React.FC<Props> = ({ x, y, items, onClose }) => {
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // document capture 페이즈에서 mousedown 을 가로채서 메뉴 밖 클릭이면 닫는다.
    // xterm 등 내부 요소가 stopPropagation 해도 capture 단계는 먼저 실행돼서 영향 없음.
    // 현재 이벤트 루프 턴에 등록하면 메뉴를 연 바로 그 클릭이 여기에 걸리므로 다음 틱에 등록.
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', onDown, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  return (
    <div ref={menuRef} className="context-menu" style={{ top: y, left: x }} onClick={e => e.stopPropagation()}>
      {items.map((item, i) => (
        <div key={i} className="context-menu-item" onClick={() => { item.onClick(); onClose(); }}>
          {item.label}
        </div>
      ))}
    </div>
  );
};

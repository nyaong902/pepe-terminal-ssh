// src/components/ContextMenu.tsx
import React, { useEffect } from 'react';

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
  useEffect(() => {
    const close = () => onClose();
    // 다음 이벤트 루프에서 리스너 등록 (현재 클릭 이벤트 버블링 방지)
    const timer = setTimeout(() => window.addEventListener('click', close), 0);
    return () => { clearTimeout(timer); window.removeEventListener('click', close); };
  }, [onClose]);

  return (
    <div className="context-menu" style={{ top: y, left: x }} onClick={e => e.stopPropagation()}>
      {items.map((item, i) => (
        <div key={i} className="context-menu-item" onClick={() => { item.onClick(); onClose(); }}>
          {item.label}
        </div>
      ))}
    </div>
  );
};

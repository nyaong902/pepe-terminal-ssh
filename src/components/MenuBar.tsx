// src/components/MenuBar.tsx
import React, { useState, useEffect, useCallback } from 'react';

type MenuItemDef = {
  label: string;
  shortcut?: string;
  action?: () => void;
  separator?: boolean;
  submenu?: MenuItemDef[];
  disabled?: boolean;
};

type MenuDef = {
  label: string;
  items: MenuItemDef[];
};

type Props = {
  menus: MenuDef[];
};

export type { MenuDef, MenuItemDef };

export const MenuBar: React.FC<Props> = ({ menus }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const [subOpen, setSubOpen] = useState<string | null>(null);
  const [subPos, setSubPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  const close = useCallback(() => { setIsOpen(false); setOpenIdx(null); setSubOpen(null); }, []);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.hamburger-menu')) close();
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [isOpen, close]);

  const handleItemClick = (item: MenuItemDef) => {
    if (item.disabled || item.submenu) return;
    item.action?.();
    close();
  };

  return (
    <div className="hamburger-menu">
      <button className="hamburger-btn" onClick={() => { setIsOpen(p => !p); setOpenIdx(null); setSubOpen(null); }} title="메뉴">
        <span className="hamburger-icon">&#9776;</span>
      </button>
      {isOpen && (
        <div className="hamburger-dropdown">
          {menus.map((menu, idx) => (
            <div key={idx} className="hamburger-group">
              <div
                className={`hamburger-group-title ${openIdx === idx ? 'open' : ''}`}
                onClick={() => setOpenIdx(prev => prev === idx ? null : idx)}
              >
                <span>{menu.label}</span>
                <span className="hamburger-group-arrow">{openIdx === idx ? '▼' : '▶'}</span>
              </div>
              {openIdx === idx && (
                <div className="hamburger-group-items">
                  {menu.items.map((item, i) => {
                    if (item.separator) return <div key={i} className="menu-separator" />;
                    const hasSubmenu = item.submenu && item.submenu.length > 0;
                    const subKey = `${idx}-${i}`;
                    return (
                      <div
                        key={i}
                        className={`menu-item ${item.disabled ? 'disabled' : ''} ${hasSubmenu ? 'has-submenu' : ''}`}
                        onClick={e => {
                          if (hasSubmenu) {
                            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                            setSubPos({ top: rect.top, left: rect.right });
                            setSubOpen(prev => prev === subKey ? null : subKey);
                            return;
                          }
                          handleItemClick(item);
                        }}
                        onMouseEnter={e => {
                          if (!hasSubmenu) { setSubOpen(null); return; }
                          // 이미 다른 서브메뉴가 열려있을 때만 전환
                          if (subOpen && subOpen !== subKey) {
                            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                            setSubPos({ top: rect.top, left: rect.right });
                            setSubOpen(subKey);
                          }
                        }}
                        onMouseLeave={e => {
                          if (!hasSubmenu) return;
                          const related = e.relatedTarget as HTMLElement;
                          if (related?.closest('.menu-submenu')) return;
                          setSubOpen(null);
                        }}
                      >
                        <span className="menu-item-label">{item.label}</span>
                        {item.shortcut && <span className="menu-item-shortcut">{item.shortcut}</span>}
                        {hasSubmenu && <span className="menu-item-arrow">&#9654;</span>}
                        {hasSubmenu && subOpen === subKey && (
                          <div className="menu-submenu" style={{ top: subPos.top, left: subPos.left }} onMouseLeave={() => setSubOpen(null)}>
                            {item.submenu!.map((sub, si) => (
                              sub.separator ? <div key={si} className="menu-separator" /> :
                              <div key={si} className={`menu-item ${sub.disabled ? 'disabled' : ''}`} onClick={e => { e.stopPropagation(); sub.action?.(); close(); }}>
                                <span className="menu-item-label">{sub.label}</span>
                                {sub.shortcut && <span className="menu-item-shortcut">{sub.shortcut}</span>}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

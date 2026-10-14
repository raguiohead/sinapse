import { useEffect, useRef, useState, type ReactNode } from "react";

export interface ContextMenuActionItem {
  type: "action";
  label: string;
  icon?: ReactNode;
  action: () => void;
  danger?: boolean;
}

export interface ContextMenuSeparatorItem {
  type: "separator";
}

export type ContextMenuItem = ContextMenuActionItem | ContextMenuSeparatorItem;
export type MenuItem = ContextMenuItem;

export interface ContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  items?: ContextMenuItem[];
  onNewWorker?: () => void;
  onNewNote?: () => void;
  onOpenSettings?: () => void;
}

export function ContextMenu({
  x,
  y,
  onClose,
  items,
  onNewWorker,
  onNewNote,
  onOpenSettings,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const defaultItems: MenuItem[] = [
    {
      type: "action",
      label: "Novo worker",
      icon: (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 2a4 4 0 0 1 4 4v2a4 4 0 0 1-8 0V6a4 4 0 0 1 4-4z" />
          <path d="M6 14h12a4 4 0 0 1 4 4v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-2a4 4 0 0 1 4-4z" />
        </svg>
      ),
      action: () => {
        onNewWorker?.();
      },
    },
    {
      type: "action",
      label: "Nova nota",
      icon: (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="12" y1="18" x2="12" y2="12" />
          <line x1="9" y1="15" x2="15" y2="15" />
        </svg>
      ),
      action: () => {
        onNewNote?.();
      },
    },
    { type: "separator" },
    {
      type: "action",
      label: "Configurações",
      icon: (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      ),
      action: () => {
        onOpenSettings?.();
      },
    },
  ];

  const menuItems: MenuItem[] = items && items.length > 0 ? items : defaultItems;
  const actions = menuItems.filter((i): i is ContextMenuActionItem => i.type === "action");

  // Clamping within window boundaries
  const MENU_WIDTH = 190;
  const MENU_HEIGHT = Math.max(40, menuItems.length * 36 + 16);
  const clampedX = Math.max(8, Math.min(x, window.innerWidth - MENU_WIDTH - 8));
  const clampedY = Math.max(40, Math.min(y, window.innerHeight - MENU_HEIGHT - 8));

  useEffect(() => {
    menuRef.current?.focus();

    const handlePointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleWheel = () => {
      onClose();
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("wheel", handleWheel, { passive: true });

    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("wheel", handleWheel);
    };
  }, [onClose]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % actions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + actions.length) % actions.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const currentAction = actions[selectedIndex];
      if (currentAction) {
        onClose();
        currentAction.action();
      }
    }
  };

  let actionCounter = 0;

  return (
    <div
      ref={menuRef}
      tabIndex={-1}
      className="context-menu nodrag"
      style={{ left: `${clampedX}px`, top: `${clampedY}px` }}
      onKeyDown={handleKeyDown}
      role="menu"
    >
      {menuItems.map((item, idx) => {
        if (item.type === "separator") {
          return <div key={`sep-${idx}`} className="context-menu-separator" role="separator" />;
        }

        const isCurrentAction = actionCounter === selectedIndex;
        const currentIdx = actionCounter;
        actionCounter++;

        return (
          <button
            key={item.label}
            type="button"
            className={`context-menu-item ${isCurrentAction ? "active" : ""} ${item.danger ? "danger" : ""}`}
            onClick={() => {
              onClose();
              item.action();
            }}
            onMouseEnter={() => setSelectedIndex(currentIdx)}
            role="menuitem"
          >
            {item.icon && <span className="context-menu-icon">{item.icon}</span>}
            <span className="context-menu-label">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}

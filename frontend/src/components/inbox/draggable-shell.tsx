'use client';

import { useRef, useState } from 'react';
import { GripHorizontal, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Floating, draggable window. No backdrop — the inbox behind stays fully
 * interactive (select/copy chat text). Drag by the header (desktop). Closes
 * only via the X / Cancel button. Full-screen on mobile.
 */
export function DraggableShell({
  title,
  onClose,
  footer,
  children,
}: {
  title: string;
  onClose: () => void;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const dragState = useRef<{
    ox: number;
    oy: number;
    px: number;
    py: number;
  } | null>(null);

  const onHeaderDown = (e: React.MouseEvent) => {
    // Drag is a desktop affordance only; mobile is full-screen.
    if (typeof window !== 'undefined' && window.innerWidth < 640) return;
    e.preventDefault();
    dragState.current = {
      ox: drag?.x ?? 0,
      oy: drag?.y ?? 0,
      px: e.clientX,
      py: e.clientY,
    };
    const move = (ev: MouseEvent) => {
      const s = dragState.current;
      if (!s) return;
      setDrag({ x: s.ox + (ev.clientX - s.px), y: s.oy + (ev.clientY - s.py) });
    };
    const up = () => {
      dragState.current = null;
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    // pointer-events-none so clicks outside the card reach the chat behind it.
    <div className="fixed inset-0 z-[90] pointer-events-none">
      <div
        role="dialog"
        aria-modal="false"
        aria-label={title}
        style={
          drag
            ? { transform: `translate(calc(-50% + ${drag.x}px), calc(-50% + ${drag.y}px))` }
            : undefined
        }
        className={cn(
          'pointer-events-auto bg-white flex flex-col shadow-2xl ring-1 ring-black/10',
          // Mobile: full screen. Desktop: centered floating card.
          'absolute inset-0 h-full',
          'sm:inset-auto sm:h-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2',
          'sm:w-[640px] sm:max-w-[calc(100vw-2rem)] sm:max-h-[90vh] sm:rounded-2xl',
        )}
      >
        <div
          onMouseDown={onHeaderDown}
          className="flex items-center gap-2 px-5 py-4 border-b border-gray-200 shrink-0 sm:cursor-move select-none"
        >
          <GripHorizontal
            size={16}
            className="hidden sm:block text-gray-300 shrink-0"
          />
          <h2 className="text-lg font-semibold text-gray-900 mr-auto">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-gray-400 hover:text-gray-600"
          >
            <X size={20} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="px-5 py-4 border-t border-gray-200 flex justify-end gap-2 shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

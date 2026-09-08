'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Pin, X } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { useSocket } from '@/context/socket-context';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';

interface PinItem {
  conversationId: number;
  pinnedAt: string;
  contactName: string;
  phone: string | null;
  lastMessage: string | null;
  assignedName: string | null;
}
interface AgentPins {
  user: { id: number; name: string; role: string };
  count: number;
  pins: PinItem[];
}

/**
 * Owner/admin only: a collapsible "Pinned by team" accordion at the top of the
 * inbox list, grouping every user's pins (max 3 each) by agent. Clicking a pin
 * opens that chat; the X unpins it for that agent. Refetches on the `pins.updated`
 * socket signal so it stays live as agents pin/unpin.
 */
export function PinnedByTeam({ onOpen }: { onOpen: (id: number) => void }) {
  const { on } = useSocket();
  const toast = useToast();
  const [groups, setGroups] = useState<AgentPins[]>([]);
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    try {
      setGroups(await apiFetch<AgentPins[]>('/inbox/pins/by-agent'));
    } catch {
      setGroups([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => on('pins.updated', () => load()), [on, load]);

  const total = groups.reduce((n, g) => n + g.count, 0);
  if (total === 0) return null; // nobody has pinned anything → hide the section

  const toggleAgent = (id: number) =>
    setExpanded((prev) => {
      const s = new Set(prev);
      s.has(id) ? s.delete(id) : s.add(id);
      return s;
    });

  const unpin = async (userId: number, conversationId: number) => {
    try {
      await apiFetch(`/inbox/pins/${userId}/${conversationId}`, { method: 'DELETE' });
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to unpin');
    }
  };

  return (
    <div className="border-b border-gray-200 bg-gray-50/70">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-xs font-semibold text-gray-600 hover:bg-gray-100"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Pin size={12} className="text-green-600" />
        Pinned by team
        <span className="ml-auto text-[11px] font-normal text-gray-400">{total}</span>
      </button>
      {open && (
        <div className="pb-1">
          {groups.map((g) => {
            const isOpen = expanded.has(g.user.id);
            return (
              <div key={g.user.id}>
                <button
                  onClick={() => toggleAgent(g.user.id)}
                  className="flex w-full items-center gap-1.5 px-4 py-1.5 text-xs text-gray-700 hover:bg-gray-100"
                >
                  {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <span className="truncate font-medium">{g.user.name}</span>
                  <span className="shrink-0 text-gray-400">· {g.user.role}</span>
                  <span className="ml-auto shrink-0 text-[11px] text-gray-400">
                    {g.count}/3
                  </span>
                </button>
                {isOpen &&
                  g.pins.map((p) => (
                    <div
                      key={p.conversationId}
                      className={cn(
                        'group flex items-center gap-2 py-1.5 pl-9 pr-2 hover:bg-gray-100',
                      )}
                    >
                      <button
                        onClick={() => onOpen(p.conversationId)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <p className="truncate text-xs font-medium text-gray-800">
                          {p.contactName}
                        </p>
                        {p.lastMessage && (
                          <p className="truncate text-[11px] text-gray-400">
                            {p.lastMessage}
                          </p>
                        )}
                      </button>
                      <button
                        onClick={() => unpin(g.user.id, p.conversationId)}
                        title="Unpin for this agent"
                        className="shrink-0 rounded p-0.5 text-gray-300 hover:bg-rose-50 hover:text-rose-600"
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

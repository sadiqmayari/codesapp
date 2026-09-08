'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Pin, X } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { useSocket } from '@/context/socket-context';
import { useToast } from '@/components/toast';

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
 * inbox list, grouping every user's pins (max 3 each) by agent. Each agent's
 * pins (and the ✕ unpin) are shown straight away. Clicking a pin opens that chat;
 * the ✕ unpins it for that agent. Refetches on the `pins.updated` socket signal
 * AND on every socket (re)connect, so it stays live without a page refresh.
 */
export function PinnedByTeam({ onOpen }: { onOpen: (id: number) => void }) {
  const { on, status } = useSocket();
  const toast = useToast();
  const [groups, setGroups] = useState<AgentPins[]>([]);
  const [open, setOpen] = useState(true);

  const load = useCallback(async () => {
    try {
      setGroups(await apiFetch<AgentPins[]>('/inbox/pins/by-agent'));
    } catch {
      setGroups([]);
    }
  }, []);

  // Load on mount and whenever the socket (re)connects — self-heals if the
  // socket wasn't ready when we first subscribed.
  useEffect(() => {
    load();
  }, [load, status]);
  // Live: refetch whenever anyone in the company pins/unpins. `status` in deps
  // re-attaches the listener to the current socket after a (re)connect.
  useEffect(() => on('pins.updated', () => load()), [on, load, status]);

  const total = groups.reduce((n, g) => n + g.count, 0);
  if (total === 0) return null; // nobody has pinned anything → hide the section

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
          {groups.map((g) => (
            <div key={g.user.id}>
              <div className="flex items-center gap-1.5 px-4 pt-1.5 pb-0.5 text-[11px] uppercase tracking-wide text-gray-400">
                <span className="truncate font-semibold text-gray-500">
                  {g.user.name}
                </span>
                <span className="shrink-0">· {g.user.role}</span>
                <span className="ml-auto shrink-0">{g.count}/3</span>
              </div>
              {g.pins.map((p) => (
                <div
                  key={p.conversationId}
                  className="flex items-center gap-2 py-1.5 pl-6 pr-2 hover:bg-gray-100"
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
                    className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-rose-50 hover:text-rose-600"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Megaphone, MessageSquare, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface TeamDrawerMessage {
  /** Unique key for this drawer card (message id or a synthetic id). */
  key: string;
  threadId: number;
  threadKind: 'dm' | 'broadcast';
  senderName: string | null;
  senderRole: string | null;
  preview: string;
}

function roleLabel(role: string | null): string {
  if (role === 'owner') return 'Owner';
  if (role === 'admin') return 'Admin';
  return 'Team';
}

/**
 * In-app notification drawer shown to AGENTS at the bottom-right when an
 * owner/admin posts in team chat (a broadcast announcement or a direct message).
 * Cards auto-dismiss and deep-link into the relevant team-chat thread. Sits
 * above the app shell; purely presentational — the Shell owns the queue.
 */
export function TeamMessageDrawer({
  messages,
  onDismiss,
}: {
  messages: TeamDrawerMessage[];
  onDismiss: (key: string) => void;
}) {
  if (messages.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-[60] flex w-[min(20rem,calc(100vw-2rem))] flex-col gap-2">
      {messages.map((m) => (
        <DrawerCard key={m.key} m={m} onDismiss={() => onDismiss(m.key)} />
      ))}
    </div>
  );
}

function DrawerCard({
  m,
  onDismiss,
}: {
  m: TeamDrawerMessage;
  onDismiss: () => void;
}) {
  const router = useRouter();
  const isBroadcast = m.threadKind === 'broadcast';

  // Auto-dismiss after a while so the stack doesn't pile up.
  useEffect(() => {
    const t = setTimeout(onDismiss, 9000);
    return () => clearTimeout(t);
  }, [onDismiss]);

  const open = () => {
    router.push(`/team-chat?t=${m.threadId}`);
    onDismiss();
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
      className={cn(
        'group relative cursor-pointer overflow-hidden rounded-xl border bg-white p-3 pr-8 shadow-lg transition hover:shadow-xl',
        isBroadcast ? 'border-amber-200' : 'border-gray-200',
      )}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
        aria-label="Dismiss"
        className="absolute right-1.5 top-1.5 rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
      >
        <X size={14} />
      </button>
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
            isBroadcast
              ? 'bg-amber-100 text-amber-600'
              : 'bg-green-100 text-green-700',
          )}
        >
          {isBroadcast ? <Megaphone size={14} /> : <MessageSquare size={14} />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold text-gray-900">
            {isBroadcast ? 'Announcement' : m.senderName || 'Team message'}
          </p>
          <p className="truncate text-[11px] text-gray-500">
            {m.senderName ? `${m.senderName} · ` : ''}
            {roleLabel(m.senderRole)}
          </p>
        </div>
      </div>
      <p className="mt-1.5 line-clamp-2 text-sm text-gray-700">{m.preview}</p>
    </div>
  );
}

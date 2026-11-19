'use client';

import { useCallback, useEffect, useState } from 'react';
import { Bot, PauseCircle, Moon, UserRound, Ban, Headphones } from 'lucide-react';
import { useSocket } from '@/context/socket-context';
import { useToast } from '@/components/toast';
import { ConfirmDialog } from '@/components/ui/modal';
import { getChatAiState, resumeAi, type ChatAiStateResult } from '@/lib/ai-agent';
import { cn } from '@/lib/utils';

const META: Record<
  ChatAiStateResult['state'],
  { label: string; tone: string; icon: typeof Bot; title: string; resumable?: boolean } | null
> = {
  off: null,
  on_workspace: { label: 'AI on', tone: 'bg-violet-50 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300', icon: Bot, title: 'The AI answers this chat (workspace setting).' },
  on_chat: { label: 'Auto-pilot', tone: 'bg-violet-50 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300', icon: Bot, title: 'AI auto-pilot is on for this chat.' },
  muted: { label: 'AI muted', tone: 'bg-sunken text-muted', icon: Ban, title: 'An agent turned the AI off for this chat. Click to give it back.', resumable: true },
  handed_off: { label: 'Handed to team', tone: 'bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300', icon: Headphones, title: 'The AI handed this chat to a person. Click to give it back to the AI.', resumable: true },
  human_active: { label: 'You replied · AI paused', tone: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300', icon: UserRound, title: 'The AI waits while your team is replying.' },
  off_hours: { label: 'After hours', tone: 'bg-sky-50 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300', icon: Moon, title: 'Outside business hours — the AI follows your off-hours setting.' },
  blocked: { label: 'AI paused', tone: 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300', icon: PauseCircle, title: 'AI is paused for the workspace (limit reached or switched off).' },
};

/**
 * One badge that tells agents what the AI is doing in THIS chat: on (workspace
 * / auto-pilot), muted, handed to the team, paused because a human replied,
 * after hours, or paused for the workspace. Handed-off / muted chats can be
 * given back to the AI from here. Live on `conversation.updated`.
 */
export function AiStateBadge({ conversationId }: { conversationId: number }) {
  const { on } = useSocket();
  const toast = useToast();
  const [st, setSt] = useState<ChatAiStateResult | null>(null);
  const [confirm, setConfirm] = useState(false);

  const load = useCallback(() => {
    getChatAiState(conversationId)
      .then(setSt)
      .catch(() => setSt(null));
  }, [conversationId]);

  useEffect(() => {
    load();
    const off = on<{ conversationId?: number }>('conversation.updated', (p) => {
      if (p?.conversationId === conversationId) load();
    });
    const t = setInterval(load, 60_000);
    return () => {
      off();
      clearInterval(t);
    };
  }, [conversationId, load, on]);

  if (!st) return null;
  const m = META[st.state];
  if (!m) return null;
  const Icon = m.icon;
  const until = st.until ? new Date(st.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null;

  return (
    <>
      <span
        role={m.resumable ? 'button' : undefined}
        tabIndex={m.resumable ? 0 : undefined}
        onClick={(e) => {
          if (!m.resumable) return;
          e.stopPropagation();
          setConfirm(true);
        }}
        onKeyDown={(e) => {
          if (m.resumable && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            e.stopPropagation();
            setConfirm(true);
          }
        }}
        title={`${m.title}${until ? ` (until ${until})` : ''}`}
        className={cn(
          'inline-flex shrink-0 items-center gap-0.5 rounded px-1.5 text-xs font-semibold',
          m.tone,
          m.resumable && 'cursor-pointer hover:opacity-80',
        )}
      >
        <Icon size={12} /> <span className="hidden sm:inline">{m.label}</span>
      </span>
      <ConfirmDialog
        open={confirm}
        title="Give this chat back to the AI?"
        message="The AI will start replying to this customer again."
        confirmLabel="Resume AI"
        onConfirm={async () => {
          setConfirm(false);
          try {
            await resumeAi(conversationId);
            toast.success('AI resumed for this chat');
            load();
          } catch {
            toast.error('Could not resume the AI');
          }
        }}
        onCancel={() => setConfirm(false)}
      />
    </>
  );
}

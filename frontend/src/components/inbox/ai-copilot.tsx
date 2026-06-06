'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Sparkles,
  MessageSquarePlus,
  Wand2,
  Languages,
  FileText,
  Copy,
  Loader2,
  Bot,
} from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/toast';
import { ApiError } from '@/lib/api';
import {
  aiRewrite,
  aiSetConversationAutoReply,
  aiSuggestReply,
  aiSummarize,
  aiTranslate,
  type RewriteMode,
} from '@/lib/ai';

const REWRITE_OPTS: { mode: RewriteMode; label: string }[] = [
  { mode: 'polite', label: 'Make polite' },
  { mode: 'shorten', label: 'Shorten' },
  { mode: 'expand', label: 'Expand' },
  { mode: 'fix', label: 'Fix grammar' },
];

const LANGS = ['English', 'Urdu', 'Roman Urdu'];

/**
 * AI Copilot composer affordance. Suggest-only — every result lands in the
 * composer for the agent to review before sending; Summarize opens a modal.
 * Hidden by the parent when AI isn't in the plan.
 */
export default function AiCopilot({
  conversationId,
  getText,
  onInsert,
  disabled,
  autoReplyOn,
  autoReplyMuted,
  allChatsOn,
  onAutoReplyChange,
}: {
  conversationId: number;
  /** Read the composer's current text (for rewrite/translate). */
  getText: () => string;
  /** Replace the composer text with the AI result. */
  onInsert: (text: string) => void;
  disabled?: boolean;
  /** Current per-chat auto-pilot state (true = forced on this chat). */
  autoReplyOn?: boolean;
  /** Chat is explicitly muted (ai_autoreply === false, e.g. after a handoff). */
  autoReplyMuted?: boolean;
  /** Workspace "answer all chats" is on → per-chat toggle is disabled. */
  allChatsOn?: boolean;
  /** Notify the parent after the per-chat auto-pilot is toggled. */
  onAutoReplyChange?: (on: boolean | null) => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const handleError = (e: unknown) => {
    const msg =
      e instanceof ApiError ? e.userMessage : 'AI request failed. Try again.';
    toast.error(msg);
  };

  const run = async (
    key: string,
    fn: () => Promise<{ text: string }>,
    onResult: (text: string) => void,
  ) => {
    if (busy) return;
    setBusy(key);
    setOpen(false);
    try {
      const { text } = await fn();
      if (text.trim()) onResult(text.trim());
      else toast.info('The assistant returned nothing — try again.');
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(null);
    }
  };

  const setAuto = async (mode: 'on' | 'off' | 'default') => {
    if (busy) return;
    setBusy('autopilot');
    setOpen(false);
    try {
      await aiSetConversationAutoReply(conversationId, mode);
      onAutoReplyChange?.(mode === 'on' ? true : mode === 'off' ? false : null);
      toast.success(
        mode === 'on'
          ? 'Auto-pilot ON — the AI will reply to this chat'
          : mode === 'off'
            ? 'Auto-pilot off for this chat'
            : 'AI resumed for this chat',
      );
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(null);
    }
  };

  const needText = (): string | null => {
    const t = getText().trim();
    if (!t) {
      toast.info('Type a message first.');
      return null;
    }
    return t;
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled || !!busy}
        title="AI Copilot"
        aria-haspopup="menu"
        aria-expanded={open}
        className="p-2.5 rounded-full bg-gradient-to-br from-indigo-500 via-violet-500 to-fuchsia-500 text-white shadow-sm hover:shadow-md hover:brightness-110 transition disabled:opacity-40"
      >
        {busy ? (
          <Loader2 size={20} className="animate-spin" />
        ) : (
          <Sparkles size={20} />
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 bottom-full mb-2 w-56 bg-white border border-gray-200 rounded-lg shadow-lg py-1 text-sm z-30"
        >
          {allChatsOn && !autoReplyMuted ? (
            // Workspace answers all chats → per-chat toggle is disabled.
            <div className="w-full px-3 py-2 flex items-center justify-between gap-2 opacity-70">
              <span className="flex items-center gap-2">
                <Bot size={16} className="text-emerald-600" />
                Auto-pilot this chat
              </span>
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">
                ALL CHATS
              </span>
            </div>
          ) : allChatsOn && autoReplyMuted ? (
            // Handed-off under all-chats → let a human resume the AI here.
            <button
              role="menuitem"
              onClick={() => setAuto('default')}
              className="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center justify-between gap-2"
            >
              <span className="flex items-center gap-2">
                <Bot size={16} className="text-gray-400" />
                Resume AI on this chat
              </span>
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">
                PAUSED
              </span>
            </button>
          ) : (
            <button
              role="menuitem"
              onClick={() => setAuto(autoReplyOn ? 'off' : 'on')}
              className="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center justify-between gap-2"
            >
              <span className="flex items-center gap-2">
                <Bot
                  size={16}
                  className={autoReplyOn ? 'text-emerald-600' : 'text-gray-400'}
                />
                Auto-pilot this chat
              </span>
              <span
                className={
                  'text-[10px] font-semibold px-1.5 py-0.5 rounded ' +
                  (autoReplyOn
                    ? 'bg-emerald-100 text-emerald-700'
                    : 'bg-gray-100 text-gray-500')
                }
              >
                {autoReplyOn ? 'ON' : 'OFF'}
              </span>
            </button>
          )}

          <div className="my-1 border-t border-gray-100" />

          <button
            role="menuitem"
            onClick={() =>
              run(
                'suggest',
                () => aiSuggestReply(conversationId),
                onInsert,
              )
            }
            className="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center gap-2"
          >
            <MessageSquarePlus size={16} className="text-violet-600" />
            Suggest a reply
          </button>

          <button
            role="menuitem"
            onClick={() =>
              run(
                'summary',
                () => aiSummarize(conversationId),
                (t) => setSummary(t),
              )
            }
            className="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center gap-2"
          >
            <FileText size={16} className="text-gray-500" />
            Summarize chat
          </button>

          <div className="my-1 border-t border-gray-100" />
          <div className="px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-gray-400 flex items-center gap-1">
            <Wand2 size={12} /> Rewrite my draft
          </div>
          {REWRITE_OPTS.map((o) => (
            <button
              key={o.mode}
              role="menuitem"
              onClick={() => {
                const t = needText();
                if (t) run(`rw-${o.mode}`, () => aiRewrite(t, o.mode), onInsert);
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-gray-50"
            >
              {o.label}
            </button>
          ))}

          <div className="my-1 border-t border-gray-100" />
          <div className="px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-gray-400 flex items-center gap-1">
            <Languages size={12} /> Translate draft to
          </div>
          {LANGS.map((lang) => (
            <button
              key={lang}
              role="menuitem"
              onClick={() => {
                const t = needText();
                if (t)
                  run(`tr-${lang}`, () => aiTranslate(t, lang), onInsert);
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-gray-50"
            >
              {lang}
            </button>
          ))}
        </div>
      )}

      {summary !== null && (
        <Modal
          open
          onClose={() => setSummary(null)}
          title="Conversation summary"
        >
          <div className="space-y-3">
            <pre className="whitespace-pre-wrap font-sans text-sm text-gray-800">
              {summary}
            </pre>
            <div className="flex justify-end">
              <button
                onClick={() => {
                  navigator.clipboard?.writeText(summary);
                  toast.success('Summary copied');
                }}
                className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-gray-300 hover:bg-gray-50"
              >
                <Copy size={14} /> Copy
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

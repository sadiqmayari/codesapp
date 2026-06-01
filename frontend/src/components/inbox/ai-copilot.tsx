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
} from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/toast';
import { ApiError } from '@/lib/api';
import {
  aiRewrite,
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
}: {
  conversationId: number;
  /** Read the composer's current text (for rewrite/translate). */
  getText: () => string;
  /** Replace the composer text with the AI result. */
  onInsert: (text: string) => void;
  disabled?: boolean;
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
        className="p-2 text-violet-500 hover:text-violet-700 disabled:opacity-40"
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

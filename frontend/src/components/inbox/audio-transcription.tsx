'use client';

import { useState } from 'react';
import { ChevronDown, ChevronUp, FileText, Loader2 } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';

/**
 * Voice-note transcription control shown under an audio bubble. If the note is
 * already transcribed (cached on the message) it shows a toggle; otherwise a
 * "Transcribe" action that calls Whisper on demand (AI-gated + metered server
 * side). Chevron expands/collapses the text.
 */
export default function AudioTranscription({
  conversationId,
  messageId,
  initial,
  out,
}: {
  conversationId: number;
  messageId: number;
  initial?: string | null;
  out: boolean;
}) {
  const toast = useToast();
  const [text, setText] = useState<string | null>(initial ?? null);
  const [open, setOpen] = useState<boolean>(!!initial);
  const [loading, setLoading] = useState(false);

  const onClick = async () => {
    if (text) {
      setOpen((o) => !o);
      return;
    }
    if (loading) return;
    setLoading(true);
    try {
      const res = await apiFetch<{ text: string }>(
        `/inbox/conversations/${conversationId}/messages/${messageId}/transcribe`,
        { method: 'POST' },
      );
      setText(res.text);
      setOpen(true);
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.userMessage : 'Could not transcribe',
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={onClick}
        disabled={loading}
        className={cn(
          'flex items-center gap-1 text-[11px] font-medium disabled:opacity-60',
          out
            ? 'text-green-100 hover:text-white'
            : 'text-gray-500 hover:text-gray-700',
        )}
      >
        {loading ? (
          <Loader2 size={12} className="animate-spin" />
        ) : (
          <FileText size={12} />
        )}
        {text ? (open ? 'Hide transcript' : 'Show transcript') : 'Transcribe'}
        {text ? (
          open ? (
            <ChevronUp size={12} />
          ) : (
            <ChevronDown size={12} />
          )
        ) : null}
      </button>
      {open && text && (
        <p
          className={cn(
            'mt-1 text-xs whitespace-pre-wrap rounded-lg px-2 py-1.5',
            out ? 'bg-green-700/40 text-white' : 'bg-gray-50 text-gray-700',
          )}
        >
          {text}
        </p>
      )}
    </div>
  );
}

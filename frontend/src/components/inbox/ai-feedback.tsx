'use client';

import { useState } from 'react';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { sendAiFeedback } from '@/lib/ai-agent';
import { cn } from '@/lib/utils';

/**
 * 👍 / 👎 on an AI-written message — the quality loop (Settings → AI Agent →
 * Performance and the super-admin Quality view read these). Optimistic.
 */
export function AiFeedbackButtons({ messageId }: { messageId: number }) {
  const [rating, setRating] = useState<1 | -1 | null>(null);
  const rate = (r: 1 | -1) => {
    const next = rating === r ? null : r;
    setRating(next ?? r);
    if (next) void sendAiFeedback(messageId, next).catch(() => setRating(null));
  };
  return (
    <span className="inline-flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => rate(1)}
        aria-label="Good AI reply"
        aria-pressed={rating === 1}
        className={cn('rounded p-0.5 hover:bg-black/5', rating === 1 ? 'text-emerald-600' : 'opacity-50 hover:opacity-100')}
      >
        <ThumbsUp size={11} />
      </button>
      <button
        type="button"
        onClick={() => rate(-1)}
        aria-label="Bad AI reply"
        aria-pressed={rating === -1}
        className={cn('rounded p-0.5 hover:bg-black/5', rating === -1 ? 'text-red-600' : 'opacity-50 hover:opacity-100')}
      >
        <ThumbsDown size={11} />
      </button>
    </span>
  );
}

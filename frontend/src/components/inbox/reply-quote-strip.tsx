'use client';

import { X } from 'lucide-react';
import type { Message } from '@/lib/inbox-types';

function summarize(m: Pick<Message, 'message_type' | 'content'>): string {
  if (m.content && m.content.trim()) return m.content.trim().slice(0, 80);
  if (m.message_type === 'image') return '[image]';
  if (m.message_type === 'video') return '[video]';
  if (m.message_type === 'audio') return '[audio]';
  if (m.message_type === 'document') return '[document]';
  return '[message]';
}

export default function ReplyQuoteStrip({
  message,
  contactName,
  onClear,
}: {
  message: Pick<Message, 'direction' | 'message_type' | 'content'>;
  contactName: string;
  onClear: () => void;
}) {
  const who = message.direction === 'outbound' ? 'You' : contactName;
  return (
    <div className="flex items-center gap-2 mb-2 border-l-4 border-green-500 bg-gray-50 rounded px-3 py-2">
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-green-700">Replying to {who}</p>
        <p className="text-xs text-gray-500 truncate">{summarize(message)}</p>
      </div>
      <button
        type="button"
        onClick={onClear}
        className="text-gray-400 hover:text-red-500"
        title="Cancel reply"
      >
        <X size={16} />
      </button>
    </div>
  );
}

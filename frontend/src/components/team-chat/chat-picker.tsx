'use client';

import { useEffect, useRef, useState } from 'react';
import { Search, X, Loader2, MessageSquare } from 'lucide-react';
import {
  searchInboxConversations,
  type ChatPickItem,
  type ChatShare,
} from '@/lib/team-chat';

/**
 * Share a WhatsApp customer conversation into a team chat. Search by contact
 * name / phone → pick → a card is posted that links to the live inbox thread.
 * Debounced; never throws (search returns [] on miss).
 */
export default function ChatPicker({
  onPick,
  onClose,
}: {
  onPick: (chat: ChatShare) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<ChatPickItem[]>([]);
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    setLoading(true);
    const t = window.setTimeout(async () => {
      try {
        const r = await searchInboxConversations(q);
        if (mine !== seq.current) return;
        setRows(r);
      } catch {
        if (mine === seq.current) setRows([]);
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    }, 350);
    return () => window.clearTimeout(t);
  }, [q]);

  return (
    <div className="fixed inset-0 z-50 flex items-stretch sm:items-center sm:justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <div className="relative flex max-h-full w-full flex-col bg-white shadow-xl sm:max-h-[80vh] sm:max-w-sm sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
          <h2 className="font-semibold text-gray-900">Share a chat</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">
            <X size={20} />
          </button>
        </div>
        <div className="border-b border-gray-100 p-3">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name or phone…"
              className="w-full rounded-lg border border-gray-300 py-2 pl-8 pr-3 text-sm"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-gray-300">
              <Loader2 className="animate-spin" size={22} />
            </div>
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-400">No chats found.</p>
          ) : (
            rows.map((r) => (
              <button
                key={r.id}
                onClick={() =>
                  onPick({
                    conversationId: r.id,
                    contactName: r.name,
                    phone: r.phone,
                    preview: r.lastMessage,
                  })
                }
                className="flex w-full items-center gap-3 rounded-xl p-2.5 text-left hover:bg-green-50"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-green-100 text-green-700">
                  <MessageSquare size={18} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold text-gray-900">{r.name}</span>
                  <span className="block truncate text-xs text-gray-500">
                    {r.lastMessage || r.phone}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

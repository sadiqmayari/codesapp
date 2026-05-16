'use client';

import { MessagesSquare } from 'lucide-react';

export default function InboxIndexPage() {
  return (
    <div className="h-full flex flex-col items-center justify-center text-gray-400 gap-3">
      <MessagesSquare size={48} />
      <p className="text-sm">Select a conversation to start chatting.</p>
    </div>
  );
}

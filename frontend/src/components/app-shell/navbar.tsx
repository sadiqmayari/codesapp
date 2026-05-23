'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Menu, Bell, LogOut, ChevronDown, Settings } from 'lucide-react';
import { useAuth } from '@/context/auth-context';
import { useSocket } from '@/context/socket-context';
import { apiFetch } from '@/lib/api';
import { cn, fmtDateTime, mediaUrl } from '@/lib/utils';
import type { ConversationRow } from '@/lib/inbox-types';

export function Navbar({
  onToggleSidebar,
  unread,
}: {
  onToggleSidebar: () => void;
  unread: number;
}) {
  const { user, logout } = useAuth();
  const { status } = useSocket();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const [bellRows, setBellRows] = useState<ConversationRow[]>([]);
  const [bellLoading, setBellLoading] = useState(false);
  const bellRef = useRef<HTMLDivElement>(null);

  const loadUnread = useCallback(async () => {
    setBellLoading(true);
    try {
      const rows = await apiFetch<ConversationRow[]>(
        '/inbox/conversations',
        { params: { status: 'unread', limit: 8 } },
      );
      setBellRows(Array.isArray(rows) ? rows : []);
    } catch {
      setBellRows([]);
    } finally {
      setBellLoading(false);
    }
  }, []);

  useEffect(() => {
    if (bellOpen) loadUnread();
  }, [bellOpen, loadUnread]);

  useEffect(() => {
    if (!bellOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) {
        setBellOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [bellOpen]);

  const onLogout = async () => {
    await logout();
    router.replace('/login');
  };

  return (
    <header className="h-16 bg-white border-b border-gray-200 flex items-center px-4 gap-3">
      <button
        className="text-gray-600 hover:text-gray-900"
        onClick={onToggleSidebar}
        aria-label="Toggle menu"
      >
        <Menu size={22} />
      </button>

      <div className="flex items-center gap-2 text-xs">
        <span
          className={cn(
            'inline-block w-2 h-2 rounded-full',
            status === 'connected' && 'bg-green-500',
            status === 'connecting' && 'bg-yellow-400',
            status === 'disconnected' && 'bg-red-500',
          )}
        />
        <span className="text-gray-500 hidden sm:inline">
          {status === 'connected'
            ? 'Live'
            : status === 'connecting'
              ? 'Reconnecting…'
              : 'Offline'}
        </span>
      </div>

      {user?.company && (
        <div className="flex items-center gap-2 min-w-0 ml-1 sm:ml-3">
          {user.company.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={mediaUrl(user.company.logo_url) ?? ''}
              alt={user.company.name}
              className="w-7 h-7 rounded object-contain bg-gray-50 border border-gray-200"
            />
          ) : (
            <span className="w-7 h-7 rounded bg-gray-100 text-gray-600 flex items-center justify-center text-xs font-semibold">
              {user.company.name?.[0]?.toUpperCase() ?? '?'}
            </span>
          )}
          <span className="text-sm font-medium text-gray-800 truncate max-w-[24ch]">
            {user.company.name}
          </span>
        </div>
      )}

      <div className="ml-auto flex items-center gap-4">
        <div className="relative" ref={bellRef}>
          <button
            type="button"
            title="Unread conversations"
            onClick={() => setBellOpen((o) => !o)}
            className="relative text-gray-600 hover:text-gray-900"
          >
            <Bell size={20} />
            {unread > 0 && (
              <span className="absolute -top-1.5 -right-1.5 bg-red-500 text-white text-[10px] rounded-full px-1.5 min-w-[16px] text-center">
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </button>
          {bellOpen && (
            <div className="absolute right-0 mt-2 w-80 bg-white border border-gray-200 rounded-xl shadow-lg z-50 overflow-hidden">
              <div className="px-4 py-2.5 border-b border-gray-100 flex items-center justify-between">
                <span className="text-sm font-semibold text-gray-800">
                  Unread chats
                </span>
                <button
                  onClick={() => {
                    setBellOpen(false);
                    router.push('/inbox');
                  }}
                  className="text-xs text-green-600 hover:underline"
                >
                  Open inbox
                </button>
              </div>
              <div className="max-h-80 overflow-y-auto">
                {bellLoading ? (
                  <div className="p-6 flex justify-center">
                    <div className="w-5 h-5 border-2 border-green-500 border-t-transparent rounded-full animate-spin" />
                  </div>
                ) : bellRows.length === 0 ? (
                  <p className="p-6 text-center text-sm text-gray-400">
                    No unread chats
                  </p>
                ) : (
                  bellRows.map((r) => (
                    <button
                      key={r.id}
                      onClick={() => {
                        setBellOpen(false);
                        router.push(`/inbox/${r.id}`);
                      }}
                      className="w-full text-left px-4 py-2.5 border-b border-gray-50 hover:bg-gray-50 flex flex-col gap-0.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-gray-900 truncate">
                          {r.contact?.name || r.contact?.phone || 'Unknown'}
                        </span>
                        {r.unread_count > 0 && (
                          <span className="bg-green-600 text-white text-[10px] rounded-full px-1.5 min-w-[18px] text-center shrink-0">
                            {r.unread_count}
                          </span>
                        )}
                      </div>
                      <span className="text-xs text-gray-500 truncate">
                        {r.last_message || r.contact?.phone}
                      </span>
                      <span className="text-[10px] text-gray-400">
                        {fmtDateTime(r.last_message_at ?? r.updated_at)}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        <div className="relative">
          <button
            onClick={() => setMenuOpen((o) => !o)}
            className="flex items-center gap-2 text-sm"
          >
            <span className="w-8 h-8 rounded-full bg-green-600 text-white flex items-center justify-center font-semibold">
              {user?.name?.[0]?.toUpperCase() ?? '?'}
            </span>
            <span className="hidden sm:flex flex-col items-start leading-tight">
              <span className="font-medium text-gray-900">{user?.name}</span>
              <span className="text-xs text-gray-500 capitalize">
                {user?.role}
              </span>
            </span>
            <ChevronDown size={16} className="text-gray-400" />
          </button>

          {menuOpen && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setMenuOpen(false)}
                aria-hidden
              />
              <div className="absolute right-0 mt-2 w-48 bg-white border border-gray-200 rounded-lg shadow-lg z-20 py-1">
                <div className="px-4 py-2 border-b border-gray-100">
                  <p className="text-sm font-medium text-gray-900 truncate">
                    {user?.name}
                  </p>
                  <p className="text-xs text-gray-500 truncate">
                    {user?.email}
                  </p>
                  <p className="text-xs text-gray-400 capitalize mt-0.5">
                    {user?.role}
                  </p>
                </div>
                <Link
                  href="/settings"
                  onClick={() => setMenuOpen(false)}
                  className="w-full flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                >
                  <Settings size={16} />
                  Settings
                </Link>
                <button
                  onClick={onLogout}
                  className="w-full flex items-center gap-2 px-4 py-2 text-sm text-red-600 hover:bg-gray-50"
                >
                  <LogOut size={16} />
                  Log out
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

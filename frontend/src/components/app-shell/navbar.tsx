'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Menu, Bell, LogOut, ChevronDown } from 'lucide-react';
import { useAuth } from '@/context/auth-context';
import { useSocket } from '@/context/socket-context';
import { cn } from '@/lib/utils';

export function Navbar({
  onOpenSidebar,
  unread,
}: {
  onOpenSidebar: () => void;
  unread: number;
}) {
  const { user, logout } = useAuth();
  const { status } = useSocket();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);

  const onLogout = async () => {
    await logout();
    router.replace('/login');
  };

  return (
    <header className="h-16 bg-white border-b border-gray-200 flex items-center px-4 gap-3">
      <button
        className="md:hidden text-gray-600"
        onClick={onOpenSidebar}
        aria-label="Open menu"
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

      <div className="ml-auto flex items-center gap-4">
        <button
          type="button"
          title="Unread conversations"
          onClick={() => router.push('/inbox')}
          className="relative text-gray-600 hover:text-gray-900"
        >
          <Bell size={20} />
          {unread > 0 && (
            <span className="absolute -top-1.5 -right-1.5 bg-red-500 text-white text-[10px] rounded-full px-1.5 min-w-[16px] text-center">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </button>

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
                </div>
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

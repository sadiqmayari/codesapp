'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Camera,
  FileText,
  Image as ImageIcon,
  Music,
  Plus,
  ShoppingBag,
  Store,
  Zap,
} from 'lucide-react';
import { useToast } from '@/components/toast';
import { ShopifyIcon } from '@/components/icons/shopify-icon';

export type MediaKind = 'image' | 'audio' | 'video' | 'document';

interface Rule {
  kind: MediaKind;
  maxBytes: number;
  mimes: string[];
}

// Mirrors backend InboxService MEDIA_RULES exactly.
const RULES: Rule[] = [
  {
    kind: 'image',
    maxBytes: 5 * 1024 * 1024,
    // Meta accepts only jpeg/png for image messages (webp is sticker-only).
    mimes: ['image/jpeg', 'image/png'],
  },
  {
    kind: 'video',
    maxBytes: 16 * 1024 * 1024,
    mimes: ['video/mp4', 'video/3gpp'],
  },
  {
    kind: 'audio',
    maxBytes: 10 * 1024 * 1024,
    mimes: ['audio/aac', 'audio/mp4', 'audio/mpeg', 'audio/amr', 'audio/ogg'],
  },
  {
    kind: 'document',
    maxBytes: 10 * 1024 * 1024,
    mimes: [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/plain',
    ],
  },
];

// Per-menu-option `accept` filters so the OS file dialog only shows the
// relevant file types (like WhatsApp's attach menu).
const ACCEPT: Record<'media' | 'document' | 'audio', string> = {
  media: 'image/jpeg,image/png,video/mp4,video/3gpp,.jpg,.jpeg,.png,.mp4,.3gp',
  document:
    'application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt',
  audio: 'audio/aac,audio/mp4,audio/mpeg,audio/amr,audio/ogg,.aac,.m4a,.mp3,.amr,.ogg',
};

export function validateFile(
  file: File,
): { ok: true; kind: MediaKind } | { ok: false; error: string } {
  const mime = (file.type || '').toLowerCase();
  const rule = RULES.find((r) => r.mimes.includes(mime));
  if (!rule) {
    return { ok: false, error: `Unsupported file type${mime ? `: ${mime}` : ''}` };
  }
  if (file.size > rule.maxBytes) {
    return {
      ok: false,
      error: `${rule.kind} exceeds the ${Math.round(
        rule.maxBytes / (1024 * 1024),
      )}MB limit`,
    };
  }
  return { ok: true, kind: rule.kind };
}

export default function AttachmentPicker({
  disabled,
  onPick,
  onCamera,
  onCatalog,
  onQuickReply,
  onTemplate,
  onShopify,
}: {
  disabled?: boolean;
  onPick: (p: { file: File; kind: MediaKind }) => void;
  /** Open the camera (mobile + desktop webcam). */
  onCamera?: () => void;
  /** Open the Shopify catalog product picker. */
  onCatalog?: () => void;
  /** Open the saved quick-reply picker. */
  onQuickReply?: () => void;
  /** Open the WhatsApp template picker. */
  onTemplate?: () => void;
  /** Open the Create-Shopify-order modal (only shown when provided). */
  onShopify?: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menuOpen]);

  const choose = (which: 'media' | 'document' | 'audio') => {
    setMenuOpen(false);
    const input = inputRef.current;
    if (!input) return;
    input.accept = ACCEPT[which];
    input.click();
  };

  const MenuItem = ({
    icon,
    label,
    onClick,
  }: {
    icon: React.ReactNode;
    label: string;
    onClick: () => void;
  }) => (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50"
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setMenuOpen((o) => !o)}
        title={disabled ? 'Send a template first' : 'Attach'}
        className={
          disabled
            ? 'p-2 text-gray-300 cursor-not-allowed'
            : 'p-2 text-gray-500 hover:text-gray-800'
        }
      >
        <Plus
          size={24}
          className={
            'transition-transform duration-200 ' +
            (menuOpen ? 'rotate-45' : 'rotate-0')
          }
        />
      </button>

      {menuOpen && !disabled && (
        <div className="absolute bottom-12 right-0 z-20 w-56 bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden py-1 max-h-[70vh] overflow-y-auto">
          <MenuItem
            icon={<ImageIcon size={18} className="text-purple-500" />}
            label="Photos & Videos"
            onClick={() => choose('media')}
          />
          {onCamera && (
            <MenuItem
              icon={<Camera size={18} className="text-pink-500" />}
              label="Camera"
              onClick={() => {
                setMenuOpen(false);
                onCamera();
              }}
            />
          )}
          <MenuItem
            icon={<FileText size={18} className="text-blue-500" />}
            label="Document"
            onClick={() => choose('document')}
          />
          <MenuItem
            icon={<Music size={18} className="text-orange-500" />}
            label="Audio"
            onClick={() => choose('audio')}
          />

          {(onCatalog || onQuickReply || onTemplate || onShopify) && (
            <div className="my-1 border-t border-gray-100" />
          )}
          {onCatalog && (
            <MenuItem
              icon={<ShoppingBag size={18} className="text-teal-600" />}
              label="Catalog"
              onClick={() => {
                setMenuOpen(false);
                onCatalog();
              }}
            />
          )}
          {onQuickReply && (
            <MenuItem
              icon={<Zap size={18} className="text-green-600" />}
              label="Quick replies"
              onClick={() => {
                setMenuOpen(false);
                onQuickReply();
              }}
            />
          )}
          {onTemplate && (
            <MenuItem
              icon={<Store size={18} className="text-gray-500" />}
              label="Send template"
              onClick={() => {
                setMenuOpen(false);
                onTemplate();
              }}
            />
          )}
          {onShopify && (
            <MenuItem
              icon={<ShopifyIcon size={18} />}
              label="Create Shopify order"
              onClick={() => {
                setMenuOpen(false);
                onShopify();
              }}
            />
          )}
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          const res = validateFile(file);
          if (!res.ok) {
            toast.error(res.error);
            return;
          }
          onPick({ file, kind: res.kind });
        }}
      />
    </div>
  );
}

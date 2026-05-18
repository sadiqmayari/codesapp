'use client';

import { useEffect, useRef, useState } from 'react';
import { FileText, Image as ImageIcon, Music, Paperclip } from 'lucide-react';
import { useToast } from '@/components/toast';

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
    mimes: ['image/jpeg', 'image/png', 'image/webp'],
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
  media: 'image/jpeg,image/png,image/webp,video/mp4,video/3gpp,.jpg,.jpeg,.png,.webp,.mp4,.3gp',
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
}: {
  disabled?: boolean;
  onPick: (p: { file: File; kind: MediaKind }) => void;
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
        <Paperclip size={20} />
      </button>

      {menuOpen && !disabled && (
        <div className="absolute bottom-12 left-0 z-20 w-52 bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden">
          <MenuItem
            icon={<ImageIcon size={18} className="text-purple-500" />}
            label="Photos & Videos"
            onClick={() => choose('media')}
          />
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

'use client';

import { useRef } from 'react';
import { Paperclip } from 'lucide-react';
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

export const ACCEPT_ATTR = [
  ...RULES.flatMap((r) => r.mimes),
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.mp4',
  '.3gp',
  '.aac',
  '.m4a',
  '.mp3',
  '.amr',
  '.ogg',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.txt',
].join(',');

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
  const toast = useToast();

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        title={disabled ? 'Send a template first' : 'Attach a file'}
        className={
          disabled
            ? 'p-2 text-gray-300 cursor-not-allowed'
            : 'p-2 text-gray-500 hover:text-gray-800'
        }
      >
        <Paperclip size={20} />
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTR}
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
    </>
  );
}

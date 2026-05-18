'use client';

import { useEffect, useState } from 'react';
import { FileText, Music, Send, X } from 'lucide-react';
import type { MediaKind } from './attachment-picker';

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function AttachmentPreview({
  file,
  kind,
  caption,
  onCaptionChange,
  onClear,
  onSend,
  sending,
}: {
  file: File;
  kind: MediaKind;
  caption: string;
  onCaptionChange: (v: string) => void;
  onClear: () => void;
  onSend: () => void;
  sending: boolean;
}) {
  const [objUrl, setObjUrl] = useState<string | null>(null);

  useEffect(() => {
    if (kind === 'image' || kind === 'video') {
      const u = URL.createObjectURL(file);
      setObjUrl(u);
      return () => URL.revokeObjectURL(u);
    }
    setObjUrl(null);
    return undefined;
  }, [file, kind]);

  const canCaption = kind === 'image' || kind === 'video';

  return (
    <div className="border border-gray-200 rounded-lg p-3 mb-2 bg-gray-50">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          {kind === 'image' && objUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={objUrl}
              alt="attachment"
              className="rounded-lg max-h-48 max-w-full"
            />
          )}
          {kind === 'video' && objUrl && (
            <video src={objUrl} controls className="rounded-lg max-h-48 max-w-full" />
          )}
          {kind === 'audio' && (
            <div className="flex items-center gap-2 text-sm text-gray-700">
              <Music size={18} className="text-gray-500" />
              <span className="truncate">{file.name}</span>
              <span className="text-gray-400">{fmtSize(file.size)}</span>
            </div>
          )}
          {kind === 'document' && (
            <div className="flex items-center gap-2 text-sm text-gray-700">
              <FileText size={18} className="text-gray-500" />
              <span className="truncate">{file.name}</span>
              <span className="text-gray-400">{fmtSize(file.size)}</span>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onClear}
          disabled={sending}
          className="text-gray-400 hover:text-red-500 disabled:opacity-40"
          title="Remove attachment"
        >
          <X size={18} />
        </button>
      </div>

      {canCaption && (
        <input
          value={caption}
          onChange={(e) => onCaptionChange(e.target.value)}
          placeholder="Add a caption…"
          className="mt-2 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
        />
      )}

      <div className="mt-2 flex justify-end">
        <button
          type="button"
          onClick={onSend}
          disabled={sending}
          className="bg-green-600 hover:bg-green-700 text-white text-sm px-4 py-2 rounded-lg flex items-center gap-2 disabled:opacity-50"
        >
          {sending ? (
            <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
          ) : (
            <Send size={16} />
          )}
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}

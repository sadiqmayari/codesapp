'use client';

import { useEffect, useState } from 'react';
import { FileText, Music, X } from 'lucide-react';
import type { MediaKind } from './attachment-picker';

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Compact preview strip for a staged attachment, shown ABOVE the normal
 * composer (like the reply-quote strip). It is preview-only: the caption is
 * typed in the SAME chat text input the user always uses, and the composer's
 * own Send button ships the media — there is no separate caption box here.
 */
export default function AttachmentPreview({
  file,
  kind,
  onClear,
}: {
  file: File;
  kind: MediaKind;
  onClear: () => void;
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

  return (
    <div className="border border-gray-200 rounded-lg p-2 mb-2 bg-gray-50 flex items-center gap-3">
      <div className="flex-1 min-w-0 flex items-center gap-3">
        {kind === 'image' && objUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={objUrl}
            alt="attachment"
            className="rounded-lg max-h-24 max-w-[50%] object-contain"
          />
        )}
        {kind === 'video' && objUrl && (
          <video
            src={objUrl}
            controls
            className="rounded-lg max-h-24 max-w-[50%]"
          />
        )}
        {kind === 'audio' && (
          <div className="flex items-center gap-2 text-sm text-gray-700 min-w-0">
            <Music size={18} className="text-gray-500 shrink-0" />
            <span className="truncate">{file.name}</span>
            <span className="text-gray-400 shrink-0">{fmtSize(file.size)}</span>
          </div>
        )}
        {kind === 'document' && (
          <div className="flex items-center gap-2 text-sm text-gray-700 min-w-0">
            <FileText size={18} className="text-gray-500 shrink-0" />
            <span className="truncate">{file.name}</span>
            <span className="text-gray-400 shrink-0">{fmtSize(file.size)}</span>
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onClear}
        className="text-gray-400 hover:text-red-500 shrink-0"
        title="Remove attachment"
      >
        <X size={18} />
      </button>
    </div>
  );
}

'use client';

import { useEffect } from 'react';
import { X } from 'lucide-react';
import { driveThumbUrl, drivePreviewUrl } from '@/lib/content';

/**
 * Full-screen viewer for a Drive-backed content/reference file. Images show a
 * large thumbnail; videos stream through the Drive preview iframe. Closes on
 * Esc, backdrop click, or the X. Bytes come straight from Google, not our VPS.
 */
export function ContentMediaViewer({
  fileId,
  mediaType,
  onClose,
}: {
  fileId: string;
  mediaType: 'image' | 'video' | null;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[70] bg-black/90 flex items-center justify-center p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <button
        onClick={onClose}
        className="absolute top-4 right-4 text-white/80 hover:text-white z-[71]"
        aria-label="Close"
      >
        <X size={28} />
      </button>
      {mediaType === 'video' ? (
        <iframe
          src={drivePreviewUrl(fileId)}
          onClick={(e) => e.stopPropagation()}
          className="w-full h-full max-w-5xl max-h-[85vh] rounded-lg bg-black"
          allow="autoplay"
          allowFullScreen
          title="Preview"
        />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={driveThumbUrl(fileId, 1600)}
          alt="Preview"
          decoding="async"
          onClick={(e) => e.stopPropagation()}
          className="max-w-full max-h-full object-contain rounded-lg"
        />
      )}
    </div>
  );
}

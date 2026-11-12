'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react';
import { fmtTime } from '@/lib/utils';

export interface GalleryImage {
  id: number;
  src: string;
  caption?: string | null;
  at: string;
  fromCustomer: boolean;
}

/**
 * In-app image viewer for a chat (Inbox-v2). Pages through EVERY image loaded
 * in the thread (← / → keys, buttons, swipe), shows caption + time, downloads
 * in place. Esc / backdrop / X closes; focus moves to the close button and the
 * body scroll is locked while open. Never opens a new tab.
 */
export default function ImageGallery({
  images,
  startId,
  onClose,
}: {
  images: GalleryImage[];
  startId: number;
  onClose: () => void;
}) {
  const [idx, setIdx] = useState(() =>
    Math.max(0, images.findIndex((i) => i.id === startId)),
  );
  const closeRef = useRef<HTMLButtonElement>(null);
  const touchX = useRef<number | null>(null);
  const cur = images[idx];

  const go = useCallback(
    (d: 1 | -1) => setIdx((i) => Math.min(images.length - 1, Math.max(0, i + d))),
    [images.length],
  );

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose, go]);

  if (!cur) return null;
  const btn =
    'flex h-11 w-11 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 disabled:opacity-30';

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col bg-black/95"
      role="dialog"
      aria-modal="true"
      aria-label="Image viewer"
      onClick={onClose}
      onTouchStart={(e) => {
        touchX.current = e.touches[0].clientX;
      }}
      onTouchEnd={(e) => {
        if (touchX.current == null) return;
        const dx = e.changedTouches[0].clientX - touchX.current;
        touchX.current = null;
        if (Math.abs(dx) > 60) go(dx < 0 ? 1 : -1);
      }}
    >
      <div
        className="flex items-center justify-between gap-3 px-4 py-3 text-sm text-white/80"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="tabular-nums">
          {images.length > 1 ? `${idx + 1} of ${images.length} · ` : ''}
          {cur.fromCustomer ? 'From customer' : 'Sent by team'} · {fmtTime(cur.at)}
        </span>
        <span className="flex items-center gap-2">
          <a href={cur.src} download className={btn} aria-label="Download image">
            <Download size={20} />
          </a>
          <button ref={closeRef} type="button" onClick={onClose} className={btn} aria-label="Close image viewer">
            <X size={22} />
          </button>
        </span>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-2 sm:px-16">
        {images.length > 1 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              go(-1);
            }}
            disabled={idx === 0}
            className={`${btn} absolute left-3 hidden sm:flex`}
            aria-label="Previous image"
          >
            <ChevronLeft size={24} />
          </button>
        )}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={cur.id}
          src={cur.src}
          alt={cur.caption?.trim() || `Photo ${cur.fromCustomer ? 'from customer' : 'sent'} at ${fmtTime(cur.at)}`}
          decoding="async"
          className="max-h-full max-w-full object-contain"
          onClick={(e) => e.stopPropagation()}
        />
        {images.length > 1 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              go(1);
            }}
            disabled={idx === images.length - 1}
            className={`${btn} absolute right-3 hidden sm:flex`}
            aria-label="Next image"
          >
            <ChevronRight size={24} />
          </button>
        )}
      </div>
      {cur.caption?.trim() && (
        <p
          className="mx-auto max-w-2xl whitespace-pre-wrap px-4 py-3 text-center text-sm text-white/90"
          onClick={(e) => e.stopPropagation()}
        >
          {cur.caption}
        </p>
      )}
    </div>
  );
}

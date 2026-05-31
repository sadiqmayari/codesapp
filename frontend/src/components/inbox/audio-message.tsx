'use client';

import { useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * WhatsApp-style voice-note player: play/pause, a clickable + draggable
 * waveform scrubber with a thumb, and elapsed/total time.
 *
 * A module-level bus coordinates ALL players in the thread so that:
 *  - starting one pauses any other that's playing (single playback), and
 *  - when a note finishes it auto-advances to the next audio note (by order).
 */
type Handle = {
  id: number;
  order: number;
  play: () => void;
  pause: () => void;
};

const registry: Handle[] = [];
const audioBus = {
  register(h: Handle) {
    if (!registry.some((x) => x.id === h.id)) registry.push(h);
  },
  unregister(id: number) {
    const i = registry.findIndex((x) => x.id === id);
    if (i !== -1) registry.splice(i, 1);
  },
  // Pause everyone except `id` (called when a player starts).
  solo(id: number) {
    registry.forEach((h) => h.id !== id && h.pause());
  },
  // Play the next audio note (in chronological order) after `id`.
  playNext(id: number) {
    const sorted = [...registry].sort((a, b) => a.order - b.order);
    const i = sorted.findIndex((h) => h.id === id);
    const nxt = sorted[i + 1];
    if (nxt) nxt.play();
  },
};

const BAR_COUNT = 40;

/** Deterministic pseudo-waveform so each note has a stable, distinct shape. */
function makeBars(seed: number): number[] {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  const out: number[] = [];
  for (let i = 0; i < BAR_COUNT; i++) {
    s = (s * 16807) % 2147483647;
    out.push(0.2 + (s / 2147483647) * 0.8);
  }
  return out;
}

function fmt(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function AudioMessage({
  src,
  out,
  messageId,
}: {
  src: string;
  out: boolean;
  messageId: number;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const dragging = useRef(false);
  const bars = useRef(makeBars(messageId)).current;

  // Register with the shared bus for single-playback + auto-advance.
  useEffect(() => {
    const handle: Handle = {
      id: messageId,
      order: messageId,
      play: () => void audioRef.current?.play().catch(() => undefined),
      pause: () => audioRef.current?.pause(),
    };
    audioBus.register(handle);
    return () => audioBus.unregister(messageId);
  }, [messageId]);

  const onLoadedMetadata = () => {
    const el = audioRef.current;
    if (!el) return;
    // ogg/opus voice notes often report Infinity until forced to seek.
    if (el.duration === Infinity || Number.isNaN(el.duration)) {
      const fix = () => {
        el.removeEventListener('timeupdate', fix);
        el.currentTime = 0;
        if (isFinite(el.duration)) setDuration(el.duration);
      };
      el.addEventListener('timeupdate', fix);
      el.currentTime = 1e101;
    } else {
      setDuration(el.duration);
    }
  };

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => undefined);
    else el.pause();
  };

  const seekFromClientX = (clientX: number) => {
    const el = audioRef.current;
    const bar = barRef.current;
    if (!el || !bar || !isFinite(duration) || duration <= 0) return;
    const r = bar.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    el.currentTime = frac * duration;
    setCurrent(frac * duration);
  };

  const frac = duration > 0 ? Math.min(1, current / duration) : 0;

  // Color tuning for green (outbound) vs white (inbound) bubbles.
  const playedColor = out ? 'bg-white' : 'bg-green-600';
  const restColor = out ? 'bg-white/40' : 'bg-gray-300';
  const btnColor = out
    ? 'text-green-700 bg-white'
    : 'text-white bg-green-600';

  return (
    <div className="flex items-center gap-2.5 w-60 max-w-full">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={onLoadedMetadata}
        onPlay={() => {
          setPlaying(true);
          audioBus.solo(messageId);
        }}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => {
          if (!dragging.current) setCurrent(e.currentTarget.currentTime);
        }}
        onEnded={() => {
          setPlaying(false);
          setCurrent(0);
          if (audioRef.current) audioRef.current.currentTime = 0;
          audioBus.playNext(messageId);
        }}
      />

      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? 'Pause' : 'Play'}
        className={cn(
          'shrink-0 w-9 h-9 rounded-full flex items-center justify-center shadow-sm',
          btnColor,
        )}
      >
        {playing ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
      </button>

      <div className="flex-1 min-w-0">
        {/* Waveform scrubber */}
        <div
          ref={barRef}
          onPointerDown={(e) => {
            dragging.current = true;
            (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
            seekFromClientX(e.clientX);
          }}
          onPointerMove={(e) => {
            if (dragging.current) seekFromClientX(e.clientX);
          }}
          onPointerUp={() => {
            dragging.current = false;
          }}
          onPointerCancel={() => {
            dragging.current = false;
          }}
          className="relative h-7 flex items-center gap-[2px] cursor-pointer touch-none"
        >
          {bars.map((h, i) => (
            <span
              key={i}
              style={{ height: `${Math.round(h * 100)}%` }}
              className={cn(
                'flex-1 rounded-full min-h-[3px]',
                i / BAR_COUNT <= frac ? playedColor : restColor,
              )}
            />
          ))}
          {/* Draggable thumb */}
          <span
            style={{ left: `${frac * 100}%` }}
            className={cn(
              'absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full shadow ring-2',
              out ? 'bg-white ring-green-600/30' : 'bg-green-600 ring-white',
            )}
          />
        </div>
        <div
          className={cn(
            'text-[10px] mt-0.5',
            out ? 'text-green-100' : 'text-gray-400',
          )}
        >
          {fmt(playing || current > 0 ? current : duration)}
        </div>
      </div>
    </div>
  );
}

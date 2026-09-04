'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, Pause, Play, Send, Trash2 } from 'lucide-react';
import { useToast } from '@/components/toast';
import { stopAllAudioPlayback } from './audio-message';

// Records a voice note with the browser's NATIVE MediaRecorder — the phone's
// own hardware-accelerated pipeline, which produces clean audio on every device
// (Android → webm/opus, iPhone → mp4/aac). The server (ffmpeg) transcodes it to
// WhatsApp OGG/Opus. This replaced an in-browser WASM Opus encoder that glitched
// on mobile (iOS especially) — the fragile real-time encode is gone.
const MAX_SECONDS = 300; // safety auto-stop (well under Meta's 16MB audio cap)

type Phase = 'idle' | 'starting' | 'recording' | 'paused';

function mmss(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Pick the best MediaRecorder container the device supports. */
function pickMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/aac',
    'audio/ogg;codecs=opus',
  ];
  return candidates.find(
    (m) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m),
  );
}

function extForMime(mime: string): string {
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mp4')) return 'm4a';
  if (mime.includes('aac')) return 'aac';
  if (mime.includes('ogg')) return 'ogg';
  return 'bin';
}

export default function VoiceRecorder({
  disabled,
  hidden,
  onComplete,
  onActiveChange,
}: {
  disabled?: boolean;
  /** Stay mounted but render nothing while idle (e.g. text present → show Send). */
  hidden?: boolean;
  onComplete: (file: File) => void;
  onActiveChange?: (active: boolean) => void;
}) {
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>('idle');
  const [seconds, setSeconds] = useState(0);

  // Recorder + captured chunks.
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const mimeRef = useRef<string>('audio/webm');
  const canceledRef = useRef(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Live waveform (analyser only — never routed to output, so no echo).
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);

  // Optional listen-back while paused (plays back the chunks recorded so far).
  const audioRef = useRef<HTMLAudioElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playPos, setPlayPos] = useState(0);
  const [playDur, setPlayDur] = useState(0);

  useEffect(() => {
    onActiveChange?.(phase === 'recording' || phase === 'paused');
  }, [phase, onActiveChange]);

  const clearTick = () => {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  };

  const releaseAudio = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    clearTick();
    try {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    } catch {
      /* noop */
    }
    streamRef.current = null;
    try {
      void audioCtxRef.current?.close();
    } catch {
      /* noop */
    }
    audioCtxRef.current = null;
    analyserRef.current = null;
    recRef.current = null;
  }, []);

  // Draw the live waveform from the analyser.
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const analyser = analyserRef.current;
    if (!canvas || !analyser) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const bins = analyser.frequencyBinCount;
    const data = new Uint8Array(bins);
    const render = () => {
      analyser.getByteTimeDomainData(data);
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#16a34a';
      ctx.beginPath();
      const slice = w / bins;
      let x = 0;
      for (let i = 0; i < bins; i++) {
        const v = data[i] / 128;
        const y = (v * h) / 2;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        x += slice;
      }
      ctx.stroke();
      rafRef.current = requestAnimationFrame(render);
    };
    render();
  }, []);

  const buildPreview = useCallback(() => {
    if (!chunksRef.current.length) return;
    const blob = new Blob(chunksRef.current, { type: mimeRef.current });
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(blob);
    });
  }, []);

  const start = useCallback(async () => {
    if (disabled) return;
    setPhase('starting');
    canceledRef.current = false;
    chunksRef.current = [];
    stopAllAudioPlayback();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          // Noise suppression OFF: the mobile browser's noise gate mis-fires on
          // speech and chops words (the original "cutting out" complaint).
          // WhatsApp does its own tuned processing. AGC stays on for a stable level.
          noiseSuppression: false,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;

      // Waveform graph (analysis only).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Ctx: any =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).AudioContext || (window as any).webkitAudioContext;
      if (Ctx) {
        const audioCtx: AudioContext = new Ctx();
        audioCtxRef.current = audioCtx;
        if (audioCtx.state === 'suspended') {
          await audioCtx.resume().catch(() => {});
        }
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        analyserRef.current = analyser;
      }

      const mime = pickMime();
      mimeRef.current = mime || 'audio/webm';
      const rec = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream);
      mimeRef.current = rec.mimeType || mimeRef.current;
      rec.ondataavailable = (e: BlobEvent) => {
        if (e.data && e.data.size) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        clearTick();
        if (canceledRef.current) {
          releaseAudio();
          return;
        }
        const blob = new Blob(chunksRef.current, { type: mimeRef.current });
        releaseAudio();
        if (!blob.size) {
          setPhase('idle');
          setSeconds(0);
          return;
        }
        const ext = extForMime(mimeRef.current);
        const file = new File([blob], `voice-note-${Date.now()}.${ext}`, {
          type: mimeRef.current,
        });
        setPhase('idle');
        setSeconds(0);
        onComplete(file); // one tap — the server transcodes to OGG/Opus + sends
      };
      // Timeslice so chunks land continuously (enables paused listen-back).
      rec.start(500);
      recRef.current = rec;

      setPhase('recording');
      setSeconds(0);
      tickRef.current = setInterval(() => {
        setSeconds((s) => {
          const next = s + 1;
          if (next >= MAX_SECONDS) {
            // Auto-stop at the cap.
            try {
              recRef.current?.stop();
            } catch {
              /* noop */
            }
          }
          return next;
        });
      }, 1000);
      draw();
    } catch (e) {
      releaseAudio();
      setPhase('idle');
      toast.error(
        e instanceof DOMException && e.name === 'NotAllowedError'
          ? 'Microphone permission denied.'
          : 'Could not start recording.',
      );
    }
  }, [disabled, draw, onComplete, releaseAudio, toast]);

  const finish = useCallback(() => {
    const rec = recRef.current;
    if (!rec) return;
    try {
      if (rec.state === 'paused') rec.resume();
      rec.stop(); // → onstop → onComplete
    } catch {
      /* noop */
    }
  }, []);

  const cancel = useCallback(() => {
    canceledRef.current = true;
    const rec = recRef.current;
    try {
      if (rec && rec.state !== 'inactive') rec.stop();
      else releaseAudio();
    } catch {
      releaseAudio();
    }
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
    }
    setPhase('idle');
    setSeconds(0);
  }, [previewUrl, releaseAudio]);

  const togglePause = useCallback(() => {
    const rec = recRef.current;
    if (!rec) return;
    if (rec.state === 'recording') {
      try {
        rec.pause();
      } catch {
        /* noop */
      }
      clearTick();
      setPhase('paused');
      // Give the paused chunk a moment to flush, then build the listen-back.
      setTimeout(buildPreview, 250);
    } else if (rec.state === 'paused') {
      try {
        rec.resume();
      } catch {
        /* noop */
      }
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
        setPreviewUrl(null);
      }
      setPhase('recording');
      tickRef.current = setInterval(() => {
        setSeconds((s) => {
          const next = s + 1;
          if (next >= MAX_SECONDS) {
            try {
              recRef.current?.stop();
            } catch {
              /* noop */
            }
          }
          return next;
        });
      }, 1000);
    }
  }, [buildPreview, previewUrl]);

  const togglePlay = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      stopAllAudioPlayback();
      void a.play().catch(() => {});
    } else {
      a.pause();
    }
  }, []);

  // Cleanup on unmount.
  useEffect(() => releaseAudio, [releaseAudio]);

  if (phase === 'idle' || phase === 'starting') {
    if (hidden) return null;
    return (
      <button
        type="button"
        disabled={disabled || phase === 'starting'}
        onClick={start}
        title={disabled ? 'Send a template first' : 'Record voice message'}
        className={
          disabled
            ? 'bg-gray-200 text-gray-400 p-2.5 rounded-full cursor-not-allowed'
            : 'bg-green-600 hover:bg-green-700 text-white p-2.5 rounded-full'
        }
      >
        <Mic size={20} />
      </button>
    );
  }

  const paused = phase === 'paused';
  const canPreview = paused && !!previewUrl;

  return (
    <div className="flex items-center gap-2 flex-1 min-w-0 bg-gray-50 border border-gray-200 rounded-2xl px-2.5 py-2">
      <audio
        ref={audioRef}
        src={previewUrl ?? undefined}
        preload="metadata"
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          setPlayDur(Number.isFinite(d) ? d : 0);
        }}
        onTimeUpdate={(e) => setPlayPos(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setPlayPos(0);
        }}
      />
      <span
        className={
          phase === 'recording'
            ? 'shrink-0 w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse'
            : 'shrink-0 w-2.5 h-2.5 rounded-full bg-gray-400'
        }
      />
      <span className="shrink-0 text-sm tabular-nums text-gray-700">
        {mmss(seconds)}
      </span>

      {canPreview ? (
        <>
          <button
            type="button"
            onClick={togglePlay}
            title={playing ? 'Pause playback' : 'Play recording'}
            className="shrink-0 flex h-7 w-7 items-center justify-center rounded-full bg-green-600 text-white hover:bg-green-700"
          >
            {playing ? (
              <Pause size={15} />
            ) : (
              <Play size={15} className="ml-0.5" />
            )}
          </button>
          <input
            type="range"
            min={0}
            max={playDur > 0 ? playDur : seconds || 1}
            step={0.01}
            value={Math.min(playPos, playDur > 0 ? playDur : seconds || 1)}
            onChange={(e) => {
              const t = Number(e.target.value);
              setPlayPos(t);
              if (audioRef.current) audioRef.current.currentTime = t;
            }}
            className="flex-1 min-w-0 accent-green-600 h-1"
            aria-label="Seek recording"
          />
        </>
      ) : (
        <canvas
          ref={canvasRef}
          width={160}
          height={28}
          className="flex-1 min-w-0 h-7"
        />
      )}

      <button
        type="button"
        onClick={cancel}
        title="Discard"
        className="shrink-0 p-1 text-gray-500 hover:text-red-500"
      >
        <Trash2 size={18} />
      </button>
      <button
        type="button"
        onClick={togglePause}
        title={paused ? 'Resume recording' : 'Pause'}
        className="shrink-0 p-1 text-gray-600 hover:text-gray-900"
      >
        {paused ? <Mic size={18} /> : <Pause size={18} />}
      </button>
      <button
        type="button"
        onClick={finish}
        title="Send voice message"
        className="shrink-0 bg-green-600 hover:bg-green-700 text-white p-2 rounded-full"
      >
        <Send size={16} />
      </button>
    </div>
  );
}

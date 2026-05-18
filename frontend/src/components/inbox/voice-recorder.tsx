'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, Pause, Play, Send, Trash2 } from 'lucide-react';
import { useToast } from '@/components/toast';

// Records a true WhatsApp voice note: opus-recorder encodes straight to
// audio/ogg;codecs=opus (the only audio format Meta renders as a PTT voice
// message). The encoder worker is vendored at /public/opus and served by
// Next at /opus/encoderWorker.min.js (Hostinger has no server transcode).
const ENCODER_PATH = '/opus/encoderWorker.min.js';
const MAX_SECONDS = 300; // safety auto-stop (well under Meta's 10MB audio cap)

type Phase = 'idle' | 'starting' | 'recording' | 'paused';

function mmss(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function VoiceRecorder({
  disabled,
  onComplete,
  onActiveChange,
}: {
  disabled?: boolean;
  onComplete: (file: File) => void;
  onActiveChange?: (active: boolean) => void;
}) {
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>('idle');
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    onActiveChange?.(phase === 'recording' || phase === 'paused');
  }, [phase, onActiveChange]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recRef = useRef<any>(null);
  const canceledRef = useRef(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopTick = () => {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  };

  const cleanup = useCallback(() => {
    stopTick();
    recRef.current = null;
    setPhase('idle');
    setSeconds(0);
  }, []);

  useEffect(() => () => stopTick(), []);

  const start = async () => {
    if (disabled || phase !== 'idle') return;
    setPhase('starting');
    canceledRef.current = false;
    try {
      const mod = await import('opus-recorder');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Recorder: any = (mod as any).default ?? mod;
      const rec = new Recorder({
        encoderPath: ENCODER_PATH,
        encoderApplication: 2048, // VoIP — tuned for speech
        numberOfChannels: 1,
        encoderSampleRate: 48000,
        streamPages: false, // one complete OGG blob on stop
      });

      rec.ondataavailable = (typedArray: Uint8Array) => {
        if (canceledRef.current) return;
        // Copy into a fresh ArrayBuffer-backed view (lib.dom's BlobPart
        // rejects the generic Uint8Array<ArrayBufferLike> under TS 5.7).
        const bytes = new Uint8Array(typedArray.length);
        bytes.set(typedArray);
        const blob = new Blob([bytes.buffer], { type: 'audio/ogg' });
        const file = new File([blob], `voice-note-${Date.now()}.ogg`, {
          type: 'audio/ogg',
        });
        onComplete(file);
      };

      await rec.start();
      recRef.current = rec;
      setPhase('recording');
      setSeconds(0);
      tickRef.current = setInterval(() => {
        setSeconds((s) => {
          const next = s + 1;
          if (next >= MAX_SECONDS) {
            // auto-stop & send at the cap
            void finish();
          }
          return next;
        });
      }, 1000);
    } catch (err) {
      cleanup();
      const msg =
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'Microphone permission denied'
          : 'Could not start recording';
      toast.error(msg);
    }
  };

  const togglePause = () => {
    const rec = recRef.current;
    if (!rec) return;
    if (phase === 'recording') {
      rec.pause();
      stopTick();
      setPhase('paused');
    } else if (phase === 'paused') {
      rec.resume();
      setPhase('recording');
      tickRef.current = setInterval(() => {
        setSeconds((s) => {
          const next = s + 1;
          if (next >= MAX_SECONDS) void finish();
          return next;
        });
      }, 1000);
    }
  };

  const cancel = () => {
    canceledRef.current = true;
    const rec = recRef.current;
    try {
      rec?.stop();
    } catch {
      /* ignore */
    }
    cleanup();
  };

  const finish = useCallback(async () => {
    const rec = recRef.current;
    if (!rec) return;
    stopTick();
    try {
      if (phase === 'paused') rec.resume();
      await rec.stop(); // → ondataavailable → onComplete
    } catch {
      toast.error('Recording failed');
    } finally {
      cleanup();
    }
  }, [phase, cleanup, toast]);

  if (phase === 'idle' || phase === 'starting') {
    return (
      <button
        type="button"
        disabled={disabled || phase === 'starting'}
        onClick={start}
        title={disabled ? 'Send a template first' : 'Record voice message'}
        className={
          disabled
            ? 'p-2 text-gray-300 cursor-not-allowed'
            : 'p-2 text-gray-500 hover:text-gray-800'
        }
      >
        <Mic size={20} />
      </button>
    );
  }

  return (
    <div className="flex items-center gap-3 flex-1 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
      <span
        className={
          phase === 'recording'
            ? 'w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse'
            : 'w-2.5 h-2.5 rounded-full bg-gray-400'
        }
      />
      <span className="text-sm tabular-nums text-gray-700">
        {mmss(seconds)}
      </span>
      <span className="text-xs text-gray-400">
        {phase === 'paused' ? 'Paused' : 'Recording…'}
      </span>
      <div className="flex-1" />
      <button
        type="button"
        onClick={cancel}
        title="Discard"
        className="text-gray-500 hover:text-red-500"
      >
        <Trash2 size={18} />
      </button>
      <button
        type="button"
        onClick={togglePause}
        title={phase === 'paused' ? 'Resume' : 'Pause'}
        className="text-gray-600 hover:text-gray-900"
      >
        {phase === 'paused' ? <Play size={18} /> : <Pause size={18} />}
      </button>
      <button
        type="button"
        onClick={finish}
        title="Send voice message"
        className="bg-green-600 hover:bg-green-700 text-white p-2 rounded-full"
      >
        <Send size={16} />
      </button>
    </div>
  );
}

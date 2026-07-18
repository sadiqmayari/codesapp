'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, Pause, Play, Send, Trash2 } from 'lucide-react';
import { useToast } from '@/components/toast';
import { stopAllAudioPlayback } from './audio-message';

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

  useEffect(() => {
    onActiveChange?.(phase === 'recording' || phase === 'paused');
  }, [phase, onActiveChange]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recRef = useRef<any>(null);
  const canceledRef = useRef(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Live waveform: a second mic stream feeds an AnalyserNode (analysis
  // only — never connected to destination, so no echo). opus-recorder
  // owns its own capture; this is independent and best-effort.
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const vizStreamRef = useRef<MediaStream | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const audioCtxRef = useRef<any>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);

  const stopTick = () => {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  };

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const analyser = analyserRef.current;
    if (!canvas || !analyser) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const bins = analyser.frequencyBinCount;
    const data = new Uint8Array(bins);
    const W = canvas.width;
    const H = canvas.height;

    // Throttle the heavy work (getByteFrequencyData + canvas fills) to ~20fps.
    // opus-recorder's audio capture runs on the MAIN thread; a 60fps waveform
    // starves it on weak phones → dropped PCM frames → the "choppy/cutting out"
    // recording. rAF still schedules smoothly, but we only repaint every ~50ms,
    // freeing ~2/3 of the main-thread cost with no visible waveform difference.
    const FRAME_MS = 50;
    let lastPaint = 0;
    const render = (now: number) => {
      rafRef.current = requestAnimationFrame(render);
      if (now - lastPaint < FRAME_MS) return;
      lastPaint = now;
      analyser.getByteFrequencyData(data);
      ctx.clearRect(0, 0, W, H);
      const bars = 32;
      const step = Math.floor(bins / bars);
      const bw = W / bars;
      ctx.fillStyle = '#16a34a';
      for (let i = 0; i < bars; i++) {
        let sum = 0;
        for (let j = 0; j < step; j++) sum += data[i * step + j];
        const v = sum / step / 255; // 0..1
        const h = Math.max(2, v * H);
        ctx.fillRect(i * bw + 1, (H - h) / 2, bw - 2, h);
      }
    };
    rafRef.current = requestAnimationFrame(render);
  }, []);

  const stopDraw = () => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sourceNodeRef = useRef<any>(null);

  // Fully release the single mic stream + audio graph. Called after every
  // recording (and on unmount). The old code opened a SECOND getUserMedia just
  // for the waveform and didn't always release it → the mic stayed held, so
  // after a few notes a new recording captured silence. Now there's one stream
  // and it's always torn down here.
  const releaseAudio = useCallback(() => {
    stopDraw();
    analyserRef.current = null;
    if (sourceNodeRef.current) {
      try {
        sourceNodeRef.current.disconnect();
      } catch {
        /* ignore */
      }
      sourceNodeRef.current = null;
    }
    if (audioCtxRef.current) {
      try {
        audioCtxRef.current.close();
      } catch {
        /* ignore */
      }
      audioCtxRef.current = null;
    }
    if (vizStreamRef.current) {
      vizStreamRef.current.getTracks().forEach((t) => t.stop());
      vizStreamRef.current = null;
    }
  }, []);

  const cleanup = useCallback(() => {
    stopTick();
    // Destroy the encoder + its Web Worker. Each recording makes a fresh
    // Recorder; without close() the workers (and their mic hold) leak, which is
    // what made repeated recordings silently stop capturing.
    const rec = recRef.current;
    if (rec) {
      try {
        rec.close();
      } catch {
        /* ignore */
      }
    }
    recRef.current = null;
    releaseAudio();
    setPhase('idle');
    setSeconds(0);
  }, [releaseAudio]);

  useEffect(
    () => () => {
      stopTick();
      const rec = recRef.current;
      if (rec) {
        try {
          rec.close();
        } catch {
          /* ignore */
        }
        recRef.current = null;
      }
      releaseAudio();
    },
    [releaseAudio],
  );

  const start = async () => {
    if (disabled || phase !== 'idle') return;
    // Silence any voice note that's playing, so it doesn't bleed into the mic.
    stopAllAudioPlayback();
    setPhase('starting');
    canceledRef.current = false;
    try {
      // ONE mic stream, shared by the encoder (via sourceNode) and the waveform
      // analyser — no second getUserMedia fighting for the mic.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          // Ask the mic for 16 kHz directly (best-effort; many mobile browsers
          // ignore it and give 48 kHz, which the AudioContext below then handles).
          sampleRate: 16000,
          echoCancellation: true,
          // noiseSuppression OFF: the browser's built-in noise gate is the real
          // cause of the "cutting out / not clear" voice notes reported on BOTH
          // an iPhone and a Galaxy Fold 2 (capable phones — so it was never a CPU
          // problem, which is why every encoder-setting change failed to fix it).
          // The mobile NS gate mis-fires on speech and chops words. WhatsApp does
          // its own tuned processing; the generic browser gate does more harm than
          // good for a voice note. AGC stays on so the level doesn't drop.
          noiseSuppression: false,
          autoGainControl: true,
        },
      });
      vizStreamRef.current = stream;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Ctx: any =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).AudioContext || (window as any).webkitAudioContext;
      // Run the graph at 16 kHz so opus-recorder's 16 kHz encoder needs NO
      // resampling — the browser resamples the mic once at the context boundary
      // (native/cheap) instead of the WASM worker resampling every tick, which is
      // the biggest CPU saving on weak phones. Falls back to the default rate if a
      // browser rejects a forced context rate (then the worker resamples as before).
      let audioCtx: AudioContext;
      try {
        audioCtx = new Ctx({ sampleRate: 16000 });
      } catch {
        audioCtx = new Ctx();
      }
      audioCtxRef.current = audioCtx;
      if (audioCtx.state === 'suspended') {
        try {
          await audioCtx.resume();
        } catch {
          /* best-effort */
        }
      }
      const sourceNode = audioCtx.createMediaStreamSource(stream);
      sourceNodeRef.current = sourceNode;
      // Waveform taps the SAME source (analysis only — not routed to output).
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      sourceNode.connect(analyser);
      analyserRef.current = analyser;

      const mod = await import('opus-recorder');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Recorder: any = (mod as any).default ?? mod;
      const rec = new Recorder({
        encoderPath: ENCODER_PATH,
        encoderApplication: 2048, // VoIP — tuned for speech intelligibility
        numberOfChannels: 1, // voice is mono
        // 16 kHz wideband (WhatsApp-grade for voice) instead of 48 kHz fullband.
        // Fullband made the Opus worker resample+encode ~3× more audio per tick;
        // on weaker phones it couldn't keep up in real time → dropped frames =
        // the "radio packet dropping"/disturbance users heard. 16 kHz captures
        // the entire speech band with no perceptible loss and huge CPU headroom.
        encoderSampleRate: 16000,
        encoderBitRate: 24000, // ample for 16 kHz mono speech
        // Complexity 5: a capable phone (Galaxy Fold 2) also recorded unclear
        // audio, which ruled out CPU starvation — so the earlier drop to 0 was
        // pure quality loss for no benefit. 5 gives noticeably better encoding
        // quality per bit at 16 kHz / 24 kbps speech with ample real-time
        // headroom. The real dropout fix is the noiseSuppression change above.
        encoderComplexity: 5,
        // Reuse OUR single stream — opus-recorder skips its own getUserMedia
        // (we own teardown of the stream + audioContext in releaseAudio()).
        sourceNode,
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
      draw(); // analyser already wired to the shared stream
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
      stopDraw();
      setPhase('paused');
    } else if (phase === 'paused') {
      rec.resume();
      setPhase('recording');
      if (analyserRef.current) draw();
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
    // Kept mounted (so recording state survives) but invisible when the parent
    // wants the Send button shown instead (text present).
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

  return (
    // min-w-0 on the bar + the canvas lets the waveform shrink on narrow phones
    // instead of forcing its 160px intrinsic width and pushing the buttons off
    // screen. Every fixed control is shrink-0 so it never gets clipped.
    <div className="flex items-center gap-2 flex-1 min-w-0 bg-gray-50 border border-gray-200 rounded-2xl px-2.5 py-2">
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
      {phase === 'paused' && (
        <span className="shrink-0 text-xs text-gray-400">Paused</span>
      )}
      <canvas
        ref={canvasRef}
        width={160}
        height={28}
        className="flex-1 min-w-0 h-7"
      />
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
        title={phase === 'paused' ? 'Resume' : 'Pause'}
        className="shrink-0 p-1 text-gray-600 hover:text-gray-900"
      >
        {phase === 'paused' ? <Play size={18} /> : <Pause size={18} />}
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

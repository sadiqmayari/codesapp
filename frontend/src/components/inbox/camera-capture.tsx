'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, RefreshCw, X } from 'lucide-react';
import { useToast } from '@/components/toast';

/**
 * In-app camera capture (no new dependency). Uses getUserMedia, which works on
 * both desktop webcams and mobile cameras. Produces a JPEG File that flows
 * through the existing /send-media image pipeline (validated as image/jpeg).
 */
export default function CameraCapture({
  onCapture,
  onClose,
}: {
  onCapture: (file: File) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [ready, setReady] = useState(false);
  const [facing, setFacing] = useState<'user' | 'environment'>('environment');

  const stop = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  const start = useCallback(
    async (mode: 'user' | 'environment') => {
      stop();
      setReady(false);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: mode },
          audio: false,
        });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
        }
        setReady(true);
      } catch (err) {
        const msg =
          err instanceof DOMException && err.name === 'NotAllowedError'
            ? 'Camera permission denied'
            : 'Could not open the camera';
        toast.error(msg);
        onClose();
      }
    },
    [stop, toast, onClose],
  );

  useEffect(() => {
    void start(facing);
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facing]);

  const snap = () => {
    const video = videoRef.current;
    if (!video || !ready) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, w, h);
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          toast.error('Capture failed');
          return;
        }
        const file = new File([blob], `photo-${Date.now()}.jpg`, {
          type: 'image/jpeg',
        });
        stop();
        onCapture(file);
      },
      'image/jpeg',
      0.9,
    );
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/90 flex flex-col">
      <div className="flex items-center justify-between p-3 text-white">
        <span className="text-sm font-medium">Camera</span>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() =>
              setFacing((f) => (f === 'user' ? 'environment' : 'user'))
            }
            title="Switch camera"
            className="p-2 hover:bg-white/10 rounded-full"
          >
            <RefreshCw size={20} />
          </button>
          <button
            type="button"
            onClick={() => {
              stop();
              onClose();
            }}
            title="Close"
            className="p-2 hover:bg-white/10 rounded-full"
          >
            <X size={22} />
          </button>
        </div>
      </div>

      <div className="flex-1 flex items-center justify-center overflow-hidden">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          ref={videoRef}
          playsInline
          muted
          className="max-h-full max-w-full object-contain"
        />
      </div>

      <div className="flex items-center justify-center p-6">
        <button
          type="button"
          onClick={snap}
          disabled={!ready}
          title="Take photo"
          className="bg-white text-gray-900 rounded-full p-4 shadow-lg disabled:opacity-40 hover:scale-105 transition"
        >
          <Camera size={28} />
        </button>
      </div>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { Phone, PhoneOff, Mic, MicOff } from 'lucide-react';
import { useSip } from '@/context/sip-context';

function useCallTimer(active: boolean, startedAt: number | null) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    if (!active || !startedAt) {
      setSecs(0);
      return;
    }
    const t = setInterval(() => setSecs(Math.floor((Date.now() - startedAt) / 1000)), 500);
    return () => clearInterval(t);
  }, [active, startedAt]);
  const m = Math.floor(secs / 60)
    .toString()
    .padStart(2, '0');
  const s = (secs % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export function SoftphoneWidget() {
  const sip = useSip();
  const timer = useCallTimer(sip?.state === 'in-call', sip?.call?.startedAt ?? null);
  if (!sip || !sip.available) return null;
  const { state, call } = sip;
  if (state === 'idle' || !call) return null;

  // Incoming ringing — full card with Answer/Decline.
  if (state === 'ringing-in') {
    return (
      <div className="fixed top-4 right-4 z-[60] w-80 rounded-2xl bg-white shadow-2xl border border-gray-200 overflow-hidden">
        <div className="bg-green-600 text-white px-4 py-3 flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center animate-pulse">
            <Phone size={18} />
          </div>
          <div className="min-w-0">
            <div className="font-semibold truncate">{call.peer}</div>
            <div className="text-xs opacity-90">Incoming WhatsApp call…</div>
          </div>
        </div>
        <div className="flex p-3 gap-3">
          <button
            onClick={() => sip.answer()}
            className="flex-1 rounded-xl bg-green-600 text-white py-2.5 font-semibold flex items-center justify-center gap-2 hover:bg-green-700"
          >
            <Phone size={16} /> Answer
          </button>
          <button
            onClick={() => sip.hangup()}
            className="flex-1 rounded-xl bg-red-500 text-white py-2.5 font-semibold flex items-center justify-center gap-2 hover:bg-red-600"
          >
            <PhoneOff size={16} /> Decline
          </button>
        </div>
      </div>
    );
  }

  // Ringing-out or in-call — compact dark bar.
  const connecting = state === 'ringing-out';
  return (
    <div className="fixed bottom-20 md:bottom-4 left-1/2 -translate-x-1/2 z-[60] w-[min(420px,92vw)] rounded-2xl bg-slate-900 text-white shadow-2xl px-4 py-3 flex items-center gap-3">
      <div className="w-11 h-11 rounded-full bg-slate-800 border-2 border-green-500 flex items-center justify-center font-semibold">
        {call.peer?.replace(/[^\d]/g, '').slice(-2) || '✆'}
      </div>
      <div className="min-w-0">
        <div className="font-semibold truncate">{call.peer}</div>
        <div className="text-xs text-green-300 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse" />
          {connecting ? 'Calling… (WhatsApp)' : 'On call · WhatsApp'}
        </div>
      </div>
      {!connecting && (
        <span className="ml-auto text-sm tabular-nums text-slate-300">{timer}</span>
      )}
      <div className={`flex gap-2 ${connecting ? 'ml-auto' : ''}`}>
        {!connecting && (
          <button
            onClick={() => sip.toggleMute()}
            title={sip.muted ? 'Unmute' : 'Mute'}
            className="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center hover:bg-slate-700"
          >
            {sip.muted ? <MicOff size={18} /> : <Mic size={18} />}
          </button>
        )}
        <button
          onClick={() => sip.hangup()}
          title="Hang up"
          className="w-10 h-10 rounded-full bg-red-500 flex items-center justify-center hover:bg-red-600"
        >
          <PhoneOff size={18} />
        </button>
      </div>
    </div>
  );
}

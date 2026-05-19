// Shell-Polish-A: device-local notification tones. Pure-client — the
// selected tone id is stored in localStorage (per-device, per-browser),
// the audio files are bundled static assets under /public/sounds. No
// backend, no env, no migration. Replaces the inline WebAudio beep.

export interface NotificationTone {
  id: string;
  label: string;
  src: string;
}

export const NOTIFICATION_TONES: NotificationTone[] = [
  { id: 'chime', label: 'Chime', src: '/sounds/chime.wav' },
  { id: 'ping', label: 'Ping', src: '/sounds/ping.wav' },
  { id: 'pop', label: 'Pop', src: '/sounds/pop.wav' },
  { id: 'bell', label: 'Bell', src: '/sounds/bell.wav' },
  { id: 'soft', label: 'Soft', src: '/sounds/soft.wav' },
];

const STORAGE_KEY = 'notification_tone_id';
const DEFAULT_ID = 'chime';

export function getSelectedTone(): NotificationTone {
  let id = DEFAULT_ID;
  try {
    id = localStorage.getItem(STORAGE_KEY) || DEFAULT_ID;
  } catch {
    /* localStorage unavailable — use default */
  }
  return (
    NOTIFICATION_TONES.find((t) => t.id === id) ?? NOTIFICATION_TONES[0]
  );
}

export function setSelectedTone(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* localStorage unavailable — best-effort */
  }
}

/** Play a specific tone (used by the settings preview button). */
export function playTone(src: string): void {
  if (typeof window === 'undefined') return;
  try {
    const audio = new Audio(src);
    audio.volume = 0.6;
    void audio.play().catch(() => {
      /* autoplay blocked before a user gesture — silent */
    });
  } catch {
    /* audio unsupported — silent */
  }
}

/** Play the user's currently selected notification tone. */
export function playNotification(): void {
  playTone(getSelectedTone().src);
}

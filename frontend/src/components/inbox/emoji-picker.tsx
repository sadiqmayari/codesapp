'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Lightweight, dependency-free emoji picker. A curated set across categories
 * (no external lib — avoids Hostinger build-registry flakiness, per project
 * conventions). Selecting an emoji calls onPick with the unicode string; the
 * composer inserts it as plain text (no backend involvement).
 */
const CATEGORIES: Array<{ key: string; icon: string; emojis: string[] }> = [
  {
    key: 'Smileys',
    icon: '😀',
    emojis: [
      '😀','😃','😄','😁','😆','😅','😂','🤣','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','😚','😙','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','😐','😶','😏','😒','🙄','😬','😴','😪','😌','😔','😕','🙁','☹️','😣','😖','😞','😟','😢','😭','😤','😠','😡','🤬','🤯','😳','🥵','🥶','😱','😨','😰','😥','😓','🤥','😶‍🌫️','🥳','🥺','😎','🤓','🧐',
    ],
  },
  {
    key: 'Gestures',
    icon: '👍',
    emojis: [
      '👍','👎','👌','🤌','🤏','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','👇','☝️','👋','🤚','🖐️','✋','🖖','👏','🙌','🤝','🙏','💪','🦾','✍️','💅','👀','🫶','🤲','👐',
    ],
  },
  {
    key: 'Hearts',
    icon: '❤️',
    emojis: [
      '❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','💯','💢','💥','💫','💦','💨','🔥','⭐','🌟','✨','⚡',
    ],
  },
  {
    key: 'Animals',
    icon: '🐶',
    emojis: [
      '🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔','🐧','🐦','🐤','🦆','🦅','🦉','🐺','🐗','🐴','🦄','🐝','🐛','🦋','🐢','🐙','🐠','🐬','🐳','🐊','🐍','🐉',
    ],
  },
  {
    key: 'Food',
    icon: '🍔',
    emojis: [
      '🍏','🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🥑','🥦','🌽','🥕','🍞','🧀','🍔','🍟','🍕','🌭','🥪','🌮','🌯','🥗','🍣','🍦','🍰','🎂','🍫','🍬','🍭','☕','🍵','🥤','🍺','🍻','🥂','🍷',
    ],
  },
  {
    key: 'Travel',
    icon: '✈️',
    emojis: [
      '🚗','🚕','🚙','🚌','🏎️','🚓','🚑','🚒','🚚','🚛','🛵','🏍️','🚲','✈️','🚀','🛸','🚁','⛵','🚤','🚢','🏠','🏢','🏥','🏦','🏪','🏫','🗼','🗽','🌍','🌋','🏖️','🏝️','⛰️','🌅','🌃',
    ],
  },
  {
    key: 'Objects',
    icon: '💡',
    emojis: [
      '⌚','📱','💻','⌨️','🖥️','🖨️','📷','📸','🎥','📞','☎️','📺','🔋','💡','🔦','💰','💵','💳','💎','🔧','🔨','📦','📫','📅','📌','📎','✂️','🔒','🔑','🛒','🎁','🎈','🎉','🎊','🏆','🥇','⚽','🏀','🎮','🎧','🎵','📚','✏️','📝',
    ],
  },
  {
    key: 'Symbols',
    icon: '✅',
    emojis: [
      '✅','❌','⭕','❗','❓','‼️','⚠️','🚫','💲','➕','➖','➗','✖️','♾️','💱','🔴','🟠','🟡','🟢','🔵','🟣','⚫','⚪','🔺','🔻','🔔','🔕','🕐','✔️','☑️','©️','®️','™️','🆗','🆕','🆒',
    ],
  },
];

export default function EmojiPicker({
  onPick,
  onClose,
}: {
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  const [cat, setCat] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onEsc);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute bottom-12 left-0 z-30 w-72 max-w-[calc(100vw-2rem)] bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden"
    >
      <div className="flex border-b border-gray-100 overflow-x-auto">
        {CATEGORIES.map((c, i) => (
          <button
            key={c.key}
            type="button"
            title={c.key}
            onClick={() => setCat(i)}
            className={
              'flex-1 min-w-[2rem] py-2 text-lg ' +
              (i === cat ? 'bg-green-50' : 'hover:bg-gray-50')
            }
          >
            {c.icon}
          </button>
        ))}
      </div>
      <div className="p-2 h-52 overflow-y-auto grid grid-cols-8 gap-0.5">
        {CATEGORIES[cat].emojis.map((e, i) => (
          <button
            key={`${e}-${i}`}
            type="button"
            onClick={() => onPick(e)}
            className="text-xl leading-none p-1 rounded hover:bg-gray-100"
          >
            {e}
          </button>
        ))}
      </div>
    </div>
  );
}

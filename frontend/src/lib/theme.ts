/**
 * Device-local colour theme (UI Phase C). 'system' follows the OS setting.
 * Applied as the `dark` class on <html>; the pre-paint script in the root
 * layout (`THEME_BOOT_SCRIPT`) applies it before hydration so there is no
 * light flash. Dark styling = token vars in globals.css + the legacy-utility
 * override layer there.
 */
export type ThemePref = 'light' | 'dark' | 'system';
const KEY = 'ca_theme';

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* ignore */
  }
  return 'light';
}

function systemDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

export function applyTheme(pref: ThemePref) {
  if (typeof document === 'undefined') return;
  const dark = pref === 'dark' || (pref === 'system' && systemDark());
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

export function setThemePref(pref: ThemePref) {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* ignore */
  }
  applyTheme(pref);
}

/** Re-apply when the OS theme flips while the pref is 'system'. */
export function watchSystemTheme(): () => void {
  if (typeof window === 'undefined') return () => {};
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const on = () => {
    if (getThemePref() === 'system') applyTheme('system');
  };
  mq.addEventListener('change', on);
  return () => mq.removeEventListener('change', on);
}

/** Inline, pre-hydration. Must stay dependency-free. */
export const THEME_BOOT_SCRIPT = `(function(){try{var p=localStorage.getItem('${KEY}')||'light';var d=p==='dark'||(p==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);if(d){document.documentElement.classList.add('dark');document.documentElement.style.colorScheme='dark';}}catch(e){}})();`;

'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { Monitor, Moon, Palette } from 'lucide-react';

export type SaTheme = 'codesapp' | 'emerald' | 'system';

const THEMES: { id: SaTheme; label: string; icon: typeof Palette }[] = [
  { id: 'codesapp', label: 'CodesApp', icon: Palette },
  { id: 'emerald', label: 'Emerald', icon: Moon },
  { id: 'system', label: 'System', icon: Monitor },
];

const STORAGE_KEY = 'sa_theme';

interface Ctx {
  theme: SaTheme;
  setTheme: (t: SaTheme) => void;
  navOpen: boolean;
  setNavOpen: (v: boolean) => void;
}

const SaThemeContext = createContext<Ctx | null>(null);

export function useSaTheme(): Ctx {
  const ctx = useContext(SaThemeContext);
  if (!ctx) throw new Error('useSaTheme must be used within SaThemeProvider');
  return ctx;
}

/** Wraps the super-admin area in the `.sa-root` themed shell. */
export function SaThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<SaTheme>('codesapp');
  const [navOpen, setNavOpen] = useState(false);

  // Hydrate the saved choice after mount (SSR defaults to codesapp).
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY) as SaTheme | null;
      if (saved === 'codesapp' || saved === 'emerald' || saved === 'system') {
        setThemeState(saved);
      }
    } catch {
      /* private mode / blocked storage — keep the default */
    }
  }, []);

  const setTheme = (t: SaTheme) => {
    setThemeState(t);
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      /* ignore */
    }
  };

  return (
    <SaThemeContext.Provider value={{ theme, setTheme, navOpen, setNavOpen }}>
      <div
        className={`sa-root${navOpen ? ' sa-nav-open' : ''}`}
        data-sa-theme={theme}
      >
        {children}
      </div>
    </SaThemeContext.Provider>
  );
}

/** Topbar control that cycles / picks the active theme. */
export function SaThemeToggle() {
  const { theme, setTheme } = useSaTheme();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onDoc = () => setOpen(false);
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, [open]);

  const active = THEMES.find((t) => t.id === theme) ?? THEMES[0];
  const ActiveIcon = active.icon;

  return (
    <div style={{ position: 'relative' }}>
      <button
        className="sa-iconbtn"
        title={`Theme: ${active.label}`}
        aria-label="Change theme"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        <ActiveIcon size={19} />
      </button>
      {open && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            right: 0,
            marginTop: 8,
            background: 'var(--sa-surface)',
            border: '1px solid var(--sa-border)',
            borderRadius: 10,
            boxShadow: 'var(--sa-shadow)',
            padding: 6,
            zIndex: 50,
            minWidth: 170,
          }}
        >
          <p
            style={{
              fontSize: 10,
              letterSpacing: '.06em',
              textTransform: 'uppercase',
              color: 'var(--sa-fg-faint)',
              padding: '4px 8px',
              margin: 0,
            }}
          >
            Theme
          </p>
          {THEMES.map((t) => {
            const Icon = t.icon;
            const on = t.id === theme;
            return (
              <button
                key={t.id}
                onClick={() => {
                  setTheme(t.id);
                  setOpen(false);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  border: 'none',
                  background: on ? 'var(--sa-accent-wash)' : 'transparent',
                  color: on ? 'var(--sa-accent-ink)' : 'var(--sa-fg)',
                  font: 'inherit',
                  fontSize: 13,
                  fontWeight: on ? 600 : 500,
                  padding: '8px 10px',
                  borderRadius: 7,
                  cursor: 'pointer',
                }}
              >
                <Icon size={15} />
                {t.label}
                {t.id === 'system' && (
                  <span
                    style={{
                      marginLeft: 'auto',
                      fontSize: 10,
                      color: 'var(--sa-fg-faint)',
                    }}
                  >
                    auto
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

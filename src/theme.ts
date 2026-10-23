import { useEffect, useState } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
const storageKey = 'avalon.theme';

function readPreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // Appearance remains usable when browser storage is unavailable.
  }
  return 'system';
}

export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(readPreference);
  useEffect(() => {
    const system = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const theme = preference === 'system' ? (system.matches ? 'dark' : 'light') : preference;
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.colorScheme = theme;
      document.documentElement.style.backgroundColor = theme === 'dark' ? '#101a15' : '#f5f6f2';
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', theme === 'dark' ? '#101a15' : '#f5f6f2');
    };
    apply();
    system.addEventListener('change', apply);
    return () => system.removeEventListener('change', apply);
  }, [preference]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === storageKey || event.key === null) setPreference(readPreference());
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  return {
    preference,
    setPreference(next: ThemePreference) {
      setPreference(next);
      try {
        localStorage.setItem(storageKey, next);
      } catch {
        // Do not interrupt the game when storage is blocked.
      }
    },
  };
}

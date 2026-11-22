import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ThemeChoice = 'light' | 'dark' | 'system';
const KEY = 'pulse.theme';

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch {
    return 'system';
  }
}

const Ctx = createContext<{ choice: ThemeChoice; resolved: 'light' | 'dark'; setChoice: (c: ThemeChoice) => void }>({
  choice: 'system',
  resolved: 'light',
  setChoice: () => undefined,
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(read);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const resolved = choice === 'system' ? (systemDark ? 'dark' : 'light') : choice;
  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);

  const value = useMemo(
    () => ({
      choice,
      resolved,
      setChoice: (c: ThemeChoice) => {
        setChoiceState(c);
        try {
          localStorage.setItem(KEY, c);
        } catch {
          /* private mode */
        }
      },
    }),
    [choice, resolved],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useTheme = () => useContext(Ctx);

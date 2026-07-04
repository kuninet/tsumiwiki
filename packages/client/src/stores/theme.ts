import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// ライト/ダークテーマ切替(デザインhandoff components.md参照)。
// data-theme属性の切り替えでCSS変数(tokens.css)を差し替える方式

export type Theme = 'light' | 'dark';

interface ThemeState {
  theme: Theme;
  toggle: () => void;
  setTheme: (theme: Theme) => void;
}

function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme: 'light',
      toggle: () =>
        set((s) => {
          const next: Theme = s.theme === 'light' ? 'dark' : 'light';
          applyTheme(next);
          return { theme: next };
        }),
      setTheme: (theme) => {
        applyTheme(theme);
        set({ theme });
      },
    }),
    { name: 'tsumiwiki-theme' },
  ),
);

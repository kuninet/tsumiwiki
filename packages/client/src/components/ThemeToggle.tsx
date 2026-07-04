import { useThemeStore } from '../stores/theme';

// テーマ切替ボタン(32×32アイコンボタン。ライト時☾/ダーク時☀。components.md参照)

export function ThemeToggle() {
  const theme = useThemeStore((s) => s.theme);
  const toggle = useThemeStore((s) => s.toggle);

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === 'light' ? 'ダークモードに切り替え' : 'ライトモードに切り替え'}
      className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded border border-line text-ink-soft transition-colors duration-[180ms] ease-out hover:bg-hoverbg"
    >
      {theme === 'light' ? '☾' : '☀'}
    </button>
  );
}

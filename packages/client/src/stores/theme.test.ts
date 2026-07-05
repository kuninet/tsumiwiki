import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useThemeStore } from './theme';

describe('useThemeStore', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    useThemeStore.setState({ theme: 'light' });
  });

  afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('toggleでテーマが切り替わり、<html>のdata-theme属性が更新される', () => {
    expect(useThemeStore.getState().theme).toBe('light');

    useThemeStore.getState().toggle();

    expect(useThemeStore.getState().theme).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    useThemeStore.getState().toggle();

    expect(useThemeStore.getState().theme).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('setThemeで直接指定した値に切り替わる', () => {
    useThemeStore.getState().setTheme('dark');

    expect(useThemeStore.getState().theme).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('localStorageにtsumiwiki-themeとして永続化される', () => {
    useThemeStore.getState().toggle();

    const stored = localStorage.getItem('tsumiwiki-theme');
    expect(stored).toBeTruthy();
    expect(JSON.parse(stored!).state.theme).toBe('dark');
  });
});

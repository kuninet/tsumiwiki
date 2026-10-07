import { cleanup, renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useUIStore } from '../stores/ui';
import { useUserSettingsStore } from '../stores/user-settings';
import { useRightPanelShortcut } from './use-right-panel-shortcut';

describe('useRightPanelShortcut (C-4-13 〜 C-4-17)', () => {
  let unmountCurrent: (() => void) | null = null;

  beforeEach(() => {
    useUserSettingsStore.setState({ rightPanelOpen: false });
    useUIStore.setState({ rightDrawerOpen: false });
  });

  afterEach(() => {
    if (unmountCurrent) {
      unmountCurrent();
      unmountCurrent = null;
    }
    cleanup();
  });

  function renderWithRoute(route = '/doc/a.md') {
    const rendered = renderHook(() => useRightPanelShortcut(), {
      wrapper: ({ children }) => (
        <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
      ),
    });
    unmountCurrent = rendered.unmount;
    return rendered;
  }

  it('C-4-13: Ctrl+Shift+U でトグルされ defaultPrevented が true になる', () => {
    renderWithRoute('/doc/a.md');

    const event = new KeyboardEvent('keydown', {
      key: 'U',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(useUserSettingsStore.getState().rightPanelOpen).toBe(true);

    const event2 = new KeyboardEvent('keydown', {
      key: 'u',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event2);

    expect(event2.defaultPrevented).toBe(true);
    expect(useUserSettingsStore.getState().rightPanelOpen).toBe(false);
  });

  it('C-4-14: Meta+Shift+U でトグルされる', () => {
    renderWithRoute('/doc/a.md');

    const event = new KeyboardEvent('keydown', {
      key: 'U',
      metaKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(useUserSettingsStore.getState().rightPanelOpen).toBe(true);
  });

  it('C-4-15: isComposing: true のときは反応せず defaultPrevented も false', () => {
    renderWithRoute('/doc/a.md');

    const event = new KeyboardEvent('keydown', {
      key: 'U',
      ctrlKey: true,
      shiftKey: true,
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(useUserSettingsStore.getState().rightPanelOpen).toBe(false);
  });

  it('C-4-16: Ctrl+u (Shiftなし) や Alt を含む場合は反応しない', () => {
    renderWithRoute('/doc/a.md');

    // Shift なし
    const ev1 = new KeyboardEvent('keydown', {
      key: 'u',
      ctrlKey: true,
      shiftKey: false,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(ev1);
    expect(ev1.defaultPrevented).toBe(false);
    expect(useUserSettingsStore.getState().rightPanelOpen).toBe(false);

    // Alt あり
    const ev2 = new KeyboardEvent('keydown', {
      key: 'U',
      ctrlKey: true,
      shiftKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(ev2);
    expect(ev2.defaultPrevented).toBe(false);
    expect(useUserSettingsStore.getState().rightPanelOpen).toBe(false);
  });

  it('C-4-17: /trash ではショートカットが反応しない', () => {
    renderWithRoute('/trash');

    const event = new KeyboardEvent('keydown', {
      key: 'U',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(useUserSettingsStore.getState().rightPanelOpen).toBe(false);
  });
});

import { cleanup, fireEvent, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useTabsStore, _testHelpers } from '../stores/tabs';
import { useTabSwitchShortcut } from './use-tab-switch-shortcut';

function Probe() {
  useTabSwitchShortcut();
  return null;
}

function render_() {
  return render(
    <MemoryRouter>
      <Probe />
    </MemoryRouter>,
  );
}

function activeId(): string | null {
  const s = useTabsStore.getState();
  const leaf = _testHelpers.findLeafById(s.root, s.activePaneId);
  return leaf?.activeId ?? null;
}

describe('useTabSwitchShortcut', () => {
  beforeEach(() => {
    useTabsStore.getState().reset();
  });
  afterEach(() => cleanup());

  it('Ctrl+Tab で次のタブへ循環する', () => {
    useTabsStore.getState().openDoc('a.md', { pinned: true });
    useTabsStore.getState().openDoc('b.md', { pinned: true });
    useTabsStore.getState().openDoc('c.md', { pinned: true });
    useTabsStore.getState().setActive('a.md');
    render_();
    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true });
    expect(activeId()).toBe('b.md');
    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true });
    expect(activeId()).toBe('c.md');
    // 末尾から先頭へ循環
    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true });
    expect(activeId()).toBe('a.md');
  });

  it('Ctrl+Shift+Tab で前のタブへ循環する', () => {
    useTabsStore.getState().openDoc('a.md', { pinned: true });
    useTabsStore.getState().openDoc('b.md', { pinned: true });
    useTabsStore.getState().openDoc('c.md', { pinned: true });
    useTabsStore.getState().setActive('a.md');
    render_();
    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true, shiftKey: true });
    // 先頭から末尾へ循環
    expect(activeId()).toBe('c.md');
  });

  it('タブが 1 つのときは何もしない', () => {
    useTabsStore.getState().openDoc('a.md');
    render_();
    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true });
    expect(activeId()).toBe('a.md');
  });

  it('IME 変換中は無視', () => {
    useTabsStore.getState().openDoc('a.md', { pinned: true });
    useTabsStore.getState().openDoc('b.md', { pinned: true });
    render_();
    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true, isComposing: true });
    expect(activeId()).toBe('b.md');
  });
});

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useUIStore } from '../stores/ui';
import { useUserSettingsStore } from '../stores/user-settings';
import { RightPanel } from './RightPanel';

describe('RightPanel (C-5)', () => {
  beforeEach(() => {
    localStorage.clear();
    useUserSettingsStore.setState({
      rightPanelOpen: true,
      rightPanelWidth: 320,
      rightPanelTab: 'backlinks',
    });
    useUIStore.setState({
      sidebarCollapsed: false,
      sidebarWidth: 260,
      rightDrawerOpen: false,
      rightPanelSlot: null,
    });
  });

  afterEach(() => {
    cleanup();
  });

  function renderPanel(route = '/doc/a.md') {
    return render(
      <MemoryRouter initialEntries={[route]}>
        <RightPanel />
      </MemoryRouter>,
    );
  }

  it('C-5-1: PR1 では [バックリンク] タブのみが存在し role=tablist かつ aria-selected=true', () => {
    renderPanel('/doc/a.md');

    const tablist = screen.getByRole('tablist');
    expect(tablist).toBeTruthy();

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(1);
    expect(tabs[0].textContent).toBe('バックリンク');
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
  });

  it('C-5-3: / (文書なし) でパネルを開くと right-panel-empty が表示されスロットの子は 0', () => {
    renderPanel('/');

    expect(screen.getByTestId('right-panel-empty').textContent).toBe(
      '文書を開くとここに表示されます',
    );
    const slot = screen.getByTestId('right-panel-slot');
    expect(slot.children.length).toBe(0);
  });

  it('C-5-4: 閉じるボタン (右パネルを閉じる) をクリックするとパネルを閉じる', () => {
    renderPanel('/doc/a.md');

    const closeBtn = screen.getByLabelText('右パネルを閉じる');
    fireEvent.click(closeBtn);

    expect(useUserSettingsStore.getState().rightPanelOpen).toBe(false);
  });

  it('C-5-5: パネル内のタブボタンにフォーカスがあるとき Escape でパネルが閉じる', () => {
    renderPanel('/doc/a.md');

    const tab = screen.getByRole('tab');
    tab.focus();

    fireEvent.keyDown(tab, { key: 'Escape' });
    expect(useUserSettingsStore.getState().rightPanelOpen).toBe(false);
  });

  it('C-5-6: e.preventDefault() 済みまたは role="dialog" 内の Escape ではパネルが閉じない', () => {
    renderPanel('/doc/a.md');

    // defaultPrevented のケース
    const tab = screen.getByRole('tab');
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    event.preventDefault();
    tab.dispatchEvent(event);
    expect(useUserSettingsStore.getState().rightPanelOpen).toBe(true);

    // role="dialog" 内のケース
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const input = document.createElement('input');
    dialog.appendChild(input);
    document.body.appendChild(dialog);

    input.focus();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(useUserSettingsStore.getState().rightPanelOpen).toBe(true);

    document.body.removeChild(dialog);
  });

  it('C-5-7: デスクトップでフォーカスが body にあるとき Escape では閉じない', () => {
    renderPanel('/doc/a.md');

    document.body.focus();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(useUserSettingsStore.getState().rightPanelOpen).toBe(true);
  });
});

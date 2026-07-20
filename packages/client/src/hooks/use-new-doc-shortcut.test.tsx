import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useTabsStore } from '../stores/tabs';
import { useUIStore } from '../stores/ui';
import { useNewDocShortcut } from './use-new-doc-shortcut';

// #137 Phase C-1: Ctrl+N(⌘N)グローバルショートカット
// useUIStore.requestCreateDoc がアクティブタブのフォルダ付きで呼ばれることを検証

function Probe() {
  useNewDocShortcut();
  return null;
}

describe('useNewDocShortcut', () => {
  beforeEach(() => {
    useTabsStore.getState().reset();
    useUIStore.setState({ createDocRequest: { nonce: 0, folder: '' } });
  });
  afterEach(() => cleanup());

  it('Ctrl+N でアクティブタブが無ければ folder="" で requestCreateDoc が呼ばれる', () => {
    render(<Probe />);
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true });
    expect(useUIStore.getState().createDocRequest.folder).toBe('');
    expect(useUIStore.getState().createDocRequest.nonce).toBe(1);
  });

  it('アクティブタブのフォルダ("テンプレ/日誌.md" → "テンプレ")が初期フォルダになる', () => {
    useTabsStore.getState().openDoc('テンプレ/日誌.md', { pinned: true });
    render(<Probe />);
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true });
    expect(useUIStore.getState().createDocRequest.folder).toBe('テンプレ');
  });

  it('ルート直下の文書ならフォルダは ""', () => {
    useTabsStore.getState().openDoc('test.md', { pinned: true });
    render(<Probe />);
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true });
    expect(useUIStore.getState().createDocRequest.folder).toBe('');
  });

  it('IME 変換中(isComposing=true)は無視する', () => {
    render(<Probe />);
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true, isComposing: true });
    expect(useUIStore.getState().createDocRequest.nonce).toBe(0);
  });

  it('Ctrl+Shift+N など修飾違いは無視する', () => {
    render(<Probe />);
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true, altKey: true });
    expect(useUIStore.getState().createDocRequest.nonce).toBe(0);
  });
});

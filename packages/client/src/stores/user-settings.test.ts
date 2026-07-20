import { beforeEach, describe, expect, it } from 'vitest';
import { resolveNewDocInitialFolder, useUserSettingsStore } from './user-settings';

describe('user-settings', () => {
  beforeEach(() => {
    useUserSettingsStore.setState({ newDocPolicy: 'same-folder', fixedFolder: '' });
  });

  describe('resolveNewDocInitialFolder', () => {
    it('same-folder: アクティブタブのフォルダを返す', () => {
      expect(resolveNewDocInitialFolder('テンプレ/日誌.md', 'same-folder', '')).toBe('テンプレ');
    });

    it('same-folder: ルート直下の文書ならフォルダは ""', () => {
      expect(resolveNewDocInitialFolder('memo.md', 'same-folder', '')).toBe('');
    });

    it('same-folder: activeDocPath が null なら ""', () => {
      expect(resolveNewDocInitialFolder(null, 'same-folder', '')).toBe('');
    });

    it('fixed-folder: fixedFolder を返す(activeDocPath 無視)', () => {
      expect(resolveNewDocInitialFolder('foo/bar.md', 'fixed-folder', 'notes/daily')).toBe(
        'notes/daily',
      );
    });

    it('fixed-folder: fixedFolder が空なら "" にフォールバック', () => {
      expect(resolveNewDocInitialFolder('foo/bar.md', 'fixed-folder', '')).toBe('');
    });

    it('root: 常に ""', () => {
      expect(resolveNewDocInitialFolder('テンプレ/日誌.md', 'root', 'notes/daily')).toBe('');
    });
  });

  describe('setNewDocPolicy / setFixedFolder', () => {
    it('ポリシーを更新できる', () => {
      useUserSettingsStore.getState().setNewDocPolicy('root');
      expect(useUserSettingsStore.getState().newDocPolicy).toBe('root');
      useUserSettingsStore.getState().setFixedFolder('notes');
      expect(useUserSettingsStore.getState().fixedFolder).toBe('notes');
    });
  });
});

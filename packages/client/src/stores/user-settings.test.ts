import { beforeEach, describe, expect, it } from 'vitest';
import {
  contentWidthMaxClass,
  resolveNewDocInitialFolder,
  useUserSettingsStore,
} from './user-settings';

describe('user-settings', () => {
  beforeEach(() => {
    useUserSettingsStore.setState({
      newDocPolicy: 'same-folder',
      fixedFolder: '',
      contentWidth: 'normal',
    });
    // #212 レビュー M2: setState は persist ミドルウェアで localStorage に書き戻される。
    // 他 test suite の初期状態を汚染しないよう永続層も掃除する
    useUserSettingsStore.persist.clearStorage();
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

  describe('contentWidth (#212)', () => {
    it('既定は normal', () => {
      expect(useUserSettingsStore.getState().contentWidth).toBe('normal');
    });

    it('setContentWidth で更新できる', () => {
      useUserSettingsStore.getState().setContentWidth('wide');
      expect(useUserSettingsStore.getState().contentWidth).toBe('wide');
      useUserSettingsStore.getState().setContentWidth('full');
      expect(useUserSettingsStore.getState().contentWidth).toBe('full');
    });

    it('contentWidthMaxClass は各値に対応する max-width クラスを返す', () => {
      expect(contentWidthMaxClass('normal')).toBe('max-w-[min(760px,100%)]');
      expect(contentWidthMaxClass('wide')).toBe('max-w-[min(1040px,100%)]');
      expect(contentWidthMaxClass('full')).toBe('max-w-full');
    });
  });
});

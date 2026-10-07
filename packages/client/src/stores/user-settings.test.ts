import { beforeEach, describe, expect, it } from 'vitest';
import {
  contentWidthMaxClass,
  resolveNewDocInitialFolder,
  useUserSettingsStore,
} from './user-settings';

describe('user-settings', () => {
  beforeEach(() => {
    localStorage.clear();
    useUserSettingsStore.setState({
      newDocPolicy: 'same-folder',
      fixedFolder: '',
      contentWidth: 'normal',
      unresolvedLinkFolder: 'same-folder',
      rightPanelOpen: false,
      rightPanelWidth: 320,
      rightPanelTab: 'backlinks',
      backlinksSort: 'updated-desc',
    });
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

  describe('unresolvedLinkFolder (#268)', () => {
    it('既定は same-folder', () => {
      expect(useUserSettingsStore.getState().unresolvedLinkFolder).toBe('same-folder');
    });

    it('setUnresolvedLinkFolder で更新できる', () => {
      useUserSettingsStore.getState().setUnresolvedLinkFolder('root');
      expect(useUserSettingsStore.getState().unresolvedLinkFolder).toBe('root');
      useUserSettingsStore.getState().setUnresolvedLinkFolder('same-folder');
      expect(useUserSettingsStore.getState().unresolvedLinkFolder).toBe('same-folder');
    });
  });

  describe('rightPanel 設定と永続化 (C-3-1 〜 C-3-6)', () => {
    it('C-3-1: localStorage 空で状態を読むと open=false, width=320, tab="backlinks"', () => {
      const state = useUserSettingsStore.getState();
      expect(state.rightPanelOpen).toBe(false);
      expect(state.rightPanelWidth).toBe(320);
      expect(state.rightPanelTab).toBe('backlinks');
    });

    it('C-3-2: setRightPanelWidth で 240〜560 にクランプされる', () => {
      const { setRightPanelWidth } = useUserSettingsStore.getState();
      setRightPanelWidth(100);
      expect(useUserSettingsStore.getState().rightPanelWidth).toBe(240);
      setRightPanelWidth(9999);
      expect(useUserSettingsStore.getState().rightPanelWidth).toBe(560);
      setRightPanelWidth(350);
      expect(useUserSettingsStore.getState().rightPanelWidth).toBe(350);
    });

    it('C-3-3: seed された設定を rehydrate すると正しく復元され、backlinksCollapsed が残っていても例外にならない', async () => {
      localStorage.setItem(
        'tsumiwiki-user-settings',
        JSON.stringify({
          state: {
            rightPanelOpen: true,
            rightPanelWidth: 400,
            rightPanelTab: 'history',
            backlinksCollapsed: true,
            backlinksSort: 'name-desc',
          },
          version: 0,
        }),
      );

      await useUserSettingsStore.persist.rehydrate();
      const state = useUserSettingsStore.getState();
      expect(state.rightPanelOpen).toBe(true);
      expect(state.rightPanelWidth).toBe(400);
      expect(state.rightPanelTab).toBe('history');
      expect(state.backlinksSort).toBe('name-desc');
      // backlinksCollapsed は型に存在しないことを確認
      expect('backlinksCollapsed' in state).toBe(false);
    });

    it('C-3-4: 不正な tab や非数値の width を seed しても既定値に復旧する', async () => {
      localStorage.setItem(
        'tsumiwiki-user-settings',
        JSON.stringify({
          state: {
            rightPanelTab: 'outline',
            rightPanelWidth: 'abc',
          },
          version: 0,
        }),
      );

      await useUserSettingsStore.persist.rehydrate();
      const state = useUserSettingsStore.getState();
      expect(state.rightPanelTab).toBe('backlinks');
      expect(state.rightPanelWidth).toBe(320);
    });

    it('C-3-5: seed された width=9999 は 560 にクランプされる', async () => {
      localStorage.setItem(
        'tsumiwiki-user-settings',
        JSON.stringify({
          state: {
            rightPanelWidth: 9999,
          },
          version: 0,
        }),
      );

      await useUserSettingsStore.persist.rehydrate();
      const state = useUserSettingsStore.getState();
      expect(state.rightPanelWidth).toBe(560);
    });

    it('C-3-6: setRightPanelOpen(true) 後、localStorage の JSON に rightPanelOpen:true が保存される', () => {
      useUserSettingsStore.getState().setRightPanelOpen(true);
      const raw = localStorage.getItem('tsumiwiki-user-settings');
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed.state.rightPanelOpen).toBe(true);
    });
  });
});

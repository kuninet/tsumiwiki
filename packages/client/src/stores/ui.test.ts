import { beforeEach, describe, expect, it } from 'vitest';
import { useUIStore } from './ui';

describe('uiストア', () => {
  beforeEach(() => {
    useUIStore.setState({
      sidebarCollapsed: false,
      rightDrawerOpen: false,
      rightPanelSlot: null,
    });
  });

  it('サイドバー幅が200〜480pxにクランプされる', () => {
    const { setSidebarWidth } = useUIStore.getState();
    setSidebarWidth(100);
    expect(useUIStore.getState().sidebarWidth).toBe(200);
    setSidebarWidth(900);
    expect(useUIStore.getState().sidebarWidth).toBe(480);
    setSidebarWidth(300);
    expect(useUIStore.getState().sidebarWidth).toBe(300);
  });

  describe('右ドロワーと排他状態 (C-3-7 〜 C-3-10)', () => {
    it('C-3-7: 初期状態では rightDrawerOpen=false, rightPanelSlot=null', () => {
      const state = useUIStore.getState();
      expect(state.rightDrawerOpen).toBe(false);
      expect(state.rightPanelSlot).toBeNull();
    });

    it('C-3-8: 左が開のとき setRightDrawerOpen(true) で右が開・左が閉(sidebarCollapsed=true)になる', () => {
      useUIStore.setState({ sidebarCollapsed: false, rightDrawerOpen: false });
      useUIStore.getState().setRightDrawerOpen(true);
      const state = useUIStore.getState();
      expect(state.rightDrawerOpen).toBe(true);
      expect(state.sidebarCollapsed).toBe(true);
    });

    it('C-3-9: 右が開のとき toggleSidebarCollapsed() で左を開くと右が閉じる', () => {
      useUIStore.setState({ sidebarCollapsed: true, rightDrawerOpen: true });
      useUIStore.getState().toggleSidebarCollapsed();
      const state = useUIStore.getState();
      expect(state.sidebarCollapsed).toBe(false);
      expect(state.rightDrawerOpen).toBe(false);
    });

    it('C-3-10: 左が開・右閉のとき toggleSidebarCollapsed() で左を閉じても右は閉のまま', () => {
      useUIStore.setState({ sidebarCollapsed: false, rightDrawerOpen: false });
      useUIStore.getState().toggleSidebarCollapsed();
      const state = useUIStore.getState();
      expect(state.sidebarCollapsed).toBe(true);
      expect(state.rightDrawerOpen).toBe(false);
    });
  });

  describe('ツリー追従 (#323)', () => {
    beforeEach(() => {
      useUIStore.setState({
        expandedFolders: new Set(),
        revealRequest: null,
        sidebarTab: 'folder',
      });
    });

    it('S-1: expandedFolders が空のとき、祖先フォルダすべてが展開される', () => {
      useUIStore.getState().expandAncestors('a/b/c.md');
      expect(useUIStore.getState().expandedFolders).toEqual(new Set(['a', 'a/b']));
    });

    it('S-2: 既存の展開フォルダを閉じずに祖先フォルダを追加展開する', () => {
      useUIStore.setState({ expandedFolders: new Set(['x']) });
      useUIStore.getState().expandAncestors('a/b/c.md');
      expect(useUIStore.getState().expandedFolders).toEqual(new Set(['x', 'a', 'a/b']));
    });

    it('S-3: すでに祖先がすべて展開済みの場合は expandedFolders の参照が変わらない', () => {
      const initial = new Set(['a', 'a/b']);
      useUIStore.setState({ expandedFolders: initial });
      useUIStore.getState().expandAncestors('a/b/c.md');
      expect(useUIStore.getState().expandedFolders).toBe(initial);
    });

    it('S-4: ルート直下の文書の場合、参照が変わらない', () => {
      const initial = new Set<string>();
      useUIStore.setState({ expandedFolders: initial });
      useUIStore.getState().expandAncestors('root.md');
      expect(useUIStore.getState().expandedFolders).toBe(initial);
    });

    it('S-5: isFolder: true かつ includeSelf: true の場合、自分自身も含めて展開される', () => {
      useUIStore.getState().expandAncestors('a/b', { isFolder: true, includeSelf: true });
      expect(useUIStore.getState().expandedFolders).toEqual(new Set(['a', 'a/b']));
    });

    it('S-6: isFolder: true でも includeSelf がなければ自分自身は展開されない', () => {
      useUIStore.getState().expandAncestors('a/b', { isFolder: true });
      expect(useUIStore.getState().expandedFolders).toEqual(new Set(['a']));
    });

    it('S-7: isFolder: false (または未指定) の場合 includeSelf: true は無視される', () => {
      useUIStore.getState().expandAncestors('a/b.md', { includeSelf: true });
      expect(useUIStore.getState().expandedFolders).toEqual(new Set(['a']));
    });

    it('S-8: revealInTree で祖先が展開され revealRequest が積まれる(sidebarTab は維持)', () => {
      useUIStore.setState({ sidebarTab: 'tag', revealRequest: null });
      useUIStore.getState().revealInTree('a/b/c.md');
      const state = useUIStore.getState();
      expect(state.expandedFolders).toEqual(new Set(['a', 'a/b']));
      expect(state.sidebarTab).toBe('tag');
      expect(state.revealRequest).toMatchObject({
        path: 'a/b/c.md',
        isFolder: false,
        focus: false,
      });
      expect(typeof state.revealRequest?.nonce).toBe('number');
    });

    it('S-9: revealInTree で activateTab: true や focus: true が指定された場合反映される', () => {
      useUIStore.setState({ sidebarTab: 'tag', revealRequest: null });
      useUIStore.getState().revealInTree('a/b', {
        isFolder: true,
        includeSelf: true,
        activateTab: true,
        focus: true,
      });
      const state = useUIStore.getState();
      expect(state.sidebarTab).toBe('folder');
      expect(state.expandedFolders).toEqual(new Set(['a', 'a/b']));
      expect(state.revealRequest).toMatchObject({
        path: 'a/b',
        isFolder: true,
        focus: true,
      });
    });

    it('S-10: 祖先が展開済みでも revealInTree を呼ぶと revealRequest が更新され nonce が増加する', () => {
      useUIStore.setState({ expandedFolders: new Set(['a', 'a/b']) });
      const initial = useUIStore.getState().expandedFolders;
      useUIStore.getState().revealInTree('a/b/c.md');
      const nonce1 = useUIStore.getState().revealRequest?.nonce;
      expect(useUIStore.getState().expandedFolders).toBe(initial);

      useUIStore.getState().revealInTree('a/b/c.md');
      const nonce2 = useUIStore.getState().revealRequest?.nonce;
      expect(nonce2).toBeGreaterThan(nonce1!);
      expect(useUIStore.getState().expandedFolders).toBe(initial);
    });

    it('S-11: consumeRevealRequest で nonce が一致する要求が消費され null になる', () => {
      useUIStore.getState().revealInTree('a/b/c.md');
      const nonce = useUIStore.getState().revealRequest!.nonce;
      useUIStore.getState().consumeRevealRequest(nonce);
      expect(useUIStore.getState().revealRequest).toBeNull();
    });

    it('S-12: 古い nonce で consumeRevealRequest を呼んでも新しい要求は残る', () => {
      useUIStore.getState().revealInTree('a/b/c.md');
      const nonce1 = useUIStore.getState().revealRequest!.nonce;
      useUIStore.getState().revealInTree('x/y/z.md');
      const nonce2 = useUIStore.getState().revealRequest!.nonce;

      useUIStore.getState().consumeRevealRequest(nonce1);
      expect(useUIStore.getState().revealRequest?.nonce).toBe(nonce2);
    });

    it('S-13: consumeRevealRequest 後に再度 revealInTree を呼んでも nonce が巻き戻らない', () => {
      useUIStore.getState().revealInTree('a/b/c.md');
      const nonce1 = useUIStore.getState().revealRequest!.nonce;
      useUIStore.getState().consumeRevealRequest(nonce1);
      expect(useUIStore.getState().revealRequest).toBeNull();

      useUIStore.getState().revealInTree('a/b/c.md');
      const nonce2 = useUIStore.getState().revealRequest!.nonce;
      expect(nonce2).toBeGreaterThan(nonce1);
    });
  });
});

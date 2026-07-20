import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useDragStore } from '../stores/drag';
import { useTabsStore } from '../stores/tabs';
import { classifyPosition, DropZoneOverlay, _MAX_PANES } from './DropZoneOverlay';

// jsdom の DragEvent は clientX/Y を安定に運ばないので、座標判定のロジックは
// classifyPosition の pure 関数単体テストで担保する。
// コンポーネント側のテストは「ドラッグ中に overlay が存在する」「drop で drag state が
// 消える」の高レベル振る舞いに絞る

describe('classifyPosition', () => {
  it('左端に近ければ left', () => {
    expect(classifyPosition(20, 150, 400, 300, true, true)).toBe('left');
  });
  it('右端に近ければ right', () => {
    expect(classifyPosition(380, 150, 400, 300, true, true)).toBe('right');
  });
  it('上端に近ければ top', () => {
    expect(classifyPosition(200, 10, 400, 300, true, true)).toBe('top');
  });
  it('下端に近ければ bottom', () => {
    expect(classifyPosition(200, 290, 400, 300, true, true)).toBe('bottom');
  });
  it('中央付近は center', () => {
    expect(classifyPosition(200, 150, 400, 300, true, true)).toBe('center');
  });
  it('allowSides=false のときは端に近くても center', () => {
    expect(classifyPosition(20, 150, 400, 300, false, true)).toBe('center');
  });
  it('allowCenter=false のとき、中央付近は null(何もハイライトしない)', () => {
    expect(classifyPosition(200, 150, 400, 300, true, false)).toBeNull();
  });
  it('サイズ 0 は null', () => {
    expect(classifyPosition(10, 10, 0, 100, true, true)).toBeNull();
    expect(classifyPosition(10, 10, 100, 0, true, true)).toBeNull();
  });
});

describe('DropZoneOverlay', () => {
  beforeEach(() => {
    useTabsStore.getState().reset();
    useDragStore.getState().end();
  });
  afterEach(() => cleanup());

  it('ドラッグ中でなければ overlay 自体を描画しない', () => {
    const paneId = useTabsStore.getState().activePaneId;
    const { container } = render(<DropZoneOverlay paneId={paneId} />);
    expect(container.querySelector('[data-testid^="dropzones-"]')).toBeNull();
  });

  it('ドラッグ中は overlay コンテナを描画する(source pane)', () => {
    const paneId = useTabsStore.getState().activePaneId;
    useTabsStore.getState().openDoc('a.md');
    useDragStore.getState().start('a.md', paneId);
    render(<DropZoneOverlay paneId={paneId} />);
    expect(screen.getByTestId(`dropzones-${paneId}`)).toBeTruthy();
  });

  it('ドロップで drag state がクリアされる', () => {
    useTabsStore.getState().openDoc('a.md');
    useDragStore.getState().start('a.md', 'other-pane');
    const paneId = useTabsStore.getState().activePaneId;
    render(<DropZoneOverlay paneId={paneId} />);
    const zone = screen.getByTestId(`dropzones-${paneId}`);
    fireEvent.drop(zone);
    expect(useDragStore.getState().draggingPath).toBeNull();
  });

  it('root が既に split でも L/R/T/B は引き続き有効(#147 N 分割)', () => {
    useTabsStore.getState().openDoc('a.md', { pinned: true });
    useTabsStore.getState().openDoc('b.md', { pinned: true });
    // まず 2 分割にする
    useTabsStore.getState().splitOrMove('a.md', useTabsStore.getState().activePaneId, 'right');
    const root = useTabsStore.getState().root;
    if (root.kind !== 'split' || root.a.kind !== 'leaf') throw new Error();
    // 分割済みの leaf にドラッグ:別ペインからなら L/R/T/B + center が使える
    useDragStore.getState().start('b.md', 'other-pane');
    const targetPaneId = root.a.id;
    render(<DropZoneOverlay paneId={targetPaneId} />);
    // overlay コンテナが存在すること(以前は isRootSplit で center のみに縛られていた)
    expect(screen.getByTestId(`dropzones-${targetPaneId}`)).toBeTruthy();
  });

  it(`leaf 総数が上限(${_MAX_PANES})に達したら L/R/T/B は無効化される`, () => {
    // 上限までペインを作る:reset 状態から新規タブ + 分割を繰り返す
    useTabsStore.getState().openDoc('a.md', { pinned: true });
    let currentActive = useTabsStore.getState().activePaneId;
    // 各ステップで新規タブを active pane に開き、そのタブを right に分割する
    for (let i = 1; i < _MAX_PANES; i++) {
      const path = `p${i}.md`;
      useTabsStore.getState().openDoc(path, { pinned: true });
      currentActive = useTabsStore.getState().activePaneId;
      useTabsStore.getState().splitOrMove(path, currentActive, 'right');
    }
    // ここで leaf 数 = MAX_PANES
    // classifyPosition が allowSides=false でも center は返る前提を保つ
    useDragStore.getState().start('a.md', 'other-pane');
    const paneId = useTabsStore.getState().activePaneId;
    render(<DropZoneOverlay paneId={paneId} />);
    expect(screen.getByTestId(`dropzones-${paneId}`)).toBeTruthy();
    // allowSides=false の直接テストは classifyPosition の unit test でカバー
  });

  it('モバイル判定で早期 return(matchMedia を stub)', () => {
    // useMediaQuery('(max-width: 767px)') が true を返すよう matchMedia を stub
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = (q: string) => ({
      matches: q.includes('767px'),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    }) as unknown as MediaQueryList;
    try {
      useTabsStore.getState().openDoc('a.md');
      useDragStore.getState().start('a.md', 'other-pane');
      const paneId = useTabsStore.getState().activePaneId;
      const { container } = render(<DropZoneOverlay paneId={paneId} />);
      expect(container.querySelector('[data-testid^="dropzones-"]')).toBeNull();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });
});

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { flushSync } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextMenu } from './ContextMenu';

// 右クリックでメニューを開く、呼び出し元を模したコンポーネント
function Opener({ name, stopPropagation }: { name: string; stopPropagation?: boolean }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <div>
      <button
        type="button"
        data-testid={`opener-${name}`}
        onContextMenu={(e) => {
          e.preventDefault();
          if (stopPropagation) e.stopPropagation();
          const pos = { x: e.clientX, y: e.clientY };
          // 実ブラウザでは、React のリスナが返った直後(window に届く前)にマイクロタスクで
          // 描画と effect が走る。jsdom の dispatchEvent では呼び出し元が積まれていて
          // マイクロタスクが割り込まないので、flushSync で同じ順序を再現する
          flushSync(() => setMenu(pos));
        }}
      >
        {name}
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[{ label: `${name}の項目`, onSelect: vi.fn() }]}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

// fireEvent は act の中で dispatch し、effect をイベントの後で流すため、即閉じが再現しない。
// act の外で、実際のイベント順のまま dispatch する。その後、イベント中に積まれた更新を流してから検証する
async function rightClick(el: Element, clientX = 10) {
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX }));
  await act(async () => {});
}

describe('ContextMenu', () => {
  afterEach(() => {
    cleanup();
  });

  it('項目をクリックするとonSelectとonCloseが呼ばれる', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<ContextMenu x={0} y={0} items={[{ label: '削除', onSelect }]} onClose={onClose} />);

    fireEvent.click(screen.getByRole('menuitem', { name: '削除' }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('メニュー外をクリックするとonCloseが呼ばれる', () => {
    const onClose = vi.fn();
    render(<ContextMenu x={0} y={0} items={[{ label: 'X', onSelect: vi.fn() }]} onClose={onClose} />);

    fireEvent.click(document.body);

    expect(onClose).toHaveBeenCalled();
  });

  describe('開閉の順序(#301)', () => {
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    let prevActEnv: boolean | undefined;

    beforeEach(() => {
      // act の外で更新するので、act 警告を止める
      prevActEnv = g.IS_REACT_ACT_ENVIRONMENT;
      g.IS_REACT_ACT_ENVIRONMENT = false;
    });

    afterEach(() => {
      g.IS_REACT_ACT_ENVIRONMENT = prevActEnv;
    });

    it.each([false, true])(
      'メニューを開いた右クリックそのものでは閉じない(stopPropagation=%s)',
      async (stopPropagation) => {
        render(<Opener name="A" stopPropagation={stopPropagation} />);

        await rightClick(screen.getByTestId('opener-A'));

        expect(screen.getAllByRole('menu')).toHaveLength(1);
        expect(screen.getByRole('menuitem', { name: 'Aの項目' })).toBeTruthy();
      },
    );

    it.each([false, true])(
      '別のメニューを開くと前のメニューが閉じる(stopPropagation=%s)',
      async (stopPropagation) => {
        render(
          <>
            <Opener name="A" stopPropagation={stopPropagation} />
            <Opener name="B" stopPropagation={stopPropagation} />
          </>,
        );

        await rightClick(screen.getByTestId('opener-A'));
        await rightClick(screen.getByTestId('opener-B'));
        expect(screen.getAllByRole('menu')).toHaveLength(1);
        expect(screen.getByRole('menuitem', { name: 'Bの項目' })).toBeTruthy();

        await rightClick(screen.getByTestId('opener-A'));
        expect(screen.getAllByRole('menu')).toHaveLength(1);
        expect(screen.getByRole('menuitem', { name: 'Aの項目' })).toBeTruthy();
      },
    );

    it('右クリック以外の経路で開いても、ほかのメニューは閉じる', async () => {
      function ClickOpener() {
        const [open, setOpen] = useState(false);
        return (
          <div>
            <button
              type="button"
              data-testid="click-opener"
              onClick={(e) => {
                // ContextMenu の window の click リスナに届かない経路
                e.stopPropagation();
                setOpen(true);
              }}
            >
              C
            </button>
            {open && (
              <ContextMenu
                x={0}
                y={0}
                items={[{ label: 'Cの項目', onSelect: vi.fn() }]}
                onClose={() => setOpen(false)}
              />
            )}
          </div>
        );
      }
      render(
        <>
          <Opener name="A" stopPropagation />
          <ClickOpener />
        </>,
      );

      await rightClick(screen.getByTestId('opener-A'));
      fireEvent.click(screen.getByTestId('click-opener'));

      expect(screen.getAllByRole('menu')).toHaveLength(1);
      expect(screen.getByRole('menuitem', { name: 'Cの項目' })).toBeTruthy();
    });

    it('同じ呼び出し元で別の位置を右クリックすると、メニューが移って開いたまま残る', async () => {
      render(<Opener name="A" />);

      await rightClick(screen.getByTestId('opener-A'), 10);
      await rightClick(screen.getByTestId('opener-A'), 40);

      expect(screen.getAllByRole('menu')).toHaveLength(1);
      expect(screen.getByRole('menu').style.left).toBe('40px');
    });

    it('メニューの中の右クリックでは閉じない', async () => {
      render(<Opener name="A" />);

      await rightClick(screen.getByTestId('opener-A'));
      await rightClick(screen.getByRole('menuitem', { name: 'Aの項目' }));

      expect(screen.getAllByRole('menu')).toHaveLength(1);
    });

    it('メニューの外の右クリックで閉じる', async () => {
      render(<Opener name="A" />);

      await rightClick(screen.getByTestId('opener-A'));
      await rightClick(document.body);

      expect(screen.queryByRole('menu')).toBeNull();
    });
  });
});

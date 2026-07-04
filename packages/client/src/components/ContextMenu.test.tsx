import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextMenu } from './ContextMenu';

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
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { DocSummary } from '@tsumiwiki/shared';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { DiffLine } from '../lib/parse-diff';
import { useToastStore } from '../stores/toast';
import { buildRows, SideBySideDiffView } from './SideBySideDiffView';

describe('buildRows', () => {
  it('純粋な追加のみ(contextなし)は右カラムのみ埋まる', () => {
    const lines: DiffLine[] = [
      { type: 'hunk', text: '@@ -0,0 +1,2 @@' },
      { type: 'add', text: '+一行目' },
      { type: 'add', text: '+二行目' },
    ];
    const rows = buildRows(lines);
    expect(rows).toEqual([
      { left: undefined, right: { kind: 'add', text: '一行目' } },
      { left: undefined, right: { kind: 'add', text: '二行目' } },
    ]);
  });

  it('純粋な削除のみは左カラムのみ埋まる', () => {
    const lines: DiffLine[] = [
      { type: 'hunk', text: '@@ -1,2 +0,0 @@' },
      { type: 'del', text: '-一行目' },
      { type: 'del', text: '-二行目' },
    ];
    const rows = buildRows(lines);
    expect(rows).toEqual([
      { left: { kind: 'del', text: '一行目' }, right: undefined },
      { left: { kind: 'del', text: '二行目' }, right: undefined },
    ]);
  });

  it('addとdelのペアは同じrowに並ぶ', () => {
    const lines: DiffLine[] = [
      { type: 'hunk', text: '@@ -1 +1 @@' },
      { type: 'del', text: '-旧' },
      { type: 'add', text: '+新' },
    ];
    const rows = buildRows(lines);
    expect(rows).toEqual([{ left: { kind: 'del', text: '旧' }, right: { kind: 'add', text: '新' } }]);
  });

  it('context行は左右両方に表示される', () => {
    const lines: DiffLine[] = [
      { type: 'hunk', text: '@@ -1 +1 @@' },
      { type: 'context', text: ' 変わらない' },
    ];
    const rows = buildRows(lines);
    expect(rows).toEqual([
      { left: { kind: 'context', text: '変わらない' }, right: { kind: 'context', text: '変わらない' } },
    ]);
  });

  it('ハンク境界にdividerを差し込む(先頭ハンクでは出さない)', () => {
    const lines: DiffLine[] = [
      { type: 'hunk', text: '@@ -1 +1 @@' },
      { type: 'add', text: '+A' },
      { type: 'hunk', text: '@@ -5 +5 @@' },
      { type: 'add', text: '+B' },
    ];
    const rows = buildRows(lines);
    expect(rows).toEqual([
      { left: undefined, right: { kind: 'add', text: 'A' } },
      { divider: true },
      { left: undefined, right: { kind: 'add', text: 'B' } },
    ]);
  });

  it('空のdiffではrowが空になる', () => {
    expect(buildRows([])).toEqual([]);
  });

  // #66 Phase 1c レビュー指摘: 非対称ケースのペアリング検証
  it('del(3)がadd(5)より少ないケース: 3行ペア + 右add2行(左は空)', () => {
    const lines: DiffLine[] = [
      { type: 'hunk', text: '@@ -1,3 +1,5 @@' },
      { type: 'del', text: '-D1' },
      { type: 'del', text: '-D2' },
      { type: 'del', text: '-D3' },
      { type: 'add', text: '+A1' },
      { type: 'add', text: '+A2' },
      { type: 'add', text: '+A3' },
      { type: 'add', text: '+A4' },
      { type: 'add', text: '+A5' },
    ];
    const rows = buildRows(lines);
    expect(rows).toEqual([
      { left: { kind: 'del', text: 'D1' }, right: { kind: 'add', text: 'A1' } },
      { left: { kind: 'del', text: 'D2' }, right: { kind: 'add', text: 'A2' } },
      { left: { kind: 'del', text: 'D3' }, right: { kind: 'add', text: 'A3' } },
      { left: undefined, right: { kind: 'add', text: 'A4' } },
      { left: undefined, right: { kind: 'add', text: 'A5' } },
    ]);
  });

  it('del(5)がadd(3)より多いケース: 3行ペア + 左del2行(右は空)', () => {
    const lines: DiffLine[] = [
      { type: 'hunk', text: '@@ -1,5 +1,3 @@' },
      { type: 'del', text: '-D1' },
      { type: 'del', text: '-D2' },
      { type: 'del', text: '-D3' },
      { type: 'del', text: '-D4' },
      { type: 'del', text: '-D5' },
      { type: 'add', text: '+A1' },
      { type: 'add', text: '+A2' },
      { type: 'add', text: '+A3' },
    ];
    const rows = buildRows(lines);
    expect(rows).toEqual([
      { left: { kind: 'del', text: 'D1' }, right: { kind: 'add', text: 'A1' } },
      { left: { kind: 'del', text: 'D2' }, right: { kind: 'add', text: 'A2' } },
      { left: { kind: 'del', text: 'D3' }, right: { kind: 'add', text: 'A3' } },
      { left: { kind: 'del', text: 'D4' }, right: undefined },
      { left: { kind: 'del', text: 'D5' }, right: undefined },
    ]);
  });

  // #66 Phase 1c レビュー指摘: meta行が完全に無視される
  it('meta行のみのdiffではrowが空(hunkに到達しないため何も出ない)', () => {
    const lines: DiffLine[] = [
      { type: 'meta', text: 'diff --git a/foo.md b/foo.md' },
      { type: 'meta', text: '--- a/foo.md' },
      { type: 'meta', text: '+++ b/foo.md' },
    ];
    expect(buildRows(lines)).toEqual([]);
  });

  it('meta行の後に最初のhunkが来ても先頭にdividerは出ない', () => {
    const lines: DiffLine[] = [
      { type: 'meta', text: 'diff --git a/foo.md b/foo.md' },
      { type: 'meta', text: '--- a/foo.md' },
      { type: 'meta', text: '+++ b/foo.md' },
      { type: 'hunk', text: '@@ -1 +1 @@' },
      { type: 'add', text: '+新' },
    ];
    const rows = buildRows(lines);
    // meta は sawContentSinceDivider を汚さないので、先頭 hunk で divider は出ない
    expect(rows).toEqual([{ left: undefined, right: { kind: 'add', text: '新' } }]);
  });
});

describe('SideBySideDiffView', () => {
  afterEach(() => {
    cleanup();
    useToastStore.setState({ toast: null });
  });

  it('変更がない場合は「変更はありません」を表示する', () => {
    render(
      <MemoryRouter>
        <SideBySideDiffView lines={[]} docs={[]} />
      </MemoryRouter>,
    );
    expect(screen.getByText('変更はありません')).toBeTruthy();
  });

  function LocationProbe() {
    const location = useLocation();
    return <div data-testid="location-pathname">{location.pathname}</div>;
  }

  function renderWithRouter(lines: DiffLine[], docs: DocSummary[]) {
    return render(
      <MemoryRouter initialEntries={['/history']}>
        <Routes>
          <Route
            path="/history"
            element={
              <>
                <SideBySideDiffView lines={lines} docs={docs} />
                <LocationProbe />
              </>
            }
          />
          <Route path="/doc/*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  // #66 Phase 1c レビュー指摘: grid の子として <hr> を置くため col-span-2 が必須。
  // これが落ちると grid 内で右カラムが崩れる。DOM 上での存在を検証する
  it('複数ハンクのdiffではhr要素にcol-span-2が付いた区切り線が現れる', () => {
    const lines: DiffLine[] = [
      { type: 'hunk', text: '@@ -1 +1 @@' },
      { type: 'add', text: '+A' },
      { type: 'hunk', text: '@@ -5 +5 @@' },
      { type: 'add', text: '+B' },
    ];
    render(
      <MemoryRouter>
        <SideBySideDiffView lines={lines} docs={[]} />
      </MemoryRouter>,
    );
    const hrs = document.querySelectorAll('hr');
    expect(hrs).toHaveLength(1);
    expect(hrs[0].className).toContain('col-span-2');
  });

  it('差分内のwikilinkをクリックすると解決先ドキュメントへnavigateする', () => {
    const lines: DiffLine[] = [
      { type: 'hunk', text: '@@ -1 +1 @@' },
      { type: 'add', text: '+ [[設計]] を参照' },
    ];
    const docs: DocSummary[] = [
      { path: '設計.md', title: '設計', folder: '', updatedAt: '2026-07-01T00:00:00+09:00' },
    ];

    renderWithRouter(lines, docs);

    expect(screen.getByTestId('location-pathname').textContent).toBe('/history');

    const wikilinkSpan = document.querySelector('span[data-type="wikilink"][data-target="設計"]');
    expect(wikilinkSpan).not.toBeNull();

    fireEvent.click(wikilinkSpan!);

    expect(screen.getByTestId('location-pathname').textContent).toBe('/doc/%E8%A8%AD%E8%A8%88.md');
  });
});

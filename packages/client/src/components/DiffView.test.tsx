// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { DocSummary } from '@tsumiwiki/shared';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { DiffLine } from '../lib/parse-diff';
import { useToastStore } from '../stores/toast';
import { DiffView, groupDiffLines } from './DiffView';

describe('groupDiffLines', () => {
  it('meta行は表示に含めない', () => {
    const lines: DiffLine[] = [
      { type: 'meta', text: '--- a/foo.md' },
      { type: 'meta', text: '+++ b/foo.md' },
      { type: 'hunk', text: '@@ -1,3 +1,3 @@' },
      { type: 'context', text: ' 変わらない' },
      { type: 'add', text: '+追加' },
    ];
    const groups = groupDiffLines(lines);
    // meta / hunk / context / add → hunk先頭では divider を出さない
    expect(groups).toEqual([
      { kind: 'context', texts: ['変わらない'] },
      { kind: 'add', texts: ['追加'] },
    ]);
  });

  it('同種の行は1グループにまとめる', () => {
    const lines: DiffLine[] = [
      { type: 'hunk', text: '@@ -1 +1,2 @@' },
      { type: 'add', text: '+一行目' },
      { type: 'add', text: '+二行目' },
      { type: 'del', text: '-削除1' },
      { type: 'del', text: '-削除2' },
    ];
    const groups = groupDiffLines(lines);
    expect(groups).toEqual([
      { kind: 'add', texts: ['一行目', '二行目'] },
      { kind: 'del', texts: ['削除1', '削除2'] },
    ]);
  });

  it('ハンク境界に divider を差し込む(先頭では出さない)', () => {
    const lines: DiffLine[] = [
      { type: 'hunk', text: '@@ -1 +1 @@' },
      { type: 'add', text: '+A' },
      { type: 'hunk', text: '@@ -5 +5 @@' },
      { type: 'add', text: '+B' },
    ];
    const groups = groupDiffLines(lines);
    expect(groups).toEqual([
      { kind: 'add', texts: ['A'] },
      { kind: 'divider' },
      { kind: 'add', texts: ['B'] },
    ]);
  });
});

// #96: 差分表示は DocView 本体の onClick コンテナと兄弟の履歴パネル内で描画されるため、
// クリックが DocView の handleContainerClick に伝播しない。DiffView が独立したハンドラで
// wikilink クリックを処理し、navigate まで到達することを保証する。
describe('DiffView wikilink click', () => {
  afterEach(() => {
    cleanup();
    useToastStore.setState({ toast: null });
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
                <DiffView lines={lines} docs={docs} />
                <LocationProbe />
              </>
            }
          />
          <Route path="/doc/*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('差分内の wikilink をクリックすると解決先ドキュメントへ navigate する', () => {
    const lines: DiffLine[] = [
      { type: 'hunk', text: '@@ -1 +1 @@' },
      { type: 'add', text: '+ [[設計]] を参照' },
    ];
    const docs: DocSummary[] = [
      { path: '設計.md', title: '設計', folder: '', updatedAt: '2026-07-01T00:00:00+09:00' },
    ];

    renderWithRouter(lines, docs);

    // 初期位置は履歴ページ
    expect(screen.getByTestId('location-pathname').textContent).toBe('/history');

    // 差分表示に data-target="設計" の wikilink span が描画されている
    const wikilinkSpan = document.querySelector('span[data-type="wikilink"][data-target="設計"]');
    expect(wikilinkSpan).not.toBeNull();

    fireEvent.click(wikilinkSpan!);

    // クリック後は解決先(/doc/設計.md, URL エンコード済み)へ navigate されている
    expect(screen.getByTestId('location-pathname').textContent).toBe('/doc/%E8%A8%AD%E8%A8%88.md');
  });

  it('リンク先が解決できない wikilink はエラートーストを出し navigate しない', () => {
    const lines: DiffLine[] = [
      { type: 'hunk', text: '@@ -1 +1 @@' },
      { type: 'add', text: '+ [[存在しない]]' },
    ];
    renderWithRouter(lines, []);

    const wikilinkSpan = document.querySelector('span[data-type="wikilink"]');
    fireEvent.click(wikilinkSpan!);

    expect(screen.getByTestId('location-pathname').textContent).toBe('/history');
    expect(useToastStore.getState().toast?.message).toBe('リンク先が見つかりません');
  });
});

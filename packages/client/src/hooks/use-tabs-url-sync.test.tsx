import { cleanup, render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getActivePaneActiveIdFromState,
  getActivePaneTabsFromState,
  useTabsStore,
} from '../stores/tabs';
import { useTabsUrlSync } from './use-tabs-url-sync';

function Probe() {
  useTabsUrlSync();
  return null;
}

function renderWith(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/" element={<Probe />} />
        <Route path="doc/*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('useTabsUrlSync', () => {
  beforeEach(() => {
    useTabsStore.getState().reset();
  });
  afterEach(() => cleanup());

  it('/doc/foo で開くと foo タブが preview として作成されアクティブになる', async () => {
    renderWith('/doc/foo.md');
    await Promise.resolve();
    expect(getActivePaneTabsFromState(useTabsStore.getState()).map((t) => t.path)).toEqual([
      'foo.md',
    ]);
    expect(getActivePaneActiveIdFromState(useTabsStore.getState())).toBe('foo.md');
  });

  it('URL 変化で既存タブがある場合はアクティブ切替のみで新規は作らない', async () => {
    useTabsStore.getState().openDoc('a.md', { pinned: true });
    useTabsStore.getState().openDoc('b.md', { pinned: true });
    expect(getActivePaneTabsFromState(useTabsStore.getState())).toHaveLength(2);

    renderWith('/doc/a.md');
    await Promise.resolve();
    expect(getActivePaneTabsFromState(useTabsStore.getState())).toHaveLength(2);
    expect(getActivePaneActiveIdFromState(useTabsStore.getState())).toBe('a.md');
  });
});

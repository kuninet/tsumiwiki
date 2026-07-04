import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

describe('App', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ヘルスチェック成功時にAPI接続OKを表示する', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            status: 'ok',
            name: 'tsumiwiki',
            version: '0.1.0',
            time: '2026-07-04T00:00:00.000Z',
          }),
      }),
    );

    render(<App />);
    const el = await screen.findByTestId('health');
    expect(el.textContent).toContain('APIサーバー接続OK');
  });

  it('ヘルスチェック失敗時にエラーを表示する', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));

    render(<App />);
    const el = await screen.findByTestId('health-error');
    expect(el.textContent).toContain('接続できません');
  });
});

import { describe, expect, it } from 'vitest';
import { getTabActions, registerTabActions, type TabActions } from './tab-actions-registry';

function makeActions(marker: string): TabActions {
  return {
    save: () => Promise.resolve(true),
    discard: () => Promise.resolve(),
    // marker はテスト側の識別用に "any" キャストで穴を開けずに済むよう、
    // 動的プロパティは避けて toString で識別する
    toString: () => marker,
  } as TabActions & { toString(): string };
}

describe('tab-actions-registry', () => {
  it('register 後 get で取得できる', () => {
    const actions = makeActions('A1');
    registerTabActions('a.md', actions);
    expect(getTabActions('a.md')).toBe(actions);
  });

  it('unregister ハンドラで解除される', () => {
    const actions = makeActions('A2');
    const unregister = registerTabActions('a.md', actions);
    unregister();
    expect(getTabActions('a.md')).toBeUndefined();
  });

  it('同じ path で二重登録すると後勝ちで上書きされる', () => {
    const a1 = makeActions('A1');
    const a2 = makeActions('A2');
    registerTabActions('a.md', a1);
    registerTabActions('a.md', a2);
    expect(getTabActions('a.md')).toBe(a2);
  });

  it('上書き後に前 actions の unregister を呼んでも現行(後勝ち)を消さない', () => {
    const a1 = makeActions('A1');
    const a2 = makeActions('A2');
    const unregA1 = registerTabActions('a.md', a1);
    registerTabActions('a.md', a2);
    unregA1(); // 前インスタンスの解除。ガード条件で無視される想定
    expect(getTabActions('a.md')).toBe(a2);
  });
});

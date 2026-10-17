import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PropertiesPanel } from './PropertiesPanel';
import { PropertyValue } from './PropertyValue';

describe('PropertiesPanel コンポーネント単体テスト(C1〜C15)', () => {
  afterEach(() => {
    cleanup();
  });

  it('C1: 初期表示は折りたたみ状態（ボタンのみ、aria-expanded="false"、値はDOMにない）', () => {
    render(<PropertiesPanel frontmatter={{ title: 'サンプル', price: 100 }} />);
    const button = screen.getByRole('button', { name: /プロパティ/ });
    expect(button).toBeTruthy();
    expect(button.textContent).toContain('プロパティ (2件)');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('properties-list')).toBeNull();
    expect(screen.queryByText('サンプル')).toBeNull();
  });

  it('C2: クリックで展開され aria-expanded="true" になりキーと値が表示される', () => {
    render(<PropertiesPanel frontmatter={{ title: 'サンプル', price: 100 }} />);
    const button = screen.getByRole('button', { name: /プロパティ/ });
    fireEvent.click(button);

    expect(button.getAttribute('aria-expanded')).toBe('true');
    const region = screen.getByRole('region');
    expect(region).toBeTruthy();
    expect(region.getAttribute('aria-labelledby')).toBe(button.id);
    expect(button.getAttribute('aria-controls')).toBe(region.id);

    expect(screen.getByText('title')).toBeTruthy();
    expect(screen.getByText('サンプル')).toBeTruthy();
    expect(screen.getByText('price')).toBeTruthy();
    expect(screen.getByText('100')).toBeTruthy();
  });

  it('C3: 再度クリックすると折りたたまれ値がDOMから消える', () => {
    render(<PropertiesPanel frontmatter={{ title: 'サンプル' }} />);
    const button = screen.getByRole('button', { name: /プロパティ/ });

    fireEvent.click(button);
    expect(screen.getByText('サンプル')).toBeTruthy();

    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('properties-list')).toBeNull();
    expect(screen.queryByText('サンプル')).toBeNull();
  });

  it('C4: 空・tagsのみ・tagのみ・非オブジェクトの場合はパネル全体が描画されない(null)', () => {
    const { container: c1 } = render(<PropertiesPanel frontmatter={{}} />);
    expect(c1.firstChild).toBeNull();

    const { container: c2 } = render(<PropertiesPanel frontmatter={{ tags: ['tag1', 'tag2'] }} />);
    expect(c2.firstChild).toBeNull();

    const { container: c2b } = render(<PropertiesPanel frontmatter={{ tag: '単数タグ' }} />);
    expect(c2b.firstChild).toBeNull();

    const { container: c3 } = render(<PropertiesPanel frontmatter={['item1', 'item2']} />);
    expect(c3.firstChild).toBeNull();

    const { container: c4 } = render(<PropertiesPanel frontmatter="スカラー文字列" />);
    expect(c4.firstChild).toBeNull();

    const { container: c5 } = render(<PropertiesPanel frontmatter={null} />);
    expect(c5.firstChild).toBeNull();
  });

  it('C5: tags以外のキーのみが件数にカウントされる', () => {
    render(
      <PropertiesPanel
        frontmatter={{
          tags: ['タグ1'],
          a: 1,
          b: null,
          c: '',
        }}
      />,
    );
    const button = screen.getByRole('button', { name: /プロパティ/ });
    expect(button.textContent).toContain('プロパティ (3件)');
  });

  it('C6: 空⇔非空のprops変化でフック順序エラーにならず、展開状態が維持される', () => {
    const { rerender } = render(<PropertiesPanel frontmatter={{}} />);
    expect(screen.queryByTestId('properties-panel')).toBeNull();

    // 非空に変更
    rerender(<PropertiesPanel frontmatter={{ key1: 'value1' }} />);
    const button = screen.getByRole('button', { name: /プロパティ/ });
    fireEvent.click(button);
    expect(screen.getByText('value1')).toBeTruthy();

    // 空に変更
    rerender(<PropertiesPanel frontmatter={{}} />);
    expect(screen.queryByTestId('properties-panel')).toBeNull();

    // 再度非空に変更した際、同じコンポーネントインスタンスなのでopen状態が維持される
    rerender(<PropertiesPanel frontmatter={{ key1: 'value2' }} />);
    expect(screen.getByText('value2')).toBeTruthy();
  });

  it('C7: 展開中にpropsの値が更新されても開いたまま最新値が表示される', () => {
    const { rerender } = render(<PropertiesPanel frontmatter={{ count: 10 }} />);
    fireEvent.click(screen.getByRole('button', { name: /プロパティ/ }));
    expect(screen.getByText('10')).toBeTruthy();

    rerender(<PropertiesPanel frontmatter={{ count: 20 }} />);
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('20')).toBeTruthy();
  });

  it('C8: 各型（null, empty, boolean, number, date, datetime, text, list, object）が正しく描画される', () => {
    render(
      <PropertiesPanel
        frontmatter={{
          fNull: null,
          fEmpty: '',
          fBoolTrue: true,
          fBoolFalse: false,
          fNum: 980,
          fZero: 0,
          fDate: '2024-01-15',
          fDateIso: '2024-01-15T00:00:00.000Z',
          fDatetime: '2026-10-17T01:00:00.000Z',
          fTextMulti: 'line1\nline2\n',
          fList: ['Netflix', 'Spotify'],
          fObject: { plan: 'basic' },
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /プロパティ/ }));

    // null: "—"
    expect(screen.getByLabelText('値なし').textContent).toBe('—');
    // empty: "(空)"
    expect(screen.getByText('(空)')).toBeTruthy();
    // boolean
    expect(screen.getByText('☑')).toBeTruthy();
    expect(screen.getByText('true')).toBeTruthy();
    expect(screen.getByText('☐')).toBeTruthy();
    expect(screen.getByText('false')).toBeTruthy();
    // number
    expect(screen.getByText('980')).toBeTruthy();
    expect(screen.getByText('0')).toBeTruthy();
    // date
    const dateTimes = screen.getAllByText('2024-01-15');
    expect(dateTimes.length).toBe(2);
    // datetime (JST 10:00)
    expect(screen.getByText('2026/10/17 10:00')).toBeTruthy();
    // text (末尾改行1つ除去)
    expect(
      screen.getByText('line1\nline2', { collapseWhitespace: false }),
    ).toBeTruthy();
    // list
    expect(screen.getByText('Netflix')).toBeTruthy();
    expect(screen.getByText('Spotify')).toBeTruthy();
    // object
    expect(screen.getByText('{"plan":"basic"}')).toBeTruthy();
  });

  it('C9: http/https URL は外部リンク（target="_blank", rel="noopener noreferrer"）として描画される', () => {
    render(<PropertiesPanel frontmatter={{ site: 'https://example.com' }} />);
    fireEvent.click(screen.getByRole('button', { name: /プロパティ/ }));

    const link = screen.getByRole('link', { name: 'https://example.com' });
    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toBe('https://example.com');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('C10: 危険なスキーム（javascript:, file:, mailto: 等）はリンク化されずプレーンテキストになる', () => {
    render(
      <PropertiesPanel
        frontmatter={{
          xss: 'javascript:alert(1)',
          file: 'file:///etc/passwd',
          mail: 'mailto:user@example.com',
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /プロパティ/ }));

    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('javascript:alert(1)')).toBeTruthy();
    expect(screen.getByText('file:///etc/passwd')).toBeTruthy();
    expect(screen.getByText('mailto:user@example.com')).toBeTruthy();
  });

  it('C11: HTMLタグを含む文字列はエスケープされ要素として生成されない', () => {
    render(
      <PropertiesPanel
        frontmatter={{
          rawHtml: '<img src="x" onerror="alert(1)" />',
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /プロパティ/ }));

    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src="x" onerror="alert(1)" />')).toBeTruthy();
  });

  it('C12: [[Doc]] 形式の wikilink 風文字列はプレーンテキストとして描画される', () => {
    render(<PropertiesPanel frontmatter={{ noteLink: '[[DocName]]' }} />);
    fireEvent.click(screen.getByRole('button', { name: /プロパティ/ }));

    expect(document.querySelector('span[data-type="wikilink"]')).toBeNull();
    expect(screen.getByText('[[DocName]]')).toBeTruthy();
  });

  it('C13: 2つのパネルを同時描画しても useId により aria-controls が衝突しない', () => {
    render(
      <div>
        <PropertiesPanel frontmatter={{ a: 1 }} />
        <PropertiesPanel frontmatter={{ b: 2 }} />
      </div>,
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0].id).not.toBe(buttons[1].id);
    expect(buttons[0].getAttribute('aria-controls')).not.toBe(
      buttons[1].getAttribute('aria-controls'),
    );
  });

  it('C14: トグルボタンはネイティブの <button type="button"> である', () => {
    render(<PropertiesPanel frontmatter={{ a: 1 }} />);
    const button = screen.getByRole('button', { name: /プロパティ/ });
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
  });

  it('C15: URL リンクをクリックした際にイベント伝播（stopPropagation）が停止される', () => {
    const parentClickSpy = vi.fn();
    render(
      <div onClick={parentClickSpy}>
        <PropertyValue
          entry={{
            key: 'website',
            value: 'https://example.com',
            kind: 'url',
          }}
        />
      </div>,
    );
    const link = screen.getByRole('link', { name: 'https://example.com' });
    fireEvent.click(link);
    expect(parentClickSpy).not.toHaveBeenCalled();
  });
});

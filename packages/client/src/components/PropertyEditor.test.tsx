import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState, useMemo } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildFrontmatterOps,
  rowsFromFrontmatter,
  validateRows,
  type PropertyRowsState,
} from '../lib/frontmatter-edit';
import { PropertiesPanel, type PropertiesPanelProps } from './PropertiesPanel';

// 単体テスト用のラッパーコンポーネント（state と errors を自動管理）
function TestPanelWrapper(props: Partial<PropertiesPanelProps>) {
  const [rows, setRows] = useState<PropertyRowsState>(
    () => props.rows ?? rowsFromFrontmatter(props.frontmatter),
  );
  const errors = useMemo(() => validateRows(rows), [rows]);

  return (
    <PropertiesPanel
      frontmatter={props.frontmatter}
      editable={props.editable}
      frontmatterStatus={props.frontmatterStatus}
      rows={rows}
      errors={errors}
      onRowsChange={(next) => {
        setRows(next);
        props.onRowsChange?.(next);
      }}
    />
  );
}

describe('PropertyEditor / PropertiesPanel 編集単体テスト (CE1〜CE18)', () => {
  afterEach(() => {
    cleanup();
  });

  it('CE1: editable 未指定で #281 と同じ DOM（properties-editor が無く properties-list がある）', () => {
    render(<PropertiesPanel frontmatter={{ title: 'テスト' }} />);
    const toggle = screen.getByRole('button', { name: /プロパティ/ });
    fireEvent.click(toggle);

    expect(screen.getByTestId('properties-list')).toBeTruthy();
    expect(screen.queryByTestId('properties-editor')).toBeNull();
    expect(screen.queryByTestId('properties-edit')).toBeNull();
  });

  it('CE2: editable で展開 → 表示は #281 と同じ。「項目を変更する」click で properties-editor に切り替わり aria-label が仕様どおり', () => {
    render(
      <TestPanelWrapper
        frontmatter={{ title: 'テスト', count: 10 }}
        editable={true}
      />,
    );
    const toggle = screen.getByRole('button', { name: /プロパティ/ });
    fireEvent.click(toggle);

    // 最初は表示モード
    expect(screen.getByTestId('properties-list')).toBeTruthy();
    expect(screen.queryByTestId('properties-editor')).toBeNull();

    // 「項目を変更する」ボタン
    const editBtn = screen.getByTestId('properties-edit');
    expect(editBtn.getAttribute('aria-label')).toBe('項目を変更する');
    fireEvent.click(editBtn);

    // 編集エディタに切り替わる
    expect(screen.queryByTestId('properties-list')).toBeNull();
    const editor = screen.getByTestId('properties-editor');
    expect(editor.getAttribute('role')).toBe('group');
    expect(editor.getAttribute('aria-label')).toBe('プロパティの編集');

    // 行ごとの aria-label
    const keyInputs = screen.getAllByRole('textbox', { name: 'プロパティ名' });
    expect(keyInputs).toHaveLength(2);
    expect(screen.getByRole('combobox', { name: 'title の型' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'count の型' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'title を削除' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'count を削除' })).toBeTruthy();
  });

  it('CE3: 型ごとの入力要素が期待どおり描画される', () => {
    render(
      <TestPanelWrapper
        frontmatter={{
          str: 'テキスト',
          multi: '1行目\n2行目',
          num: 123,
          flag: true,
          dateVal: '2024-01-15',
          dtVal: '2026-10-17T10:00:00+09:00',
          listVal: ['item1', 'item2'],
          objVal: { foo: 'bar' },
        }}
        editable={true}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /プロパティ/ }));
    fireEvent.click(screen.getByTestId('properties-edit'));

    // text: input[type="text"]
    const strInput = screen.getByLabelText('str の値');
    expect(strInput.tagName.toLowerCase()).toBe('input');
    expect(strInput.getAttribute('type')).toBe('text');

    // multi text: textarea
    const multiInput = screen.getByLabelText('multi の値');
    expect(multiInput.tagName.toLowerCase()).toBe('textarea');

    // number: input[inputmode="decimal"]
    const numInput = screen.getByLabelText('num の値');
    expect(numInput.getAttribute('inputmode')).toBe('decimal');

    // boolean: input[type="checkbox"]
    const boolInput = screen.getByLabelText('flag の値');
    expect(boolInput.getAttribute('type')).toBe('checkbox');
    expect((boolInput as HTMLInputElement).checked).toBe(true);

    // date: input[type="date"]
    const dateInput = screen.getByLabelText('dateVal の値');
    expect(dateInput.getAttribute('type')).toBe('date');

    // datetime: input[type="datetime-local"]
    const dtInput = screen.getByLabelText('dtVal の値');
    expect(dtInput.getAttribute('type')).toBe('datetime-local');

    // list: チップと追加入力欄
    expect(screen.getByText('item1')).toBeTruthy();
    expect(screen.getByText('item2')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'listVal に項目を追加' })).toBeTruthy();

    // object: code と disabled select
    expect(screen.getByText('{"foo":"bar"}')).toBeTruthy();
    const objSelect = screen.getByRole('combobox', { name: 'objVal の型' });
    expect((objSelect as HTMLSelectElement).disabled).toBe(true);
  });

  it('CE4: テキストの change → 1 回の onChange で値が反映（blur を待たない）', () => {
    const onRowsChange = vi.fn();
    render(
      <TestPanelWrapper
        frontmatter={{ title: '旧タイトル' }}
        editable={true}
        onRowsChange={onRowsChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /プロパティ/ }));
    fireEvent.click(screen.getByTestId('properties-edit'));

    const input = screen.getByLabelText('title の値');
    fireEvent.change(input, { target: { value: '新タイトル' } });

    expect(onRowsChange).toHaveBeenCalledTimes(1);
    const lastState: PropertyRowsState = onRowsChange.mock.calls[0][0];
    expect(lastState.rows[0].key).toBe('title');
    expect(lastState.rows[0].text).toBe('新タイトル');

    const ops = buildFrontmatterOps(lastState);
    expect(ops).toEqual([{ op: 'set', key: 'title', value: '新タイトル' }]);
  });

  it('CE5: キー名の change で重複 → role="alert" に 「…」は既にあります、aria-invalid="true"', () => {
    render(
      <TestPanelWrapper
        frontmatter={{ first: 1, second: 2 }}
        editable={true}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /プロパティ/ }));
    fireEvent.click(screen.getByTestId('properties-edit'));

    const keyInputs = screen.getAllByRole('textbox', { name: 'プロパティ名' });
    // 2行目のキー名を 'first' に変更して重複させる
    fireEvent.change(keyInputs[1], { target: { value: 'first' } });

    const alerts = screen.getAllByRole('alert');
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0].textContent).toContain('「first」は既にあります');
    expect(keyInputs[1].getAttribute('aria-invalid')).toBe('true');
  });

  it('CE6: 削除ボタン → 行が消え、removedKeys に元のキーが追加される', () => {
    const onRowsChange = vi.fn();
    render(
      <TestPanelWrapper
        frontmatter={{ a: 1, b: 2 }}
        editable={true}
        onRowsChange={onRowsChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /プロパティ/ }));
    fireEvent.click(screen.getByTestId('properties-edit'));

    const deleteBtn = screen.getByRole('button', { name: 'a を削除' });
    fireEvent.click(deleteBtn);

    expect(onRowsChange).toHaveBeenCalledTimes(1);
    const lastState: PropertyRowsState = onRowsChange.mock.calls[0][0];
    expect(lastState.rows).toHaveLength(1);
    expect(lastState.rows[0].key).toBe('b');
    expect(lastState.removedKeys).toEqual(['a']);

    const ops = buildFrontmatterOps(lastState);
    expect(ops).toEqual([{ op: 'delete', key: 'a' }]);
  });

  it('CE7: 追加ボタン → 新規行が末尾に出て、キー欄にフォーカスが当たる', () => {
    render(
      <TestPanelWrapper
        frontmatter={{ title: 'テスト' }}
        editable={true}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /プロパティ/ }));
    fireEvent.click(screen.getByTestId('properties-edit'));

    const addBtn = screen.getByTestId('properties-add');
    fireEvent.click(addBtn);

    const keyInputs = screen.getAllByRole('textbox', { name: 'プロパティ名' });
    expect(keyInputs).toHaveLength(2);
    expect(document.activeElement).toBe(keyInputs[1]);
  });

  it('CE8: 0 件 + editable → properties-panel は無く properties-add-first が出る。押すと properties-panel が出て展開・フォーム表示になり、新規行キー欄にフォーカス', () => {
    render(<TestPanelWrapper frontmatter={{}} editable={true} />);

    expect(screen.queryByTestId('properties-panel')).toBeNull();
    const addFirstBtn = screen.getByTestId('properties-add-first');
    expect(addFirstBtn).toBeTruthy();
    expect(addFirstBtn.textContent).toContain('＋ プロパティを追加');

    fireEvent.click(addFirstBtn);

    expect(screen.getByTestId('properties-panel')).toBeTruthy();
    expect(screen.getByTestId('properties-editor')).toBeTruthy();

    const keyInputs = screen.getAllByRole('textbox', { name: 'プロパティ名' });
    expect(keyInputs).toHaveLength(1);
    expect(document.activeElement).toBe(keyInputs[0]);
  });

  it('CE9: 0 件 + 非 editable → 何も描画しない', () => {
    const { container } = render(<TestPanelWrapper frontmatter={{}} editable={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('CE10: list の追加欄で Enter → 項目追加。isComposing: true の Enter → 追加されない。空文字の Enter → 追加されない', () => {
    const onRowsChange = vi.fn();
    render(
      <TestPanelWrapper
        frontmatter={{ items: ['初期1'] }}
        editable={true}
        onRowsChange={onRowsChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /プロパティ/ }));
    fireEvent.click(screen.getByTestId('properties-edit'));

    const addInput = screen.getByRole('textbox', { name: 'items に項目を追加' });

    // 1. 空文字で Enter → 追加されない
    fireEvent.change(addInput, { target: { value: '   ' } });
    fireEvent.keyDown(addInput, { key: 'Enter' });
    expect(onRowsChange).not.toHaveBeenCalled();

    // 2. isComposing: true で Enter → 追加されない
    fireEvent.change(addInput, { target: { value: '変換中' } });
    fireEvent.keyDown(addInput, { key: 'Enter', isComposing: true });
    expect(onRowsChange).not.toHaveBeenCalled();

    // 3. 通常の Enter → 追加される
    fireEvent.change(addInput, { target: { value: '新規項目' } });
    fireEvent.keyDown(addInput, { key: 'Enter' });

    expect(onRowsChange).toHaveBeenCalledTimes(1);
    const lastState: PropertyRowsState = onRowsChange.mock.calls[0][0];
    const row = lastState.rows[0];
    expect(row.type).toBe('list');
    if (row.type === 'list') {
      expect(row.items).toEqual(['初期1', '新規項目']);
    }
  });

  it('CE11: list のチップ × → その項目だけ消える（同名が複数あるときはクリックしたほうだけ）', () => {
    const onRowsChange = vi.fn();
    render(
      <TestPanelWrapper
        frontmatter={{ items: ['foo', 'bar', 'foo'] }}
        editable={true}
        onRowsChange={onRowsChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /プロパティ/ }));
    fireEvent.click(screen.getByTestId('properties-edit'));

    const removeBtns = screen.getAllByRole('button', { name: 'foo を削除' });
    expect(removeBtns).toHaveLength(2);

    // 最初の 'foo' を削除
    fireEvent.click(removeBtns[0]);

    expect(onRowsChange).toHaveBeenCalledTimes(1);
    const lastState: PropertyRowsState = onRowsChange.mock.calls[0][0];
    const row = lastState.rows[0];
    if (row.type === 'list') {
      expect(row.items).toEqual(['bar', 'foo']);
    }
  });

  it('CE12: 型 select を text→number に変えると値欄が inputmode=decimal になり、1.5 が引き継がれる', () => {
    render(
      <TestPanelWrapper
        frontmatter={{ price: '1.5' }}
        editable={true}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /プロパティ/ }));
    fireEvent.click(screen.getByTestId('properties-edit'));

    const typeSelect = screen.getByRole('combobox', { name: 'price の型' });
    fireEvent.change(typeSelect, { target: { value: 'number' } });

    const input = screen.getByLabelText('price の値');
    expect(input.getAttribute('inputmode')).toBe('decimal');
    expect((input as HTMLInputElement).value).toBe('1.5');
  });

  it('CE13: frontmatterStatus="invalid" + editable → 変更ボタンが無く「編集不可」の注記がある。展開しても入力欄なし', () => {
    render(
      <TestPanelWrapper
        frontmatter={{ title: 'テスト' }}
        editable={true}
        frontmatterStatus="invalid"
      />,
    );
    expect(screen.queryByTestId('properties-edit')).toBeNull();
    const notice = screen.getByTitle('フロントマターを解釈できないため、ここでは編集できません');
    expect(notice).toBeTruthy();
    expect(notice.textContent).toBe('編集不可');

    const toggle = screen.getByRole('button', { name: /プロパティ/ });
    fireEvent.click(toggle);

    expect(screen.getByTestId('properties-list')).toBeTruthy();
    expect(screen.queryByTestId('properties-editor')).toBeNull();
  });

  it('CE14: フォーム表示で updated は読み取り専用行として出る。件数は updated を含む', () => {
    render(
      <TestPanelWrapper
        frontmatter={{
          title: 'テスト',
          updated: '2026-10-01T10:00:00+09:00',
        }}
        editable={true}
      />,
    );
    const toggle = screen.getByRole('button', { name: /プロパティ/ });
    expect(toggle.textContent).toContain('プロパティ (2件)');

    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId('properties-edit'));

    // フォーム表示中も件数は 2件
    expect(toggle.textContent).toContain('プロパティ (2件)');

    // updated 読み取り専用行
    const updatedRow = screen.getByTestId('property-row-updated');
    expect(updatedRow).toBeTruthy();
    expect(updatedRow.textContent).toContain('updated');
    expect(updatedRow.textContent).toContain('保存時に自動更新');
  });

  it('CE15: 件数ラベルは削除・追加で増減する（未入力の新規行も1件として数える）', () => {
    render(
      <TestPanelWrapper
        frontmatter={{ a: 1, b: 2 }}
        editable={true}
      />,
    );
    const toggle = screen.getByRole('button', { name: /プロパティ/ });
    expect(toggle.textContent).toContain('プロパティ (2件)');

    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId('properties-edit'));

    // 追加ボタンを押すと 3 件になる
    fireEvent.click(screen.getByTestId('properties-add'));
    expect(toggle.textContent).toContain('プロパティ (3件)');

    // 1行削除すると 2 件に戻る
    fireEvent.click(screen.getByRole('button', { name: 'a を削除' }));
    expect(toggle.textContent).toContain('プロパティ (2件)');
  });

  it('CE16: XSS: キー・値に <img src=x onerror=alert(1)> を入れても img 要素ができない', () => {
    const malicious = '<img src=x onerror=alert(1)>';
    const { container } = render(
      <TestPanelWrapper
        frontmatter={{ title: 'テスト' }}
        editable={true}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /プロパティ/ }));
    fireEvent.click(screen.getByTestId('properties-edit'));

    const keyInput = screen.getByRole('textbox', { name: 'プロパティ名' });
    const valInput = screen.getByLabelText('title の値');

    fireEvent.change(keyInput, { target: { value: malicious } });
    fireEvent.change(valInput, { target: { value: malicious } });

    expect(container.querySelector('img')).toBeNull();
  });

  it('CE17: 完了ボタン: 未変更なら「入力を終える」で表示に戻る。値を変えると disabled。未変更状態に戻ると再び押せる', () => {
    render(
      <TestPanelWrapper
        frontmatter={{ title: '初期値' }}
        editable={true}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /プロパティ/ }));
    fireEvent.click(screen.getByTestId('properties-edit'));

    // 未変更なので完了ボタン（入力を終える）は押せる
    const doneBtn = screen.getByRole('button', { name: '入力を終える' });
    expect((doneBtn as HTMLButtonElement).disabled).toBe(false);

    // 値を変更すると disabled になる
    const input = screen.getByLabelText('title の値');
    fireEvent.change(input, { target: { value: '変更値' } });
    expect((doneBtn as HTMLButtonElement).disabled).toBe(true);

    // 値を元に戻すと（opsが空になり）再び押せる
    fireEvent.change(input, { target: { value: '初期値' } });
    expect((doneBtn as HTMLButtonElement).disabled).toBe(false);

    // 完了ボタンを押すとフォームが閉じ、表示モードに戻る
    fireEvent.click(doneBtn);
    expect(screen.queryByTestId('properties-editor')).toBeNull();
    expect(screen.getByTestId('properties-list')).toBeTruthy();
  });

  it('CE18: editable が偽になるとフォームが閉じる', () => {
    const { rerender } = render(
      <TestPanelWrapper
        frontmatter={{ title: '初期値' }}
        editable={true}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /プロパティ/ }));
    fireEvent.click(screen.getByTestId('properties-edit'));
    expect(screen.getByTestId('properties-editor')).toBeTruthy();

    // editable=false で rerender
    rerender(
      <TestPanelWrapper
        frontmatter={{ title: '初期値' }}
        editable={false}
      />,
    );
    expect(screen.queryByTestId('properties-editor')).toBeNull();
    expect(screen.getByTestId('properties-list')).toBeTruthy();
  });

  it('新規行が1件の状態で値を変更してもフォーカスがキー欄に奪われない', () => {
    render(
      <TestPanelWrapper
        frontmatter={{}}
        editable={true}
      />,
    );
    // 0件から新規追加
    fireEvent.click(screen.getByTestId('properties-add-first'));
    const keyInput = screen.getByRole('textbox', { name: 'プロパティ名' });
    expect(document.activeElement).toBe(keyInput);

    // キー名を入力
    fireEvent.change(keyInput, { target: { value: 'tagline' } });

    // 値欄にフォーカスを当てて入力
    const valInput = screen.getByLabelText('tagline の値');
    valInput.focus();
    expect(document.activeElement).toBe(valInput);

    fireEvent.change(valInput, { target: { value: 'Hello World' } });

    // 入力後もフォーカスが値欄にとどまり、キー欄に戻らないこと
    expect(document.activeElement).toBe(valInput);
  });
});

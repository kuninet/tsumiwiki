import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EditorDemo } from './EditorDemo';

describe('EditorDemo', () => {
  it('エディタが起動し、サンプルのwikilinkがMarkdown出力に保全される', async () => {
    render(<EditorDemo />);
    // useEditorのエディタ生成は非同期のため、出力が反映されるまで待つ
    await waitFor(() => {
      const output = screen.getByTestId('markdown-output');
      expect(output.textContent).toContain('[[リンク先ページ]]');
      expect(output.textContent).toContain('[[フォルダ/ページ|別名表示]]');
      expect(output.textContent).toContain('![[screenshot.png]]');
      expect(output.textContent).toContain('```mermaid');
    });
  });
});

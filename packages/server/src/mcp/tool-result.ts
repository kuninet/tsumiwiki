// MCPツールの戻り値組み立て共通処理。
// SDKのCallToolResult.structuredContentはオブジェクト(record)必須で配列を直接渡すと
// バリデーションエラーになるため、配列は{ items: [...] }でラップする。
// content[0].textも同じ形に揃える(受け手によってcontentとstructuredContentの
// 形が食い違わないように)
export function toolResult(result: unknown) {
  const shaped = Array.isArray(result) ? { items: result } : (result as Record<string, unknown>);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(shaped, null, 2) }],
    structuredContent: shaped,
  };
}

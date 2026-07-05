// テンプレート変数の展開ユーティリティ(#84 Phase 2)。
// {{date:YYYY-MM-DD}} や {{title}} 等の変数を実際の値に置き換える。
// サーバー(デイリーノートAPI)とクライアント(既存文書へのテンプレ適用UI等)で共有する。
//
// サポート:
//   {{date}}         現在日付(既定 YYYY-MM-DD)
//   {{date:FMT}}     指定フォーマットで日付(例 {{date:YYYY年MM月DD日}})
//   {{time}}         現在時刻(既定 HH:mm)
//   {{time:FMT}}     指定フォーマットで時刻
//   {{year}} {{month}} {{day}}  {{hour}} {{minute}}
//   {{title}}        文書のタイトル(ファイル名から拡張子を除いたもの)
//   {{user}}         現在のユーザー表示名
//   {{cursor}}       クライアント側でカーソル位置マーカーとして扱う(サーバーでは空文字に展開しない=そのまま残す)
//
// フォーマット:
//   YYYY 西暦4桁 / YY 西暦2桁 / MM 月2桁 / DD 日2桁 / HH 時24時間2桁 / mm 分2桁 / ss 秒2桁

export interface TemplateContext {
  date: Date;
  title: string;
  user: string;
}

function pad(n: number, len = 2): string {
  return String(n).padStart(len, '0');
}

export function formatDate(d: Date, fmt: string): string {
  return fmt
    .replace(/YYYY/g, String(d.getFullYear()))
    .replace(/YY/g, pad(d.getFullYear() % 100))
    .replace(/MM/g, pad(d.getMonth() + 1))
    .replace(/DD/g, pad(d.getDate()))
    .replace(/HH/g, pad(d.getHours()))
    .replace(/mm/g, pad(d.getMinutes()))
    .replace(/ss/g, pad(d.getSeconds()));
}

// {{cursor}} は特別なマーカーとして本文中に残す(クライアント側で位置決めに使う)。
// サーバー側でファイル名パターンを展開する時は cursor を空文字に(ファイル名にマーカー不要)。
const CURSOR_MARKER = '{{cursor}}';

export interface ExpandOptions {
  // trueにするとcursorも空文字へ展開する(ファイル名など、cursor が意味を持たない箇所用)
  stripCursor?: boolean;
}

export function expandTemplateVariables(
  input: string,
  ctx: TemplateContext,
  opts: ExpandOptions = {},
): string {
  return input.replace(/\{\{(\w+)(?::([^}]+))?\}\}/g, (match, name: string, fmt?: string) => {
    switch (name) {
      case 'date':
        return formatDate(ctx.date, fmt ?? 'YYYY-MM-DD');
      case 'time':
        return formatDate(ctx.date, fmt ?? 'HH:mm');
      case 'year':
        return String(ctx.date.getFullYear());
      case 'month':
        return pad(ctx.date.getMonth() + 1);
      case 'day':
        return pad(ctx.date.getDate());
      case 'hour':
        return pad(ctx.date.getHours());
      case 'minute':
        return pad(ctx.date.getMinutes());
      case 'title':
        return ctx.title;
      case 'user':
        return ctx.user;
      case 'cursor':
        return opts.stripCursor ? '' : CURSOR_MARKER;
      default:
        // 未知の変数はそのまま残す(タイポでも情報が消えないように)
        return match;
    }
  });
}

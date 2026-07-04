# TsumiWiki UI ハンドオフパッケージ

TsumiWiki の UI リニューアル案一式です。既存の要件定義・設計ドキュメントに準拠しながら、Notion 風にすっきり明るく、Obsidian 相当の実務ツールとして使いやすい方向で作っています。

## 方針

- **テーマ**: ライト + ダーク両対応。ユーザー切替可（既定=ライト）。
- **アクセントカラー**: `#7c6cf0`（紫）
- **タイポ**: Noto Sans JP（本文）/ JetBrains Mono（コード・キーバインド表示）
- **雰囲気**: Notion 風にすっきり、密度は中程度、罫線は薄めに
- **最小幅**: 1280px（要件通り PC 向け）

## 収録物

| ファイル | 用途 |
|---|---|
| `TsumiWiki-preview.html` | 完成イメージ（自己完結の単一 HTML。ブラウザで開くだけで動作。ライト/ダーク切替・タブ切替・閲覧/編集モード切替が動きます） |
| `design-tokens.css` | CSS 変数として定義された全トークン（ライト・ダーク両対応） |
| `design-tokens.json` | 機械可読なトークン（Style Dictionary 等で使えます） |
| `tailwind.config.js` | Tailwind CSS 用プリセット |
| `components.md` | 主要コンポーネントの仕様（レイアウト・状態・実装ヒント） |

## Claude Code への指示例

> `handoff/` にある TsumiWiki UI リニューアル案を実装してください。以下の順で進めてください:
> 1. `design-tokens.css` を `src/styles/tokens.css` に配置し、`index.html` から読み込む
> 2. `tailwind.config.js` の内容を現行 Tailwind 設定にマージ
> 3. `components.md` に沿って `<AppShell>` → `<Header>` → `<Sidebar>` → `<MainPane>` の順にコンポーネントを差し替える
> 4. ダークモードは `data-theme="dark"` を `<html>` に付与する方式で、`ThemeToggle` から切替
> 5. `TsumiWiki-preview.html` を最終ゴールとして参照し、視覚的に一致させる

## 実装済みの部分

- [x] メイン画面（ヘッダー + サイドバー + 本文ペイン）
- [x] ライト/ダーク切替
- [x] フォルダ/タグタブ切替
- [x] 閲覧/編集モード切替（編集時にツールバー表示）
- [x] wikilink・コード・callout・Mermaid風図・表 の閲覧レンダリング

## 未実装（次段階）

- [ ] 履歴・差分パネル（サイドオーバーレイ）
- [ ] `[[` サジェストポップアップ
- [ ] ロック取得中の他者編集表示（トースト）
- [ ] ごみ箱・ユーザー管理・設定画面

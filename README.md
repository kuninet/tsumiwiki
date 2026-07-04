# TsumiWiki

**知識を積む、チームのためのMarkdown Wiki。**

TsumiWikiは、ObsidianライクなWYSIWYG Markdownエディタを備えた、小規模チーム向けのWebベースWikiシステムです。文書はサーバー上のフォルダに素のMarkdownファイル(UTF-8)として保存され、既存のObsidianヴォルトをコピーするだけでそのまま利用できることを目指しています。

> 名前の由来: 「知識を積む」+ Wiki。発音は「積み木」に掛けています。

## 特徴(計画中)

- 🖊️ **WYSIWYG Markdownエディタ** — Markdown記法もツールバーも使える、Obsidianライクなライブプレビュー編集
- 👥 **複数人での利用** — ログイン・編集者の記録・編集ロックによる排他制御
- 📁 **素のMarkdownで保存** — データはフォルダ上の `.md` ファイル。ツールロックインなし
- 🔮 **Obsidian互換** — 既存ヴォルトをコピーするだけで動作。`[[wikilink]]`・`![[埋め込み]]`・タグ互換
- 🕘 **Git履歴** — 保存のたびにコミット。差分表示・過去版への復元
- 🏷️ **フォルダ&タグ** — フォルダツリーとタグの両方で文書を整理
- 🔍 **日本語全文検索** / 🖼️ **画像ドラッグ&ドロップ** / 📊 **Mermaid図レンダリング**

## ステータス

現在は**プロトタイプ検証フェーズ**です。

- [要件定義ドキュメント](docs/要件定義/README.md)
- [基本設計ドキュメント](docs/設計/README.md)

## 開発

必要環境: Node.js 20.19以上、pnpm 10(corepackで自動選択されます)

```bash
corepack enable          # 初回のみ。package.json記載のpnpmが使われる
pnpm install
pnpm dev                 # client(5173) + server(3000) を同時起動
```

| コマンド | 内容 |
|---|---|
| `pnpm dev` | 開発サーバー起動(Vite HMR + APIプロキシ) |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | 静的検査・テスト(CIと同じ) |
| `pnpm build` | 本番ビルド |

構成: pnpmモノレポ(`packages/client` = React SPA / `packages/server` = Fastify API / `packages/shared` = 共有zodスキーマ)。詳細は[基本設計](docs/設計/01_アーキテクチャ設計.md)参照。

## ライセンス

[MIT License](LICENSE)

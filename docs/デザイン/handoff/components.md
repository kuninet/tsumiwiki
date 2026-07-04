# TsumiWiki コンポーネント仕様

`TsumiWiki.dc.html` を最終形として、React (Vite + TypeScript + Tailwind) 実装のためのコンポーネント仕様です。設計ドキュメント 04章 (画面設計)・05章 (エディタ設計) と対応します。

Tailwind クラスは `handoff/tailwind.config.js` のトークンを前提としています。素の CSS 変数は `handoff/design-tokens.css` を参照してください。

---

## AppShell

認証済みレイアウト全体のシェル。

```
<div class="flex flex-col h-screen min-w-app bg-canvas text-ink font-sans">
  <Header />
  <div class="flex flex-1 min-h-0">
    <Sidebar />
    <MainPane />
  </div>
</div>
```

- `min-h-0` は Flex 内スクロールに必須。
- モバイル対応はスコープ外（`min-w-app` = 1280px）。

---

## Header

高さ `52px`、下辺 `border-line`、背景 `panel`。

```
[Logo | TsumiWiki]  [🔍 検索 ......   Ctrl K]   [↻ 更新確認] [☾/☀] [Avatar]
```

- **ロゴマーク**: 26×26、`bg: accent-gradient`、丸 7px、白文字「積」
- **検索ボックス**: max-width 420px、`bg: panel-2`、押下で `<SearchDropdown>` を開く。右端に `Ctrl K` バッジ（`font-mono text-xs`、`border-line`）
- **テーマ切替**: 32×32 アイコンボタン。ライト時 ☾ / ダーク時 ☀ を表示。`data-theme` を `<html>` にトグル。
- **アバター**: 30×30 円、`bg: accent`、白イニシャル。クリックで `<UserMenu>`（設定・ログアウト）
- **更新確認ボタン**: FR-DOC-08 相当。ライブラリ再スキャンをキック。

---

## Sidebar

幅 `250px`（ドラッグ可）、`bg: panel`、右辺 `border-line`。

### 上部タブ

```
[フォルダ] [タグ]
```

- 2 タブ、非アクティブは `text-ink-faint`、アクティブは `bg-active text-accent font-semibold`。
- タブ切替は Zustand の UI ストアで保持（サイドバー幅・折りたたみと同じ場所）。

### FolderTree (フォルダタブ)

- ツリー行の高さ `30px`、`px-2`、深さ 1 段 = `pl-4` 追加。
- 行構造: `[twisty ▾/▸] [icon 📂/📄] [label] [count?]`
- 現在文書の行: `bg-active`、`text-accent font-semibold`
- 右クリック: `<TreeContextMenu>` — 新規文書 / 新規フォルダ / リネーム / 移動 / 削除
- キーボード: `↑/↓` 移動、`→` 展開、`←` 折りたたみ、`Enter` 開く、`F2` リネーム、`Delete` ごみ箱へ

### TagPane (タグタブ)

- タグをチップ表示: `bg: panel-2`, `border-line`, `radius-full`, `text-sm`, ` #タグ名 <count>`
- クリックでタグ絞込み。複数選択で AND (SHOULD)。選択中は `bg: accent-soft`, `text-accent`, `border-accent-border`
- 全解除ボタンを上部に。

### フッター

- 高さ `38px`、`border-t border-line`、`+ 新規文書` と `🗑 ごみ箱` へのショートカット。

---

## MainPane

`flex-1 min-w-0 flex flex-col bg-canvas` — 縦構造:

1. `<DocHeader>` — パンくず + タイトル + 履歴/編集ボタン
2. `<EditorToolbar>` — 編集モードのみ
3. `<DocViewer>` / `<DocEditor>` — スクロール領域
4. `<StatusBar>` — 最下部

### DocHeader

- パディング `20px 32px 16px`
- 左側: パンくず（`text-xs text-ink-faint`、`›` 区切り）→ タイトル（`h1 22px bold`）→ 更新情報＋保存バッジ
- 右側: `[⟲ 履歴]` (ghost) → `[✎ 編集]` (primary) / 編集中は `[✓ 保存]` (`bg-success`)
- **保存バッジ**: 状態 = `保存済み` (success) / `未保存の変更` (warning) / `自動保存済み` (ink-faint)
- **他ユーザーが編集中**: 編集ボタンを disabled、ツールチップに「○○さんが編集中」

### EditorToolbar

- 高さ 40px、`border-y border-line`、`bg: panel`、`px-8`、`gap-1`、グループ間 divider (`w-px h-4 bg-line`)
- グループ:
  1. `H1 H2 H3`
  2. `B I S` (太字・斜体・打消)
  3. `• リスト` `1.` `☑` (箇条書き・番号・チェック)
  4. `⊞ 表` `<> コード` `❝` (引用)
  5. `🔗 リンク` `🖼 画像` `◈ Mermaid`
- ボタンは `min-w-7 h-7 px-1.5 text-base rounded whitespace-nowrap`、現在カーソル位置で active（`bg: active text-accent`）
- Tiptap の `editor.chain().focus().toggleBold()...` を呼ぶ。

### DocViewer / DocEditor

- 両者とも Tiptap を使う。Viewer は `editable: false`。
- 記事幅は `max-w-content mx-auto px-8`（760px）
- 見出し・段落・リスト・callout・コードブロック・表・Mermaid・wikilink のスタイルは下記「コンテンツスタイル」参照。

### StatusBar

- 高さ `28px`、`bg: panel`、`border-t border-line`、`text-xs text-ink-faint`
- 左: 状態 (`閲覧モード` / `編集中 · ロック取得済み（あなた）` / `他者編集中` / `保存エラー`)
- 右: `font-mono` で文書パス

---

## コンテンツスタイル

エディタ・閲覧で共通の Markdown 描画スタイル。

| 要素 | クラス例 |
|---|---|
| `p` | `text-body text-ink-soft mb-3.5` |
| `h2` | `mt-8 mb-3 text-h2 text-ink` |
| `h3` | `mt-6 mb-2 text-h3 text-ink` |
| `ul/ol` | `pl-6 mb-3.5`、`li` は `text-body text-ink-soft leading-relaxed` |
| `code`（inline） | `font-mono text-[13px] bg-panel-2 text-code-text px-1.5 py-px rounded-sm` |
| `pre code`（block） | `font-mono text-[13px] bg-panel-2 border border-line rounded-lg p-3.5` |
| `blockquote` | `border-l-2 border-line pl-3 text-ink-faint` |
| `table` | `w-full text-sm border-collapse`; `th` = `bg-panel-2 border border-line px-3 py-2 text-left`; `td` = `border border-line px-3 py-2 text-ink-soft` |
| `hr` | `border-t border-line my-6` |
| wikilink | `text-accent font-medium border-b border-accent-border cursor-pointer` — 未解決は `text-ink-faint border-b-ink-faint` |
| callout (`> [!note]` 等) | `flex gap-2.5 p-3.5 my-4 bg-accent-soft border border-accent-border border-l-[3px] rounded-lg` |
| Mermaid ブロック | `p-4 my-3.5 bg-panel border border-line rounded-xl`; ヘッダに `font-mono text-xs text-ink-faint` で "mermaid" 表示 |

---

## SearchDropdown (Ctrl+K)

- ヘッダー検索クリック or `Ctrl/⌘+K` で開く。
- 位置: 検索ボックス直下、`w-[520px]`、`shadow-lg`、`rounded-lg`、`bg: panel`、`border-line`
- 中身: 最近開いた文書 → 検索結果（文書名・本文スニペット）→ タグ候補
- キー: `↑/↓` 選択、`Enter` 遷移、`Esc` 閉じる

---

## HistoryPanel

- サイドオーバーレイ（画面右、幅 `400px`、`shadow-lg`）で表示。
- 上部: 「履歴 · アーキテクチャ設計 [×]」
- 一覧: 日時（`2時間前` の相対 + tooltip で絶対時刻）・編集者アバター・コメント
- 選択で下部に `<DiffView>` 展開: 追加行 = `bg: rgba(34,160,107,0.10) text-success`、削除行 = `bg: rgba(220,38,38,0.08) text-danger`、行番号は `font-mono text-ink-faint`
- 下部: `[この版に戻す]` (primary、確認ダイアログあり)

---

## トースト / 確認ダイアログ

- **Toast**: 右下、`bg: panel border border-line rounded-lg shadow-lg`、`p-3.5`、アイコン + 本文。種別: success/info/warning/danger。自動消滅 3s（error は手動）。
- **ConfirmDialog**: 中央モーダル。バックドロップ `bg-black/40 backdrop-blur-sm`。ボタン右揃え、破壊的操作は `bg-danger`。

---

## ボタン仕様

| 種別 | 高さ | 背景 | 文字色 | 境界 |
|---|---|---|---|---|
| primary | 32 | `bg-accent hover:bg-accent-hover` | `text-white` | none |
| success (保存中) | 32 | `#22a06b` | `text-white` | none |
| danger | 32 | `#dc2626` | `text-white` | none |
| ghost | 30 | transparent | `text-ink-soft` | `border-line` |
| icon | 32×32 | transparent | `text-ink-soft` | `border-line` |
| toolbar | 28×28 | transparent | `text-ink-soft` | none, `hover:bg-hover` |
| tab | 30 | `bg-active` (active) | `text-accent` (active) | none |

すべて `rounded` (7px), `text-sm`, `transition-colors duration-fast ease-smooth`。

---

## 状態管理 (設計 4.3 準拠)

- **サーバー状態**: TanStack Query — `tree`, `doc`, `tags`, `search`, `history`, `trash`, `users`
- **UI 状態**: Zustand — サイドバー幅・折りたたみ・現在タブ (`folder|tag`)・編集モード・dirty フラグ・選択中タグ・テーマ (`light|dark`)
- **エディタ状態**: Tiptap 内部。dirty は `onUpdate` で立てる。

## テーマ切替の実装

```ts
// theme-store.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const useTheme = create<{theme:'light'|'dark'; toggle:()=>void}>()(
  persist(
    (set) => ({
      theme: 'light',
      toggle: () => set((s) => {
        const next = s.theme === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', next);
        return { theme: next };
      }),
    }),
    { name: 'tsumiwiki-theme' }
  )
);
```

初回マウント時に `useEffect` で `document.documentElement.setAttribute('data-theme', theme)` を実行しておくこと。

# 06. Git連携設計

要件: FR-HIST一式、FR-DOC-06(編集者記録)、FR-DOC-08(外部変更の取り込み)、NFR-AVL-02(バックアップ)。

## 6.1 方式

- ライブラリルートをGit作業リポジトリとする。サーバー初回起動時に `.git` がなければ `git init` + 初回コミットを自動実行。
- Git操作は `simple-git`(Git CLIラッパー)で行う。**サーバーにGit for Windowsのインストールが前提**(導入手順書に記載)。
- リポジトリ設定(初期化時に自動設定):
  - `core.autocrlf=false`(LF固定)
  - `core.quotepath=false`(日本語ファイル名の可読性)
  - `core.precomposeUnicode=true`(NFC統一)
- Git操作はサーバー内で**単一の直列キュー**を通す(同時コミットによる index.lock 競合を排除)。1操作は通常数十ms〜数百msであり、小規模チームの同時保存でも実用上問題ない。

## 6.2 コミット規約

| 操作 | コミットメッセージ | author |
|---|---|---|
| 保存 | `edit: <path>` | 操作ユーザー |
| 新規作成 | `add: <path>` | 操作ユーザー |
| リネーム/移動 | `move: <旧path> -> <新path>` | 操作ユーザー |
| 削除(ごみ箱へ) | `trash: <path>` | 操作ユーザー |
| 復元(ごみ箱から) | `untrash: <path>` | 操作ユーザー |
| 完全削除 | `purge: <path>` | 操作ユーザー(admin) |
| 過去版復元 | `restore: <path> @<rev短縮>` | 操作ユーザー |
| 添付追加 | `attach: <path>` | 操作ユーザー |
| 外部変更取り込み | `sync: external changes` | システムユーザー |

- author表記: `表示名 <username@tsumiwiki.local>`。メールドメインはダミー(実メールは使わない)。
- committerは固定のシステム名義(`TsumiWiki <system@tsumiwiki.local>`)。

## 6.3 履歴・差分・復元(FR-HIST)

| 機能 | 実装 |
|---|---|
| 履歴一覧 | `git log --follow --format=... -- <path>`(リネーム追跡) |
| 過去版内容 | `git show <rev>:<path>` |
| 差分 | `git diff <rev> <against> -- <path>`(unified形式で返し、クライアントで追加/削除行をハイライト表示) |
| 復元 | 過去版の内容を取得→通常の保存フロー(上書き+ `restore:` コミット)。履歴は改変しない(FR-HIST-04) |

- 差分表示は行単位(unified)を基本とし、必要になれば語単位ハイライトを追加検討。

## 6.4 外部変更の取り込み(FR-DOC-08)

Obsidianや直接ファイル操作でライブラリが変更されるケースへの対応。

- **検出タイミング**: サーバー起動時+定期(5分間隔)+文書取得時にmtime不一致を検知した場合。
- **処理**: `git status --porcelain` で未コミット変更を検出 → `git add -A` + `sync: external changes` コミット(authorはシステムユーザー)→ 該当文書のインデックス再構築。
- **編集ロック中の文書に外部変更があった場合**: syncコミットは行うが、Wikiでの保存時に `baseUpdatedAt` 不一致で `CONFLICT` を返し、ユーザーに再読み込みを促す(03章)。

## 6.5 バックアップpush(NFR-AVL-02)

- リモート名 `backup` に bareリポジトリ(例: `\\fileserver\share\tsumiwiki.git`)を登録。
- push契機: 定期(既定10分。`BACKUP_PUSH_INTERVAL_MINUTES`)+サーバー正常終了時。
- 方式: `git push backup main --force-with-lease`。バックアップ専用リモート(他からpushしない)のためコンフリクトは原則発生しない。
- 失敗時: エラーログ記録+リトライ(次回定期)。**pushが失敗してもWiki本体の動作は継続する**。連続失敗はヘルスチェックAPI(`GET /api/health`)で警告表示。
- 初期セットアップ: 導入手順書に bareリポジトリ作成(`git init --bare`)とリモート登録手順を記載。

## 6.6 復旧手順(運用ドキュメントに記載する内容)

1. ライブラリ喪失時: `git clone \\fileserver\share\tsumiwiki.git <LIBRARY_PATH>` → サーバー起動(自動リインデックス)。
2. `app.db` 喪失時: サーバー起動(スキーマ自動作成)→ `tsumiwiki create-admin` → 各ユーザー再登録 → `tsumiwiki reindex`。

## 6.7 除外設定

ライブラリ内 `.gitignore`(初期化時に自動生成・既存があれば追記しない):

```
.obsidian/
.DS_Store
Thumbs.db
```

- `.trash/` は**コミット対象**(削除・復元の履歴を残す。要件05章5.1)。
- `.obsidian/` はObsidian個人設定のため履歴管理しない(FR-OBS-04)。

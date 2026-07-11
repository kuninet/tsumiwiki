# 03. API設計

## 3.1 共通仕様

- ベースパス: `/api`。リクエスト/レスポンスはJSON(添付アップロードのみ multipart/form-data)。
- 認証: セッションCookie。未認証は `401`。admin専用APIに一般ユーザーがアクセスすると `403`。
- 変更系(POST/PUT/PATCH/DELETE)はヘッダ `X-Requested-With: TsumiWiki` を必須とする(CSRF対策)。
- 文書パスはクエリ/ボディの `path` に相対パスで渡す。サーバーは正規化とルート配下検証を必ず行う。
- エラー形式:

```json
{ "error": { "code": "DOC_LOCKED", "message": "この文書は山田さんが編集中です" } }
```

主なエラーコード: `UNAUTHORIZED` `FORBIDDEN` `NOT_FOUND` `DOC_LOCKED` `LOCK_EXPIRED` `CONFLICT` `INVALID_PATH` `VALIDATION_ERROR` `INVALID_SETTINGS`

### ヘルスチェック(NFR-OPS-02)

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/health` | 稼働確認(認証不要)。バックアップpushの連続失敗などをここで警告表示する |

## 3.2 エンドポイント一覧

### 認証(FR-AUTH)

| メソッド | パス | 内容 |
|---|---|---|
| POST | `/api/auth/login` | `{username, password}` → セッション発行。`{user}` を返す |
| POST | `/api/auth/logout` | セッション破棄 |
| GET | `/api/auth/me` | ログイン中ユーザー情報 `{id, username, displayName, role}` |

### ツリー・文書(FR-DOC, FR-NAV-01)

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/tree` | フォルダ階層と文書一覧(ドットフォルダ除外)。`{folders:[...], docs:[{path,title,folder,updatedAt}]}` |
| GET | `/api/docs?path=` | 文書取得。`{path, frontmatter, body, updatedAt, lock: {userId, displayName} \| null}` |
| POST | `/api/docs` | 新規作成 `{folder, title}` → 空文書作成+コミット。作成後パスを返す |
| PUT | `/api/docs` | 保存 `{path, body, frontmatter, baseUpdatedAt}`。ロック保持者のみ。保存+コミット(06章)。`baseUpdatedAt` 不一致は `CONFLICT`(外部変更との衝突検知) |
| DELETE | `/api/docs?path=` | ごみ箱(`.trash/`)へ移動+コミット(FR-DOC-07) |
| POST | `/api/docs/move` | `{path, newFolder, newTitle}` リネーム/移動+コミット。ロック中は不可 |

### フォルダ(FR-DOC-04)

| メソッド | パス | 内容 |
|---|---|---|
| POST | `/api/folders` | `{path}` 作成 |
| POST | `/api/folders/move` | `{path, newPath}` リネーム/移動+コミット。配下にロック中文書があれば不可 |
| DELETE | `/api/folders?path=` | 配下ごと `.trash/` へ移動+コミット |

### タグ・検索(FR-NAV-02/03, FR-OBS-06)

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/tags` | 全タグと件数 `[{tag, count}]` |
| GET | `/api/tags/docs?tags=a,b` | 指定タグ(AND)の文書一覧 |
| GET | `/api/search?q=` | 全文検索。`[{path, title, snippet}]`(snippetはヒット箇所前後、FTS5 snippet関数) |
| GET | `/api/docs/recent?limit=` | 最近更新一覧(FR-NAV-04) |

### 履歴(FR-HIST)

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/history?path=` | 履歴一覧 `[{rev, authorName, date, message}]`(`git log --follow`) |
| GET | `/api/history/all?limit=` | ライブラリ全体の履歴一覧(issue #66)。`[{rev, authorName, date, message, paths}]`(パス絞りなしの`git log`。`paths`は当該コミットで変更されたファイルパス。リネームはnew側のみ)。`limit`省略時100、1〜1000の範囲で指定可 |
| GET | `/api/history/content?path=&rev=` | 指定版の内容 |
| GET | `/api/history/diff?path=&rev=&against=` | 差分(unified形式。`against` 省略時は現行版と比較) |
| GET | `/api/history/all/diff?path=&rev=` | 全体履歴用の差分(`rev^..rev` = そのコミット単体で加わった差分)。issue #66。非文書パス(`.gitignore`・`.trash` 配下・添付ファイル等)も扱える |
| POST | `/api/history/restore` | `{path, rev}` 指定版の内容で上書き保存+コミット(履歴は改変しない。FR-HIST-04)。ロック取得が前提 |

### 編集ロック(FR-LOCK)

| メソッド | パス | 内容 |
|---|---|---|
| POST | `/api/locks` | `{path}` ロック取得。取得済みなら `DOC_LOCKED` |
| PUT | `/api/locks/refresh` | `{path}` ハートビート(編集画面が60秒間隔で送信。`refreshed_at` 更新) |
| DELETE | `/api/locks?path=` | ロック解放(保存完了時・編集破棄時) |
| DELETE | `/api/locks/force?path=` | **admin** 強制解放(FR-LOCK-04) |

- 自動解放: サーバーが定期ジョブで `refreshed_at` が `LOCK_TIMEOUT_MINUTES` を超えた行を削除(FR-LOCK-03)。

### 下書き(FR-EDIT-08)

| メソッド | パス | 内容 |
|---|---|---|
| PUT | `/api/drafts` | `{path, content}` 自動保存(ロック保持者のみ。コミットしない) |
| GET | `/api/drafts?path=` | 下書き取得(編集再開時。クラッシュ復帰用) |
| DELETE | `/api/drafts?path=` | 破棄(保存完了時にも自動削除) |

### 添付・ファイル配信(FR-IMG)

| メソッド | パス | 内容 |
|---|---|---|
| POST | `/api/attachments?docPath=` | multipart `{file}`(docPathはクエリ。フィールド順非依存)→ 添付フォルダに保存+コミットし、参照名を返す |
| GET | `/api/files/*` | ライブラリ内ファイルのraw配信(画像表示用)。Markdownは対象外。`Content-Disposition` と MIME を適切に設定 |

### ごみ箱(FR-DOC-07)

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/trash` | `.trash/` 内の一覧(元パス・削除日時・削除者は直近コミットから取得) |
| POST | `/api/trash/restore` | `{trashPath}` 元の場所へ復元+コミット(元パスに同名があれば連番付与) |
| DELETE | `/api/trash?path=` | **admin** 完全削除(ファイル削除+コミット。Git履歴には残る) |

### ユーザー管理(FR-AUTH-02。admin専用)

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/users` | 一覧 |
| POST | `/api/users` | 追加 `{username, displayName, password, role}` |
| PATCH | `/api/users/:id` | 表示名・ロール・有効/無効・パスワードリセット |

### 個人設定

| メソッド | パス | 内容 |
|---|---|---|
| PUT | `/api/me/password` | `{currentPassword, newPassword}`。成功時は **現行以外の全セッションを失効させる**(端末を選ばずリセット可能) |

### テンプレート機能

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/templates` | ライブラリ設定 `templates.folder` 配下の `.md` を再帰列挙。`[{path, name, targetFolder?, description?}]`。frontmatter の `target_folder`/`description` を軽量パースして返す |
| POST | `/api/templates/apply` | `{templatePath, title, targetFolder?}` → 変数展開+テンプレ専用メタキー除去 → **新規文書を作成**しパスを返す(`add:` コミット) |
| POST | `/api/templates/expand` | `{templatePath}` → 変数展開後の Markdown 本文を返す(既存文書への挿入/追記用。frontmatter は落とし、`{{cursor}}` マーカーは残す) |

### デイリーノート機能

| メソッド | パス | 内容 |
|---|---|---|
| POST | `/api/daily-notes/today` | 「今日」のデイリーノートを取得または作成。`{path, created: boolean}` を返す。同時実行(二人同時押し)は `DocConflictError` を既存扱いに畳み込むため、二重作成しない |

- 「今日」の判定は **サーバーローカルTZ** を使用。
- ファイル名は `dailyNotes.filenamePattern`(素の日付書式。`{{...}}` 構文は禁止)を今日の日付で `formatDate` した文字列。
- 作成時は `dailyNotes.template`(空欄で既定本文)の内容を変数展開して書き込む(`stripCursor:true`)。

### ライブラリ設定

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/library/settings` | 現在のライブラリ設定(認証必須)。`{ settings, corrupted }` を返す |
| PUT | `/api/library/settings` | **admin** 更新。`.tsumiwiki/settings.yaml` を書き `config: update library settings` でコミット |

- `corrupted`: `settings.yaml` の**パース失敗・バリデーション失敗**時に `true`(サーバーログに warn を出力しつつデフォルト値へフォールバック)。ファイル不在(初期セットアップ)は `false`。
  `true` のまま PUT すると git 上の正しい過去版を上書きしてしまうため、クライアントは警告バナーを表示する(#99)。

### ライブラリ運用

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/library/status` | バックアップの状態(直近push日時・連続失敗数など) |
| POST | `/api/library/rescan` | 外部変更の手動取り込み(06章4)。ツリー/タグの再取得を促す |

## 3.3 CLI(FR-AUTH-06)

```
tsumiwiki create-admin --username <id> --display-name <名前>   # パスワードは対話入力
tsumiwiki reindex                                              # フルリインデックス
```

## 3.4 保存フローのシーケンス(代表)

```
クライアント                サーバー
  │ POST /api/locks {path}     │ ロック取得(locks INSERT)
  │ ──────────────────────────▶│
  │ (編集中… 60秒ごと)          │
  │ PUT /api/locks/refresh     │ refreshed_at更新
  │ (30秒ごと)                 │
  │ PUT /api/drafts            │ 下書きUPSERT
  │ (Ctrl+S / 保存ボタン)       │
  │ PUT /api/docs              │ 1. ロック・baseUpdatedAt検証
  │ ──────────────────────────▶│ 2. フロントマター再結合→一時ファイル→rename
  │                            │ 3. git add + commit(author=ユーザー)
  │                            │ 4. インデックス更新・下書き削除
  │ ◀──────────────────────────│ 5. {updatedAt} 返却
  │ DELETE /api/locks(編集終了時)│ ロック解放
```

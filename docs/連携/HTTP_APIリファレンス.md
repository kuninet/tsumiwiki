# TsumiWiki HTTP API リファレンス

生成AI・スクリプト等の外部システムから TsumiWiki を操作するためのAPI仕様。ブラウザUIも同じAPIを叩いている(設計01章1.3)。

**対象読者**: 生成AIエージェント(このドキュメントをそのまま読ませる想定)、および連携システムを実装する開発者。

**ベースURL**: `http://<サーバホスト>:<PORT>` (既定 `http://localhost:3080`)

---

## 1. 認証と CSRF

### セッション Cookie

`POST /api/auth/login` に成功するとブラウザ / HTTPクライアントに **セッションCookie**(HttpOnly, SameSite=Lax)が設定される。以後のAPI呼び出しはこのCookieで認証される。

### CSRF ヘッダ(必須)

**すべての書込系リクエスト**(POST / PUT / DELETE / PATCH)には以下のヘッダが必須:

```
X-Requested-With: TsumiWiki
```

このヘッダが無いリクエストは 403 で拒否される。生成AIエージェントはCSRF回避のためこのヘッダを常に付ける実装にしておくと安全。

### 未認証時の挙動

- 認証必須のエンドポイントに未認証で叩くと `401 Unauthorized`(エラー形式は共通)
- 例外: `GET /api/auth/me` は未認証でも 200 で `{ user: null }` を返す(セッション有無の探索用)

---

## 2. ログイン

### POST /api/auth/login

```json
{ "username": "admin", "password": "..." }
```

**レスポンス**: `{ user: { id, username, displayName, role, disabled } }`。Cookie がセットされる。

### POST /api/auth/logout

Cookie を無効化。

### GET /api/auth/me

現在のユーザーを返す。未認証時は `{ user: null }` (200)。

---

## 3. 共通ルール

### エラー形式

すべてのエラーは以下の共通形式:

```json
{ "error": { "code": "STRING_CODE", "message": "日本語エラーメッセージ" } }
```

主なコード:
- `VALIDATION_ERROR` — リクエストが zod スキーマ違反
- `NOT_FOUND` — パスが存在しない
- `CONFLICT` — 保存時に `baseUpdatedAt` が食い違う
- `LOCK_HELD` / `LOCK_EXPIRED` — 編集ロック関連
- `DOC_LOCKED` — 他ユーザーが編集中
- `FORBIDDEN` — 権限不足(admin専用APIなど)

### パス表記

- 文書パスは常に POSIX 区切り(`/`)。Windows で動いていても API では `フォルダ/ファイル.md` の形式
- **`.md` 拡張子は必須**(文書パスの一部)
- ルート直下の文書は `フォルダ/` を付けない: 例 `メモ.md`
- フォルダパスは末尾に `/` を付けない: 例 `研究/2026年`
- 制御文字・NUL・Windows予約デバイス名(CON/PRN/AUX/NUL/COM1〜/LPT1〜)は拒否される
- `..` や絶対パスは validate で弾かれる
- Unicode は NFC 正規化される(macOS/Linux で NFD 表記を送っても内部で NFC 化)

### 日付形式

すべての `updatedAt`, `deletedAt`, `date` などは ISO 8601 文字列(サーバー側は Unix mtime を ISO 化)。

### エンコード

- リクエスト/レスポンスとも `Content-Type: application/json; charset=utf-8`
- クエリパラメータの日本語は URL エンコード必須(`encodeURIComponent(path)`)

---

## 4. 文書ツリー / 一覧

### GET /api/tree

ライブラリ全体の一覧。

**レスポンス**:
```json
{
  "folders": ["研究", "研究/2026年", "日記"],
  "docs": [
    { "path": "日記/2026-07-05.md", "title": "2026-07-05", "folder": "日記", "updatedAt": "2026-07-05T12:34:56.789Z" }
  ]
}
```

- `folders`: フォルダパスのフラットリスト(親→子順にソート済み)
- `docs`: 全文書。`title` は拡張子を除いたファイル名、`folder` は所属フォルダ("" = ルート)、`updatedAt` はファイルmtime
- ドラフトや `.trash/` 配下は含まない
- `updatedAt` は文書の内容更新のたびに変わる。ポーリングでの差分検知に使える

### GET /api/docs/recent?limit=20

最近更新順の一覧。`limit` は 1〜100(既定 20)。レスポンスは `DocSummary` の配列。

---

## 5. 文書の読み取り

### GET /api/docs?path=<path>

指定文書の全内容。

**レスポンス**:
```json
{
  "path": "日記/2026-07-05.md",
  "frontmatter": { "tags": ["日記"], "updated": "2026-07-05" },
  "tags": ["日記", "技術"],
  "body": "# 見出し\n本文...\n#技術 のようなインラインタグは tags に含まれる",
  "updatedAt": "2026-07-05T12:34:56.789Z",
  "lock": null
}
```

- `frontmatter`: YAMLフロントマターを未加工の JSON 化した辞書。未知キーもそのまま入る
- `tags`: フロントマターの `tags:` + 本文中の `#タグ名` を合算した重複なしリスト
- `body`: フロントマターを除いた本文
- `updatedAt`: 保存時に必ずクライアントへ **記憶しておく**(次の保存で必要)
- `lock`: 他ユーザーが編集中なら `{ userId, displayName }`、なければ `null`

---

## 6. 文書の作成・保存・移動・削除

### POST /api/docs — 新規作成

```json
{ "folder": "日記", "title": "2026-07-05" }
```

- `folder`: `""` でルート直下、非空でフォルダ指定
- `title`: `.md` は付けない(サーバー側で付与)。既存文書と衝突すると 409

**レスポンス**: `{ path: "日記/2026-07-05.md", updatedAt: "..." }`。この直後に GET /api/docs?path=... で本文取得可(初期は空)。

### PUT /api/docs — 保存

```json
{
  "path": "日記/2026-07-05.md",
  "body": "本文全文(マークダウン)",
  "tags": ["日記"],
  "baseUpdatedAt": "2026-07-05T12:34:56.789Z"
}
```

**重要**: `baseUpdatedAt` は **GET /api/docs で取得した時の `updatedAt`**。サーバー側で現ファイルの mtime と一致しなければ 409 CONFLICT を返す(楽観ロック)。

`tags` を省略するとタグは変更しない。空配列を渡すと全削除。

**保存の副作用**:
- 内容を LF に統一(CRLF は自動で LF 化される)
- フロントマターの外科的編集: `tags:` と `updated:` を差し替え、他のキー・コメント・キー順は温存
- git コミット(`edit: <path>` メッセージ、author = 保存ユーザー)
- インデックス(DB)更新
- **保存には編集ロックが必要**(6.1 参照)

**レスポンス**: `{ updatedAt: "新しいISO文字列" }`。次の保存にはこれを `baseUpdatedAt` として使う。

### DELETE /api/docs?path=<path>

`.trash/日付/` へ移動(復元可能)。ロック必須。

### POST /api/docs/move — 移動・リネーム

```json
{
  "path": "日記/2026-07-05.md",
  "newFolder": "アーカイブ",
  "newTitle": "2026-07-05"
}
```

- `newFolder` を変えれば移動、`newTitle` を変えればリネーム、両方変えれば移動+リネーム
- ロック必須(自分がロック取得済みなら OK)
- git ログには `move: old -> new` として1コミットで表現され、`git log --follow` で追跡可能
- 移動先に同名文書があると 409

### 6.1 編集ロックの取得と解放

保存(PUT)・削除(DELETE)・リネーム(move)は **編集ロックを保持しているユーザーだけ**が実行できる。

```
POST /api/locks           { "path": "..." }        # ロック取得(既に他人が持ってると 409)
PUT  /api/locks/refresh   { "path": "..." }        # ハートビート(60秒に1回推奨。無応答2分でタイムアウト)
DELETE /api/locks?path=<path>                       # 明示解放
```

**典型フロー**:
1. `POST /api/locks` で取得
2. `GET /api/docs?path=...` で最新の `updatedAt` を取得
3. 編集 → `PUT /api/docs` で保存(その `baseUpdatedAt` に上の値を渡す)
4. `DELETE /api/locks` で解放

- ロック未取得で PUT すると `LOCK_HELD` (403)
- 他人がロック中に POST /api/locks すると `DOC_LOCKED` (409) — `error.message` に `<userName>さんが編集中です`
- 生成AIエージェントは処理開始前に **GET /api/docs で `lock` フィールドを見て回避判断**すると賢い

### 6.2 別解: ロックを使わずに複数文書を書き換えたいとき

AIが一気に大量の文書を書き換える用途で、いちいちロックしていられないなら、以下のいずれか:

- **A案(推奨)**: 対象ファイルを **直接ディスクに書く**。Chokidar が3秒後に検知し `sync: external changes` として system author でコミット。ただし整合性(同時編集の衝突)は AI 側で気を付ける必要あり。詳細は 12.章
- **B案**: 各ファイルごとに acquire → save → release を順次実行。時間はかかるが、ロック競合を即検知できる

---

## 7. フォルダ

### POST /api/folders — 作成

```json
{ "path": "研究/2026年" }
```

親フォルダは自動作成される。既存の場合は 409。

### POST /api/folders/move — 移動・リネーム

```json
{ "path": "研究/2026年", "newPath": "アーカイブ/2026年" }
```

配下の文書ごと移動。フォルダを自分自身の子孫へ移動しようとすると 400。

### DELETE /api/folders?path=<path>

`.trash/日付/` へ移動(配下の文書ごと)。

---

## 8. タグ

### GET /api/tags

全タグの利用数一覧。`[{ "tag": "日記", "count": 42 }, ...]`。

### GET /api/tags/docs?tag=<tag>

指定タグを持つ文書一覧。`DocSummary[]`。

タグの認識ルール(サーバー側):
- **フロントマター**: `tags:` の配列。文字列単数指定も可
- **本文**: `#タグ名`(先頭 `#` の直後は `[A-Za-z0-9_ぁ-んァ-ヶ一-龠々ー\-]` の連続)。行頭見出しの `# ` は除外
- **正規化**: NFC 統一・先頭 `#` を除去・重複除去

`GET /api/docs` の `tags` フィールドは上記2つを合算したもの。

---

## 9. 検索

### GET /api/search?q=<query>&limit=20

SQLite FTS5 trigram インデックスによる全文検索。

- `q` は 3文字以上推奨(1〜2文字だとヒットしないことがある。trigram特性)
- `limit` は 1〜100(既定 20)
- 大文字小文字を区別しない、日本語もOK

**レスポンス**: `SearchResult[]`。

```json
[
  {
    "path": "日記/2026-07-05.md",
    "title": "2026-07-05",
    "snippet": "本文抜粋(HTMLエスケープ済み)<mark>ハイライト</mark>部分のみHTML"
  }
]
```

`snippet` の `<mark>` タグ以外の HTML は全てエスケープ済み。UIは `innerHTML` で描画してよい契約。

---

## 10. 履歴・復元

### GET /api/history?path=<path>&limit=50

該当文書の git 履歴。`HistoryEntry[]`。

```json
[
  { "rev": "abc1234", "authorName": "山田太郎", "date": "2026-07-05T12:34:56Z", "message": "edit: 日記/2026-07-05.md" }
]
```

`rev` は SHA(4〜40桁 hex)。

### GET /api/history/content?path=<path>&rev=<rev>

指定リビジョンの全文。`{ content: "..." }`。

### GET /api/history/diff?path=<path>&rev=<rev>

指定リビジョンの unified diff。`{ diff: "..." }`。

### POST /api/history/restore

```json
{ "path": "日記/2026-07-05.md", "rev": "abc1234" }
```

そのリビジョンの内容で復元(`restore:` コミットになる)。ロック必須。

---

## 11. ごみ箱

### GET /api/trash

`TrashEntry[]`。

### POST /api/trash/restore

```json
{ "trashPath": ".trash/2026-07-05/12-34-56/日記/2026-07-05.md" }
```

元パス(または元パス直近)に戻す。ロック不要(削除済みの復元なので競合しない)。

### DELETE /api/trash?trashPath=<...>

物理削除(`purge:` コミット)。復元不可。

---

## 12. ライブラリの外部変更取り込み

### GET /api/library/status

バックアップpush状況・sync状況。監視用。

### POST /api/library/rescan

ライブラリの再スキャンを即時実行(手動 `更新確認` ボタン相当)。以下を行う:

1. `git status` を見て未コミットの差分があれば `sync: external changes`(author=system)でコミット
2. 全文書を再インデックス(DB)
3. タグを再抽出

**AI連携の重要ポイント**: 直接ファイルを書き換えたあと、以下のいずれかで反映される:

- **自動**: chokidar が3秒デバウンスで検知して 12. と同じ処理を回す
- **手動**: 大量に書き換えた直後にこのAPIを叩くと即反映

外部変更のみで書き換える運用でも、TsumiWiki 側からは「system が更新した」として履歴に残る。

---

## 13. 添付ファイル

### POST /api/attachments (multipart/form-data)

```
docPath=日記/2026-07-05.md
file=<バイナリ>
```

`日記/attachments/2026-07-05_<原名>` 相当に保存され、レスポンスの `fileName` を Obsidian embed 記法 `![[fileName]]` で本文に埋め込むと参照できる。

### GET /api/files/*

添付・画像などライブラリ内のファイルを配信する。認証必須。

---

## 14. ユーザー管理(admin専用)

- `GET /api/users` — 一覧
- `POST /api/users` — 追加(role: 'admin' | 'user')
- `PATCH /api/users/:id` — 表示名 / role / 有効無効 / パスワードリセット
- `PUT /api/me/password` — 自分のパスワード変更(currentPasswordの検証あり)

**Note**: ユーザーは物理削除しない(過去のGitコミットの author 情報を残すため、`disabled: true` で無効化)。

---

## 15. 生成AIエージェント連携のベストプラクティス

### 15.1 読み取り主体のワークフロー(例: 週次サマリー生成)

安全度: 高。副作用ゼロ。

```
1. POST /api/auth/login
2. GET /api/tree            → 全文書一覧
3. GET /api/docs?path=...   → 対象を順に読む
4. AI が処理してサマリー本文を作成
5. POST /api/docs で新規文書として書き込み
6. POST /api/auth/logout
```

### 15.2 既存文書の書き換え(例: 誤字修正エージェント)

安全度: 中。同時編集の衝突に注意。

**推奨手順**:
```
1. GET /api/docs?path=... → 現在のbody・updatedAt・lock を取得
2. lock !== null なら「他ユーザー編集中」→ スキップ
3. POST /api/locks で自分がロック取得
4. AI が書き換えたbodyを作る
5. PUT /api/docs (baseUpdatedAt = ステップ1の値)
6. DELETE /api/locks で解放
```

- 5 で `CONFLICT` が返ったら、その文書は他要因で更新された。**上書きせず**、GET し直してマージ判断
- 5 で `LOCK_EXPIRED`(2分以上ハートビートなし) → 再度 3 からやり直し

### 15.3 一括流し込み(例: 別リポジトリから移行)

安全度: 中。API 経由が最も安全。

- 各文書ごとに 15.2 の手順、または
- POST /api/docs で新規作成 → 直後に PUT で本文を書き込む
- 大量の場合は sequential(並列にすると FTS 更新等で SerialQueue に詰まる)

### 15.4 ファイル直接編集(高速だが要注意)

生成AIエージェントが `LIBRARY_PATH` に直接書き込む場合の注意:

- **やって良い**:
  - 新規文書の追加(空でないコンテンツ + LF 改行 + UTF-8 無 BOM)
  - 既存文書の書き換え(他ユーザーがロックしていないもの限定)
- **やらない方が良い**:
  - **物理削除**: git 履歴以外に復元手段がない。`DELETE /api/docs?path=...` で `.trash` 経由が安全
  - **リネーム(delete+add)**: git 上で別ファイル扱いになり `git log --follow` が繋がらない。`POST /api/docs/move` が安全
  - **`.trash/` `.git/` `.tsumiwiki-tmp-*` への書き込み**: 監視は無視するが破壊リスクあり
  - **CRLF での書き込み**: 動くが、次のユーザー保存時に全行がLFに変換され、無関係な差分が発生する
  - **改行/BOM/エンコード違いでの書き込み**: 同上
- ファイル直接編集後は `POST /api/library/rescan` を叩くと反映が早い(自動でも3秒デバウンスで反映)

### 15.5 認証情報の管理

生成AIエージェント用の専用ユーザーを1つ作り、その資格情報だけをエージェントに持たせる:

```
POST /api/users { "username": "ai-agent-01", "displayName": "AIエージェント01", "password": "...", "role": "user" }
```

- `role: 'user'` で十分(admin は user 管理APIに触りたい時のみ)
- 履歴・author 情報に「AIエージェント01」が残るので、後から追跡可能
- パスワード漏洩時は `PATCH /api/users/:id` の `password` フィールドで即リセット

### 15.6 レートリミット・並列度

明示的なレートリミットはないが、以下は挙動として知っておくと良い:

- 書込み系(POST/PUT/DELETE)はサーバー内 SerialQueue で直列化される(git commit 保護のため)。並列で 100 リクエスト飛ばしても内部で順次実行
- 検索(GET /api/search)は SQLite FTS で高速
- チャンク大量並列読取は避け、10並列くらいで tree → 個別 doc を回すのが健全

---

## 16. 参考: 完全なフロー例(curl)

社内 Windows サーバー `http://tsumiwiki.example.internal:3080` に対して:

```bash
# ログイン(セッションCookieを cookies.txt に保存)
curl -s -c cookies.txt \
     -H 'X-Requested-With: TsumiWiki' \
     -H 'Content-Type: application/json' \
     -d '{"username":"ai-agent-01","password":"..."}' \
     http://tsumiwiki.example.internal:3080/api/auth/login

# ツリー取得
curl -s -b cookies.txt \
     http://tsumiwiki.example.internal:3080/api/tree | jq

# 文書取得
curl -s -b cookies.txt \
     "http://tsumiwiki.example.internal:3080/api/docs?path=$(printf '日記/2026-07-05.md' | jq -sRr @uri)" | jq

# ロック→保存→解放
curl -s -b cookies.txt -H 'X-Requested-With: TsumiWiki' -H 'Content-Type: application/json' \
     -d '{"path":"日記/2026-07-05.md"}' \
     http://tsumiwiki.example.internal:3080/api/locks

curl -s -b cookies.txt -X PUT -H 'X-Requested-With: TsumiWiki' -H 'Content-Type: application/json' \
     -d '{"path":"日記/2026-07-05.md","body":"# 更新\n","tags":["日記"],"baseUpdatedAt":"2026-07-05T12:34:56.789Z"}' \
     http://tsumiwiki.example.internal:3080/api/docs

curl -s -b cookies.txt -X DELETE -H 'X-Requested-With: TsumiWiki' \
     "http://tsumiwiki.example.internal:3080/api/locks?path=$(printf '日記/2026-07-05.md' | jq -sRr @uri)"
```

---

## 17. スキーマの一次情報

このドキュメントは `packages/shared/src/index.ts` の zod スキーマから抜粋したもの。細部の型は同ファイルで確認できる:

- 全リクエスト/レスポンスの型定義(`z.infer<>`)
- バリデーションルール(例: username は `/^[a-zA-Z0-9_.-]+$/` のみ)
- コメントによる制約説明

API 追加時はこのドキュメントも更新すること。

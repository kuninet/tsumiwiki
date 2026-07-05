# AIエージェントによるライブラリ直接編集ガイド

生成AIエージェント(Cowork, GitHub Copilot Workspace, Cursor, Claude Code, ChatGPT Codex 等)が **TsumiWiki の `LIBRARY_PATH` フォルダを直接読み書き**する運用のためのルールとベストプラクティス。

HTTP API 経由の連携は `HTTP_APIリファレンス.md` を参照してください。両方を組み合わせることも可能です。

**対象読者**: 生成AIエージェント本体、およびエージェントに context として渡される system prompt を書く人。

---

## 1. 全体像

TsumiWiki のライブラリは **プレーンなMarkdownフォルダ + Gitリポジトリ**なので、ファイルシステム越しに触れます。特別なDBやサーバー越しの手続きなく直接編集できるのが利点。

TsumiWiki 側は以下を自動で行うため、AI は「普通にファイルを書けば」内容は反映されます:

1. **監視**: `LIBRARY_PATH` を chokidar が常時ウォッチ(3秒デバウンス)
2. **取り込み**: 未コミットの外部変更を検知 → `sync: external changes` として system author で自動コミット
3. **再インデックス**: SQLite の doc_index / doc_tags / doc_fts を更新
4. **UI 反映**: 開いているブラウザに変更が反映される(次回の refetch または `更新確認` ボタン)

即時反映したい時は AI 側から `POST /api/library/rescan`(認証必要)を叩けば 3秒待たずに sync が回ります。

---

## 2. ライブラリの場所と構造

- **ルート**: `LIBRARY_PATH` 環境変数で指定(例: `C:\tsumiwiki-library`)
- **文書**: 拡張子 `.md` の UTF-8 テキストファイル
- **フォルダ**: 任意の階層(制限なし)
- **特殊フォルダ**:
  - `.trash/` — ごみ箱。AI は書き込まない(TsumiWiki の削除処理専用)
  - `.git/` — Git内部。AIは絶対に触らない
  - `attachments/` — 添付ファイル置き場(規約。例: `日記/attachments/2026-07-05_photo.png`)

## 3. ファイル形式の必須ルール

以下を **守っていない**とTsumiWikiの正規化処理で「無関係な差分」が発生し、履歴が汚くなります。

| 項目 | 要件 |
|---|---|
| 文字コード | UTF-8(BOMなし) |
| 改行 | LF(`\n`)固定。CRLF不可 |
| ファイル名 | NFC正規化した日本語OK、`.md` 拡張子必須 |
| Windows予約名 | `CON` `PRN` `AUX` `NUL` `COM1`〜`COM9` `LPT1`〜`LPT9` は末尾に `_` を付ける(タイトル `CON.md` → `CON_.md`) |
| 制御文字 | ファイル名にもフロントマターにも本文にも入れない |
| 相対パス | `../` `./` の埋め込みはNG(パスバリデーションで弾かれる) |
| 隠しファイル | ドット始まりのファイル(`.foo.md` 等)は無視される |

## 4. Markdown ファイルの構造

### 4.1 標準形

```markdown
---
tags:
  - 日記
  - 技術
updated: 2026-07-05
---

# 見出し

本文。 [[別文書]] や #インラインタグ、**強調** など Obsidian 互換記法。

## 見出し2

- リスト
- リスト
```

### 4.2 フロントマターの規約

- `---` で囲まれた YAML ブロック(先頭に置く)
- `tags:` は文字列配列。TsumiWikiは `- タグ名` または `tags: [a, b]` どちらも読める
- `updated:` は最終更新日(TsumiWikiのUI保存で自動更新される。AIが直接編集する場合は「触らないでおく」か「更新して置く」)
- **未知キーはそのまま保持される**(AIが独自のメタ情報を書いても壊れない)
- **コメント・キー順・スタイルは温存される**(UI保存でも失われない)

### 4.3 タグ

- **フロントマター**: `tags:` の配列
- **本文中インライン**: `#タグ名`
  - `#` の直後は `[A-Za-z0-9_ぁ-んァ-ヶ一-龠々ー\-]` の連続
  - 行頭見出しの `# ` は除外される(スペース付きは Markdown 見出し扱い)
  - 例: `#日記 #技術系-2026` は認識、`# 見出し` は非タグ

両方合算した重複なしリストがUIの「タグ」として扱われる。

### 4.4 内部リンク

- `[[文書名]]` — 同名の文書へ解決。パス一部一致も許容
- `[[文書名|表示名]]` — 表示名指定
- `![[添付ファイル名]]` — 埋め込み(画像や別文書の埋め込み)

---

## 5. 変更操作の可否表

「AI が LIBRARY_PATH 内で直接やる作業」ごとの推奨度と注意点:

| 操作 | 推奨度 | 補足 |
|---|---|---|
| **新規文書の追加** | ◎ | 最も安全。フロントマター + 本文を書いてファイル配置するだけ |
| **既存文書の書き換え** | ○ | 他ユーザーが編集中でないことを事前確認(11章)。フロントマターは外科的に(4.2) |
| **フォルダの追加** | ◎ | `mkdir` するだけ。空フォルダは Git に載らないので、直後に何か文書を入れる |
| **既存文書のリネーム(mv)** | △ | Git履歴が「別ファイル」扱いになる。避けたい場合は HTTP API `POST /api/docs/move` を推奨 |
| **既存文書の削除(rm)** | × | 復元手段が git 履歴のみになる。ごみ箱経由の `DELETE /api/docs?path=...` が安全 |
| **`.trash/` への書き込み** | × | UI のごみ箱表示が壊れる |
| **`.git/` への書き込み** | × | Git内部を破壊 |
| **添付ファイル(画像等)の追加** | ○ | `フォルダ名/attachments/` の下に置く規約 |
| **一括処理(多数の文書を一気に書き換え)** | ○ | 5.1 参照。1回の sync commit にまとめられて履歴が読みにくくなるので、可能なら AI 自身が `git commit` してから終了 |

### 5.1 一括処理を「1コミット」にまとめる

`sync: external changes` は 3 秒デバウンスで発火するため、AI がそれより短い間隔で連続書き込みすると 1コミットにまとまります。逆に長時間かけて書くと複数コミットに分割されて履歴が読みにくくなります。

**確実な方法**: AI 自身が git を使う。

```bash
cd $LIBRARY_PATH
git add -A
git commit -m "docs: 誤字修正エージェント 一括処理" --author="AIエージェント01 <ai01@tsumiwiki.local>"
```

この場合、TsumiWiki の sync-service は「未コミット変更なし」と判定するので、追加コミットせず index 更新のみ行います。履歴に AI コミットがそのまま残ります。

---

## 6. TsumiWiki 側の反応の理解

### 6.1 反映タイミング

AI が書き込んでからブラウザに反映されるまで:

```
AI 書き込み
   ↓
[chokidar 3秒デバウンス] ← ここでまとまった変更を1コミットに集約
   ↓
sync-service.run()
  1. git status で未コミット差分検出
  2. 差分があれば `sync: external changes` として system author でコミット
  3. 全文書を再スキャン(indexer.scanAll)
  4. doc_index / doc_tags / doc_fts を更新
   ↓
ブラウザに反映(次回 GET /api/tree などで)
```

即時反映したいときは `POST /api/library/rescan` を叩く(3秒待たずに sync 発火)。

### 6.2 コミットの authorship

- AI が直接ファイル書き込み + TsumiWikiの sync 経由 → author は **TsumiWiki system**
- AI 自身が `git commit --author=...` を使う → その author 名がそのまま残る(6.3)

**推奨**: AI エージェント専用のユーザー(git identity)を用意する。

```bash
export GIT_AUTHOR_NAME="ai-agent-01"
export GIT_AUTHOR_EMAIL="ai-agent-01@tsumiwiki.local"
```

TsumiWiki UI 側でも履歴の author 欄に「ai-agent-01」と表示され、追跡が容易になります。

### 6.3 UI 側からの識別方法

- 履歴パネルで author 名を見る
- コミットメッセージのプレフィックスで判別: `add:` `edit:` = ユーザー、`sync:` = 外部変更取り込み、AI 自身のコミットは AI の付けたメッセージのまま

---

## 7. 検索インデックスと反映

TsumiWiki の全文検索は SQLite FTS5 trigram を使っています。

- ファイル配置後、chokidar → sync → index 再構築で自動的に検索対象に入る
- `/api/library/rescan` の返り値 `indexed`/`removed` で反映件数が分かる
- FTS5 の特性上、**3文字未満のクエリはヒットしないことがある**(trigram のため)

---

## 8. 添付ファイル(画像等)

TsumiWiki UI の画像ドラッグ&ドロップは `フォルダ/attachments/日時_原名` の規約で保存し、本文には `![[原名.png]]` で参照を挿入します。AI も同じ規約に従うと UI 側と噛み合います。

例:
```markdown
# 会議メモ

議事録：

![[会議室図.png]]
```

上のファイル `会議メモ.md` が `プロジェクトA/` にあるとき、画像は:

- `プロジェクトA/attachments/会議室図.png`
- または `プロジェクトA/会議室図.png`

のどちらかに配置。UI は同フォルダ・`attachments/` サブ・ライブラリ全体、の順で検索します。

---

## 9. 検証パターン(AI が結果を確認する方法)

AI が編集後、正しく反映されたかを確認したい場合:

### 9.1 HTTP API で確認

```bash
# ツリーに載ってるか
curl -s -b cookies.txt http://<host>:3080/api/tree | jq '.docs[] | select(.path=="日記/2026-07-05.md")'

# 内容確認
curl -s -b cookies.txt "http://<host>:3080/api/docs?path=$(urlencode 日記/2026-07-05.md)" | jq
```

### 9.2 Git で確認

```bash
cd $LIBRARY_PATH
git log --oneline -5           # 最新コミット
git show HEAD -- 日記/2026-07-05.md   # 差分
```

### 9.3 ライブラリ状態

```bash
curl -s -b cookies.txt http://<host>:3080/api/library/status | jq
# → syncErrors, indexErrors, backup 状態が確認できる
```

---

## 10. トラブルシューティング

### 10.1 反映されない

- 3秒待つ(デバウンス)
- `POST /api/library/rescan` を明示的に叩く
- `GET /api/library/status` で `syncErrors` を確認
- **ファイル名の NFC 正規化**が原因のことがある。macOS/Linux で NFD で書くと `.git` は保存できても TsumiWiki が index できない → UI に出ない

### 10.2 「無関係な差分」が発生する

原因はほぼ **改行コード**か **BOM**:

- CRLF で書いた → 次回ユーザー保存時に全行が LF に変換され、diff が全行になる
- UTF-8 BOM 付きで書いた → BOM が本文の一部として扱われる

対策: エディタ/ライブラリで LF・BOMなし固定。

### 10.3 フロントマターのキー順が変わった

TsumiWiki UI での保存(PUT /api/docs)は yaml の Document API を使う **外科的編集**なので、キー順は温存されます。しかし AI が全部 dump し直す形で書いていると自分自身が順序を変えてる可能性大。既存フロントマターのキーの位置を保ちたいなら、AI 側でも「該当キーだけ差し替える」実装にする。

### 10.4 他ユーザーとの編集競合

AI が編集した直後にユーザーが UI で開いて編集 → ユーザーが保存すると:

- baseUpdatedAt が食い違う → 409 CONFLICT ダイアログ
- ユーザーは「自分で上書き」or「破棄して最新を読み込む」の選択

これは想定内の挙動。ユーザー側で判断してもらう。AI が「上書きされたくない」ときは:

- 11 章のロック取得を使う
- または、AI 編集直後にユーザーが編集しないよう時間を分ける運用

---

## 11. ロック(強い同期を取りたいとき)

ユーザーが編集中の文書に AI が書き込むと、ユーザーの編集内容が「他要因の更新」として競合ダイアログの対象になります。これを回避するには HTTP API 経由でロックを取ります。

```bash
# 1. ロック取得
curl -s -b cookies.txt -X POST -H 'X-Requested-With: TsumiWiki' -H 'Content-Type: application/json' \
     -d '{"path":"日記/2026-07-05.md"}' \
     http://<host>:3080/api/locks
# → 409 なら他ユーザーがロック中。編集を諦めるか待つ

# 2. ファイル書き込み(直接)
echo "..." > $LIBRARY_PATH/日記/2026-07-05.md

# 3. 60秒毎にハートビート(処理が長引くとき)
curl -s -b cookies.txt -X PUT -H 'X-Requested-With: TsumiWiki' -H 'Content-Type: application/json' \
     -d '{"path":"日記/2026-07-05.md"}' \
     http://<host>:3080/api/locks/refresh

# 4. ロック解放
curl -s -b cookies.txt -X DELETE -H 'X-Requested-With: TsumiWiki' \
     "http://<host>:3080/api/locks?path=$(urlencode 日記/2026-07-05.md)"
```

**手軽な代替**: ロックせず、GET /api/docs で `lock !== null` の文書をスキップするだけでも「同時編集の衝突」は大幅に減ります。

---

## 12. 生成AIエージェントの推奨プロファイル

| 項目 | 推奨値 |
|---|---|
| Git identity | `ai-agent-<番号>` / `ai@tsumiwiki.local` |
| TsumiWiki アカウント | `role: user`(admin不要)。HTTP API を併用する場合 |
| 実行タイミング | 業務時間外(ユーザー編集が少ない時間帯) |
| 対象文書 | `lock === null` のもの限定 |
| バッチサイズ | 10〜100文書/回。あまり大きいと sync 1コミットが巨大化 |
| リトライ | 409 CONFLICT / 409 DOC_LOCKED が返ったらそのファイルはスキップ、次回リトライ |
| ログ | AI 側で「触った文書パス + before/after のハッシュ」を残す(復元しやすい) |
| バックアップ確認 | 大量変更前に `GET /api/library/status.backup.lastPushAt` を確認、直近成功しているなら安心 |

---

## 13. 参考: 最小のPythonエージェント例

新規文書を作って本文を書くだけの最小例:

```python
import os
from pathlib import Path

LIBRARY_PATH = Path(os.environ["LIBRARY_PATH"])

def write_doc(rel_path: str, tags: list[str], body: str) -> None:
    """新規文書を作成する。既存の場合は上書き。"""
    assert rel_path.endswith(".md")
    assert not rel_path.startswith("."), "隠しファイルは不可"
    assert ".." not in rel_path.split("/"), "パス脱出不可"
    
    p = LIBRARY_PATH / rel_path
    p.parent.mkdir(parents=True, exist_ok=True)
    
    tag_lines = "\n".join(f"  - {t}" for t in tags)
    content = f"""---
tags:
{tag_lines}
---

{body}
"""
    # UTF-8 無BOM、改行LF固定
    p.write_bytes(content.encode("utf-8").replace(b"\r\n", b"\n"))

# 使用例
write_doc(
    "日記/2026-07-05.md",
    tags=["日記", "AI連携"],
    body="今日のタスク:\n- [ ] タスク1\n- [ ] タスク2\n\n#日記 テスト",
)
```

3秒後に自動 sync commit + index 更新 → ブラウザに反映されます。

---

## 14. 関連ドキュメント

- `HTTP_APIリファレンス.md` — サーバー越しに操作したい場合(ロック取得・API経由の削除/リネーム・検索・履歴等)
- `packages/shared/src/index.ts` — 全 API のリクエスト/レスポンスの zod スキーマ(一次情報)
- `docs/要件定義/` — 機能要件・非機能要件
- `docs/設計/` — アーキテクチャ・ファイル形式・履歴管理の詳細

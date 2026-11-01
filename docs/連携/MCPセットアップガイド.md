# TsumiWiki MCP セットアップガイド

TsumiWiki を Remote MCP サーバーとして起動し、Claude Desktop / Claude Code などの MCP 対応クライアントからノートを検索・閲覧・作成・更新・削除する手順。

**対象読者**: 自分専用の TsumiWiki を自宅サーバーで運用し、外部の MCP クライアントから利用したい人。

**想定構成**: 単一ユーザー + Bearer 静的トークン。複数ユーザー配布や OAuth は対象外(必要になれば別途拡張)。LAN / Tailscale 内だけで使う場合は、トークンを使わない認証なしモードも選べる(§2.4)。

---

## 1. 前提条件

- TsumiWiki サーバーが動く環境(Node.js 20.19 以上)。詳細は [Windowsセットアップ](../導入/Windowsセットアップ.md)
- **HTTPS 必須**。Bearer トークンを平文で送るため、素の HTTP で外部公開しない
  - 自宅内 → Tailscale / WireGuard で VPN 経由
  - 外部公開 → Cloudflare Tunnel / Caddy / Nginx でリバースプロキシ + Let's Encrypt

---

## 2. サーバー側セットアップ

### 2.1 トークン生成

64 文字(256 bit)のランダム 16 進文字列を生成:

```bash
openssl rand -hex 32
# 例: e3f8a1c9b7d4e2f0a1c9b7d4e2f0a1c9b7d4e2f0a1c9b7d4e2f0a1c9b7d4e2f0
```

Windows で openssl が無ければ PowerShell:

```powershell
-join ((1..64) | ForEach-Object { '0123456789abcdef'[(Get-Random -Max 16)] })
```

### 2.2 環境変数

既存の TsumiWiki 起動 env に以下を追加:

```
MCP_ENABLED=true
MCP_TOKEN=<上で生成した 64 文字の 16 進>
```

- `MCP_ENABLED` が未設定 / `false` のとき、`/mcp` エンドポイントは登録されない(既存 API に一切影響しない)
- `MCP_TOKEN` は **32 文字未満だと fail-secure で起動拒否**。誤って短いトークンを設定した場合は起動時にエラーメッセージで気付ける
- 任意: `MCP_WORK_LOG_RECIPE` で、プロンプト `work_log` / `daily_journal` が読むレシピノートのパスを変えられる(既定 `作業ログの書き方.md`。§6 参照)

### 2.3 起動確認

サーバー起動後、認証無しで叩いて 401 が返ることを確認:

```bash
curl -i -X POST http://localhost:3000/mcp
# HTTP/1.1 401 Unauthorized
# WWW-Authenticate: Bearer realm="tsumiwiki-mcp"
```

正しいトークンで `tools/list` を叩き、23 個のツールが返ることを確認:

```bash
export MCP_TOKEN=<設定したトークン>
curl -sS -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

**Accept ヘッダに `application/json, text/event-stream` の両方**を含めること(MCP SDK の要件)。

### 2.4 認証なしモード(LAN / Tailscale 内専用)

自宅 LAN や Tailscale の内側だけで使うなら、トークンなしで運用できる。`MCP_AUTH=none` を **明示したときだけ** 有効になる(既定は `token`)。

```
MCP_ENABLED=true
MCP_AUTH=none
```

- `MCP_AUTH` に指定できる値は `token`(既定。未設定・空文字も同じ)と `none` のみ。それ以外の値では起動を拒否する
- `MCP_AUTH=none` のとき `MCP_TOKEN` は不要。設定されていても無視される(起動ログに警告が出る)
- 公開されたときに誰でもノートを削除・改ざんできてしまうのを防ぐため、**送信元アドレスが次の範囲のときだけ**受け付ける。範囲外は 403

| 範囲 | 用途 |
|---|---|
| `127.0.0.0/8`, `::1` | 同一マシン(ループバック) |
| `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` | プライベートネットワーク(LAN) |
| `100.64.0.0/10`, `fc00::/7` | Tailscale(`fd7a:115c:a1e0::/48` を含む) |
| `169.254.0.0/16`, `fe80::/10` | リンクローカル |

- ソケットの送信元に加えて、`X-Forwarded-For` / `Forwarded` / `X-Real-IP` / `CF-Connecting-IP` / `True-Client-IP` が示す元の送信元も検査し、**1 つでも範囲外なら 403** にする。同一ホスト上のリバースプロキシやトンネルを通ると、ソケットの送信元は 127.0.0.1 に見えるため
- そのため **Cloudflare Tunnel / Tailscale Funnel / 外部公開のリバースプロキシ(Caddy・Nginx など)経由では 403** になる。外部から使うなら §2.1 のトークン認証(`MCP_AUTH=token`)を使う
- Tailscale Serve(tailnet 内だけの公開)は、転送ヘッダーが 100.x なので通る
- **ブラウザからの接続(`Origin` / `Sec-Fetch-Site` / `Sec-Fetch-Mode` / `Sec-Fetch-Dest` のいずれかが付いたリクエスト)は 403 で拒否**する。LAN 内のブラウザで悪意あるサイトを開くと、DNS リバインディングによって送信元が LAN のアドレスのまま `/mcp` を叩かれてしまうため。Claude Code / Claude Desktop などの非ブラウザのクライアントはこれらのヘッダーを送らないので影響しない
- ルーターのポート開放などでサーバーを直接インターネットへ公開しないこと
- LAN 内の他の端末からは、認証なしで誰でも読み書きできる。家族共用の LAN や、信頼できない端末が接続する環境では使わない

起動確認(トークン不要):

```bash
curl -sS -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

---

## 3. HTTPS 公開の選択肢

自宅サーバーを Claude Desktop / Claude Code から叩けるようにする方法。

| 手段 | メリット | 向いているケース |
|---|---|---|
| **Tailscale** | セットアップ最短、ゼロ設定 HTTPS(MagicDNS + Tailscale HTTPS)、Bearer トークン漏れても VPN 側で守れる二重防御 | 自分の端末だけで使う。第三者に共有しない |
| **Cloudflare Tunnel** | 固定 IP・ポート開放不要、CF Access で追加認証も可 | 外出先の端末や複数マシンから、常時アクセスしたい |
| **Caddy + Let's Encrypt** | 直接自宅 IP を公開、フル制御 | ドメイン所有・ポート開放できる。他ツールと共存 |

**推奨: Tailscale**(単一ユーザーには過剰な複雑さを避けられる)。

---

## 4. クライアント登録

### 4.1 Claude Code (CLI)

```bash
claude mcp add --transport http tsumiwiki https://<host>/mcp \
  --header "Authorization: Bearer <MCP_TOKEN>"
```

- **オプションはサーバー名の前**に置く必要がある(`--transport http` を `tsumiwiki` の後にすると受け付けない)
- `--header` は `${VAR}` 展開が使えるので、シェルの env に置いておくと安全:
  ```bash
  claude mcp add --transport http tsumiwiki https://<host>/mcp \
    --header "Authorization: Bearer ${TSUMIWIKI_MCP_TOKEN}"
  ```

登録確認:

```bash
claude mcp list
# tsumiwiki: https://<host>/mcp (HTTP) - Connected ✓
```

### 4.2 Claude Desktop

`claude_desktop_config.json` に追加:

```json
{
  "mcpServers": {
    "tsumiwiki": {
      "type": "http",
      "url": "https://<host>/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_TOKEN>"
      }
    }
  }
}
```

設定後 Claude Desktop を再起動。

### 4.3 認証なしモード(§2.4)の場合

`Authorization` ヘッダーは不要。

```bash
claude mcp add --transport http tsumiwiki http://<host>:3000/mcp
```

Claude Desktop は `headers` を省く:

```json
{
  "mcpServers": {
    "tsumiwiki": {
      "type": "http",
      "url": "http://<host>:3000/mcp"
    }
  }
}
```

`<host>` には LAN 内のホスト名・IP、または Tailscale の MagicDNS 名 / 100.x のアドレスを指定する。

---

## 5. 公開ツール一覧

Read 9 種 + 履歴 4 種 + Write 9 種 + 記録の手順 1 種の計 23 個。全て `docService` / `queryService` 経由で動作するため、UI 経由の書き込みと同じくパス検証・Git コミット・SQLite 索引更新を経由する。

### Read

| ツール | 引数 | 用途 |
|---|---|---|
| `search_notes` | `query: string`, `limit?: number (1-200, 既定 50)` | 全文検索。ヒット箇所のスニペット付き |
| `read_note` | `path: string` | 本文 + フロントマター + タグ + `updatedAt` を取得 |
| `list_recent` | `limit?: number (1-200, 既定 20)` | 最近更新されたノート一覧 |
| `list_tags` | (なし) | 全タグと件数 |
| `get_docs_by_tags` | `tags: string[] (非空)` | 指定タグを **全て** 持つノート(AND) |
| `find_notes_by_property` | `key: string`, `value?: string \| number \| boolean`, `limit?: number (1-200, 既定 50)` | フロントマターのプロパティでノートを探す。`value` を省略するとそのキーを持つノートすべて。配列のプロパティは要素のどれかが一致すれば該当。数値は `1` でも `"1"` でもよく、日付は `YYYY-MM-DD` で指定する。各ノートの `values` にそのキーの値(配列は全要素)が入る。`tags` / `tag` は `USE_TAG_TOOL` エラーになるので `get_docs_by_tags` を使う。比較の注意: 時刻つきの日時は UTC の ISO 文字列で比較する / 小数は JS の数値表現で比較する(`1.0` は `1`) / 真偽値と文字列の `"true"` は一致する |
| `list_properties` | (なし) | ライブラリで使われているプロパティ名(`tags` は除く)と、件数・型・よく使われる値(上位 10 件)。`find_notes_by_property` の前に、どのキー・値があるか調べるのに使う |
| `get_tree` | (なし) | フォルダツリー + 全ノートのサマリ |
| `get_backlinks` | `path: string`, `limit?: number` | 指定ノートへ `[[リンク]]` を張っているノートの一覧(リンク元ごとに行番号・前後の文脈つき)。`limit` はリンク元ノートの最大件数(既定 200)で、超えると `truncated: true` |

### 履歴

読み取り専用。復元(restore)は編集ロックが前提のため MCP には提供しない。

| ツール | 引数 | 用途 |
|---|---|---|
| `get_history` | `path: string` | ノートの変更履歴(新しい順)。各エントリの `rev` を下の 2 つに渡せる |
| `get_history_content` | `path: string`, `rev: string` | 過去の版の全文(フロントマター含む) |
| `get_history_diff` | `path: string`, `rev: string`, `against?: string` | `rev` と `against` の差分(unified diff)。`against` 省略時は現行版(HEAD)との差分 |
| `list_library_history` | `limit?: number (1-1000)` | ライブラリ全体の変更履歴。`.trash` や添付ファイルなど文書以外のパスも含む |

`rev` / `against` は 4〜40 桁の 16 進数(コミットハッシュ)。それ以外は拒否される。

### Write

| ツール | 引数 | 用途 |
|---|---|---|
| `create_note` | `path: string`, `content: string` | 新規作成。既存パスならエラー(`.md` 必須) |
| `save_note` | `path: string`, `body: string`, `baseUpdatedAt: string`, `tags?: string[]`, `frontmatter?: Record<string, unknown>` | 更新。`baseUpdatedAt` は `read_note` で得た値を渡す(競合検知)。`frontmatter` で独自項目の部分更新(null でキー削除)。戻り値に `updatedAt` と更新後 `frontmatter` を返す |
| `update_frontmatter` | `path: string`, `frontmatter?: Record<string, unknown>`, `tags?: string[]`, `addTags?: string[]`, `removeTags?: string[]`, `baseUpdatedAt?: string` | 本文を送らずにフロントマターのプロパティとタグだけを更新する(本文は原則変わらない。例外は表の下の注意を参照)。`frontmatter` は `save_note` と同じ部分マージ(null でキー削除、`tags` / `updated` は指定不可)。`tags` は全置き換え、`addTags` / `removeTags` はフロントマターの `tags` への追加・削除(本文中のインライン `#タグ` は対象外)。`frontmatter` / `tags` / `addTags` / `removeTags` のどれも無ければ `NOTHING_TO_UPDATE`、`tags` と `addTags` / `removeTags` の同時指定は `INVALID_ARGUMENTS`。`baseUpdatedAt` は指定したときだけ競合検知する。UI で編集中のノートには書けず `DOC_LOCKED`。戻り値は `updatedAt` / `frontmatter` / `tags` |
| `move_note` | `path: string`, `newFolder: string`, `newTitle: string` | リネーム / 移動 |
| `create_folder` | `path: string` | フォルダを作成(途中のフォルダもまとめて作る)。空フォルダは Git 管理外 |
| `move_folder` | `path: string`, `newPath: string` | フォルダの改名・移動(例: `議事録/2026` → `議事録/2026年度`)。配下のノートごと移動する。配下を UI で誰かが編集中なら拒否。移動先に同名フォルダがある場合や自分自身の配下への移動もエラー。`path` がファイルのときもエラー(ノートの移動は `move_note` を使う) |
| `delete_note` | `path: string` | `.trash/` へ送る(完全削除ではない) |
| `create_daily_note` | `date?: string (YYYY-MM-DD)` | ライブラリ設定 `dailyNotes.folder` / `template` / `filenamePattern` に基づき指定日(省略時は今日)の Daily Note を生成 or 既存を返す。実在しない日付・形式不正は `isError` かつ `structuredContent.code` が `INVALID_DATE` |
| `append_to_daily_note` | `text: string`, `heading?: string`(既定 `## メモ`), `source?: string` | 今日のデイリーノートの指定見出しの節末尾に `HH:MM [source] text` を1件追記(なければノート・見出しごと作成)。本文全体の読み書きは不要。戻り値は `path` / `created` / `updatedAt`。箇条書きにしたいときは `text` を `- ` で始める。日付と時刻はサーバーのローカル時刻(`TZ` 環境変数)で決まる。UI で編集中のノートには書けず、`isError` かつ `structuredContent.code` が `DOC_LOCKED` になる |

### 記録の手順

| ツール | 引数 | 用途 |
|---|---|---|
| `get_record_instructions` | `kind: 'work_log' \| 'daily_journal'`, `project?: string` | 作業ログ・日誌・振り返りを書くときの手順を返す。本文は §6 のプロンプトと同じ(同じ関数で作る)。`project` は `work_log` のときだけ使い、`daily_journal` では無視される。戻り値は手順の本文をそのまま入れたテキストだけ(JSON にはしない) |

パスは常に **リポジトリルート相対の POSIX 形式**(`Projects/foo.md` など)。`..` / `.git/*` / `.trash/*` / 非 `.md` 拡張子は全て拒否される。

- **`update_frontmatter` で本文やフロントマターの書式が変わる場合**: 本文は送り直さずにそのまま残しますが、次の場合はファイルの見た目が変わります。
  - フロントマターがないノートにフロントマターを新設すると、閉じフェンス(`---`)と本文の間に空行が1行入る
  - 改行コードが CRLF のノートは、保存時に LF にそろう
  - フロントマターは YAML として読み直して書き戻すため、書式が変わることがある(例: `tags: [a, c]` が `tags: [ a, c ]` になる、`...` で閉じたフロントマターが `---` で閉じる形になる)。値そのものは変わらない
  - `addTags` / `removeTags` は、今のタグを原文の表記のまま残す(`2026-01-01`・`true`・`1.0` などのタグも消えない)。`tags` の中にある入れ子の配列など、タグとして読めない要素は追加・削除の対象外とし、そのまま残す。ただし `null` や空文字の要素は削除される
  - `tags` がなく単数形の `tag` だけがあるノートでは、`tag` を残したまま、そのタグを含めた `tags` を新しく書く
  - フロントマターが壊れている(YAML の構文エラー、閉じフェンスがない、ルートがマップでない)ノートは、タグだけの指定でもエラーにして何も書き込まない
- **`update_frontmatter` と `save_note` の同時実行**: `update_frontmatter` は `append_to_daily_note` とは順番に処理されますが、`save_note` とは同時に走りえます。その場合は後から書いたほうが残ります(先に書いた変更は消える)。`read_note` で得た `updatedAt` を `baseUpdatedAt` に渡すと、途中で変更されていれば競合エラーになるので安全です。
- **`save_note` のフロントマター自動抽出**: `body` の先頭に YAML ヘッダー(`---`)が含まれる場合、二重化を防ぐため自動抽出されてフロントマターにマージされます。本文ヘッダー由来の空キー(`aliases:` など)はキー削除されず保持されます(明示的な `frontmatter` 引数で `key: null` を渡した場合はキー削除されます)。

---

## 6. プロンプト

MCP の prompts 機能で、プロンプトを配る。いまあるのは `work_log` と `daily_journal` の 2 つ。

| プロンプト | 使う場面 |
|---|---|
| `work_log` | 作業の区切りごと。いま終わった作業の詳細を、作業ログのノートとして 1 つ作る |
| `daily_journal` | 1 日の終わり。その日の作業ログとデイリーノートを読み、1 日のまとめを書く |

詳細は作業ログに、1 日のまとめはデイリーノートに残す、という使い分け。

**AI に頼むだけで使われるように、同じ本文を `get_record_instructions`(§5)でも返す。** プロンプトはスラッシュコマンドで人が呼んだときにしか届かず、AI は自分から取得できない。スラッシュコマンドは人が確実に呼ぶため、ツールは「日誌書いて」「ログ残して」と頼んだときに AI が自分で呼ぶためのもの。ツールの説明文に「書き込む前に必ず呼ぶ」と書いてあるので、頼まれた AI は手順を取得してから書く。本文はプロンプトと同じ関数で作るので、二重管理にはならない。

### work_log

いま終わった作業について、AI に作業の記録を書かせる手順。作業ログの詳細は `create_note` で毎回新しいノートとして作り、今日のデイリーノートには `append_to_daily_note` で要約とリンクを足す。リンクは、作ったノートのパスから `.md` を除いた形の wikilink で、例は `[[フォルダ/2026-11-01 作業の要約]]`(wikilink はパスの完全一致が最優先で解決される)。既存のノートへの追記や上書きはしない。

| 引数 | 内容 |
|---|---|
| `project?: string` | 対象プロジェクト名。省略すると、AI が作業の内容から特定する(決められなければ本人に聞く) |

- 日付の引数はない。対象は当日の作業で、0 時をまたいだ作業も、書いた日のデイリーノートに入る
- 作業ログのノートの先頭には、次のフロントマターを付けるよう指示される(`date` は当日の日付)。`daily_journal` が、この `type` と `date` で当日の作業ログを探す

  ```yaml
  ---
  type: work-log
  date: 2026-11-01
  project: tsumiwiki
  ---
  ```

- 手順は「プロジェクトの特定 → 下書き(確かめられない数字や固有名詞は「未確認」と書く) → 本人の承認 → `create_note` → `append_to_daily_note` → パスの報告」。作業ログの下書き、保存先のパス、デイリーノートに足す要約を見せて承認を得るまでは、どちらのノートにも書き込まない。同じパスのノートがあって `create_note` がエラーになったら、別のファイル名を本人に確認する(既存のノートは上書きしない)
- Claude Code では `/mcp__tsumiwiki__work_log [プロジェクト名]` で呼べる
- 呼び出すたびに(`prompts/get` のとき)サーバーが下のレシピノートを読み、本文をプロンプトに差し込む

### daily_journal

その日の作業ログとデイリーノートを読み、1 日の振り返りをデイリーノートに追記する手順。引数はなく、対象は当日だけ(過去の日付や、週・月のまとめは対象外)。

- 材料は、当日の作業ログ(`find_notes_by_property` で `date` が当日のノートを探し、`read_note` で読んで、フロントマターの `type` が `work-log` のものだけ使う)、当日のデイリーノート(`create_daily_note` でパスを得て `read_note` で読む。当日のノートが無ければこのとき作られる)、デイリーノートの要約にリンクされている作業ログ(フロントマターの無い古いログを拾うため)、今のセッションの会話。`find_notes_by_property` は 2 つの条件で絞れないため、`date` で探してから `type` で絞る
- 振り返りの項目は「今日の成果(プロジェクトごとに数行)/判断したこと/明日以降に残ったこと/所感」。該当する項目だけを書く。所感は本人の発言があるときだけ書く
- 各成果の末尾に、作業ログへのリンク(パスから `.md` を除いた wikilink)を付ける。数字・固有名詞・件数は、作業ログか本人の発言で確かめられたものだけを書き、推測で埋めない
- 手順は「材料集め → 下書き → 本人の承認 → `append_to_daily_note` → 報告」。承認の前には書き込まない。見出しは既定で `## 振り返り`(レシピで変えられる)。`append_to_daily_note` は本文の1行目に「HH:MM [source] 」を付けるため、本文は `- ` の箇条書きで始め、項目名は `**今日の成果**` のように太字にして、4 項目を 1 回の呼び出しでまとめて書く。当日の振り返りが既にその見出しにあるときは、重ねて書かず本人に確認する
- Claude Code では `/mcp__tsumiwiki__daily_journal` で呼べる

### レシピノート

手順の骨格はサーバーが持つ。保存先のフォルダ、ファイル名の決め方、項目の追加など、運用に固有の決まりは Wiki の「レシピノート」に書く。ノートを編集するだけで変えられ、サーバーの再起動もデプロイも要らない。

- 既定のパスは `作業ログの書き方.md`(ライブラリ直下)。環境変数 `MCP_WORK_LOG_RECIPE` でライブラリ相対のパスに変えられる(空文字は既定値)
- `work_log` と `daily_journal` は同じレシピノートを使う
- 保存先・命名規則・見出し・項目について手順と食い違うときは、レシピを優先するようプロンプトに書いてある
- レシピノートが無い・読めない・本文が空のときは、骨格だけで動く
  - `work_log`: AI は保存先のフォルダとファイル名を本人に確認してから決める
  - `daily_journal`: 既定の手順どおりに書く(見出しは `## 振り返り`)

レシピノートの見本:

```markdown
# 作業ログの書き方

## 作業ログの置き場所

- `作業ログ/{プロジェクト}/` に、`YYYY-MM-DD {作業の要約}.md` というファイル名で作る
  - 例: `作業ログ/tsumiwiki/2026-11-01 MCPプロンプトの追加.md`
- `{プロジェクト}` は下の一覧のフォルダ名を使う

## デイリーノートへの追記

- `append_to_daily_note` の `heading` には `## 作業` を渡す
- 要約は 3〜5 行。末尾に作業ログへのリンクを付ける

## 作業ログのフロントマター

- 先頭に `type: work-log` / `date: 書いた日(今日。YYYY-MM-DD)` / `project: プロジェクト名` を付ける(`daily_journal` が当日の作業ログを探すのに使うので、省略しない)

## 1日の振り返り

- `daily_journal` の `append_to_daily_note` の `heading` には `## 今日のまとめ` を渡す(書かなければ `## 振り返り`)
- 成果はプロジェクトごとに数行にまとめ、末尾に作業ログへのリンクを付ける

## プロジェクト一覧

| プロジェクト | フォルダ名 | 内容 |
|---|---|---|
| tsumiwiki | tsumiwiki | TsumiWiki 本体の開発 |
| 自宅サーバー | 自宅サーバー | LAN 内のサーバー運用 |
```

---

## 7. 運用上の注意

### Bearer トークン管理

- サーバーの env に平文で置くしかない(単一固定トークン設計)。`.env` ファイルの権限を絞る、systemd unit なら `EnvironmentFile` を root:root 600 で置く等
- ローテーションは **env 差し替え + サーバー再起動**。頻度が高いなら PAT テーブル方式への拡張を検討
- **Authorization ヘッダはサーバーログで常にマスクされる**(pino redact 設定済み)

### 編集ロック整合

- UI 側で誰かがノートを編集ロック中の場合、MCP からの `save_note` / `delete_note` / `move_note` などの書き込みは **`DOC_LOCKED` で拒否される**(UI 側の作業を壊さない安全策)
- UI は、ノートを開いただけではロックを取らない。**本文やタグを書き換え始めたときに** ロックを取り、保存後しばらく(2分)入力が無ければ手放す。開きっぱなしの画面が MCP の書き込みを阻むことはない
- 逆に MCP からの書き込みは編集ロックを取らないため、MCP 経由での連続更新中に UI 側が同じノートを開いても衝突検知(`baseUpdatedAt`)で守られる。UI 側が開いたあとに MCP で書き込んだ場合、UI で書き換え始めた時点で競合ダイアログが出る

### コミット author

MCP 経由の書き込みは Git コミット author が固定で `MCP Agent <mcp@tsumiwiki.local>` になる。UI 経由の変更(ログインユーザー名)と混在するので、`git log` で誰がいつどこから触ったか追跡できる。

---

## 8. トラブルシューティング

### 401 が返る

- `Authorization: Bearer <token>` ヘッダが付いているか(`bearer` 小文字・複数スペースも許容)
- トークンが env の `MCP_TOKEN` と完全一致しているか(前後の空白・改行に注意)
- サーバーログに `MCP リクエスト処理に失敗しました` が出ていないか

### 403 が返る(認証なしモード)

`MCP_AUTH=none` で起動しているときの、送信元アドレスの制限によるエラー。

- クライアントがローカル・LAN・Tailscale(§2.4 の表の範囲)から接続しているか
- Cloudflare Tunnel / Tailscale Funnel / 外部公開のリバースプロキシを経由していないか。これらは転送ヘッダーに外部アドレスが入るため拒否される
- ブラウザ(または `Origin` / `Sec-Fetch-*` ヘッダーを付けるクライアント)から接続していないか。レスポンスの message が「ブラウザからの接続は受け付けません」のときはこれが原因
- サーバーログの `MCP 認証なしモード: 許可外の送信元を拒否しました` に、検査したアドレスの一覧が出る。どれが範囲外かを確認する
- 外部から接続する構成なら、`MCP_AUTH` を外して(または `token` にして)トークン認証へ切り替える

### 404 が返る

- サーバーが `MCP_ENABLED=true` で起動しているか(未設定 or `false` だと `/mcp` は存在しない)
- 静的配信(SPA)経由で 404 JSON が返る場合は正常(切り戻し運用時の安全策)
- URL の末尾が `/mcp` 単体になっているか(`/mcp/foo` は 404)

### `initialize` は通るが `tools/list` が空

- MCP_ENABLED を追加した状態でサーバー再起動しているか
- Accept ヘッダに `application/json, text/event-stream` の **両方** が入っているか

### 応答が返らずタイムアウトする

- リバースプロキシが SSE 応答をバッファしていないか。Nginx なら `proxy_buffering off`、Cloudflare は SSE 対応済み
- ステートレス transport 実装のため通常は POST 一発で終わるが、逆プロキシ側のアイドルタイムアウトが極端に短いと影響する可能性

### 起動時に「MCP_TOKEN を 32 文字以上で設定してください」

`MCP_ENABLED=true` にしたのに `MCP_TOKEN` が未設定 or 短すぎる場合の fail-secure エラー。トークンを生成し直して設定する(§2.1 参照)。

### 起動時に「MCP_AUTH は token / none のいずれかで指定してください」

`MCP_AUTH` に `token` / `none` 以外の値(typo など)を指定している。値を直すか、トークン認証なら `MCP_AUTH` を削除する(§2.4 参照)。

---

## 9. スコープ外(将来検討)

- OAuth 2.1 / Dynamic Client Registration
- 複数トークン管理(PAT テーブル + 発行 UI + ローテーション自動化)
- MCP Resources(現状は Tools と、§6 の Prompts 1 種のみ)
- Rate limit

# TsumiWiki MCP セットアップガイド

TsumiWiki を Remote MCP サーバーとして起動し、Claude Desktop / Claude Code などの MCP 対応クライアントからノートを検索・閲覧・作成・更新・削除する手順。

**対象読者**: 自分専用の TsumiWiki を自宅サーバーで運用し、外部の MCP クライアントから利用したい人。

**想定構成**: 単一ユーザー + Bearer 静的トークン。複数ユーザー配布や OAuth は対象外(必要になれば別途拡張)。

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

### 2.3 起動確認

サーバー起動後、認証無しで叩いて 401 が返ることを確認:

```bash
curl -i -X POST http://localhost:3000/mcp
# HTTP/1.1 401 Unauthorized
# WWW-Authenticate: Bearer realm="tsumiwiki-mcp"
```

正しいトークンで `tools/list` を叩き、11 個のツールが返ることを確認:

```bash
export MCP_TOKEN=<設定したトークン>
curl -sS -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

**Accept ヘッダに `application/json, text/event-stream` の両方**を含めること(MCP SDK の要件)。

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

---

## 5. 公開ツール一覧

Read 6 種 + Write 5 種の計 11 個。全て `docService` / `queryService` 経由で動作するため、UI 経由の書き込みと同じくパス検証・Git コミット・SQLite 索引更新を経由する。

### Read

| ツール | 引数 | 用途 |
|---|---|---|
| `search_notes` | `query: string`, `limit?: number (1-200, 既定 50)` | 全文検索。ヒット箇所のスニペット付き |
| `read_note` | `path: string` | 本文 + フロントマター + タグ + `updatedAt` を取得 |
| `list_recent` | `limit?: number (1-200, 既定 20)` | 最近更新されたノート一覧 |
| `list_tags` | (なし) | 全タグと件数 |
| `get_docs_by_tags` | `tags: string[] (非空)` | 指定タグを **全て** 持つノート(AND) |
| `get_tree` | (なし) | フォルダツリー + 全ノートのサマリ |

### Write

| ツール | 引数 | 用途 |
|---|---|---|
| `create_note` | `path: string`, `content: string` | 新規作成。既存パスならエラー(`.md` 必須) |
| `save_note` | `path: string`, `body: string`, `baseUpdatedAt: string`, `tags?: string[]` | 更新。`baseUpdatedAt` は `read_note` で得た値を渡す(競合検知) |
| `move_note` | `path: string`, `newFolder: string`, `newTitle: string` | リネーム / 移動 |
| `delete_note` | `path: string` | `.trash/` へ送る(完全削除ではない) |
| `create_daily_note` | (なし) | ライブラリ設定 `dailyNotes.folder` / `template` / `filenamePattern` に基づき今日の Daily Note を生成 or 既存を返す |

パスは常に **リポジトリルート相対の POSIX 形式**(`Projects/foo.md` など)。`..` / `.git/*` / `.trash/*` / 非 `.md` 拡張子は全て拒否される。

---

## 6. 運用上の注意

### Bearer トークン管理

- サーバーの env に平文で置くしかない(単一固定トークン設計)。`.env` ファイルの権限を絞る、systemd unit なら `EnvironmentFile` を root:root 600 で置く等
- ローテーションは **env 差し替え + サーバー再起動**。頻度が高いなら PAT テーブル方式への拡張を検討
- **Authorization ヘッダはサーバーログで常にマスクされる**(pino redact 設定済み)

### 編集ロック整合

- UI 側で誰かがノートを編集ロック中の場合、MCP からの `save_note` / `delete_note` / `move_note` は **エラーで拒否される**(UI 側の作業を壊さない安全策)
- 逆に MCP からの書き込みは編集ロックを取らないため、MCP 経由での連続更新中に UI 側が同じノートを開いても衝突検知(`baseUpdatedAt`)で守られる

### コミット author

MCP 経由の書き込みは Git コミット author が固定で `MCP Agent <mcp@tsumiwiki.local>` になる。UI 経由の変更(ログインユーザー名)と混在するので、`git log` で誰がいつどこから触ったか追跡できる。

---

## 7. トラブルシューティング

### 401 が返る

- `Authorization: Bearer <token>` ヘッダが付いているか(`bearer` 小文字・複数スペースも許容)
- トークンが env の `MCP_TOKEN` と完全一致しているか(前後の空白・改行に注意)
- サーバーログに `MCP リクエスト処理に失敗しました` が出ていないか

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

---

## 8. スコープ外(将来検討)

- OAuth 2.1 / Dynamic Client Registration
- 複数トークン管理(PAT テーブル + 発行 UI + ローテーション自動化)
- MCP Resources / Prompts(現状は Tools のみ)
- Rate limit
- バックリンク API(index 側の対応が必要)

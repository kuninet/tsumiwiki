# Windows PC への導入手順

TsumiWikiをWindows PCで本番運用するための手順(設計01章1.4)。

## 1. 前提ソフトウェア

| ソフトウェア | バージョン | 備考 |
|---|---|---|
| Node.js | 20.19以上(22系推奨。Dockerイメージは22) | https://nodejs.org/ |
| Git for Windows | 2.30以上 | https://gitforwindows.org/ 。履歴管理・バックアップに必須 |

インストール後、PowerShellで確認:

```powershell
node --version
git --version
corepack enable   # pnpmを有効化(初回のみ。管理者権限が必要な場合あり)
```

## 2. アプリケーションの配置とビルド

```powershell
git clone https://github.com/kuninet/tsumiwiki.git C:\tsumiwiki
cd C:\tsumiwiki
pnpm install
pnpm build        # クライアントをビルド(サーバーが静的配信する)
```

## 3. 環境変数の設定

システム環境変数またはサービス定義で設定する:

| 変数 | 例 | 説明 |
|---|---|---|
| `LIBRARY_PATH` | `C:\tsumiwiki-library` | 文書ライブラリ(必須)。既存Obsidianヴォルトのコピーでも可 |
| `DB_PATH` | `C:\tsumiwiki-data\app.db` | アプリDB(省略時はライブラリの隣の `tsumiwiki-data\app.db`) |
| `PORT` | `3000` | 待ち受けポート |
| `BACKUP_REMOTE` | `\\fileserver\share\tsumiwiki.git` | バックアップ先bareリポジトリ(4章参照。省略可) |
| `BACKUP_PUSH_INTERVAL_MINUTES` | `10` | push間隔 |
| `LOG_FILE` | `C:\tsumiwiki-data\app.log` | ログ出力先(省略時は標準出力) |

## 4. バックアップ先bareリポジトリの作成(推奨)

ファイルサーバー上に作成する(NFR-AVL-02):

```powershell
# ファイルサーバー側(またはUNCパス経由)で1回だけ実行
git init --bare \\fileserver\share\tsumiwiki.git
```

`BACKUP_REMOTE` を設定して起動すると、定期的に(既定10分)自動pushされる。push状態は `GET /api/library/status`(要ログイン)で確認できる。

## 5. 初期管理者の作成と動作確認

```powershell
cd C:\tsumiwiki
$env:LIBRARY_PATH="C:\tsumiwiki-library"
# DB_PATHを既定から変える場合は、ここでも同じ値を設定すること
# (異なるDBに管理者が作られるとログインできない)
pnpm --filter @tsumiwiki/server create-admin -- --username admin --display-name 管理者
# パスワードは対話入力

# 手動起動して確認
pnpm --filter @tsumiwiki/server start
# ブラウザで http://localhost:3000 → ログインできればOK
```

## 6. Windowsサービス化(NSSM)

常時稼働にはNSSM(https://nssm.cc/)でサービス登録する:

```powershell
# --import tsx で単一プロセス起動にする(tsx CLI経由の二段プロセスだと
# サービス停止時のシグナルが実サーバーへ届かず、最終pushが実行されないため)
nssm install TsumiWiki "C:\Program Files\nodejs\node.exe"
nssm set TsumiWiki AppParameters "--import tsx C:\tsumiwiki\packages\server\src\index.ts"
nssm set TsumiWiki AppDirectory "C:\tsumiwiki\packages\server"
nssm set TsumiWiki AppEnvironmentExtra LIBRARY_PATH=C:\tsumiwiki-library DB_PATH=C:\tsumiwiki-data\app.db PORT=3000 BACKUP_REMOTE=\\fileserver\share\tsumiwiki.git LOG_FILE=C:\tsumiwiki-data\app.log
nssm set TsumiWiki AppStopMethodSkip 0
nssm set TsumiWiki AppStopMethodConsole 15000
nssm start TsumiWiki
```

停止時は最終sync・バックアップpush・WALチェックポイントが実行される
(実際に発火することを9章のチェックリストで必ず確認すること)。

## 7. 復旧手順(設計06章6.6)

- **ライブラリ喪失時**: `git clone \\fileserver\share\tsumiwiki.git C:\tsumiwiki-library` → サービス起動(自動リインデックス)
- **DB喪失時**: サービス起動(スキーマ自動作成)→ `create-admin` → ユーザー再登録 → `pnpm --filter @tsumiwiki/server reindex`

## 8. Docker運用(代替)

Docker Desktopがある環境ではコンテナでも運用できる:

```powershell
docker build -t tsumiwiki .
docker run -d --name tsumiwiki -p 3000:3000 `
  -v C:\tsumiwiki-library:/library -v C:\tsumiwiki-data:/data tsumiwiki
```

## 9. Windows実機検証チェックリスト

初回導入時に以下を確認する(issue #12・#16):

- [ ] 日本語ファイル名の文書作成・編集・履歴表示(#16)
- [ ] UNCパスのbareリポジトリへのバックアップpush成功(`/api/library/status`)(#16)
- [ ] サーバーテスト一式のパス: `pnpm --filter @tsumiwiki/server test`(#16)
- [ ] MS-IMEでの編集(変換確定・ショートカット・`[[`補完)— issue #6のチェックリストA〜D(#12)
- [ ] サービス再起動後のロック・インデックス整合
- [ ] **サービス停止時に最終バックアップpushが実行される**(停止→bareリポジトリのログに直前の変更が含まれること)(#16)

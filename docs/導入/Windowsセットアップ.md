# Windows PC への導入手順

TsumiWikiをWindows PCで本番運用するための手順(設計01章1.4)。

## 1. 前提ソフトウェア

| ソフトウェア | バージョン | 備考 |
|---|---|---|
| Node.js | 20.19以上(22系推奨。Dockerイメージは22) | https://nodejs.org/ |
| Git for Windows | 2.30以上 | https://gitforwindows.org/ 。履歴管理・バックアップに必須 |
| pnpm | 10系(package.jsonでpin) | corepackで有効化。11系はNode 22必須で非採用 |
| NSSM | 2.24以上 | https://nssm.cc/ 。Windowsサービス化(6章) |

インストール後、PowerShellで確認:

```powershell
node --version
git --version
corepack enable                     # pnpmを有効化(初回のみ。管理者権限が必要な場合あり)
```

pnpmのバージョンはリポジトリ内で確認する(package.jsonの `packageManager` フィールドで
10.34.3 に pin してあり、Corepackが自動でこのバージョンを使う):

```powershell
cd C:\tsumiwiki                     # 2章でcloneした後
pnpm --version                      # 10.34.3 が返ればOK
```

補足: リポジトリ外で `pnpm --version` を叩くと、Corepack最新の pnpm 11 系が
ダウンロードされる場合があるが、これはリポジトリ外で使う分には無害。TsumiWiki の
ビルド・実行はリポジトリ内で行うので、必ず 10.34.3 が使われる。

Git for Windowsは既定インストールで問題ないが、以下の点だけ確認する:

- **PATH に `git.exe` が入っていること**(コマンドプロンプト・PowerShellから `git --version` が通ること)。サービス化した後もNSSMがgitを起動するため、システム環境変数のPATHに必要
- 改行変換設定: `git config --global core.autocrlf false` を推奨(NFR-COMP-03。LF固定運用のため)

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
| `PORT` | `3080` | 待ち受けポート(省略時は `3000`。他のNode系サービスと衝突しないよう変更を推奨) |
| `HOST` | `0.0.0.0` | 待ち受けアドレス(省略時 `0.0.0.0` = 全インタフェース。社内LANの他PCから http://<サーバIP>:PORT でアクセス可)。ローカルからのみ受け付けたい場合は `127.0.0.1` |
| `BACKUP_REMOTE` | `\\fileserver\share\tsumiwiki.git` | バックアップ先bareリポジトリ(4章参照。省略可) |
| `BACKUP_PUSH_INTERVAL_MINUTES` | `10` | push間隔 |
| `LOG_FILE` | `C:\tsumiwiki-data\app.log` | ログ出力先(省略時は標準出力) |

### 3.1 ポート選択のヒント

3000番は多くのNode.js製ツールが既定で使うため、他システムと衝突しやすい。以下から選ぶと安全:

- `3080` `3800` `4080` — 覚えやすく衝突しにくい
- `8080` `8081` — 一般的な代替HTTPポート(社内Webシステムで衝突がなければ)

**避けるべきポート**: 3000(create-react-app / Node標準)、5173(Vite)、8000(python/Django系)、80/443(IIS等の管理下)、1024未満(要管理者権限)。

現在Windowsで使われているポートを確認するには:

```powershell
netstat -ano | Select-String "LISTENING"
```

## 4. バックアップ先bareリポジトリの作成(推奨)

ファイルサーバー上に作成する(NFR-AVL-02):

```powershell
# ファイルサーバー側(またはUNCパス経由)で1回だけ実行
git init --bare \\fileserver\share\tsumiwiki.git
```

`BACKUP_REMOTE` を設定して起動すると、定期的に(既定10分)自動pushされる。push状態は `GET /api/library/status`(要ログイン)で確認できる。

### 4.1 UNCパス認証(必要な場合)

ファイルサーバーがドメイン認証を要求する場合、Windowsサービスから見えるように**サービス実行ユーザーの資格情報**で覚えさせる:

```powershell
# サービス実行ユーザーに切り替えたコンテキストで実行するのが確実
# (対話的セッションで登録した資格情報はサービスから参照できない)
cmdkey /add:fileserver /user:DOMAIN\username /pass:PASSWORD
```

以下いずれかの構成が確実:

- サービスの実行ユーザーを、ファイルサーバーの共有への書込権を持つドメインアカウントに変更(NSSMの `Log on` タブ、または `nssm set TsumiWiki ObjectName DOMAIN\username PASSWORD`)
- 匿名アクセス可の共有にする(社内サーバーで運用ポリシー上許容できる場合のみ)

### 4.2 バックアップpushの動作確認

サービス起動後、以下で確認する:

```powershell
# API から実行状態を確認
curl.exe http://localhost:3000/api/library/status -H "cookie: <ログイン後のセッション>"
# → lastPushAt が更新されていて lastError が null であること

# bareリポジトリ側でログ確認
git --git-dir=\\fileserver\share\tsumiwiki.git log --oneline -5
```

## 5. 初期管理者の作成と動作確認

```powershell
cd C:\tsumiwiki
$env:LIBRARY_PATH="C:\tsumiwiki-library"
# DB_PATHを既定から変える場合は、ここでも同じ値を設定すること
# (異なるDBに管理者が作られるとログインできない)
pnpm --filter @tsumiwiki/server create-admin -- --username admin --display-name 管理者
# パスワードは対話入力
```

サーバーの手動起動には `scripts\windows\start.bat`(または `start.ps1`)を使う。
中で `set` / `$env:` によって環境変数をスクリプト内スコープでのみ設定するため、
親シェルや他アプリケーションと衝突しない。

雛形をそのまま編集すると `git pull` のたびに衝突するので、まず自分専用のコピーを
作る(コピー名は `start-local.bat` / `start-local.ps1` で、これらは `.gitignore`
で追跡対象外にしてある):

```powershell
copy scripts\windows\start.bat scripts\windows\start-local.bat
notepad scripts\windows\start-local.bat   # 自環境に合わせて編集

# 以降の起動はこちらを使う
.\scripts\windows\start-local.bat

# PowerShell版も同様
Copy-Item scripts\windows\start.ps1 scripts\windows\start-local.ps1
.\scripts\windows\start-local.ps1
```

書き換えた start-local.bat はサービス化(6章)の環境変数構成の元ネタにもなる。

ブラウザで `http://localhost:<PORT>` にアクセスしてログインできればOK。

## 6. Windowsサービス化(NSSM)

常時稼働にはNSSM(https://nssm.cc/)でサービス登録する。NSSMの `AppEnvironmentExtra`
はサービスプロセスにのみ適用される環境変数で、システム環境や他アプリケーションに
一切漏れない。設定内容は 5章 の start.bat と合わせる。

### 6.1 NSSMの入手と配置

- https://nssm.cc/download から nssm-2.24.zip をダウンロード
- 展開して `win64\nssm.exe` を `C:\Windows\System32\` へ配置(または `C:\tsumiwiki\bin\` などPATHの通ったフォルダへ)

### 6.2 サービス登録

管理者権限のPowerShellで:

```powershell
# --import tsx で単一プロセス起動にする(tsx CLI経由の二段プロセスだと
# サービス停止時のシグナルが実サーバーへ届かず、最終pushが実行されないため)
nssm install TsumiWiki "C:\Program Files\nodejs\node.exe"
nssm set TsumiWiki AppParameters "--import tsx C:\tsumiwiki\packages\server\src\index.ts"
nssm set TsumiWiki AppDirectory "C:\tsumiwiki\packages\server"
nssm set TsumiWiki AppEnvironmentExtra LIBRARY_PATH=C:\tsumiwiki-library DB_PATH=C:\tsumiwiki-data\app.db PORT=3080 BACKUP_REMOTE=\\fileserver\share\tsumiwiki.git LOG_FILE=C:\tsumiwiki-data\app.log

# 停止シグナル:  最終sync・バックアップpush・WAL checkpoint 完了を待つため猶予15秒
nssm set TsumiWiki AppStopMethodSkip 0
nssm set TsumiWiki AppStopMethodConsole 15000

# ログの標準出力/標準エラーはNSSMのローテートに乗せる(LOG_FILEは追加の詳細ログ)
nssm set TsumiWiki AppStdout C:\tsumiwiki-data\service-stdout.log
nssm set TsumiWiki AppStderr C:\tsumiwiki-data\service-stderr.log
nssm set TsumiWiki AppRotateFiles 1
nssm set TsumiWiki AppRotateBytes 10485760   # 10MB でローテート

# 障害復帰: プロセスが落ちたら10秒後に自動再起動
nssm set TsumiWiki AppExit Default Restart
nssm set TsumiWiki AppRestartDelay 10000

nssm start TsumiWiki
nssm status TsumiWiki                         # SERVICE_RUNNING と表示されればOK
```

停止時は最終sync・バックアップpush・WALチェックポイントが実行される
(実際に発火することを9章のチェックリストで必ず確認すること)。

### 6.3 Windows Firewallの設定

社内LANからアクセスさせる場合、受信規則を追加(`LocalPort` は 3章で決めた PORT と合わせる):

```powershell
New-NetFirewallRule -DisplayName "TsumiWiki" -Direction Inbound -Protocol TCP -LocalPort 3080 -Action Allow -Profile Domain,Private
```

社外(パブリックプロファイル)からのアクセスは開けないこと。TsumiWikiは想定利用者数〜20名の社内向け設計(要件01章1.4)であり、CSRF・XSS対策は施しているものの外部公開の脅威モデルには合わせていない。

他PCからは以下でアクセスできる(HOSTの既定は `0.0.0.0` なので追加設定は不要):

```
http://<サーバのIPアドレスまたはホスト名>:3080
```

サーバの IP は `ipconfig` の IPv4 で確認する。DNSに登録してホスト名で引けるようにすると運用が楽。

### 6.4 起動時の自動開始とサービスユーザー

- 既定でNSSMのStart typeは Automatic(自動)。サーバー再起動後にも起動する
- 4.1 で UNC 認証をサービスユーザーで通したい場合は、Log Onを LocalSystem から専用アカウントに変更:

```powershell
nssm set TsumiWiki ObjectName DOMAIN\tsumiwiki-svc "パスワード"
```

そのアカウントには `C:\tsumiwiki` 配下および `LIBRARY_PATH`/`DB_PATH`/`LOG_FILE` への読み書き権限が必要。

## 7. 復旧手順(設計06章6.6)

- **ライブラリ喪失時**: `git clone \\fileserver\share\tsumiwiki.git C:\tsumiwiki-library` → サービス起動(自動リインデックス)
- **DB喪失時**: サービス起動(スキーマ自動作成)→ `create-admin` → ユーザー再登録 → `pnpm --filter @tsumiwiki/server reindex`

## 8. Docker運用(代替)

Docker Desktopがある環境ではコンテナでも運用できる:

```powershell
docker build -t tsumiwiki .
# ホスト側 3080 → コンテナ内 3000 に転送(コンテナ内のPORTは既定3000で問題ない)
docker run -d --name tsumiwiki -p 3080:3000 `
  -v C:\tsumiwiki-library:/library -v C:\tsumiwiki-data:/data tsumiwiki
```

## 9. Windows実機検証チェックリスト

初回導入時に以下を確認する(issue #16。IME関連はフェーズ1テストで確認済み):

- [ ] 日本語ファイル名の文書作成・編集・履歴表示
- [ ] UNCパスのbareリポジトリへのバックアップpush成功(`/api/library/status` の `lastPushAt` 更新・`lastError` null)
- [ ] Git for Windowsで `git log`・`git diff` の履歴取得が動作する
- [ ] サーバーテスト一式のパス: `pnpm --filter @tsumiwiki/server test`
- [ ] Windowsサービスの自動起動: 再起動 → ログイン画面が開く
- [ ] サービス再起動後のロック・インデックス整合(誰かのロックが残らない・DB整合が取れている)
- [ ] **サービス停止時に最終バックアップpushが実行される**(停止→bareリポジトリのログに直前の変更が含まれること)
- [ ] サービスが異常終了した場合の自動再起動(`AppExit Default Restart`の動作)
- [ ] Firewall越しに他PCから http://<サーバIP>:<PORT> でアクセスできる(社内LAN限定)

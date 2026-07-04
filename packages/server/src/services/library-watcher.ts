import chokidar, { type FSWatcher } from 'chokidar';

// ライブラリのファイルシステム監視(FR-DOC-08 / 設計06章6.4)
// 変更イベントをデバウンスしてまとめ、SyncServiceの実行を促す。
// 注意: ネットワークドライブ等では監視イベントが届かないことがあるため、
// 定期ポーリング・手動rescanが保険になる(多重防御)

// .git / .obsidian 等の設定系ドットフォルダは監視対象外
// (.trashはWiki操作でも変わるため対象に含め、syncのhasExternalChangesで吸収する)
const IGNORED_RE = /(^|[/\\])\.(git|obsidian)([/\\]|$)/;

export class LibraryWatcher {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly libraryPath: string,
    private readonly onChange: () => void,
    private readonly debounceMs = 3000,
  ) {}

  start(): void {
    this.watcher = chokidar.watch(this.libraryPath, {
      ignored: IGNORED_RE,
      ignoreInitial: true,
      // 書き込み途中のファイルを拾わないよう安定を待つ
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    });
    this.watcher.on('all', () => this.schedule());
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onChange();
    }, this.debounceMs);
    // プロセス終了を妨げない
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    await this.watcher?.close();
    this.watcher = null;
  }
}

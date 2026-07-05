import chokidar, { type FSWatcher } from 'chokidar';

// ライブラリのファイルシステム監視(FR-DOC-08 / 設計06章6.4)
// 変更イベントをデバウンスしてまとめ、SyncServiceの実行を促す。
// 注意: ネットワークドライブ等では監視イベントが届かないことがあるため、
// 定期ポーリング・手動rescanが保険になる(多重防御)

// .git / .obsidian 等の設定系ドットフォルダは監視対象外
// (.trashはWiki操作でも変わるため対象に含め、syncのhasExternalChangesで吸収する)
const IGNORED_RE = /(^|[/\\])(\.(git|obsidian|tsumiwiki)([/\\]|$)|\.tsumiwiki-tmp-)/;

export class LibraryWatcher {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private firstEventAt: number | null = null;

  constructor(
    private readonly libraryPath: string,
    private readonly onChange: () => void,
    private readonly debounceMs = 3000,
    // イベントが途切れない大量一括変更でも、この時間で必ず一度発火する
    private readonly maxWaitMs = 15_000,
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
    const now = Date.now();
    this.firstEventAt ??= now;
    if (this.timer) clearTimeout(this.timer);
    const elapsed = now - this.firstEventAt;
    if (elapsed >= this.maxWaitMs) {
      this.fire();
      return;
    }
    this.timer = setTimeout(
      () => this.fire(),
      Math.min(this.debounceMs, this.maxWaitMs - elapsed),
    );
    // プロセス終了を妨げない
    this.timer.unref?.();
  }

  private fire(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.firstEventAt = null;
    this.onChange();
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    await this.watcher?.close();
    this.watcher = null;
  }
}

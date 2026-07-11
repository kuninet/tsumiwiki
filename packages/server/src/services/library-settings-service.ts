import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  LIBRARY_SETTINGS_DEFAULTS,
  librarySettingsSchema,
  type LibrarySettings,
} from '@tsumiwiki/shared';
import type { GitAuthor, GitService } from './git-service.js';

// #84 Phase 1: ライブラリ設定(テンプレ・デイリーノート等)の読み書き。
// 保存場所は .tsumiwiki/settings.yaml。git 追跡対象なのでバックアップ push にも乗る。
// library-watcher.ts は .tsumiwiki/ を無視するので sync ジョブに巻き込まれない。

const SETTINGS_REL_PATH = '.tsumiwiki/settings.yaml';

export interface LibrarySettingsResult {
  settings: LibrarySettings;
  // #99: yaml のパース/バリデーションに失敗した状態でデフォルト値にフォールバックしたか。
  //      true の場合、この settings をそのまま保存すると git 上の正しい過去版を上書きしてしまう。
  corrupted: boolean;
}

export class LibrarySettingsService {
  constructor(
    private readonly libraryPath: string,
    private readonly git: GitService,
    private readonly logger?: Logger,
  ) {}

  private absPath(): string {
    return path.join(this.libraryPath, SETTINGS_REL_PATH);
  }

  // 読み取り: ファイル不在は初期セットアップ扱い(corrupted: false)でデフォルト値を返す。
  //           パース失敗・バリデーション失敗は「壊れた設定」として warn ログを出しつつ
  //           corrupted: true とデフォルト値を返す(#99: サイレントに握って上書き事故を招かないため)。
  async get(): Promise<LibrarySettingsResult> {
    let raw: string;
    try {
      raw = await readFile(this.absPath(), 'utf8');
    } catch {
      return { settings: LIBRARY_SETTINGS_DEFAULTS, corrupted: false };
    }

    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch (e) {
      this.logger?.warn(
        { err: e, path: this.absPath() },
        'ライブラリ設定(settings.yaml)のパースに失敗しました。デフォルト値にフォールバックします',
      );
      return { settings: LIBRARY_SETTINGS_DEFAULTS, corrupted: true };
    }

    const validated = librarySettingsSchema.safeParse(parsed);
    if (!validated.success) {
      this.logger?.warn(
        { issues: validated.error.issues, path: this.absPath() },
        'ライブラリ設定(settings.yaml)のバリデーションに失敗しました。デフォルト値にフォールバックします',
      );
      return { settings: LIBRARY_SETTINGS_DEFAULTS, corrupted: true };
    }

    return { settings: validated.data, corrupted: false };
  }

  // 更新: バリデーション済みの値を yaml として書き、git コミット。
  //       失敗しても保存は完了しているとみなし、commit 失敗はログのみ(呼び出し側でルーティング)
  async update(next: LibrarySettings, author: GitAuthor): Promise<LibrarySettings> {
    // 明示的にキー順を固定して yaml を書く(未来の PR で差分が読みやすい)
    const ordered: LibrarySettings = {
      templates: { folder: next.templates.folder },
      dailyNotes: {
        folder: next.dailyNotes.folder,
        template: next.dailyNotes.template,
        filenamePattern: next.dailyNotes.filenamePattern,
      },
    };
    const yaml = stringifyYaml(ordered);
    await mkdir(path.dirname(this.absPath()), { recursive: true });
    await writeFile(this.absPath(), yaml, 'utf8');
    await this.git.commit([SETTINGS_REL_PATH], 'config: update library settings', author);
    return ordered;
  }
}

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
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

export class LibrarySettingsService {
  constructor(
    private readonly libraryPath: string,
    private readonly git: GitService,
  ) {}

  private absPath(): string {
    return path.join(this.libraryPath, SETTINGS_REL_PATH);
  }

  // 読み取り: ファイル不在・パース失敗はサイレントにデフォルト値を返す
  //           (初期セットアップ直後や壊れた設定でも UI が読めるようにする)
  async get(): Promise<LibrarySettings> {
    let raw: string;
    try {
      raw = await readFile(this.absPath(), 'utf8');
    } catch {
      return LIBRARY_SETTINGS_DEFAULTS;
    }
    try {
      const parsed = parseYaml(raw);
      const validated = librarySettingsSchema.safeParse(parsed);
      if (validated.success) return validated.data;
    } catch {
      // parse error → fall through to defaults
    }
    return LIBRARY_SETTINGS_DEFAULTS;
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

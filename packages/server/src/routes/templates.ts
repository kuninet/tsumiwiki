import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyPluginCallback } from 'fastify';
import { parseDocument as parseYamlDocument } from 'yaml';
import {
  applyTemplateRequestSchema,
  expandTemplateRequestSchema,
  expandTemplateVariables,
  type TemplateSummary,
} from '@tsumiwiki/shared';
import {
  InvalidPathError,
  isProtectedPath,
  normalizeRelPath,
  resolveInLibrary,
} from '../lib/paths.js';
import { sendError } from '../plugins/auth.js';
import { DocNotFoundError, sanitizeTitle } from '../services/doc-service.js';
import { authorOf, handling } from './docs.js';

// #84 Phase B/C: テンプレート機能。
// - GET  /api/templates       : `settings.templates.folder` 配下の `.md` を再帰列挙する
// - POST /api/templates/apply : 選択したテンプレの変数を展開し、新規文書として作成する(Phase B)
// - POST /api/templates/expand: 選択したテンプレの変数を展開して Markdown を返す(Phase C。
//                               既存文書への挿入/追記用。新規文書は作らない)
//
// テンプレのフロントマターには以下のメタキーを置ける(いずれも任意):
//   target_folder: 新規作成先フォルダ(client から `targetFolder` で上書き可能)
//   description  : 選択UIでの補助説明
// これらは「テンプレ自体のメタ情報」なので、作成される文書のフロントマターには残さない。
// なお frontmatter の再結合は「外科的編集」= yaml.Document API 経由で
// キー順・コメント・スタイルを保全する(FR-OBS-07。DocService.composeContent と同方針)。

// テンプレフロントマターに残す keys の並び順を安定させ、コメントも保全するため、
// gray-matter で分離せずに正規表現で frontmatter ブロックだけ切り出す。
const FM_BLOCK_RE = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
// テンプレ 1 件あたりの上限。frontmatter だけを読みたいが Node の fs API では
// 途中で切るのが面倒なので、まず stat で大きすぎるファイルは列挙から外す
const MAX_TEMPLATE_BYTES = 1024 * 1024; // 1 MiB

// UTF-8 BOM を除去する(Windows のエディタで作られた md の互換性のため)
function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

// Windows 予約デバイス名(サーバー実装の他所と揃える。folder パスにも適用したい)
const WINDOWS_RESERVED_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

function hasWindowsReservedSegment(relPath: string): boolean {
  return relPath.split('/').some((seg) => WINDOWS_RESERVED_RE.test(seg));
}

// テンプレ本文からテンプレ専用メタキー(target_folder / description)だけを外科的に落として
// 再結合する。yaml Document API で他キー・コメント・スタイル・キー順は原文のまま保持する
function stripTemplateMeta(raw: string): { body: string; targetFolder?: string } {
  const fmMatch = FM_BLOCK_RE.exec(raw);
  if (!fmMatch) {
    return { body: raw };
  }
  const doc = parseYamlDocument(fmMatch[1]);
  if (doc.errors.length > 0) {
    // 壊れた frontmatter には触らず、そのまま本文として扱う
    return { body: raw };
  }
  const targetFolderNode = doc.get('target_folder');
  const targetFolder = typeof targetFolderNode === 'string' ? targetFolderNode : undefined;
  doc.delete('target_folder');
  doc.delete('description');

  // items が空になったら frontmatter ブロック自体を落とす(空 `---\n---\n` を書かない)
  const items = (doc.contents as { items?: unknown[] } | null)?.items;
  const remainingBody = raw.slice(fmMatch[0].length);
  if (!items || items.length === 0) {
    return { body: remainingBody.replace(/^\r?\n/, ''), targetFolder };
  }
  return { body: `---\n${doc.toString()}---\n${remainingBody}`, targetFolder };
}

async function listTemplatesUnder(
  libAbs: string,
  folderRel: string,
): Promise<TemplateSummary[]> {
  // 中#6: templates.folder が空 = テンプレ機能未セットアップとみなして空を返す
  // (ルートから全 md を走査してテンプレ非管理の文書を混入させないため)
  if (!folderRel || folderRel.trim() === '') return [];

  let rootAbs: string;
  let rootRel: string;
  try {
    rootRel = normalizeRelPath(folderRel);
    if (!rootRel) return [];
    rootAbs = resolveInLibrary(libAbs, rootRel);
  } catch {
    // 設定値が不正な場合(通常は Zod で弾かれるが二重の防御)は空配列
    return [];
  }

  // frontmatter を parse するために各ファイルの先頭を読む。
  // 中#8: 直列で await していると多ファイル時に遅い + サイズ制限も無かったので
  // Promise.all で並列化 + stat.size で MAX_TEMPLATE_BYTES を超えるファイルは除外する
  interface Candidate {
    rel: string;
    abs: string;
    name: string;
  }
  const candidates: Candidate[] = [];

  async function collect(dirAbs: string, dirRel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (ent) => {
        const name = ent.name.normalize('NFC');
        const rel = dirRel ? `${dirRel}/${name}` : name;
        // 保護パス(.git 等)と .trash はドット始まりで一律除外
        if (rel.split('/').some((seg) => seg.startsWith('.'))) return;
        if (ent.isDirectory()) {
          await collect(path.join(dirAbs, ent.name), rel);
        } else if (ent.isFile() && name.toLowerCase().endsWith('.md')) {
          candidates.push({ rel, abs: path.join(dirAbs, ent.name), name });
        }
      }),
    );
  }
  await collect(rootAbs, rootRel);

  const summaries = await Promise.all(
    candidates.map(async ({ rel, abs, name }): Promise<TemplateSummary | null> => {
      try {
        const st = await stat(abs);
        if (st.size > MAX_TEMPLATE_BYTES) return null;
        const raw = stripBom(await readFile(abs, 'utf8'));
        // 一覧では frontmatter の値だけ欲しいので yaml Document で軽く読む
        const fmMatch = FM_BLOCK_RE.exec(raw);
        let targetFolder: string | null = null;
        let description: string | undefined;
        if (fmMatch) {
          const doc = parseYamlDocument(fmMatch[1]);
          if (doc.errors.length === 0) {
            const tf = doc.get('target_folder');
            if (typeof tf === 'string' && tf.trim() !== '') targetFolder = tf;
            const d = doc.get('description');
            if (typeof d === 'string' && d.trim() !== '') description = d;
          }
        }
        return {
          path: rel,
          name: name.replace(/\.md$/i, ''),
          targetFolder,
          description,
        };
      } catch {
        return null;
      }
    }),
  );

  return summaries
    .filter((s): s is TemplateSummary => s !== null)
    .sort((a, b) => a.path.localeCompare(b.path));
}

// テンプレファイルの正規化+読み取り。BOM 剥がしと基本パス検証まで面倒を見る。
// 見つからない/壊れた場合は DocNotFoundError / InvalidPathError を投げるので、
// 呼び出し側は handling() でそのまま 404/400 に変換できる。
async function readTemplate(
  libAbs: string,
  templatePath: string,
  templatesFolder: string,
): Promise<{ raw: string; norm: string }> {
  const norm = normalizeRelPath(templatePath);
  if (!norm || isProtectedPath(norm) || !norm.toLowerCase().endsWith('.md')) {
    throw new InvalidPathError(templatePath);
  }
  // 中#8: `settings.templates.folder` 配下限定にする。任意 md をテンプレとして
  // 扱うと通常文書に偶然含まれる `{{title}}` 等が黙って展開される事故につながる。
  // templates.folder が空文字("テンプレ機能無効")のときは全パスを拒否する
  const rootNorm = templatesFolder ? normalizeRelPath(templatesFolder) : '';
  if (!rootNorm) {
    throw new InvalidPathError(templatePath);
  }
  if (norm !== rootNorm && !norm.startsWith(rootNorm + '/')) {
    throw new InvalidPathError(templatePath);
  }
  const abs = resolveInLibrary(libAbs, norm);
  let raw: string;
  try {
    raw = stripBom(await readFile(abs, 'utf8'));
  } catch {
    throw new DocNotFoundError(norm);
  }
  return { raw, norm };
}

export const templatesRoutes: FastifyPluginCallback = (app, _opts, done) => {
  app.get('/api/templates', async (req, reply) => {
    if (!req.user) return sendError(reply, 401, 'UNAUTHORIZED', '認証が必要です');
    const settings = await app.librarySettingsService.get();
    const templates = await listTemplatesUnder(app.config.libraryPath, settings.templates.folder);
    return { templates };
  });

  app.post('/api/templates/apply', async (req, reply) => {
    if (!req.user) return sendError(reply, 401, 'UNAUTHORIZED', '認証が必要です');
    const parsed = applyTemplateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(
        reply,
        400,
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? '入力内容を確認してください',
      );
    }
    return handling(reply, async () => {
      const { templatePath, title } = parsed.data;
      // 中#5: 空文字の targetFolder は「未指定」と同義として扱う
      // (json 直叩き/次フェーズ再利用でも意外挙動にならないよう server で正規化)
      const overrideFolder =
        parsed.data.targetFolder && parsed.data.targetFolder.trim() !== ''
          ? parsed.data.targetFolder
          : undefined;

      const settings = await app.librarySettingsService.get();
      const { raw } = await readTemplate(
        app.config.libraryPath,
        templatePath,
        settings.templates.folder,
      );

      // 中#3: frontmatter は yaml.Document 経由で外科的に「target_folder / description」だけ落とす。
      //       gray-matter + stringify だとコメント欠落・キー順変更・型変換(01→1 等)が起きる
      const { body: sourceBody, targetFolder: fmTargetFolder } = stripTemplateMeta(raw);

      // 変数展開: {{cursor}} は Phase C のクライアント UI で解釈するまでサーバー側では除去
      const body = expandTemplateVariables(
        sourceBody,
        { date: new Date(), title, user: req.user!.displayName },
        { stripCursor: true },
      );

      // 適用先: body > frontmatter > 空(ライブラリ直下)
      const rawFolder = overrideFolder ?? fmTargetFolder ?? '';
      const folderNorm = rawFolder ? normalizeRelPath(rawFolder) : '';
      // 中#7: Windows 予約名は sanitizeTitle(ファイル名)側ではケアされるが、
      //       フォルダの各セグメントには適用されないので、事前に弾く(500 化防止)
      if (folderNorm && hasWindowsReservedSegment(folderNorm)) {
        throw new InvalidPathError(rawFolder);
      }
      // sanitizeTitle が空文字や不正入力に対して InvalidPathError を投げる
      const safeName = sanitizeTitle(title);
      const relPath = folderNorm ? `${folderNorm}/${safeName}.md` : `${safeName}.md`;

      // createDocWithContent が保護パス・.trash を validateDocPath 経由で拒否する。
      // DocConflictError はテンプレ適用ではエラーとして返す(デイリーノートと違い
      // ユーザーが明示的にタイトルを付けるため、リトライは UI 側の役目)
      const created = await app.docService.createDocWithContent(relPath, body, authorOf(req));
      return reply.code(201).send({ path: created.path });
    });
  });

  // Phase C: 既存文書へ流し込むために、テンプレを展開した Markdown 本文だけを返す。
  // 新規作成しないので target_folder は無関係。frontmatter は「テンプレ設定」であり
  // 適用先の frontmatter を汚すのは望ましくないので、frontmatter ブロック全体を落とす。
  // `{{cursor}}` はマーカーとしてレスポンスに残す(クライアントで split してカーソル位置を決める)。
  app.post('/api/templates/expand', async (req, reply) => {
    if (!req.user) return sendError(reply, 401, 'UNAUTHORIZED', '認証が必要です');
    const parsed = expandTemplateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(
        reply,
        400,
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? '入力内容を確認してください',
      );
    }
    return handling(reply, async () => {
      const { templatePath, title } = parsed.data;
      const settings = await app.librarySettingsService.get();
      const { raw } = await readTemplate(
        app.config.libraryPath,
        templatePath,
        settings.templates.folder,
      );

      // frontmatter ブロック全体を落とす(既存文書に流し込む用途では meta 情報は不要)
      const fmMatch = FM_BLOCK_RE.exec(raw);
      const sourceBody = fmMatch ? raw.slice(fmMatch[0].length).replace(/^\r?\n/, '') : raw;

      // stripCursor: false — マーカーはそのまま残してクライアントの分割に委ねる
      const markdown = expandTemplateVariables(
        sourceBody,
        { date: new Date(), title, user: req.user!.displayName },
        { stripCursor: false },
      );
      return { markdown };
    });
  });

  done();
};

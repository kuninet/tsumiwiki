import path from 'node:path';
import {
  ATTACHMENT_FOLDER_DEFAULT,
  type AttachmentReplacement,
  type LibrarySettings,
  type ReorganizeDocRewrite,
  type ReorganizeLockedWarning,
  type ReorganizeMoveItem,
  type ReorganizePreviewResponse,
  type ReorganizeSkippedItem,
} from '@tsumiwiki/shared';
import {
  EXCLUDED_SCHEME_RE,
  MD_LINK_REWRITE_RE,
  WIKILINK_REWRITE_RE,
  buildByNameIndex,
  folderOfDoc,
  resolveAttachmentFromByName,
  resolveMarkdownRelPath,
  resolveShortestEmbedTargetWith,
  splitFrontmatter,
  splitTargetSuffix,
} from '../lib/attachment-links.js';
import { computeCodeRanges, isWithinCode } from '../lib/code-ranges.js';
import { InvalidPathError } from '../lib/paths.js';

export { resolveMarkdownRelPath };

export interface ReorgInputDoc {
  docPath: string;
  content: string;
  lockedBy: { userId: number; displayName: string } | null;
}

export interface ReorgPlanInput {
  attachmentPaths: string[];
  docs: ReorgInputDoc[];
  settings: LibrarySettings;
  moveSharedToCommonFolder: boolean;
  /** 移動先が移動対象外の既存ファイルと衝突しないか判定する(任意) */
  isOccupiedOnDisk?: (relPath: string) => Promise<boolean>;
}

export interface PlannedDocRewrite extends ReorganizeDocRewrite {
  originalContent: string;
  nextContent: string;
}

export interface AttachmentReorgPlan {
  preview: ReorganizePreviewResponse;
  rewritesWithContent: PlannedDocRewrite[];
}

function normalizeTemplateFolder(folder: string): string {
  return folder
    .normalize('NFC')
    .replaceAll('\\', '/')
    .trim()
    .replace(/^\/+|\/+$/g, '');
}

function isUnderFolder(targetFolder: string, guardFolderLower: string): boolean {
  if (!guardFolderLower) return false;
  const lower = targetFolder.toLowerCase();
  return lower === guardFolderLower || lower.startsWith(`${guardFolderLower}/`);
}

function splitNameExt(fileName: string): { stem: string; ext: string } {
  const ext = path.posix.extname(fileName);
  const stem = ext ? fileName.slice(0, fileName.length - ext.length) : fileName;
  return { stem, ext };
}

async function allocateDestination(
  targetFolder: string,
  fileName: string,
  movingFromLower: ReadonlySet<string>,
  occupiedLower: Set<string>,
  isOccupiedOnDisk?: (relPath: string) => Promise<boolean>,
): Promise<{ toPath: string; renamed: boolean }> {
  const { stem, ext } = splitNameExt(fileName);
  for (let i = 1; ; i++) {
    const candidateName = i === 1 ? fileName : `${stem}-${i}${ext}`;
    const candidateRel = targetFolder ? `${targetFolder}/${candidateName}` : candidateName;
    const candidateLower = candidateRel.toLowerCase();
    if (occupiedLower.has(candidateLower)) continue;
    if (
      isOccupiedOnDisk &&
      !movingFromLower.has(candidateLower) &&
      (await isOccupiedOnDisk(candidateRel))
    ) {
      occupiedLower.add(candidateLower);
      continue;
    }
    occupiedLower.add(candidateLower);
    return { toPath: candidateRel, renamed: i > 1 };
  }
}

function rewriteDocLinks(
  content: string,
  docPath: string,
  movedMap: ReadonlyMap<string, string>,
  resolvePreWikilink: (target: string, fromDoc: string) => string | null,
  resolvePreMarkdown: (pathPart: string, isImageEmbed: boolean, fromDoc: string) => string | null,
  resolvePostWikilink: (target: string, fromDoc: string) => string | null,
): { nextContent: string; replacements: AttachmentReplacement[] } {
  const { prefix, body } = splitFrontmatter(content);
  const docFolder = folderOfDoc(docPath);
  const replacements = new Map<string, string>();

  // 1. Obsidian 埋め込み / wikilink
  const wikilinkRanges = computeCodeRanges(body);
  let working = body.replace(
    WIKILINK_REWRITE_RE,
    (full: string, open: string, rawTarget: string, close: string, offset: number): string => {
      if (isWithinCode(wikilinkRanges, offset + open.length)) return full;
      const { pathPart, suffix } = splitTargetSuffix(rawTarget);
      if (!pathPart || EXCLUDED_SCHEME_RE.test(pathPart)) return full;
      const preResolved = resolvePreWikilink(pathPart, docPath);
      if (!preResolved) return full;
      const movedDest = movedMap.get(preResolved);
      const expectedDest = movedDest ?? preResolved;

      if (movedDest) {
        const oldBase = path.posix.basename(preResolved);
        const newBase = path.posix.basename(expectedDest);
        if (
          !pathPart.includes('/') &&
          oldBase.toLowerCase() === newBase.toLowerCase() &&
          resolvePostWikilink(pathPart, docPath) === expectedDest
        ) {
          return full;
        }
      } else if (resolvePostWikilink(pathPart, docPath) === preResolved) {
        return full;
      }

      const nextTarget = resolveShortestEmbedTargetWith(docPath, expectedDest, resolvePostWikilink);
      if (nextTarget === pathPart) return full;
      replacements.set(pathPart, nextTarget);
      return `${open}${nextTarget}${suffix}${close}`;
    },
  );

  // 2. 標準 Markdown 画像 / リンク (置換後の body で codeRanges を再計算する)
  const mdRanges = computeCodeRanges(working);
  working = working.replace(
    MD_LINK_REWRITE_RE,
    (full: string, open: string, rawTarget: string, close: string, offset: number): string => {
      if (isWithinCode(mdRanges, offset + open.length)) return full;
      const { pathPart, suffix } = splitTargetSuffix(rawTarget);
      if (!pathPart || EXCLUDED_SCHEME_RE.test(pathPart)) return full;
      const isImageEmbed =
        open.startsWith('!') && path.posix.extname(pathPart).toLowerCase() !== '.pdf';
      const preResolved = resolvePreMarkdown(pathPart, isImageEmbed, docPath);
      if (!preResolved) return full;
      const toPath = movedMap.get(preResolved);
      if (!toPath) return full;

      const relFromDoc = path.posix.relative(docFolder || '.', toPath);
      if (relFromDoc === pathPart) return full;
      replacements.set(pathPart, relFromDoc);
      return `${open}${relFromDoc}${suffix}${close}`;
    },
  );

  return {
    nextContent: prefix + working,
    replacements: [...replacements].map(([from, to]) => ({ from, to })),
  };
}

/**
 * ライブラリ設定と現状のインデックス・文書本文から、添付整理の計画(Dry-run / 実行共用)を生成します。
 * ディスク・Git・DB へは一切書き込みを行いません。
 */
export async function planAttachmentReorganization(
  input: ReorgPlanInput,
): Promise<AttachmentReorgPlan> {
  const { attachmentPaths, docs, settings, moveSharedToCommonFolder, isOccupiedOnDisk } = input;
  const mode = settings.attachments.mode;
  const targetFolder = settings.attachments.folder;
  const commonFolder = settings.attachments.folder || ATTACHMENT_FOLDER_DEFAULT;
  const templateFolder = normalizeTemplateFolder(settings.templates.folder);
  const templateFolderLower = templateFolder.toLowerCase();

  if (mode === 'vault-folder' && isUnderFolder(targetFolder, templateFolderLower)) {
    throw new InvalidPathError(
      targetFolder,
      '添付フォルダがテンプレートフォルダと重複しているため整理できません',
    );
  }

  const sortedAttachments = [...attachmentPaths].sort();
  const attSet = new Set(sortedAttachments);
  const attLowerMap = new Map<string, string>();
  for (const rel of sortedAttachments) {
    attLowerMap.set(rel.toLowerCase(), rel);
  }
  const preByName = buildByNameIndex(sortedAttachments);

  const resolvePreWikilink = (target: string, fromDoc: string): string | null =>
    resolveAttachmentFromByName(target, fromDoc, (b) => preByName.get(b) ?? []);

  const resolvePreMarkdown = (
    pathPart: string,
    isImageEmbed: boolean,
    fromDoc: string,
  ): string | null => {
    const docFolder = folderOfDoc(fromDoc);
    const relCand = resolveMarkdownRelPath(docFolder, pathPart);
    if (relCand) {
      if (attSet.has(relCand)) return relCand;
      const ci = attLowerMap.get(relCand.toLowerCase());
      if (ci) return ci;
    }
    if (isImageEmbed) {
      const base = path.posix.basename(relCand ?? pathPart);
      if (base) return resolvePreWikilink(base, fromDoc);
    }
    return null;
  };

  // 全文書 1 パス走査で各添付ファイルの参照元文書を収集
  const refsByAtt = new Map<string, Set<string>>();
  for (const rel of sortedAttachments) {
    refsByAtt.set(rel, new Set<string>());
  }

  const sortedDocs = [...docs].sort((a, b) => a.docPath.localeCompare(b.docPath));
  for (const doc of sortedDocs) {
    const { body } = splitFrontmatter(doc.content);
    const ranges = computeCodeRanges(body);

    for (const m of body.matchAll(WIKILINK_REWRITE_RE)) {
      const offset = (m.index ?? 0) + m[1].length;
      if (isWithinCode(ranges, offset)) continue;
      const { pathPart } = splitTargetSuffix(m[2]);
      if (!pathPart || EXCLUDED_SCHEME_RE.test(pathPart)) continue;
      const resolved = resolvePreWikilink(pathPart, doc.docPath);
      if (resolved) refsByAtt.get(resolved)?.add(doc.docPath);
    }

    for (const m of body.matchAll(MD_LINK_REWRITE_RE)) {
      const offset = (m.index ?? 0) + m[1].length;
      if (isWithinCode(ranges, offset)) continue;
      const { pathPart } = splitTargetSuffix(m[2]);
      if (!pathPart || EXCLUDED_SCHEME_RE.test(pathPart)) continue;
      const isImageEmbed =
        m[1].startsWith('!') && path.posix.extname(pathPart).toLowerCase() !== '.pdf';
      const resolved = resolvePreMarkdown(pathPart, isImageEmbed, doc.docPath);
      if (resolved) refsByAtt.get(resolved)?.add(doc.docPath);
    }
  }

  // 分類: 移動候補 vs スキップ
  interface MoveCandidate {
    fromPath: string;
    destFolder: string;
    referencedBy: string[];
  }
  const moveCandidates: MoveCandidate[] = [];
  const skipped: ReorganizeSkippedItem[] = [];

  for (const rel of sortedAttachments) {
    const dir = path.posix.dirname(rel);
    const currentFolder = dir === '.' ? '' : dir;
    const refs = [...(refsByAtt.get(rel) ?? [])].sort();

    // テンプレートフォルダ配下の添付はモードに関わらず移動対象外として保護する
    if (isUnderFolder(currentFolder, templateFolderLower)) {
      skipped.push({ path: rel, reason: 'template-folder', referencedBy: refs });
      continue;
    }

    if (mode === 'vault-folder') {
      if (currentFolder === targetFolder) {
        skipped.push({ path: rel, reason: 'already-in-place', referencedBy: refs });
      } else {
        moveCandidates.push({ fromPath: rel, destFolder: targetFolder, referencedBy: refs });
      }
      continue;
    }

    // same-folder / doc-subfolder
    if (refs.length === 0) {
      skipped.push({ path: rel, reason: 'unreferenced', referencedBy: [] });
      continue;
    }

    const docFolders = new Set(refs.map((d) => folderOfDoc(d)));
    if (docFolders.size === 1) {
      const ownerFolder = [...docFolders][0];
      // テンプレート文書のみが参照している添付はテンプレート領域を汚さないようスキップする
      if (isUnderFolder(ownerFolder, templateFolderLower)) {
        skipped.push({ path: rel, reason: 'template-folder', referencedBy: refs });
        continue;
      }

      const destFolder =
        mode === 'same-folder'
          ? ownerFolder
          : ownerFolder
            ? `${ownerFolder}/${targetFolder}`
            : targetFolder;

      if (destFolder && isUnderFolder(destFolder, templateFolderLower)) {
        throw new InvalidPathError(
          destFolder,
          '添付フォルダがテンプレートフォルダと重複しているため整理できません',
        );
      }

      if (currentFolder === destFolder) {
        skipped.push({ path: rel, reason: 'already-in-place', referencedBy: refs });
      } else {
        moveCandidates.push({ fromPath: rel, destFolder, referencedBy: refs });
      }
      continue;
    }

    // 複数フォルダ横断で参照されている共有添付
    if (!moveSharedToCommonFolder) {
      skipped.push({ path: rel, reason: 'shared-across-folders', referencedBy: refs });
      continue;
    }

    if (isUnderFolder(commonFolder, templateFolderLower)) {
      throw new InvalidPathError(
        commonFolder,
        '共通フォルダがテンプレートフォルダと重複しているため整理できません',
      );
    }

    if (currentFolder === commonFolder) {
      skipped.push({ path: rel, reason: 'already-in-place', referencedBy: refs });
    } else {
      moveCandidates.push({ fromPath: rel, destFolder: commonFolder, referencedBy: refs });
    }
  }

  // 占有パス集合: スキップされた添付は現位置にとどまる
  const occupiedLower = new Set<string>();
  for (const s of skipped) {
    occupiedLower.add(s.path.toLowerCase());
  }
  const movingFromLower = new Set(moveCandidates.map((c) => c.fromPath.toLowerCase()));

  // 衝突リネームを解決して移動計画を確定
  const moves: ReorganizeMoveItem[] = [];
  const movedMap = new Map<string, string>();
  for (const cand of moveCandidates) {
    const fileName = path.posix.basename(cand.fromPath);
    const { toPath, renamed } = await allocateDestination(
      cand.destFolder,
      fileName,
      movingFromLower,
      occupiedLower,
      isOccupiedOnDisk,
    );
    moves.push({
      fromPath: cand.fromPath,
      toPath,
      renamed,
      referencedBy: cand.referencedBy,
    });
    movedMap.set(cand.fromPath, toPath);
  }

  // 移動後の添付インデックスを構築してリンク書き換え内容を計算
  const postPaths = sortedAttachments.map((rel) => movedMap.get(rel) ?? rel);
  const postByName = buildByNameIndex(postPaths);
  const resolvePostWikilink = (target: string, fromDoc: string): string | null =>
    resolveAttachmentFromByName(target, fromDoc, (b) => postByName.get(b) ?? []);

  const rewrites: ReorganizeDocRewrite[] = [];
  const rewritesWithContent: PlannedDocRewrite[] = [];
  const lockedWarnings: ReorganizeLockedWarning[] = [];

  if (moves.length > 0) {
    for (const doc of sortedDocs) {
      const { nextContent, replacements } = rewriteDocLinks(
        doc.content,
        doc.docPath,
        movedMap,
        resolvePreWikilink,
        resolvePreMarkdown,
        resolvePostWikilink,
      );
      if (nextContent === doc.content || replacements.length === 0) continue;

      const item: ReorganizeDocRewrite = {
        docPath: doc.docPath,
        lockedBy: doc.lockedBy,
        replacements,
      };
      rewrites.push(item);
      rewritesWithContent.push({
        ...item,
        originalContent: doc.content,
        nextContent,
      });
      if (doc.lockedBy) {
        lockedWarnings.push({
          docPath: doc.docPath,
          displayName: doc.lockedBy.displayName,
        });
      }
    }
  }

  let skipAlreadyInPlace = 0;
  let skipShared = 0;
  let skipUnreferenced = 0;
  let skipTemplate = 0;
  for (const s of skipped) {
    if (s.reason === 'already-in-place') skipAlreadyInPlace++;
    else if (s.reason === 'shared-across-folders') skipShared++;
    else if (s.reason === 'template-folder') skipTemplate++;
    else skipUnreferenced++;
  }

  return {
    preview: {
      mode,
      targetFolder,
      commonFolder,
      moves,
      rewrites,
      skipped,
      lockedWarnings,
      summary: {
        totalAttachments: sortedAttachments.length,
        moveCount: moves.length,
        renameCount: moves.filter((m) => m.renamed).length,
        rewriteDocCount: rewrites.length,
        skipAlreadyInPlace,
        skipShared,
        skipUnreferenced,
        skipTemplate,
      },
    },
    rewritesWithContent,
  };
}

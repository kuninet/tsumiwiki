import path from 'node:path';

// パス検証の共通関数(NFR-SEC-04 / NFR-COMP-04 / NFR-OPS-04)。
// APIで受け取る文書パスは必ずここを通す。
// - NFC正規化(macOS由来のNFD対策)
// - 区切りを / に統一(Windowsの \\ を吸収)
// - ライブラリルート外への脱出(..)を拒否

export class InvalidPathError extends Error {
  // 利用者に見せてよい理由(指定時はAPIレスポンスのmessageに使う。未指定なら固定文言)
  readonly userMessage?: string;
  constructor(input: string, userMessage?: string) {
    super(`不正なパスです: ${input}`);
    this.name = 'InvalidPathError';
    this.userMessage = userMessage;
  }
}

// 相対パスを正規化する(NFC・/区切り・空セグメント除去)
export function normalizeRelPath(input: string): string {
  // ヌルバイト・制御文字はfs層に渡る前にここで拒否する
  if (/[\u0000-\u001f\u007f]/.test(input)) {
    throw new InvalidPathError(input);
  }
  const unified = input.normalize('NFC').replaceAll('\\', '/');
  const parts = unified.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) {
    throw new InvalidPathError(input);
  }
  return parts.join('/');
}

// 設定系の保護パス(.git/.obsidian等のドット始まり)か。
// ごみ箱 .trash はアプリが管理するため対象外(FR-OBS-04)。
// 前提: normalizeRelPath 済みの入力を渡すこと(NFC・/区切り)。
// ネストした .trash(a/.trash/x)もごみ箱扱いになる点に注意。
export function isProtectedPath(relPath: string): boolean {
  return relPath
    .split('/')
    .some((p) => p.startsWith('.') && p !== '.trash');
}

// ライブラリルート配下の絶対パスへ解決する。ルート外は拒否。
// 注意: 解決は字句的で、シンボリックリンクは辿らない。ライブラリ内に
// symlinkを置けるのはサーバーのFSに直接アクセスできる者だけであり、
// 信頼境界内とみなす(設計01章1.5)。
export function resolveInLibrary(libraryRoot: string, relPath: string): string {
  const normalized = normalizeRelPath(relPath);
  const rootAbs = path.resolve(libraryRoot);
  const abs = path.resolve(rootAbs, normalized);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new InvalidPathError(relPath);
  }
  return abs;
}

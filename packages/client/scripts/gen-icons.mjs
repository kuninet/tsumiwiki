// TsumiWiki アプリアイコンの生成スクリプト。
// public/icon.svg を元に、iOS/Android/PWA が求める PNG を生成する。
// 手動実行: `pnpm --filter @tsumiwiki/client gen-icons`
// pnpm install の postinstall では走らせない(devDep sharp が無い環境で失敗するため)。

import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const publicDir = path.join(root, 'public');

const svg = await readFile(path.join(publicDir, 'icon.svg'));
await mkdir(publicDir, { recursive: true });

// PWA manifest / Chrome / Android
await sharp(svg).resize(192, 192).png().toFile(path.join(publicDir, 'icon-192.png'));
await sharp(svg).resize(512, 512).png().toFile(path.join(publicDir, 'icon-512.png'));

// iOS ホーム画面用(180x180 が Apple 推奨)
await sharp(svg)
  .resize(180, 180)
  .png()
  .toFile(path.join(publicDir, 'apple-touch-icon.png'));

// PWA の maskable 用(セーフゾーンを80%に保つため12.5%の縮小マージン付き。
// 一旦 icon-512.png と同じでも Chrome は許容する。厳密にやるなら別SVG推奨)
await sharp(svg)
  .resize(512, 512)
  .extend({
    top: 32,
    bottom: 32,
    left: 32,
    right: 32,
    background: { r: 124, g: 108, b: 240, alpha: 1 },
  })
  .resize(512, 512)
  .png()
  .toFile(path.join(publicDir, 'icon-maskable-512.png'));

// 32x32 の favicon(ブラウザタブ)
await sharp(svg).resize(32, 32).png().toFile(path.join(publicDir, 'favicon-32.png'));

console.log('icons generated in public/');

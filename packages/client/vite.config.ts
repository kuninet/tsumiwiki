/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Service Worker(設計07章7.6・#251)。
    // injectManifest方式: キャッシュ戦略(ナビゲーションのフォールバック、/api の素通し)を
    // src/sw.ts に自前で書くため。generateSW ではこの制御ができない
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      // 入力は src/sw.ts。拡張子が .ts のときプラグインが自動で dist/sw.js へ出力する
      filename: 'sw.ts',
      // ルートスコープで配信する(/sw.js が / 全体を制御する)
      scope: '/',
      // 登録はsrc/lib/register-sw.tsで自前に行う(更新通知を自分で制御するため)。
      // null は非推奨のため false を使う
      injectRegister: false,
      // public/manifest.webmanifest を手で管理しているのでプラグインには生成させない
      manifest: false,
      injectManifest: {
        // index.html を含むビルド成果物をプリキャッシュする。
        // フォント(woff2)と画像(アイコン)まで含めないとオフライン起動時に崩れる
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
      },
      // 開発時(pnpm dev)はService Workerを登録・生成しない(既定値)。
      // HMRがSWのキャッシュに邪魔されないようにするため(#251の要件)
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      // 開発時はAPIサーバー(3000)へ中継する(設計01章1.4)
      '/api': 'http://localhost:3000',
    },
  },
  test: {
    environment: 'jsdom',
  },
});

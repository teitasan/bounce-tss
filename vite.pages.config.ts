import { defineConfig } from 'vite';

// GitHub Pages 用：静的ファイルだけを作る（部屋サーバーがないのでオンライン対戦は出さない）。
// どのパスに置かれても動くように、読み込むファイルは相対パスにする
export default defineConfig({
  base: './',
  define: { 'import.meta.env.VITE_OFFLINE_ONLY': JSON.stringify('1') },
  build: { outDir: 'dist-pages', emptyOutDir: true },
});

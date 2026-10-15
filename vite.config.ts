import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';

// `npm run dev` 1本でクライアントと Worker / Durable Object（対戦の部屋）がローカルで動く
export default defineConfig({
  plugins: [cloudflare()],
});

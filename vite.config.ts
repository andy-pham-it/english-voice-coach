import devServer from '@hono/vite-dev-server';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Mọi path không bắt đầu bằng /api/ do Vite phục vụ (SPA). /api/* chạy trong
// cùng process qua Hono entry — không cần proxy, không cần terminal thứ hai.
export default defineConfig({
  plugins: [
    react(),
    devServer({
      entry: 'server/entry.ts',
      exclude: [/^\/(?!api\/)/],
    }),
  ],
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});

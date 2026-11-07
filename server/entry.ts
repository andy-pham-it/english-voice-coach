// Entry cho `@hono/vite-dev-server` (dev). Production dùng `api/index.ts`.
// Vite không đưa biến server vào process.env, nên nạp .env.local thủ công.
import { existsSync } from 'node:fs';
import { createApp } from './app.js';

if (existsSync('.env.local')) {
  try {
    process.loadEnvFile('.env.local');
  } catch {
    // .env.local hỏng thì để env() báo lỗi rõ ràng
  }
}

export default createApp();

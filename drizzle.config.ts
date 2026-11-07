import { readFileSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';

// drizzle-kit chỉ tự đọc `.env`; project này dùng `.env.local` do Neon CLI sinh.
function loadEnvLocal() {
  try {
    const text = readFileSync(new URL('./.env.local', import.meta.url), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      const key = m?.[1];
      const raw = m?.[2];
      if (!key || raw === undefined) continue;
      if (!process.env[key]) process.env[key] = raw.replace(/^"|"$/g, '');
    }
  } catch {
    // không có .env.local → dựa vào env của shell/CI
  }
}

loadEnvLocal();

// Migration đi đường direct (không pooler): DDL qua pooler hay bị timeout.
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

if (!url) {
  throw new Error('Thiếu DATABASE_URL_UNPOOLED — chạy `neon env pull` trước');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './server/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url },
  strict: true,
  verbose: true,
});

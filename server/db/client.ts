import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import * as schema from './schema.js';

/**
 * Runtime dùng HTTP driver của Neon: mỗi query là một HTTP request, không giữ
 * socket. Phù hợp Vercel serverless (function ngủ sau mỗi request) và không
 * cần pool. Migration thì dùng `DATABASE_URL_UNPOOLED` qua `drizzle-kit`.
 */
export function createDb(connectionString: string) {
  const sql = neon(connectionString);
  return drizzle(sql, { schema });
}

export type Db = ReturnType<typeof createDb>;
export { schema };

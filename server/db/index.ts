import { env } from '../env.js';
import { createDb, type Db } from './client.js';

/**
 * Một instance cho mỗi tiến trình. Trên Vercel function ngủ sau request nên
 * "cache" này chỉ sống trong một invocation — không có gì để rò rỉ.
 */
let cached: Db | null = null;

export function getDb(): Db {
  if (!cached) cached = createDb(env().DATABASE_URL);
  return cached;
}

export type { Db };

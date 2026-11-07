import { z } from 'zod';

/**
 * Validate env một chỗ, fail fast. Không đọc `process.env` rải rác trong code —
 * nếu thiếu biến thì phải nổ ngay lúc khởi động, không phải lúc user bấm Start.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'thiếu DATABASE_URL (pooled)'),
  GEMINI_API_KEY: z.string().min(1, 'thiếu GEMINI_API_KEY'),
  // Chỉ cần khi chạy bước trích xuất sau phiên; thiếu thì phiên vẫn lưu.
  GROQ_API_KEY: z.string().min(1).optional(),
  // Chỉ cần khi bật auth. Thiếu ở production thì `requireAuthEnv()` sẽ nổ.
  ACCESS_CODE: z.string().min(1).optional(),
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET phải ≥ 32 ký tự').optional(),
  // Khoá riêng cho endpoint nhận log của spike (spike chạy ở origin khác).
  SPIKE_LOG_KEY: z.string().min(16).optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Env không hợp lệ — ${detail}`);
  }
  cached = parsed.data;
  return cached;
}

/** Auth là bắt buộc trên production; ở dev có thể tạm bỏ trống. */
export function requireAuthEnv(): { accessCode: string; authSecret: string } {
  const e = env();
  if (!e.ACCESS_CODE || !e.AUTH_SECRET) {
    throw new Error('Thiếu ACCESS_CODE hoặc AUTH_SECRET — bắt buộc khi bật auth');
  }
  return { accessCode: e.ACCESS_CODE, authSecret: e.AUTH_SECRET };
}

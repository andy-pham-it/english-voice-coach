// Ephemeral token cho Live API — để GEMINI_API_KEY không bao giờ xuống trình duyệt.
// Công thức này đã kiểm chứng bằng tools/verify-token.mjs (xem spec §15):
//
//   1. POST  https://generativelanguage.googleapis.com/v1alpha/auth_tokens
//      header x-goog-api-key, body { uses, expireTime, newSessionExpireTime,
//      bidiGenerateContentSetup }
//   2. WebSocket method **BidiGenerateContentConstrained** + ?access_token=
//   3. Client vẫn gửi { setup: { model } }; phần còn lại lấy từ token.
//
// Ba bẫy đã gặp: field REST tên là bidiGenerateContentSetup (SDK gọi là
// liveConnectConstraints); dùng BidiGenerateContent → 1008; token tạo bằng
// v1alpha không dùng được cho WS v1beta.

import type { LiveSetup } from './config.js';

const AUTH_TOKENS_URL = 'https://generativelanguage.googleapis.com/v1alpha/auth_tokens';

const WS_BASE =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained';

export interface LiveToken {
  /** `auth_tokens/<id>` — truyền nguyên văn vào ?access_token=. */
  name: string;
  /** ISO time token hết hạn tuyệt đối. */
  expireTime: string;
  /** ISO time hết hạn mở phiên mới (phải nối trước mốc này). */
  newSessionExpireTime: string;
}

export interface CreateTokenOptions {
  apiKey: string;
  setup: LiveSetup;
  /** Thời gian sống của token. Một phiên 20 phút + dư. */
  ttlMs?: number;
  /** Cửa sổ để mở phiên mới sau khi cấp token. */
  newSessionWindowMs?: number;
}

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export async function createLiveToken(options: CreateTokenOptions): Promise<LiveToken> {
  const ttlMs = options.ttlMs ?? 30 * 60 * 1000;
  const windowMs = options.newSessionWindowMs ?? 2 * 60 * 1000;
  const now = Date.now();

  const res = await fetch(AUTH_TOKENS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': options.apiKey },
    body: JSON.stringify({
      uses: 1,
      expireTime: iso(now + ttlMs),
      newSessionExpireTime: iso(now + windowMs),
      bidiGenerateContentSetup: options.setup,
    }),
  });

  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`auth_tokens ${res.status}: ${JSON.stringify(json).slice(0, 400)}`);
  }
  const name = json.name;
  if (typeof name !== 'string' || !name.startsWith('auth_tokens/')) {
    throw new Error(`auth_tokens trả về name không hợp lệ: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return { name, expireTime: iso(now + ttlMs), newSessionExpireTime: iso(now + windowMs) };
}

/** URL WebSocket để client nối thẳng. Không chứa API key. */
export function liveSocketUrl(tokenName: string): string {
  return `${WS_BASE}?access_token=${encodeURIComponent(tokenName)}`;
}

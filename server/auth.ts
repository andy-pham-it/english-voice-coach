import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { env, requireAuthEnv } from './env.js';

export const AUTH_COOKIE = 'evc_auth';
const TTL_DAYS = 90;

function mac(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

/** Cookie value = `<expiry-ms>.<hmac>`; không chứa gì khác để khỏi phải parse. */
export function signSession(secret: string, now = Date.now()): string {
  const exp = String(now + TTL_DAYS * 86_400_000);
  return `${exp}.${mac(secret, exp)}`;
}

export function verifySession(value: string | undefined, secret: string, now = Date.now()): boolean {
  if (!value) return false;
  const dot = value.indexOf('.');
  if (dot <= 0) return false;
  const exp = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < now) return false;
  const expected = mac(secret, exp);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** So sánh access code bằng timingSafeEqual để không lộ độ dài/tiền tố. */
export function checkAccessCode(input: string, expected: string): boolean {
  const a = Buffer.from(input);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isAuthConfigured(): boolean {
  const e = env();
  return Boolean(e.ACCESS_CODE && e.AUTH_SECRET);
}

export function setAuthCookie(c: Context): void {
  const { authSecret } = requireAuthEnv();
  setCookie(c, AUTH_COOKIE, signSession(authSecret), {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: env().NODE_ENV === 'production',
    maxAge: TTL_DAYS * 86_400,
  });
}

export function clearAuthCookie(c: Context): void {
  setCookie(c, AUTH_COOKIE, '', { path: '/', httpOnly: true, sameSite: 'Lax', maxAge: 0 });
}

export function hasValidSession(c: Context): boolean {
  const e = env();
  if (!e.AUTH_SECRET) return false;
  return verifySession(getCookie(c, AUTH_COOKIE), e.AUTH_SECRET);
}

/**
 * Auth bắt buộc ở production. Ở dev, thiếu ACCESS_CODE/AUTH_SECRET thì bỏ qua
 * để không phải dựng cookie trước khi có UI — nhưng production thì nổ ngay.
 */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  const e = env();
  if (!isAuthConfigured()) {
    if (e.NODE_ENV === 'production') {
      return c.json({ error: 'auth_not_configured', message: 'Thiếu ACCESS_CODE hoặc AUTH_SECRET' }, 500);
    }
    return next();
  }
  if (!hasValidSession(c)) return c.json({ error: 'unauthorized' }, 401);
  return next();
};

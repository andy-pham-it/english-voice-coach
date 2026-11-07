import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { clearAuthCookie, checkAccessCode, hasValidSession, isAuthConfigured, requireAuth, setAuthCookie } from './auth.js';
import { env } from './env.js';
import { getDb } from './db/index.js';
import { spikeRuns } from './db/schema.js';
import { extractAndStore } from './extract/run.js';
import {
  appendEvents,
  deactivateMistake,
  endSession,
  getContext,
  rebrief,
  saveProfile,
  startSession,
  type SessionMode,
} from './session/service.js';

const eventsSchema = z.object({
  turns: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        text: z.string().min(1).max(8_000),
        audioMs: z.number().int().min(0).max(3_600_000).optional(),
        createdAt: z.string().datetime().optional(),
      }),
    )
    .max(200)
    .optional(),
  usage: z
    .object({
      audioSec: z.number().min(0).max(86_400).optional(),
      tokens: z.number().min(0).max(10_000_000).optional(),
    })
    .optional(),
});

const profileSchema = z.object({
  contentMd: z.string().min(1).max(8_000),
});

const authSchema = z.object({
  code: z.string().min(1).max(200),
});

/** Spike gửi nguyên object kết quả đo; chỉ ràng buộc hai field cần để tra cứu. */
const spikeRunSchema = z.looseObject({
  run_id: z.string().min(1).max(100),
  test: z.string().min(1).max(200),
});

function fail(c: any, error: unknown) {
  const status = typeof (error as { status?: number })?.status === 'number' ? (error as { status: number }).status : 500;
  const message = error instanceof Error ? error.message : String(error);
  return c.json({ error: status === 500 ? 'internal_error' : 'request_failed', message }, status);
}

export function createApp() {
  const app = new Hono();

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      service: 'english-voice-coach',
      authConfigured: isAuthConfigured(),
      gemini: Boolean(env().GEMINI_API_KEY),
      groq: Boolean(env().GROQ_API_KEY),
      time: new Date().toISOString(),
    }),
  );

  app.post('/api/auth', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = authSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

    const e = env();
    if (!e.ACCESS_CODE || !e.AUTH_SECRET) {
      // Dev không cấu hình auth: coi như đã đăng nhập để UI chạy được.
      return c.json({ ok: true, auth: 'disabled' });
    }
    if (!checkAccessCode(parsed.data.code, e.ACCESS_CODE)) {
      return c.json({ error: 'invalid_code' }, 401);
    }
    setAuthCookie(c);
    return c.json({ ok: true, auth: 'cookie' });
  });

  app.get('/api/auth/status', (c) => {
    const e = env();
    if (!isAuthConfigured()) return c.json({ auth: 'disabled', authenticated: e.NODE_ENV !== 'production' });
    return c.json({ auth: 'cookie', authenticated: hasValidSession(c) });
  });

  app.post('/api/auth/logout', (c) => {
    clearAuthCookie(c);
    return c.json({ ok: true });
  });

  // Nhận log của spike. Khác origin (spike deploy riêng) nên cần CORS; xác thực
  // bằng key riêng chứ không dùng cookie — spike không có phiên đăng nhập.
  app.use(
    '/api/spike-log',
    cors({
      origin: '*',
      allowMethods: ['POST', 'OPTIONS'],
      allowHeaders: ['content-type', 'x-spike-key'],
      maxAge: 86_400,
    }),
  );

  app.post('/api/spike-log', async (c) => {
    const e = env();
    if (e.SPIKE_LOG_KEY) {
      if (!checkAccessCode(c.req.header('x-spike-key') ?? '', e.SPIKE_LOG_KEY)) {
        return c.json({ error: 'invalid_key' }, 401);
      }
    } else if (e.NODE_ENV === 'production') {
      // Không có key thì không mở endpoint ghi DB cho bất kỳ ai.
      return c.json({ error: 'spike_log_disabled' }, 503);
    }

    const parsed = spikeRunSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

    await getDb()
      .insert(spikeRuns)
      .values({ runId: parsed.data.run_id, payload: parsed.data })
      .onConflictDoNothing();
    return c.json({ ok: true });
  });

  app.use('/api/session/*', requireAuth);
  app.use('/api/context', requireAuth);
  app.use('/api/context/*', requireAuth);
  app.use('/api/mistakes/*', requireAuth);

  app.post('/api/session/start', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const mode = (body?.mode === 'ptt' ? 'ptt' : 'duplex') as SessionMode;
    try {
      const result = await startSession(getDb(), { mode });
      return c.json({
        session_id: result.session.id,
        resumed: result.resumed,
        topic: result.session.topic,
        brief: result.brief,
        brief_tokens: result.briefTokens,
        recap: result.recap,
        model: result.model,
        live: result.live,
      });
    } catch (error) {
      return fail(c, error);
    }
  });

  app.post('/api/session/:id/events', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid_session_id' }, 400);
    const body = await c.req.json().catch(() => null);
    const parsed = eventsSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
    try {
      return c.json(await appendEvents(getDb(), id, parsed.data));
    } catch (error) {
      return fail(c, error);
    }
  });

  app.post('/api/session/:id/rebrief', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid_session_id' }, 400);
    try {
      const result = await rebrief(getDb(), id);
      return c.json({
        brief: result.brief,
        brief_tokens: result.briefTokens,
        model: result.model,
        live: result.live,
      });
    } catch (error) {
      return fail(c, error);
    }
  });

  app.post('/api/session/:id/end', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid_session_id' }, 400);
    const body = await c.req.json().catch(() => ({}));
    const durationSec =
      typeof body?.durationSec === 'number' && body.durationSec >= 0 ? Math.round(body.durationSec) : undefined;
    try {
      return c.json(await endSession(getDb(), id, { durationSec }));
    } catch (error) {
      return fail(c, error);
    }
  });

  // Chạy lại bước trích xuất khi lần end trước timeout/fail.
  app.post('/api/session/:id/extract', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid_session_id' }, 400);
    try {
      const result = await extractAndStore(getDb(), id);
      return c.json({
        topic: result.extraction.topic,
        summary: result.extraction.summary,
        corrections: result.corrections,
        items: result.extraction.corrections,
        phrases: result.extraction.new_phrases,
      });
    } catch (error) {
      return fail(c, error);
    }
  });

  app.get('/api/context', async (c) => {
    try {
      return c.json(await getContext(getDb()));
    } catch (error) {
      return fail(c, error);
    }
  });

  app.put('/api/context/profile', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = profileSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
    try {
      await saveProfile(getDb(), parsed.data.contentMd);
      return c.json({ ok: true });
    } catch (error) {
      return fail(c, error);
    }
  });

  app.delete('/api/mistakes/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid_mistake_id' }, 400);
    try {
      const removed = await deactivateMistake(getDb(), id);
      return removed ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404);
    } catch (error) {
      return fail(c, error);
    }
  });

  app.notFound((c) => c.json({ error: 'not_found', path: c.req.path }, 404));
  app.onError((error, c) => fail(c, error));

  return app;
}

# English Voice Coach

Voice-first English speaking practice for one learner — a Vietnamese backend engineer (B1–B2) — with memory that survives between sessions. Speak 10–20 minutes on your phone; the coach corrects you in the moment and brings tomorrow's phrases back next time.

**Vietnamese version:** [README.vi.md](./README.vi.md)

- **Live app:** https://english-voice-coach-five.vercel.app
- **Spike:** https://spike-ecru-six.vercel.app
- **Design spec:** [docs/superpowers/specs/2026-11-06-english-voice-coach-design.md](./docs/superpowers/specs/2026-11-06-english-voice-coach-design.md)
- **Reason mode design:** [docs/superpowers/specs/2026-11-24-reason-mode-design.md](./docs/superpowers/specs/2026-11-24-reason-mode-design.md)
- **Test plan:** [docs/02-test-plan.md](./docs/02-test-plan.md)
- **How to run the spike tests:** [docs/03-run-tests.md](./docs/03-run-tests.md)

## Status

Deployed to Vercel production at `https://english-voice-coach-five.vercel.app` on 25/11/2026 (commit `c788456`). It is a real app, not a demo: one access code, a single-learner data model, and corrections meant to be used the next day. Current checks: 18 unit tests, typecheck and build pass; `verify:brief` OK; `verify:api` 26/26; Live round-trip and socket-close checks pass.

## Purpose / Why

Practising 30 minutes a day went nowhere because every session started from zero: the AI did not know I am a backend engineer, did not know which mistakes I repeat, and did not remember that last week it fixed "I have experience in..." to "I have experience with...".

This app closes the loop:

```
speak → detect a mistake → remember it → meet it again → fix it
```

Memory is the feature, not a side effect.

## Features

### Four coach modes

Pick a mode on Home (choice is saved in `sessionStorage`). You can also type a topic or tap a chip: daily standup, code review, technical disagreement, job interview. Leave the topic empty and the app derives one from your weak spots.

| Mode | What the AI does | Use it for |
|---|---|---|
| `coach` — "Coach (sửa lỗi)" | Always English, 2–4 short sentences. Corrects at most two important mistakes per turn as wrong → right → one short reason, then keeps talking with a question. | Everyday work conversations. |
| `interview` — "Phỏng vấn (không sửa)" | Stays in character as a hiring panel: no teaching, no grammar correction, one question at a time, pushes for specifics and numbers, cuts answers past 90 seconds. At minute 8 it scores clarity / depth / numbers / honesty 1–5 and gives one four-sentence model answer. | Mock interviews under pressure. |
| `reflex` — "Phản xạ (20 giây)" | 12–15 rapid questions of at most 10 words; answers should land in 15–20 seconds. Cuts in with "Next." at 20 seconds. At the end: the three worst answers with 15-second model answers, plus one filler word to drop. | Fast interview and small-talk answers. |
| `reason` — "Reason" | Before answering you state a four-part frame: PREP (Point, Reason, Example, Point), Problem–Cause–Fix–Impact, or STAR. The AI asks exactly one question about the missing part, cuts in at 45 seconds without a frame, and makes you ask a clarifying question every third turn. No grammar correction during the drill. At minute 8 it scores structure / reasoning / evidence / conversation flow 1–5 with one evidence line each, then gives one four-sentence model answer using the frame you used worst. | Structured thinking and keeping a conversation alive. |

Modes only change the RULES block and the derived topic. The Live API, extraction and summary paths are shared.

### One session

```
Home → Recap (mistakes + due phrases) → Session (Gemini Live, duplex or push-to-talk)
     → Summary → Home
                 ↳ Drill (no audio, no Live tokens) → next brief
```

- **Recap** shows mistakes and phrases that are due before you start.
- **Session** streams audio full-duplex. The mic is probed first; `Nhắc AI` rebriefs via a reconnect (~1–2 s).
- **Summary** gives three rewritten sentences you can use tomorrow, with a Vietnamese gloss and a read-aloud button.
- **History** lists past sessions and expands to corrections plus the full transcript.
- **Context** shows the exact brief the model received and lets you edit the learner profile.

### Memory and drill

The Live API accepts `systemInstruction` only once per connection, so memory is composed before the call and written back after it:

```
end of session N:   transcript → LLM extraction → Postgres
start of session N+1: Postgres → brief (≤1000 tokens) → systemInstruction
```

The brief has five sections — `rules`, `profile`, `state`, `recall`, `today` — with RULES capped at 250 tokens. It is stored verbatim in `sessions.brief`. No LLM is called to compose it; state comes from SQL.

Drill is the cheap way back in: one card at a time, no microphone. Wrong sends an item back to tomorrow; right moves it along a 3/7/14/30-day ladder until it graduates. The same policy feeds the `today` section of the next brief, so reviewing in Drill changes what the AI asks about.

## Expected results

These are the design targets from the spec (and the added `reason` target), with the evidence available today.

| # | Target | How to measure | Evidence / status |
|---|---|---|---|
| G1 | 20 minutes continuous speech on a phone | 10 consecutive sessions on Android + Chrome, no mic error or crash | Live pipeline verified end-to-end (audio + transcript + clean close); long-run checklist in `docs/02-test-plan.md`. |
| G2 | Perceived latency ≤ 1.5 s | p50 `first audio` after the user stops talking, in push-to-talk | Spike: 8 turns / 117 s audio / ~1.5K tokens / 0 errors. VAD silence threshold 1300 ms. |
| G3 | AI remembers old mistakes | Session N+1 recalls ≥ 3/5 mistakes from N without prompting | Unit tests cover brief assembly, due-vocab selection and mistake patterns. |
| G4 | Memory is visible and editable | Context tab shows the exact `sessions.brief`; profile can be edited | `/api/context`, profile `PUT`, and `verify:brief` token-budget check. |
| G5 | Cost stays at 0 VND | No paid tier crossed in 30 days | Gemini API + Groq + Vercel Hobby (non-commercial) + Neon free. One extraction per session ≈ 2.2K tokens; Groq `gpt-oss-120b` allows 200K TPD ≈ 85–90 sessions/day. |
| G6 | AI does not cut in | `early_responses = 0` over 5 minutes of continuous speech | VAD tuned to 1300 ms after measurement; socket-close and Live checks pass. |
| G7 (`reason`) | A structured debrief after a reasoning drill | After 8 minutes: 1–5 on four axes with evidence, plus a four-sentence model answer | `verify:brief` checks rules, six-topic rotation and due-vocab weaving; one manual short session is the final check. |

## Stack, models and providers

### Stack

| Layer | Choice | Why |
|---|---|---|
| Conversation | Gemini Live API (`gemini-3.8-live`) | Full-duplex audio, ~1.5K tokens per session |
| Extraction | Groq `openai/gpt-oss-120b` | ~3 s per session, strict JSON schema |
| API | Hono on Vercel Functions | One file, no framework |
| DB | Neon Postgres + Drizzle | tsvector search, free tier, branching |
| Client | React 19 + Vite | Audio pipeline in plain WebAudio |

### Providers and fallbacks

| Job | Primary | Fallback | Notes |
|---|---|---|---|
| Realtime conversation | Gemini Live `models/gemini-3.8-live` | `models/gemini-2.5-flash-native-audio-latest` | Server issues an ephemeral token; voice `Puck`; VAD 1300 ms; PCM16 mono 16 kHz in / 24 kHz out. |
| Post-session extraction | Groq `openai/gpt-oss-120b` | `qwen/qwen3.8-27b`, `openai/gpt-oss-20b` | One strict-JSON call per session (~2.2K tokens). Skips a model on 404 / 429 / 5xx; result still goes through zod. |
| Extraction, alternate provider | Gemini `gemini-3.8-flash` | `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-flash-latest` | Used when Groq is unavailable. One retry on 503; `additionalProperties` is stripped from the response schema for Gemini. |
| Recall embeddings (v2, not shipped) | — | Gemini `gemini-embedding-2` | Planned for better recall; not in production. |

API keys stay on the server. The browser receives only a short-lived Live token. Model names live in `server/live/config.ts` and `server/extract/providers.ts`; changing them does not require a client change.

## Setup

### 1. Vercel (production)

Checklist:

1. Import `andy-pham-it/english-voice-coach`; use Node 22.x.
2. Select the `english-voice-coach` project (serves `-five.vercel.app`). The near-identical `english-voice-coaching` project has no env vars and returns 500 on every route. Check `vercel ls` before blaming a deploy.
3. Set production env vars: `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `ACCESS_CODE`, `AUTH_SECRET`, `SPIKE_LOG_KEY`. Generate the secret with `openssl rand -hex 32` (at least 32 characters).
4. Apply migrations **inside Vercel's production env context**:

   ```bash
   vercel env run -e production -- npx drizzle-kit migrate
   ```

   Do not use `vercel env pull` with an OIDC token: the pulled values come back as `[env:NAME]` placeholders and cannot decrypt the real secrets.

5. Deploy and verify:

   ```bash
   npm run deploy          # same as: npx vercel --prod --yes
   curl https://english-voice-coach-five.vercel.app/api/health
   ```

   Health should return `200` with `ok: true`. Also check the page title and that the production JS bundle contains `reason`.

6. Rollback: promote the previous deployment in the Vercel dashboard, or `git revert <commit> && git push` and redeploy.

`vercel.json` deliberately uses legacy `builds`/`routes`: the Vite preset otherwise injects `^/api(/.*)?$ → 404` and the function is never registered. Relative imports under `server/` and `api/` must end in `.js`, and `tsconfig.json` must not set `"types": ["node"]` (causes `TS2688`).

### 2. Local development

```bash
npm install
cp .env.example .env.local     # then fill in the values
npm run db:migrate             # creates tables on the Neon branch
npm run db:seed                # optional: sample profile, mistakes, phrases
npm run dev                    # http://localhost:5173 (UI + API in one process)
```

With `ACCESS_CODE` unset, auth is disabled locally and the app opens straight to Home. For phone testing you need HTTPS (a Vercel preview or a tunnel): `getUserMedia` does not work over plain `http://192.168.x.x`.

Run the checks before changing anything:

```bash
npm test
npm run typecheck
npm run build
npm run verify:brief
npm run verify:api
```

Verification scripts write real rows and restore the previous state, so they are safe on a dev branch. Never point them at production data.

### 3. Self-hosted Node server

Use this for a VPS, Docker container, or any Node host instead of Vercel.

1. Install dependencies. The Node adapter and `tsx` are declared in `package.json`, so there is nothing extra to add:

   ```bash
   npm install
   # production containers: npm ci --omit=dev
   ```

2. Export the same seven env vars as Vercel, plus `NODE_ENV=production` and optionally `PORT` (default `3000`). Apply migrations with `DATABASE_URL_UNPOOLED` and build the frontend:

   ```bash
   npm run db:migrate
   npm run build
   ```

3. Start the API with the repo script:

   ```bash
   npm run start:node
   ```

   The entry point is `server/node.ts`; it already exists. The script uses `tsx` from dependencies, so it works after a dev-free install too.

4. Serve `dist/` from the same origin. Example Caddyfile with automatic TLS and SPA fallback:

   ```caddyfile
   example.com {
     handle /api/* {
       reverse_proxy 127.0.0.1:3000
     }
     handle {
       root * /srv/english-voice-coach/dist
       try_files {path} /index.html
       file_server
     }
   }
   ```

   If you change `PORT`, update the `reverse_proxy` target to match.

Notes:

- HTTPS is mandatory for microphone access; terminate TLS at Caddy/Nginx/your load balancer.
- No WebSocket proxy is needed for the conversation: the browser connects directly to Gemini Live with a server-issued ephemeral token. The Node process only serves the REST API.
- `api/index.ts` and `vercel.json` are Vercel-only and are not used here.
- `ACCESS_CODE` and `AUTH_SECRET` are required when `NODE_ENV=production`; if `SPIKE_LOG_KEY` is absent, `/api/spike-log` returns 503.

## Reading guide

Most of the design work sits in five places:

- [`server/memory/brief.ts`](./server/memory/brief.ts) — turning a database into one prompt under a fixed token budget: per-section caps, clipping at word boundaries, mode-specific RULES, and state computed in SQL rather than written by a model.
- [`src/live.ts`](./src/live.ts) — hand-rolled WebSocket + AudioWorklet pipeline (16 kHz up, 24 kHz down), including the resampler that exists because Chrome on Android ignores `new AudioContext({ sampleRate: 16000 })`.
- [`server/extract/`](./server/extract) — schema-constrained extraction with provider fallback, and the rule that the model may only pick phrases the learner has already been shown.
- [`server/review/drill.ts`](./server/review/drill.ts) — self-graded review and the 3/7/14/30-day schedule shared with the brief.
- [`server/session/service.ts`](./server/session/service.ts) — session lifecycle and the reconnect path that keeps `durationSec` honest when the phone locks or the tab closes.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite + Hono API on one port |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Preview the built `dist/` locally |
| `npm test` | Vitest unit suite (18 tests) |
| `npm run test:watch` | Vitest watch mode |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run deploy` | Deploy to Vercel production |
| `npm run start:node` | Serve the REST API with the Node adapter (self-hosted) |
| `npm run db:generate` | Generate a Drizzle migration from `server/db/schema.ts` |
| `npm run db:migrate` | Apply migrations using `DATABASE_URL_UNPOOLED` |
| `npm run db:studio` | Open Drizzle Studio |
| `npm run db:seed` | Seed profile, three mistakes, three phrases |
| `npm run db:seed:plan` | Seed the interview-plan fixture |
| `npm run db:reset` | Wipe sessions/mistakes/vocab/usage and restore the seed |
| `npm run verify:brief` | Build a brief from the real DB and check the token budget |
| `npm run verify:live` | Brief → ephemeral token → Live API round trip |
| `npm run verify:token` | Ephemeral token creation only |
| `npm run verify:extract` | Extraction pipeline against a fixture session (cleans up) |
| `npm run verify:live-close` | Socket-close flags: reconnect vs. end-of-session (no mic, no network) |
| `npm run verify:api` | 26 end-to-end API assertions (cleans up) |
| `npm run verify:drill` | Drill scheduling checks |
| `npm run verify:schedule` | Review-interval checks |
| `npm run dev:spike` | Serve the measurement spike at `:8080` |

## Layout

```
api/index.ts          Vercel entry (Hono adapter)
server/
  app.ts              routes
  node.ts             self-hosted Node entry (npm run start:node)
  auth.ts             HMAC cookie
  env.ts              env validation (fail fast)
  db/                 schema, client, singleton
  live/               Live API config + ephemeral token
  memory/brief.ts     profile + state + recall + mode RULES → brief
  extract/            prompt, zod schema, providers with fallback, apply
  review/drill.ts     due items + 3/7/14/30-day scheduling
  session/service.ts  start / events / rebrief / end
  session/history.ts  past sessions + transcript for the History tab
src/                  React client: Home, Session, Summary, History, Context
src/mic.ts            microphone probe used by Home
spike/index.html      measurement harness (T1 / T3 / V1), not shipped
tools/                dev server, log queries, verification scripts
drizzle/              generated SQL migrations
docs/superpowers/     design specs and implementation plans
```

## Known limits

- One user. The access code is not a user system.
- No per-turn context injection: the brief is fixed at connect time. `Nhắc AI` reconnects with a fresh brief when the conversation drifts.
- Corrections are extracted after the session, not while speaking. In `reason` and `interview` modes grammar is deliberately not corrected mid-drill.
- Pronunciation is not scored, and the read-aloud button uses the phone's own text-to-speech voice.
- Ephemeral tokens expire after 30 minutes; a reconnect issues a new one.
- A session dropped by accident (tab closed, phone locked) is resumed if you come back within 15 minutes: the timer continues from the original start, so `durationSec` stays honest. After that it is marked `abandoned` and capped at the window length, so one forgotten session cannot distort the weekly stats.
- Vercel Hobby is non-commercial only; move to a paid plan or self-host if this stops being a personal tool.

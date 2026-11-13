# English Voice Coach

Voice-first English speaking practice for one user, with memory that survives between sessions.
Speak for 10–20 minutes on your phone; the app corrects you in the moment, then stores what you got
wrong and brings it back next time.

**Vietnamese version:** [README.vi.md](./README.vi.md)

- **Live app:** https://english-voice-coach-five.vercel.app
- **Design spec:** [docs/superpowers/specs/2026-11-06-english-voice-coach-design.md](./docs/superpowers/specs/2026-11-06-english-voice-coach-design.md)
- **Test plan:** [docs/02-test-plan.md](./docs/02-test-plan.md)
- **How to run the spike tests:** [docs/03-run-tests.md](./docs/03-run-tests.md)

## Status

Built for myself as the only user, and deployed. It is a real app rather than a demo: there is one
access code, the whole data model is shaped around a single learner, and the corrections it stores
are meant to be used the next day. Everything below describes what runs in production, not a plan.

## How it works

```
Home → Recap (mistakes + due phrases) → Session (Gemini Live, full-duplex) → Summary → Home
                              ↳ Drill (no audio: self-graded review of what is due)
```

On Home you can type a topic (or tap a chip: daily standup, code review, technical disagreement,
job interview) and check the microphone before starting. The topic goes straight into the brief, so
the AI opens on the subject you want. Leave it empty and the app picks one from your weak spots.

Memory is two-phase, because the Live API only accepts `systemInstruction` once per connection:

```
end of session N:   transcript → LLM extraction (Groq) → Postgres
start of session N+1: Postgres → brief (≤1000 tokens) → systemInstruction
```

The brief is stored verbatim in `sessions.brief`, so the Context tab shows exactly what the model read.

After each session you get three rewritten sentences you can actually use tomorrow (with a Vietnamese gloss
and a read-aloud button), and they come back in the next brief for review.
The History tab lists past sessions and expands each one into its corrections and full transcript.

Drill is the cheap way back in: a card at a time, no microphone, no Live API tokens. It shows only what is
actually due, and every answer reschedules that item — wrong drops it back to tomorrow, right moves it along
a 3/7/14/30-day ladder until it graduates. The same policy drives the review section of the next brief, so
reviewing in Drill genuinely changes what the AI asks about.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Conversation | Gemini Live API (`gemini-3.8-live`) | full-duplex audio, ~1.5K tokens per session |
| Extraction | Groq `openai/gpt-oss-120b` | ~3s per session, JSON schema |
| API | Hono on Vercel Functions | one file, no framework |
| DB | Neon Postgres + Drizzle | tsvector search, free tier, branching |
| Client | React 19 + Vite | audio pipeline in plain WebAudio |

## Reading guide

Most of the design work sits in four places:

- [`server/memory/brief.ts`](./server/memory/brief.ts) — turning a database into one prompt under a
  fixed token budget: per-section caps, clipping at word boundaries, and state computed in SQL
  rather than written by a model.
- [`src/live.ts`](./src/live.ts) — hand-rolled WebSocket + AudioWorklet pipeline (16 kHz up, 24 kHz
  down), including the resampler that exists because Chrome on Android ignores
  `new AudioContext({ sampleRate: 16000 })`.
- [`server/extract/`](./server/extract) — schema-constrained extraction on Groq, and the rule that
  the model may only pick phrases the learner has already been shown.
- [`server/session/service.ts`](./server/session/service.ts) — session lifecycle and the reconnect
  path that keeps `durationSec` honest when the phone locks or the tab closes.

## Local development

```bash
npm install
cp .env.example .env.local     # then fill in the values
npm run db:migrate             # create tables on the Neon branch
npm run db:seed                # optional: sample profile, mistakes, phrases
npm run dev                    # http://localhost:5173 (UI + API in one process)
```

With `ACCESS_CODE` unset, auth is disabled locally — the app opens straight to Home.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite + Hono API on one port |
| `npm run build` | Production build into `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:generate` | Generate a Drizzle migration from `server/db/schema.ts` |
| `npm run db:migrate` | Apply migrations using `DATABASE_URL_UNPOOLED` |
| `npm run db:seed` | Seed profile, three mistakes, three phrases |
| `npm run db:reset` | Wipe sessions/mistakes/vocab/usage and restore the seed |
| `npm run verify:brief` | Build a brief from the real DB and check token budget |
| `npm run verify:live` | Brief → ephemeral token → Live API round trip |
| `npm run verify:token` | Ephemeral token creation only |
| `npm run verify:extract` | Extraction pipeline against a fixture session (cleans up) |
| `npm run verify:live-close` | Socket-close flags: reconnect vs. end-of-session (no mic, no network) |
| `npm run verify:api` | 17 end-to-end API assertions (cleans up) |
| `npm run dev:spike` | Serve the measurement spike at `:8080` |

Verification scripts write real rows and then restore the previous state, so they are safe to run
against the dev branch. Do not point them at production data.

## Deploying

```bash
npm run deploy      # same as: npx vercel --prod --yes
```

`vercel.json` uses the legacy `builds`/`routes` form on purpose: the Vite preset injects a
`^/api(/.*)?$ → 404` route and the function never gets registered. Two more constraints that cost
real debugging time:

- Relative imports under `server/` and `api/` must end in `.js` (the function builds as ESM).
- `tsconfig.json` must not set `"types": ["node"]`, or the function build fails with `TS2688`.
- There are two Vercel projects one letter apart. `english-voice-coach` is this one, behind
  `-five.vercel.app`. `english-voice-coaching` was created without the environment variables and
  answers 500 on every route, so check `vercel ls` names before deciding a deploy did not work.

Production env vars: `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `GEMINI_API_KEY`, `GROQ_API_KEY`,
`ACCESS_CODE`, `AUTH_SECRET`, `SPIKE_LOG_KEY`.

## Layout

```
api/index.ts          Vercel entry (Hono adapter)
server/
  app.ts              routes
  auth.ts             HMAC cookie
  db/                 schema, client, singleton
  live/               Live API config + ephemeral token
  memory/brief.ts     profile + state + recall → brief
  extract/            prompt, zod schema, providers, apply
  session/service.ts  start / events / rebrief / end
  session/history.ts  past sessions + transcript for the History tab
src/                  React client: Home, Session, Summary, History, Context
src/mic.ts            microphone probe used by Home
spike/index.html      measurement harness (T1 / T3 / V1), not shipped
tools/                dev server, log queries, verification scripts
drizzle/              generated SQL migrations
```

## Known limits

- One user. The access code is not a user system.
- No per-turn context injection: the brief is fixed at connect time. The `Nhắc AI` button
  reconnects with a fresh brief when the conversation drifts.
- Corrections are extracted after the session, not while speaking.
- Pronunciation is not scored, and the read-aloud button uses the phone's own text-to-speech voice.
- Ephemeral tokens expire after 30 minutes; a reconnect issues a new one.
- A session dropped by accident (tab closed, phone locked) is resumed if you come back within
  15 minutes: the timer continues from the original start, so `durationSec` stays honest. After
  that it is marked `abandoned` and capped at the window length, so one forgotten session cannot
  distort the weekly stats.

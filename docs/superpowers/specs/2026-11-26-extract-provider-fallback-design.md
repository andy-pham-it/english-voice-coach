# Extraction Provider Fallback Design

**Date:** 2026-11-26
**Status:** Draft — awaiting approval

## Intent

After a production session ended with `summary = null` because the Groq extraction call failed, make extraction resilient without changing anything the learner sees. Gemini becomes the primary extraction provider; Groq remains a fallback.

This is a resilience change, **not** a claim about the root cause of that one production failure. The failure was transient — replaying the same session later with the same production env succeeded in ~3.2s. The exact error text was never captured, so possible causes (429/5xx, Vercel function timeout, 401/403 at that moment, schema rejection) are still open.

## Goals

- Default extraction runs on Gemini with this exact model order: `gemini-3.8-flash` → `gemini-3.7-flash` → `gemini-3.6-flash` → `gemini-3-flash-preview`.
- If every Gemini model fails, or returns JSON that fails zod validation, retry the whole extraction through the existing Groq chain (`openai/gpt-oss-120b` → `qwen/qwen3.8-27b` → `openai/gpt-oss-20b`).
- Keep explicit `provider: 'groq'` working for diagnostics/verification scripts, with no Gemini fallback in that case.
- Preserve the existing abort signal, prompt, schema, DB writes and UI behaviour.

## Non-goals

- No Live API change (speech rate and voice stay as they are; speech rate is a separate request).
- No DB schema, brief, prompt, or extraction schema change.
- No change to the UI's one-shot auto-retry on the Summary screen.
- No removal of the Groq key or its fallback chain.

## Constraints

- `GEMINI_API_KEY` is required; `GROQ_API_KEY` is optional. If Groq has no key, skip the Groq fallback instead of throwing on a missing key.
- Gemini's `responseSchema` must keep stripping `additionalProperties` (Gemini rejects that field).
- `endSession` already aborts extraction at `EXTRACT_TIMEOUT_MS = 30_000`; all new attempts must honour the same signal. No separate per-attempt timeout is added.
- Model IDs were verified against the live API before writing this doc: `gemini-3.8-flash` currently returns 503 (high demand, with the existing one retry), while `gemini-3.7-flash`, `gemini-3.6-flash` and `gemini-3-flash-preview` return 200. `gemini-2.5-flash` returns 404 for new users and `gemini-flash-latest` is excluded. `gemini-3.7-flash` was initially excluded on the user's instruction but was added back on a later correction, after the live probe showed it available.

## Approaches

1. **Keep Groq primary, add Gemini fallback.** Smallest diff and fixes the transient-failure class, but does not match the user's request to move extraction onto Gemini. Rejected.
2. **Gemini primary, Groq fallback.** Makes Gemini the default while keeping Groq as a safety net, including when Gemini is temporarily overloaded. Chosen.
3. **Drop Groq entirely.** Simpler operations (one provider) but leaves no fallback while `gemini-3.8-flash` is returning 503. Rejected.

## Design

### Model chain

In `server/extract/providers.ts`, replace `GEMINI_EXTRACT_FALLBACKS` with:

```ts
['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3-flash-preview']
```

Keep `GEMINI_EXTRACT_MODEL = 'gemini-3.8-flash'` as the preferred model and keep the existing 503 one-retry behaviour inside `callGemini`. Groq's chain and its status-skip rules are unchanged.

### Provider selection

In `server/extract/run.ts`, change `pickProvider(explicit?)` so the no-explicit case returns Gemini (`GEMINI_API_KEY` plus `GEMINI_EXTRACT_MODEL`) instead of Groq. Explicit `'gemini'` stays unchanged; explicit `'groq'` still requires `GROQ_API_KEY` and stays Groq-only.

### Cross-provider fallback

Put the fallback loop in `extractTranscript`, not in `callProvider`. Reason: zod validation already lives there, so a malformed-but-HTTP-200 response can trigger the fallback without adding a validation callback to `providers.ts`. `callProvider` remains a single-provider dispatcher.

For a Gemini-primary call, attempt candidates in order:

1. Gemini with `GEMINI_API_KEY`, model from `options.model ?? GEMINI_EXTRACT_MODEL`.
2. Groq with `GROQ_API_KEY`, if present; otherwise no second candidate.

For each candidate, call the provider, parse with `parseJsonLoose`, and run `extractionSchema.safeParse`. Any thrown error or schema failure moves to the next candidate. After the last candidate, rethrow the last error. An explicit `'groq'` call has exactly one candidate, so it keeps today's behaviour.

The returned `ExtractRun.provider` must be the provider that actually succeeded, and `model`/`tokens` must come from that successful call, so DB usage rows stay accurate.

### Tests

- `pickProvider()` with no argument returns Gemini; with `'groq'` returns Groq; with `'gemini'` returns Gemini.
- `extractTranscript()` retries through Groq after a Gemini call failure and after a Gemini JSON-invalid response; returns the Groq provider/model/tokens.
- `extractTranscript()` does not call Gemini when `'groq'` is explicit, and does not call Groq when the key is absent.
- Keep `verify:extract` working with its explicit provider cases.

## Left to the builder

Write the implementation plan, then implement with TDD. The design leaves the exact mock shape for `callProvider` in the tests to the builder.

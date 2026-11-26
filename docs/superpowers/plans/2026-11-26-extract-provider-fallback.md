# Extract Provider Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make post-session extraction use Gemini models first and fall back to the existing Groq chain when every Gemini model fails or returns JSON that fails zod validation.

**Architecture:** Keep `callProvider` as a single-provider dispatcher. Change `pickProvider` so the default candidate is Gemini, then put the cross-provider retry loop in `extractTranscript` — the only place that already validates JSON — so both transport errors and malformed HTTP-200 responses trigger the Groq chain. `extractAndStore` keeps writing whichever candidate succeeded.

**Tech Stack:** TypeScript, Hono, Zod, Vitest 5, `@google/genai`, Groq REST via `fetch`.

**Spec:** `docs/superpowers/specs/2026-11-26-extract-provider-fallback-design.md`

## Global Constraints

- Gemini chain, in this exact order: `gemini-3.8-flash` → `gemini-3.7-flash` → `gemini-3.6-flash` → `gemini-3-flash-preview`.
- Groq chain unchanged: `openai/gpt-oss-120b` → `qwen/qwen3.8-27b` → `openai/gpt-oss-20b`.
- `GEMINI_API_KEY` is required; `GROQ_API_KEY` is optional. No Groq candidate when the key is absent.
- `callProvider` stays a single-provider dispatcher; cross-provider fallback lives in `extractTranscript`.
- Explicit `provider: 'groq'` stays Groq-only for diagnostics; explicit `provider: 'gemini'` stays Gemini-only.
- Keep stripping `additionalProperties` from the Gemini `responseSchema`.
- Honour the existing `EXTRACT_TIMEOUT_MS = 30_000` abort signal; add no new per-attempt timeout.
- `ExtractRun.provider/model/tokens` must come from the successful candidate.
- No changes to Live API, speech rate, DB schema, brief, prompt, extraction schema, or UI.
- Code/identifiers stay English; `README.md` and `README.vi.md` stay mirrored.

## Review Focus

- `gemini-3.8-flash` returns 503 "high demand" → chain must advance to `3.7` / `3.6` / `3-flash-preview`, not abort. Test: `uses the four approved models in order` (Task 1).
- All Gemini models fail → Groq chain runs when `GROQ_API_KEY` is set. Test: `falls back to Groq when the Gemini call throws` (Task 2).
- Gemini returns HTTP 200 with JSON that fails zod → Groq chain runs. Test: `falls back to Groq when Gemini JSON fails schema` (Task 2).
- `GROQ_API_KEY` absent → no Groq candidate; the Gemini error is rethrown. Test: `does not fall back to Groq without GROQ_API_KEY` (Task 2).
- Explicit `provider: 'groq'` with no key → throw before any provider call. Test: `throws before any call for explicit groq without GROQ_API_KEY` (Task 2).

---

### Task 1: Gemini-first provider selection

**Files:**
- Modify: `server/extract/providers.ts` (`GEMINI_EXTRACT_FALLBACKS`)
- Modify: `server/extract/run.ts:40-52` (`pickProvider`)
- Test: `server/extract/run.test.ts` (new)

**Interfaces:**
- Consumes: `env()` from `../env`; type `ExtractProvider` from `./providers`.
- Produces: `pickProvider(explicit?: ExtractProvider): { provider: ExtractProvider; apiKey: string; model?: string }` with default Gemini; `GEMINI_EXTRACT_FALLBACKS` as the four-ID tuple above.

- [ ] **Step 1: Write the failing test**

Create `server/extract/run.test.ts` with this scaffolding and these three tests:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ env: vi.fn(), callProvider: vi.fn() }));

vi.mock('../env', () => ({ env: mocks.env }));
vi.mock('./providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./providers')>();
  return { ...actual, callProvider: mocks.callProvider };
});

import { GEMINI_EXTRACT_FALLBACKS } from './providers';
import { pickProvider } from './run';

beforeEach(() => {
  mocks.env.mockReturnValue({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://user:pass@127.0.0.1:5432/db',
    GEMINI_API_KEY: 'gemini-key',
    GROQ_API_KEY: 'groq-key',
  });
  mocks.callProvider.mockReset();
});

describe('pickProvider', () => {
  it('defaults to Gemini when Groq key is set', () => {
    expect(pickProvider().provider).toBe('gemini');
  });

  it('keeps explicit groq and gemini', () => {
    expect(pickProvider('groq').provider).toBe('groq');
    expect(pickProvider('gemini').provider).toBe('gemini');
  });
});

describe('Gemini extraction chain', () => {
  it('uses the four approved models in order', () => {
    expect(GEMINI_EXTRACT_FALLBACKS).toEqual([
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-3.6-flash',
      'gemini-3-flash-preview',
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/extract/run.test.ts --reporter=verbose`
Expected: FAIL — `pickProvider().provider` is `groq`, and `GEMINI_EXTRACT_FALLBACKS` still contains `gemini-flash-latest`.

- [ ] **Step 3: Implement the selection change**

In `server/extract/providers.ts`, replace `GEMINI_EXTRACT_FALLBACKS` with the exact four-ID array from Global Constraints. In `server/extract/run.ts`, change the default branch of `pickProvider` to return `{ provider: 'gemini', apiKey: e.GEMINI_API_KEY, model: GEMINI_EXTRACT_MODEL }`; keep the explicit `'gemini'` and `'groq'` branches and the Groq-key guard unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/extract/run.test.ts --reporter=verbose`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add server/extract/providers.ts server/extract/run.ts server/extract/run.test.ts
git commit -m "feat: select Gemini first for extraction"
```

### Task 2: Cross-provider fallback in extractTranscript

**Files:**
- Modify: `server/extract/run.ts:58-83` (`extractTranscript`)
- Test: `server/extract/run.test.ts`

**Interfaces:**
- Consumes: Task 1's default Gemini selection and `GEMINI_EXTRACT_FALLBACKS`.
- Produces: `extractTranscript(turns, context?, options?)` tries `[Gemini, Groq?]`, validates each response with `extractionSchema.safeParse(parseJsonLoose(text))`, and returns `ExtractRun` from the successful candidate.

- [ ] **Step 1: Write the failing tests**

Append to `server/extract/run.test.ts`. Reuse the mocks/`beforeEach` from Task 1 and add:

```ts
import { extractTranscript } from './run';

const VALID_JSON = JSON.stringify({
  topic: 'Work conversation',
  summary: 'The learner described a recent project using clear past tense.',
  corrections: [],
  new_phrases: [],
  tomorrow: [],
  used_phrases: [],
  fixed_patterns: [],
});

const turns = [{ role: 'user' as const, text: 'I finished the migration last week.' }];

describe('extractTranscript fallback', () => {
  it('falls back to Groq when the Gemini call throws', async () => {
    mocks.callProvider
      .mockRejectedValueOnce(new Error('Gemini unavailable'))
      .mockResolvedValueOnce({ text: VALID_JSON, model: 'openai/gpt-oss-120b', tokens: 123 });

    const run = await extractTranscript(turns, {}, { model: 'custom-gemini-model' });

    expect(run.provider).toBe('groq');
    expect(run.model).toBe('openai/gpt-oss-120b');
    expect(run.tokens).toBe(123);
    expect(mocks.callProvider.mock.calls.map((c) => [c[0].provider, c[0].model])).toEqual([
      ['gemini', 'custom-gemini-model'],
      ['groq', ''],
    ]);
  });

  it('falls back to Groq when Gemini JSON fails schema', async () => {
    mocks.callProvider
      .mockResolvedValueOnce({ text: '{"topic":"too short"}', model: 'gemini-3.8-flash', tokens: 10 })
      .mockResolvedValueOnce({ text: VALID_JSON, model: 'openai/gpt-oss-120b', tokens: 20 });

    const run = await extractTranscript(turns);
    expect(run.provider).toBe('groq');
    expect(run.tokens).toBe(20);
  });

  it('does not call Gemini for explicit groq', async () => {
    mocks.callProvider.mockResolvedValueOnce({ text: VALID_JSON, model: 'openai/gpt-oss-120b', tokens: 1 });

    const run = await extractTranscript(turns, {}, { provider: 'groq' });
    expect(run.provider).toBe('groq');
    expect(mocks.callProvider).toHaveBeenCalledTimes(1);
  });

  it('throws before any call for explicit groq without GROQ_API_KEY', async () => {
    mocks.env.mockReturnValue({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://user:pass@127.0.0.1:5432/db',
      GEMINI_API_KEY: 'gemini-key',
    });

    await expect(extractTranscript(turns, {}, { provider: 'groq' })).rejects.toThrow('GROQ_API_KEY');
    expect(mocks.callProvider).not.toHaveBeenCalled();
  });

  it('does not fall back to Groq without GROQ_API_KEY', async () => {
    mocks.env.mockReturnValue({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://user:pass@127.0.0.1:5432/db',
      GEMINI_API_KEY: 'gemini-key',
    });
    mocks.callProvider.mockRejectedValueOnce(new Error('Gemini unavailable'));

    await expect(extractTranscript(turns)).rejects.toThrow('Gemini unavailable');
    expect(mocks.callProvider).toHaveBeenCalledTimes(1);
  });

  it('propagates the last error after all candidates fail', async () => {
    mocks.callProvider
      .mockRejectedValueOnce(new Error('Gemini unavailable'))
      .mockRejectedValueOnce(new Error('Groq unavailable'));

    await expect(extractTranscript(turns)).rejects.toThrow('Groq unavailable');
    expect(mocks.callProvider).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/extract/run.test.ts --reporter=verbose`
Expected: FAIL — fallback tests see one call and reject with the Gemini error; explicit-groq test still not exercising the Groq-key guard through `extractTranscript`.

- [ ] **Step 3: Implement the candidate loop**

In `server/extract/run.ts`, replace the single `callProvider`/`safeParse` block in `extractTranscript` with this behavior:

- Build `candidates = [chosen]`; when `chosen.provider === 'gemini'` and `env().GROQ_API_KEY` is set, append `{ provider: 'groq', apiKey: env().GROQ_API_KEY }`.
- Loop candidates. For the first candidate use `model: options.model ?? candidate.model ?? ''`; for later candidates use `model: candidate.model ?? ''` so a Gemini-only `options.model` is never sent to Groq.
- Pass the same `system`, `prompt`, `apiKey`, and `signal` to every call.
- On a thrown error or a zod-invalid JSON payload, record the error and continue to the next candidate.
- Return `{ extraction: parsed.data, provider: candidate.provider, model, tokens }` on the first success; after the loop, `throw lastError`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/extract/run.test.ts --reporter=verbose`
Expected: PASS — 9 tests in this file.

- [ ] **Step 5: Commit**

```bash
git add server/extract/run.ts server/extract/run.test.ts
git commit -m "feat: fall back from Gemini to Groq on extraction failure"
```

### Task 3: Docs alignment and full verification

**Files:**
- Modify: `README.md:82`, `README.md:93`, `README.md:103-104`
- Modify: `README.vi.md:82`, `README.vi.md:93`, `README.vi.md:103-104`

**Interfaces:**
- Consumes: Task 1 + Task 2 behavior. No code interface produced.

- [ ] **Step 1: Update the English README provider rows**

Replace the cost row, the stack row, and the two provider-fallback rows so they name Gemini `gemini-3.8-flash` as primary, list `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3-flash-preview` as the in-provider fallbacks, and describe Groq `openai/gpt-oss-120b` → `qwen/qwen3.8-27b` → `openai/gpt-oss-20b` as the cross-provider fallback used when all Gemini models fail or return invalid JSON. Keep the 200K TPD / 85–90 sessions/day note as the Groq backstop capacity.

- [ ] **Step 2: Mirror the same rows in README.vi.md**

Use the Vietnamese equivalents already in that file; keep the same table positions and wording structure.

- [ ] **Step 3: Verify the two READMEs stay mirrored**

Run: `diff <(grep '^#' README.md) <(grep '^#' README.vi.md) && test "$(grep -c '\`\`\`' README.md)" = "$(grep -c '\`\`\`' README.vi.md)" && ! grep -q 'Dùng khi Groq không khả dụng' README.vi.md`
Expected: no output, exit 0.

- [ ] **Step 4: Run the full verification suite**

Run:
```bash
npx vitest run --reporter=verbose
npx tsc --noEmit
npx vite build
npx tsx tools/verify-api.ts
npx tsx tools/verify-extract.ts
```
Expected:
- `vitest`: 5 files, 27 tests pass.
- `tsc` and `vite build`: no output/errors.
- `verify-api`: 26/26 PASS.
- `verify-extract`: Gemini and Groq extraction calls succeed; the two pre-existing DB-pollution assertions (`tomorrow` due ordering, `push back` streak) may still FAIL and are out of scope — report them, do not treat as regression.

- [ ] **Step 5: Commit**

```bash
git add README.md README.vi.md
git commit -m "docs: document Gemini-first extraction fallback"
```

# Reason Coach Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fourth coaching mode `reason` that trains structured thinking, reasoning with evidence, and conversation maintenance in spoken English.

**Architecture:** The mode is a brief-only feature. `COACH_MODES` gains `'reason'`; `REASON_RULES` and a 6-topic rotation live in `composeBrief`; the existing Live API setup, reconnect/rebrief, extraction, and DB write-back paths are unchanged. UI adds one chip and teaches `sessionStorage` the new value.

**Tech Stack:** TypeScript, Drizzle ORM + Postgres, Hono, React 19, Vitest, Vite.

**Spec:** `docs/superpowers/specs/2026-11-24-reason-mode-design.md`

## Global Constraints

- Brief ≤ 1.000 token; RULES budget ≤ 250 token (`SECTION_BUDGET.rules` in `server/memory/brief.ts`).
- `CoachMode` values are exactly `coach | interview | reflex | reason` everywhere (DB enum, server type, FE type).
- Live API `systemInstruction` is accepted only at setup; never add mid-session instructions outside `composeBrief`/reconnect.
- No grammar correction during a `reason` session; feedback is deferred to the minute-8 score.
- English-only UI copy and brief text; commit messages in English.

## Review Focus

- **DB CHECK constraint still rejects `'reason'`** after deploy → Task 1 runs `npm run db:migrate` and asserts `COACH_MODES` includes `'reason'`.
- **`REASON_RULES` overflows the 250-token RULES budget** and gets clipped → Task 2 asserts `estimateTokens(REASON_RULES) <= 250`.
- **`deriveTopic` collides with the interview rotation or drifts by one** → Task 2 asserts all six indices produce the expected reason topics.
- **`sessionStorage` restore silently downgrades `'reason'` to `'coach'`** → Task 1 exports `isCoachMode`; Task 3 uses it and Task 1 tests it.
- **Due vocab disappears in reason mode** → Task 2 asserts `reviewLine` branch includes reason; `npm run verify:brief` covers the composed brief.

---

### Task 1: Extend the mode enum, DB constraint, and FE type guard

**Files:**
- Modify: `server/db/schema.ts:58`
- Create: `drizzle/0006_reason_mode.sql`
- Modify: `src/api.ts:58`
- Create: `server/db/schema.test.ts`
- Create: `src/api.test.ts`

**Interfaces:**
- Consumes: none.
- Produces: `COACH_MODES` (server) includes `'reason'`; `CoachMode` (FE) is derived from `FE_COACH_MODES`; `isCoachMode(value: string | null): value is CoachMode`.

- [ ] **Step 1: Write failing server test**

```ts
// server/db/schema.test.ts
import { describe, expect, it } from 'vitest';
import { COACH_MODES } from './schema';

describe('COACH_MODES', () => {
  it('includes reason after reflex', () => {
    expect(COACH_MODES).toEqual(['coach', 'interview', 'reflex', 'reason']);
  });
});
```

- [ ] **Step 2: Write failing FE guard test**

```ts
// src/api.test.ts
import { describe, expect, it } from 'vitest';
import { isCoachMode } from './api';

describe('isCoachMode', () => {
  it('accepts reason and rejects unknown values', () => {
    expect(isCoachMode('reason')).toBe(true);
    expect(isCoachMode('coach')).toBe(true);
    expect(isCoachMode('bogus')).toBe(false);
    expect(isCoachMode(null)).toBe(false);
  });
});
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `npx vitest run server/db/schema.test.ts src/api.test.ts`
Expected: FAIL — `COACH_MODES` is 3 items; `isCoachMode` is not exported.

- [ ] **Step 4: Update server enum**

In `server/db/schema.ts:58`, replace the `COACH_MODES` array with exactly:

```ts
export const COACH_MODES = ['coach', 'interview', 'reflex', 'reason'] as const;
```

Keep the `CoachMode` type line unchanged.

- [ ] **Step 5: Add the DB migration**

Create `drizzle/0006_reason_mode.sql` with exactly:

```sql
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_coach_mode_check";--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_coach_mode_check" CHECK ("sessions"."coach_mode" in ('coach', 'interview', 'reflex', 'reason'));
```

Follow the exact `--> statement-breakpoint` style of `drizzle/0005_reflex_mode_and_latency.sql`.

- [ ] **Step 6: Update FE type and guard**

In `src/api.ts:58`, replace the union with:

```ts
export const FE_COACH_MODES = ['coach', 'interview', 'reflex', 'reason'] as const;
export type CoachMode = (typeof FE_COACH_MODES)[number];
export function isCoachMode(value: string | null | undefined): value is CoachMode {
  return !!value && (FE_COACH_MODES as readonly string[]).includes(value);
}
```

- [ ] **Step 7: Run tests and typecheck**

Run: `npx vitest run server/db/schema.test.ts src/api.test.ts && npm run typecheck`
Expected: both PASS, no TS errors.

- [ ] **Step 8: Apply migration to local DB**

Run: `npm run db:migrate`
Expected: migration `0006_reason_mode.sql` applied without constraint error.

- [ ] **Step 9: Commit**

```bash
git add server/db/schema.ts drizzle/0006_reason_mode.sql src/api.ts server/db/schema.test.ts src/api.test.ts
git commit -m "feat: add reason coach mode to enum, schema, and FE type guard"
```

---

### Task 2: Teach the brief about reason mode

**Files:**
- Modify: `server/memory/brief.ts:55-92` (insert `REASON_RULES` after `REFLEX_RULES`)
- Modify: `server/memory/brief.ts:233-276` (`deriveTopic`)
- Modify: `server/memory/brief.ts:319-347` (`composeBrief`)
- Create: `server/memory/brief.test.ts`

**Interfaces:**
- Consumes: `CoachMode` from `server/db/schema.js` (`'reason'` now exists).
- Produces: `REASON_RULES: string`; `rulesFor(coach: CoachMode): string`; `deriveTopic({ ..., coach })` returns a reason topic when `coach === 'reason'`.

- [ ] **Step 1: Write failing tests**

```ts
// server/memory/brief.test.ts
import { describe, expect, it } from 'vitest';
import { deriveTopic, estimateTokens, REASON_RULES, rulesFor } from './brief';

const reasonTopics = [
  'a technical decision I would defend with numbers',
  'a production incident from cause to fix',
  'why a migration was worth its cost',
  'a disagreement settled with evidence',
  'choosing between two competing fixes',
  'explaining a tradeoff to a non-technical manager',
];

describe('reason mode brief', () => {
  it('keeps RULES inside the 250-token budget', () => {
    expect(estimateTokens(REASON_RULES)).toBeLessThanOrEqual(250);
  });

  it('selects REASON_RULES for reason mode', () => {
    expect(rulesFor('reason')).toBe(REASON_RULES);
    expect(rulesFor('coach')).not.toBe(REASON_RULES);
  });

  it('rotates all six reason topics by session count', () => {
    for (let i = 0; i < reasonTopics.length; i++) {
      expect(deriveTopic({ dueVocab: [], topMistakes: [], sessionCount: i, coach: 'reason' }))
        .toBe(`mock reasoning on ${reasonTopics[i]}`);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/memory/brief.test.ts`
Expected: FAIL — `REASON_RULES` / `rulesFor` not exported; `deriveTopic` returns a rotation topic.

- [ ] **Step 3: Add `REASON_RULES` in `server/memory/brief.ts`**

Insert after `REFLEX_RULES`:

```ts
export const REASON_RULES = `You are my reasoning coach. We talk about my real work as a backend engineer, in English.
Rules:
- Always speak English. Keep replies to 2-3 short sentences.
- Before I answer, I state a four-part frame: "Point, Reason, Example, Point" or "Problem, Cause, Fix, Impact" or "Situation, Task, Action, Result".
- Listen for those four parts. If one is missing, ask exactly one question about that part, then stop. Never supply the answer.
- If I speak past 45 seconds without a frame, cut in: "Give me your point first."
- Every third turn, make me ask you one short clarifying question before you continue. I need practice keeping the conversation alive.
- Never correct grammar during the drill. Note repeated wording only at the end.
- After 8 minutes, step out of role: score me 1-5 on structure, reasoning, evidence and conversation flow, one line of evidence each, then give one model answer in four sentences using the frame I used worst.`;
```

- [ ] **Step 4: Add `rulesFor` and wire `deriveTopic`**

Export:

```ts
export function rulesFor(coach: CoachMode): string {
  if (coach === 'reason') return REASON_RULES;
  if (coach === 'interview') return INTERVIEW_RULES;
  if (coach === 'reflex') return REFLEX_RULES;
  return RULES;
}
```

In `deriveTopic`, insert **before** the `input.coach === 'reflex'` branch:

```ts
if (input.coach === 'reason') {
  const topics = [
    'a technical decision I would defend with numbers',
    'a production incident from cause to fix',
    'why a migration was worth its cost',
    'a disagreement settled with evidence',
    'choosing between two competing fixes',
    'explaining a tradeoff to a non-technical manager',
  ];
  return `mock reasoning on ${topics[input.sessionCount % topics.length] ?? topics[0]}`;
}
```

- [ ] **Step 5: Wire `composeBrief`**

In `composeBrief`, add `const reason = coach === 'reason';`. Change the `reviewLine` condition from `(interview || reflex)` to `(interview || reflex || reason)`. Change the opener fallback to add a `reason` case before `interview`: `'Open with one short question that needs a reason, not a fact.'`. Replace the inline rules ternary with `rules: rulesFor(coach)`.

- [ ] **Step 6: Run test and typecheck**

Run: `npx vitest run server/memory/brief.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Verify the composed brief against the real DB**

Run: `npm run verify:brief`
Expected: existing checks pass; brief tokens ≤ 1.000.

- [ ] **Step 8: Commit**

```bash
git add server/memory/brief.ts server/memory/brief.test.ts
git commit -m "feat: add reason rules and topic rotation to brief"
```

---

### Task 3: Expose the mode in the UI

**Files:**
- Modify: `src/App.tsx:122-195`, `src/App.tsx:376-380`
- Test: `src/api.test.ts` from Task 1 already pins the guard.

**Interfaces:**
- Consumes: `isCoachMode` from `src/api.ts` (import path `'./api'` in App); `CoachMode` type.
- Produces: a fourth `reason` chip that sends `coach: 'reason'` on start and survives reload.

- [ ] **Step 1: Add the chip**

In the coach selector block (`src/App.tsx:164-187`), add a fourth button after `reflex`, using the same pattern:

```tsx
<button
  className={coach === 'reason' ? 'primary' : 'chip'}
  aria-pressed={coach === 'reason'}
  onClick={() => setCoach('reason')}
>
  Reason
</button>
```

Update the caption below the chips (`src/App.tsx:188-193`) to add a `reason` branch: `"Structure: frame your point, support it, keep the conversation going."`

- [ ] **Step 2: Restore the stored mode**

Replace the restore expression at `src/App.tsx:376-380` with:

```tsx
const storedCoach = sessionStorage.getItem('coach');
isCoachMode(storedCoach) ? storedCoach : 'coach',
```

Import `isCoachMode` from `./api` alongside the existing imports.

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm run build`
Expected: PASS; no TS error and Vite build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx
git commit -m "feat: add reason chip and restore it from sessionStorage"
```

---

### Task 4: Full verification

**Files:** none (verification only).

**Interfaces:**
- Consumes: all three tasks above.

- [ ] **Step 1: Run the automated suite**

Run: `npm test && npm run typecheck && npm run build`
Expected: all tests pass (existing 13 plus the new ones), typecheck clean, build succeeds.

- [ ] **Step 2: Run the DB-backed checks**

Run: `npm run verify:brief && npm run verify:api`
Expected: brief token budget respected; API session start accepts `coach: 'reason'`.

- [ ] **Step 3: Commit the spec and plan**

```bash
git add docs/superpowers/specs/2026-11-24-reason-mode-design.md docs/superpowers/plans/2026-11-24-reason-mode.md
git commit -m "docs: add reason coach mode design and implementation plan"
```

If both files are already tracked and unchanged, skip this step.

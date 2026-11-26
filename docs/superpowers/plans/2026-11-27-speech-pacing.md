# Speech Pacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Live API coach speak more slowly by adding one shared pacing instruction to every coach mode's `systemInstruction` rules.

**Architecture:** `composeBrief()` already builds one text blob from `RULES`/`INTERVIEW_RULES`/`REFLEX_RULES`/`REASON_RULES` via `rulesFor(coach)`, and `buildLiveConfig()` installs that blob as `systemInstruction` at setup. One exported constant is interpolated into all four rule templates; no Live API, token, client playback, UI, DB, extraction, or schema code changes.

**Tech Stack:** TypeScript, Vitest, Drizzle (unchanged), Gemini Live API `systemInstruction`.

**Spec:** `docs/superpowers/specs/2026-11-27-speech-pacing-design.md`

## Global Constraints

- `BRIEF_BUDGET = 1000`; `SECTION_BUDGET.rules = 250`.
- Exact pacing line: `\n- Speak slightly slower; pause between clauses.` (12 tokens by `estimateTokens`).
- All four rule constants must stay within 250 tokens after interpolation: coach 149, interview 212, reflex 170, reason 248.
- `rulesFor(coach)` and `joinBrief()` stay unchanged; `tools/verify-brief.ts` must stay unchanged and keep passing its `reasonBrief.parts.rules === REASON_RULES` check.
- Live API `systemInstruction` is set only once at setup; no mid-session injection.
- This is a fixed slower pace for all sessions, not a per-session adjustable control; do not touch `src/live.ts` or add UI.
- Repo files stay English except the bilingual README pair (not touched by this plan).

## Review Focus

- A rules string crosses 250 tokens and `joinBrief()` silently clips away the pacing line — pinned by Task 1 test `keeps every coach-mode rules inside the 250-token budget` plus `verify-brief` rule-budget checks.
- A coach mode is missed, so pacing applies only to some sessions — pinned by Task 1 test `includes the pacing instruction for every coach mode` (checks all four modes through `rulesFor`).
- The line is pasted twice into one template, wasting tokens — pinned by Task 1 test `includes the pacing line exactly once per rules string`.
- `verify-brief` reason equality breaks because the template changed shape — pinned by Task 1 verification step running `npx tsx tools/verify-brief.ts` unchanged.
- Someone later edits the line and silently eats reason mode's 2-token headroom — pinned by the exact-line assertion in Task 1 and the budget test; the exact measured counts remain in the verification step output.

---

### Task 1: Add shared pacing line to all coach rules

**Files:**
- Modify: `server/memory/brief.ts:55-102` (four `RULES` constants; add `PACE_RULE` before them)
- Test: `server/memory/brief.test.ts` (add import + three tests)

**Interfaces:**
- Consumes: existing `RULES`, `INTERVIEW_RULES`, `REFLEX_RULES`, `REASON_RULES`, `rulesFor(coach)`, `estimateTokens(text)` from `server/memory/brief.ts`.
- Produces: exported `PACE_RULE: string` with exact value `'\n- Speak slightly slower; pause between clauses.'`; the four constants now contain it exactly once; `rulesFor` and `composeBrief` signatures unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `server/memory/brief.test.ts`: import `INTERVIEW_RULES`, `PACE_RULE`, `REFLEX_RULES`, `RULES` alongside the existing imports, define `const allRules = [['coach', RULES], ['interview', INTERVIEW_RULES], ['reflex', REFLEX_RULES], ['reason', REASON_RULES]] as const;`, then add:

```ts
it('includes the pacing instruction for every coach mode', () => {
  for (const [mode, rules] of allRules) {
    expect(rulesFor(mode)).toBe(rules);
    expect(rules).toContain(PACE_RULE.trim());
  }
});

it('keeps every coach-mode rules inside the 250-token budget', () => {
  for (const [mode, rules] of allRules) {
    expect(estimateTokens(rules)).toBeLessThanOrEqual(250);
  }
});

it('includes the pacing line exactly once per rules string', () => {
  for (const [mode, rules] of allRules) {
    expect(rules.split(PACE_RULE.trim()).length - 1).toBe(1);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/memory/brief.test.ts --reporter=verbose`
Expected: FAIL — import error because `PACE_RULE`, `INTERVIEW_RULES`, `REFLEX_RULES`, `RULES` are not exported yet (or `rules` does not contain the pacing line once the import resolves).

- [ ] **Step 3: Implement the shared constant and interpolate it**

In `server/memory/brief.ts`, export the exact constant before `RULES`:

```ts
export const PACE_RULE = '\n- Speak slightly slower; pause between clauses.';
```

Append `${PACE_RULE}` immediately before the closing backtick of each of `RULES`, `INTERVIEW_RULES`, `REFLEX_RULES`, and `REASON_RULES`. Do not edit `rulesFor`, `joinBrief`, `composeBrief`, the token estimator, or any section budget.

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `npx vitest run server/memory/brief.test.ts --reporter=verbose`
Expected: PASS — 6 tests in this file (3 existing + 3 new).

- [ ] **Step 5: Run the full verification set**

Run these in order and read each output:

```bash
npx tsc --noEmit
npx vitest run --reporter=verbose
npx tsx tools/verify-brief.ts
```

Expected: typecheck clean; 6 files / 31 tests pass (28 existing + 3 new); `verify-brief` prints `OK` with `rules reason ≤ 250 token` at 248 and `brief reason dùng REASON_RULES` PASS.

- [ ] **Step 6: Commit**

```bash
git add server/memory/brief.ts server/memory/brief.test.ts
git commit -m "fix: ask the live coach to speak more slowly"
```

## Plan notes

- Ruling made during self-review: the design doc's verification line says "28 tests unchanged", but TDD requires new tests. This plan adds three and expects 31; cost is only a larger test count, no behavior change.
- The spec header still says `Status: Draft — awaiting approval`; the user approved the design in conversation (`ok`), so this plan treats it as approved and does not edit the header.

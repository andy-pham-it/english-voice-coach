# Speech Pacing — Short Design

Status: Draft — awaiting approval

## Intent

After an afternoon production test, the user reported that the coach speaks too fast and wants a slower pace. Gemini Live API has no documented `speechRate`/`speakingRate` knob (Context7 `/websites/ai_google_dev_gemini-api_live-api` documents only `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`). The cheapest change is to ask the model to speak more slowly in the existing `systemInstruction`.

## Approaches

1. **Client-side playback rate** — set `AudioBufferSourceNode.playbackRate.value` in `src/live.ts` and advance `nextPlayTime` by `buf.duration / rate`. Deterministic and adjustable, but changes only playback, not generation, and needs a UI control. Deferred.
2. **Prompt-based pacing (chosen)** — append one pacing line to each of the four `RULES` constants in `server/memory/brief.ts`, which feed `systemInstruction` via `composeBrief()`. No Live API, token, UI, or client playback changes.
3. **Server-side `speechConfig` rate** — probe for an undocumented rate field. Highest risk: likely rejected or ignored. Rejected.

## Design

- Add `PACE_RULE = '\n- Speak slightly slower; pause between clauses.'` in `server/memory/brief.ts`.
- Interpolate `${PACE_RULE}` into `RULES`, `INTERVIEW_RULES`, `REFLEX_RULES`, and `REASON_RULES` so every coach mode gets the same pacing instruction.
- Measured cost: 12 tokens. Resulting rule budgets: `coach` 149, `interview` 212, `reflex` 170, `reason` 248 — all within the 250-token `rules` section budget. Total brief stays under `BRIEF_BUDGET = 1000`.
- Keep `rulesFor(coach)` and `joinBrief()` unchanged. `tools/verify-brief.ts` compares `reasonBrief.parts.rules === REASON_RULES` and uses the four constants directly, so the shared interpolation preserves it unchanged.
- This is a **fixed slower pace for all sessions**, not a per-session adjustable control. If the user later wants an adjustable speed, approach 1 remains the fallback.

## Goals / Non-goals / Anti-goals

- Goals: slower, clearer speech in every coach mode; no new dependencies; no provider or protocol changes.
- Non-goals: UI slider/presets, client playback-rate control, DB or brief-schema changes, extraction changes.
- Anti-goals: exceeding the 250-token rules budget, changing `verify-brief` expectations, or touching `src/live.ts`.

## Constraints

- `BRIEF_BUDGET = 1000`; `SECTION_BUDGET.rules = 250`.
- `REASON_RULES` ends at 248 tokens with only 2 tokens of headroom; recount if the line is edited.
- Live API `systemInstruction` is set once at setup; no mid-session injection.

## Verification

- `npx tsc --noEmit`
- `npx vitest run --reporter=verbose` (expect 6 files / 28 tests unchanged)
- `npx tsx tools/verify-brief.ts` (expect OK; reason rules still equal `REASON_RULES`)

## Left to the builder

Add the shared constant, interpolate it into the four rule templates, run the three verification commands, and commit with `fix: ask the live coach to speak more slowly`. Per `writing-plans`, a separate implementation plan will follow approval of this doc.

// Prompt cho một call text LLM duy nhất ở cuối phiên. Xem spec §10.6.
// Không chấm phát âm, không bịa lỗi, không dạy lại cả bài — chỉ trích xuất.

import { MAX_CORRECTIONS, MAX_NEW_PHRASES } from './schema.js';

export const EXTRACT_SYSTEM = [
  'You analyse an English-speaking practice transcript between a Vietnamese backend engineer (B1-B2) and an AI tutor.',
  'Your job is extraction, not teaching. Be conservative: a miss you are not sure about is worse than a missed one.',
  '',
  'Rules:',
  '1. Only report an error if it changes meaning or would sound clearly wrong to a native colleague.',
  '2. Skip slips of the tongue that the learner immediately corrected.',
  '3. `wrong` must be copied verbatim from a LEARNER line. Never invent or paraphrase it.',
  '4. `right` is the corrected version of that same sentence, natural spoken English.',
  '5. `pattern` must be one of the allowed enum values. If nothing fits, use vocabulary_choice.',
  '6. `note` explains the rule in Vietnamese, at most 12 words.',
  `7. Return at most ${MAX_CORRECTIONS} corrections, most impactful first. Do not pad the list.`,
  '8. Never comment on pronunciation, accent, speed or confidence.',
  `9. \`new_phrases\`: at most ${MAX_NEW_PHRASES} short phrases the LEARNER used correctly and should reuse. Not phrases the AI said.`,
  '10. `topic` and `summary` are in English; `summary` is 2-3 sentences about what was discussed, not about errors.',
  '11. If the learner made no clear error, return an empty corrections array. That is a valid answer.',
  '12. Reply with a single JSON object only, matching the given shape. No prose, no markdown code fences.',
].join('\n');

export interface TranscriptTurn {
  role: 'user' | 'assistant';
  text: string;
}

export function renderTranscript(turns: TranscriptTurn[]): string {
  return turns
    .filter((t) => t.text.trim())
    .map((t) => `${t.role === 'user' ? 'LEARNER' : 'TUTOR'}: ${t.text.trim()}`)
    .join('\n');
}

export function buildExtractPrompt(
  turns: TranscriptTurn[],
  context: { topicHint?: string | null; durationSec?: number | null; topMistakes?: string[] } = {},
): string {
  const lines: string[] = [];
  if (context.topicHint) lines.push(`Session topic (working title): ${context.topicHint}`);
  if (context.durationSec) lines.push(`Duration: ${Math.round(context.durationSec / 60)} minutes`);
  if (context.topMistakes?.length) {
    lines.push(`Mistakes this learner repeats often, watch for them: ${context.topMistakes.join(', ')}`);
  }
  lines.push('', 'Transcript:', renderTranscript(turns));
  return lines.join('\n');
}

/**
 * Giữ phần đầu và phần cuối khi transcript quá dài. Lỗi lặp thường nằm ở đầu
 * (khi người học còn lúng túng) và ở cuối (khi đã thoải mái), nên cắt giữa.
 */
export function trimTranscript(
  turns: TranscriptTurn[],
  maxChars = 6000,
): TranscriptTurn[] {
  const total = turns.reduce((n, t) => n + t.text.length, 0);
  if (total <= maxChars) return turns;

  const headBudget = Math.floor(maxChars * 0.6);
  const tailBudget = maxChars - headBudget;
  const head: TranscriptTurn[] = [];
  const tail: TranscriptTurn[] = [];
  let h = 0;
  for (const t of turns) {
    if (h + t.text.length > headBudget) break;
    head.push(t);
    h += t.text.length;
  }
  let tl = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    if (tl + t.text.length > tailBudget) break;
    tail.unshift(t);
    tl += t.text.length;
  }
  return [...head, { role: 'assistant', text: '[… middle of the session trimmed …]' }, ...tail];
}

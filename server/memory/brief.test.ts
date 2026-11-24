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

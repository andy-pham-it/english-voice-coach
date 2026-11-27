import { describe, expect, it } from 'vitest';
import { extractionSchema } from './schema';

const base = {
  topic: 'Work conversation',
  summary: 'The learner described a recent migration using clear past tense.',
  corrections: [],
  tomorrow: [],
  used_phrases: [],
  fixed_patterns: [],
};

describe('extractionSchema new_phrases', () => {
  it('accepts a chunk with an English phrase and a Vietnamese gloss', () => {
    const parsed = extractionSchema.parse({
      ...base,
      new_phrases: [{ en: 'take responsibility for', vi: 'chịu trách nhiệm về' }],
    });

    expect(parsed.new_phrases).toEqual([{ en: 'take responsibility for', vi: 'chịu trách nhiệm về' }]);
  });

  it('rejects the old bare-string chunk format', () => {
    expect(() => extractionSchema.parse({ ...base, new_phrases: ['old phrase'] })).toThrow();
  });
});

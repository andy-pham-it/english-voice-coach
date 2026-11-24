import { describe, expect, it } from 'vitest';
import { COACH_MODES } from './schema';

describe('COACH_MODES', () => {
  it('includes reason after reflex', () => {
    expect(COACH_MODES).toEqual(['coach', 'interview', 'reflex', 'reason']);
  });
});

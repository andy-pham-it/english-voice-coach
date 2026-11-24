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

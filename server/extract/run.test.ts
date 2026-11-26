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

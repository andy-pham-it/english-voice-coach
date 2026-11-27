import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ env: vi.fn(), callProvider: vi.fn() }));

vi.mock('../env', () => ({ env: mocks.env }));
vi.mock('./providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./providers')>();
  return { ...actual, callProvider: mocks.callProvider };
});

import { GEMINI_EXTRACT_FALLBACKS } from './providers';
import { extractTranscript, newPhraseVocabValues, pickProvider } from './run';

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

describe('newPhraseVocabValues', () => {
  it('stores the Vietnamese gloss as the drill front for a new chunk', () => {
    const values = newPhraseVocabValues(
      { en: 'take responsibility for', vi: 'chịu trách nhiệm về' },
      0,
      new Date('2026-11-27T00:00:00.000Z'),
    );

    expect(values).toMatchObject({
      phrase: 'take responsibility for',
      example: 'chịu trách nhiệm về',
      count: 1,
    });
  });
});

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

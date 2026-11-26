import { afterEach, describe, expect, it, vi } from 'vitest';
import { callProvider } from './providers';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('callGemini', () => {
  it('retries a 503 once before advancing to the next model', async () => {
    vi.useFakeTimers();
    const attempted: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const model = url.split('/models/')[1]?.split(':')[0] ?? '';
      attempted.push(model);
      if (model === 'gemini-3.8-flash') {
        return new Response('high demand', { status: 503 });
      }
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
          usageMetadata: { totalTokenCount: 42 },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const promise = callProvider({
      provider: 'gemini',
      model: '',
      system: 'sys',
      prompt: 'prompt',
      apiKey: 'key',
    });
    await vi.advanceTimersByTimeAsync(1200);
    const result = await promise;

    expect(result.model).toBe('gemini-3.7-flash');
    expect(result.tokens).toBe(42);
    expect(attempted).toEqual([
      'gemini-3.8-flash',
      'gemini-3.8-flash',
      'gemini-3.7-flash',
    ]);
  });
});

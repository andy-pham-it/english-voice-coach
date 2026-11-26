// Gọi provider text cho bước trích xuất. Groq là chính, Gemini là dự phòng
// (spec §8). Cả hai đều được yêu cầu trả JSON đúng schema, nhưng kết quả vẫn
// phải qua zod — không tin provider.

import { extractionJsonSchema } from './schema.js';

/** Gemini không chấp nhận `additionalProperties` trong responseSchema. */
function stripAdditionalProperties(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripAdditionalProperties);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'additionalProperties') continue;
      out[k] = stripAdditionalProperties(v);
    }
    return out;
  }
  return value;
}

const geminiExtractionSchema = stripAdditionalProperties(extractionJsonSchema);

export type ExtractProvider = 'groq' | 'gemini';

export interface ProviderCall {
  provider: ExtractProvider;
  model: string;
  system: string;
  prompt: string;
  apiKey: string;
  signal?: AbortSignal;
}

export interface ProviderResult {
  text: string;
  model: string;
  tokens: number;
}

export const GROQ_MODEL = 'openai/gpt-oss-120b';
/** Fallback khi model chính 404/429/5xx thay model cho tài khoản mới. */
export const GROQ_FALLBACKS = [
  'openai/gpt-oss-120b',
  'qwen/qwen3.8-27b',
  'openai/gpt-oss-20b',
];
export const GEMINI_EXTRACT_MODEL = 'gemini-3.8-flash';
/** Model text dự phòng, thử lần lượt khi model trước 404/429/5xx. */
export const GEMINI_EXTRACT_FALLBACKS = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3-flash-preview',
];
/** 404 = model đã bị gỡ cho tài khoản mới; 429/5xx = tạm thời. Dùng cho cả Groq và Gemini. */
const SKIP_STATUS = new Set([404, 429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class ProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** Bỏ rào ```json … ``` mà model hay tự thêm, rồi parse. */
export function parseJsonLoose(text: string): unknown {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  return JSON.parse(clean);
}

async function callGroq(call: ProviderCall): Promise<ProviderResult> {
  const preferred = call.model || GROQ_MODEL;
  const models = [preferred, ...GROQ_FALLBACKS.filter((m) => m !== preferred)];
  let last: unknown = null;

  for (const model of models) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${call.apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 3000,
        reasoning_effort: 'low',
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'extraction', strict: true, schema: extractionJsonSchema },
        },
        messages: [
          { role: 'system', content: call.system },
          { role: 'user', content: call.prompt },
        ],
      }),
      signal: call.signal,
    });

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      last = new ProviderError(`Groq ${res.status} (${model}): ${detail}`, res.status);
      if (!SKIP_STATUS.has(res.status)) throw last;
      continue;
    }

    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { total_tokens?: number };
    };
    const text = body.choices?.[0]?.message?.content;
    if (!text) {
      last = new ProviderError(`Groq trả về rỗng (${model})`);
      continue;
    }
    return { text, model, tokens: body.usage?.total_tokens ?? 0 };
  }

  throw last ?? new ProviderError('Groq: mọi model đều fail');
}

async function callGemini(call: ProviderCall): Promise<ProviderResult> {
  const preferred = call.model || GEMINI_EXTRACT_MODEL;
  const models = [preferred, ...GEMINI_EXTRACT_FALLBACKS.filter((m) => m !== preferred)];
  let last: unknown = null;

  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': call.apiKey,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: call.system }] },
          contents: [{ role: 'user', parts: [{ text: call.prompt }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 2000,
            responseMimeType: 'application/json',
            responseSchema: geminiExtractionSchema,
          },
        }),
        signal: call.signal,
      });

      if (!res.ok) {
        const detail = (await res.text()).slice(0, 200);
        last = new ProviderError(`Gemini ${res.status} (${model}): ${detail}`, res.status);
        if (!SKIP_STATUS.has(res.status)) throw last;
        // 503 thường là quá tải tạm thời: thử lại một lần trước khi đổi model.
        if (res.status === 503 && attempt === 0) {
          await sleep(1200);
          continue;
        }
        break;
      }

      const body = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
        usageMetadata?: { totalTokenCount?: number };
      };
      const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('');
      if (!text) {
        last = new ProviderError(`Gemini trả về rỗng (${model})`);
        break;
      }
      return { text, model, tokens: body.usageMetadata?.totalTokenCount ?? 0 };
    }
  }

  throw last ?? new ProviderError('Gemini: mọi model đều fail');
}

export async function callProvider(call: ProviderCall): Promise<ProviderResult> {
  return call.provider === 'groq' ? callGroq(call) : callGemini(call);
}

export { ProviderError };

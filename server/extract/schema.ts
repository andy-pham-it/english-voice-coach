// Schema JSON mà bước trích xuất sau phiên bắt buộc phải trả về.
// Xem spec §10.6. LLM không được tự đặt tên lỗi: `pattern` phải thuộc enum đóng
// 20 giá trị trong `MISTAKE_PATTERNS`, nếu không `count` sẽ không bao giờ cộng.

import { z } from 'zod';
import { MISTAKE_PATTERNS } from '../db/schema.js';

export const MAX_CORRECTIONS = 5;
export const MAX_NEW_PHRASES = 5;
export const MAX_TOMORROW = 3;

/** Nơi câu sẽ được dùng — cố định để client lọc/nhóm mà không phải đoán chuỗi. */
export const TOMORROW_TAGS = ['standup', 'review', 'meeting', 'interview', 'smalltalk'] as const;

export const correctionSchema = z.object({
  wrong: z.string().min(2).max(200),
  right: z.string().min(2).max(200),
  pattern: z.enum(MISTAKE_PATTERNS),
  note: z.string().max(160).default(''),
});

/** Một câu tiếng Anh dùng được ở chỗ làm, kèm nghĩa tiếng Việt và ngữ cảnh. */
export const tomorrowSchema = z.object({
  en: z.string().min(8).max(120),
  vi: z.string().min(4).max(120),
  tag: z.enum(TOMORROW_TAGS),
});

export const extractionSchema = z.object({
  topic: z.string().min(3).max(120),
  summary: z.string().min(10).max(600),
  corrections: z.array(correctionSchema).max(MAX_CORRECTIONS).default([]),
  new_phrases: z.array(z.string().min(2).max(80)).max(MAX_NEW_PHRASES).default([]),
  tomorrow: z.array(tomorrowSchema).max(MAX_TOMORROW).default([]),
  used_phrases: z.array(z.string().min(2).max(80)).max(5).default([]),
});

export type Correction = z.infer<typeof correctionSchema>;
export type TomorrowPhrase = z.infer<typeof tomorrowSchema>;
export type Extraction = z.infer<typeof extractionSchema>;

/**
 * JSON Schema cho provider hỗ trợ structured output (Gemini `responseSchema`,
 * Groq `json_schema`). Viết tay thay vì convert từ zod để kiểm soát chặt enum.
 */
export const extractionJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    topic: { type: 'string', description: 'Chủ đề phiên, ≤ 120 ký tự, tiếng Anh' },
    summary: { type: 'string', description: 'Tóm tắt 2–3 câu, tiếng Anh' },
    corrections: {
      type: 'array',
      maxItems: MAX_CORRECTIONS,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          wrong: { type: 'string', description: 'Đúng nguyên văn cụm người học đã nói sai' },
          right: { type: 'string', description: 'Câu/cụm đúng' },
          pattern: { type: 'string', enum: [...MISTAKE_PATTERNS] },
          note: { type: 'string', description: 'Lý do ngắn, tiếng Việt, ≤ 12 từ' },
        },
        required: ['wrong', 'right', 'pattern', 'note'],
      },
    },
    new_phrases: {
      type: 'array',
      maxItems: MAX_NEW_PHRASES,
      items: { type: 'string', description: 'Cụm từ tự nhiên người học đã dùng đúng và nên giữ lại' },
    },
    tomorrow: {
      type: 'array',
      maxItems: MAX_TOMORROW,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          en: { type: 'string', description: 'Câu tiếng Anh hoàn chỉnh, dùng được ở chỗ làm' },
          vi: { type: 'string', description: 'Nghĩa tiếng Việt, ≤ 15 từ' },
          tag: { type: 'string', enum: [...TOMORROW_TAGS], description: 'Nơi câu được dùng' },
        },
        required: ['en', 'vi', 'tag'],
      },
    },
    used_phrases: {
      type: 'array',
      maxItems: 5,
      items: { type: 'string', description: 'Cụm trong danh sách Due for review mà người học đã dùng đúng' },
    },
  },
  required: ['topic', 'summary', 'corrections', 'new_phrases', 'tomorrow', 'used_phrases'],
} as const;

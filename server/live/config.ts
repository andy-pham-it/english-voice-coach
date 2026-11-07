// Cấu hình Live API do server dựng — client không tự quyết định hành vi.
// Xem spec §12. VAD và systemInstruction chỉ gửi được một lần lúc setup,
// nên mọi thay đổi đều phải reconnect.

export const LIVE_MODEL = 'models/gemini-3.8-live';

/** Thứ tự thử khi model chính fail lúc setup — spec §8. */
export const LIVE_MODEL_FALLBACKS = [
  'models/gemini-3.8-live',
  'models/gemini-2.5-flash-native-audio-latest',
] as const;

export const DEFAULT_VOICE = 'Puck';

/**
 * 900ms đã thử và gây cắt lời khi người dùng ngừng lấy hơi; 1300ms là mặc định.
 * Đây là tham số đã chứng minh trên spike, đừng hạ xuống khi chưa đo lại.
 */
export const DEFAULT_VAD = {
  silenceDurationMs: 1300,
  prefixPaddingMs: 300,
  startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
  endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
} as const;

export interface VadConfig {
  silenceDurationMs: number;
  prefixPaddingMs: number;
  startOfSpeechSensitivity: string;
  endOfSpeechSensitivity: string;
}

export interface LiveSetup {
  model: string;
  generationConfig: {
    responseModalities: ['AUDIO'];
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } };
  };
  systemInstruction: { parts: { text: string }[] };
  inputAudioTranscription: Record<string, never>;
  outputAudioTranscription: Record<string, never>;
  realtimeInputConfig: { automaticActivityDetection: VadConfig };
}

export interface LiveConfigOptions {
  /** Nguyên văn brief đã biên soạn — thứ duy nhất AI đọc lúc bắt đầu. */
  brief: string;
  model?: string;
  voice?: string;
  vad?: Partial<VadConfig>;
}

/**
 * Khối setup gửi kèm ephemeral token. Server gọi hàm này một lần cho mỗi
 * phiên; client nhận token chứ không nhận khối này.
 */
export function buildLiveConfig(options: LiveConfigOptions): LiveSetup {
  return {
    model: options.model ?? LIVE_MODEL,
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: options.voice ?? DEFAULT_VOICE } },
      },
    },
    systemInstruction: { parts: [{ text: options.brief }] },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    realtimeInputConfig: {
      automaticActivityDetection: { ...DEFAULT_VAD, ...options.vad },
    },
  };
}

/** Setup tối thiểu client vẫn phải gửi — config thật lấy từ token. */
export function clientSetup(model: string = LIVE_MODEL): { setup: { model: string } } {
  return { setup: { model } };
}

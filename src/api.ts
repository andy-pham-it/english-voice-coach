export interface Recap {
  mistakes: Array<{ pattern: string; wrong: string; right: string; count: number; lastSeen: string }>;
  dueVocab: string[];
}

// Đây là đúng những field server trả về (server/app.ts dựng JSON tay, dùng
// snake_case cho hai field này). Đừng "chuẩn hoá" interface mà không sửa route:
// lệch tên field là session_id thành undefined và cả phiên không được lưu.
export interface StartResult {
  resumed: boolean;
  session_id: number;
  started_at: string;
  topic: string | null;
  brief: string;
  brief_tokens: number;
  recap: Recap;
  live: { token: string; socket: string; expiresAt: string };
  model: string;
}

export interface ContextResult {
  profile: string;
  brief: string | null;
  briefTokens: number | null;
  briefSessionId: number | null;
  mistakes: Array<{ id: number; pattern: string; wrong: string; right: string; count: number; lastSeen: string }>;
  dueVocab: Array<{ id: number; phrase: string; example: string | null; count: number }>;
  week: { minutes: number; sessions: number };
  today: { audioSec: number; tokens: number; extractRequests: number };
}

export interface TurnEvent {
  role: 'user' | 'assistant';
  text: string;
  audioMs?: number;
  createdAt: string;
}

export interface CorrectionItem {
  wrong: string;
  right: string;
  pattern: string;
  note: string;
}

export interface TomorrowPhrase {
  en: string;
  vi: string;
  tag: string;
}

export interface EndResult {
  sessionId: number;
  status: string;
  durationSec: number;
  alreadyEnded: boolean;
  summary: string | null;
  topic: string | null;
  extract: 'done' | 'failed' | 'timeout' | 'skipped';
  corrections: number;
  items?: CorrectionItem[];
  phrases?: string[];
  tomorrow?: TomorrowPhrase[];
  error?: string;
}

export interface SessionListItem {
  id: number;
  topic: string | null;
  summary: string | null;
  status: string;
  mode: string | null;
  startedAt: string;
  durationSec: number | null;
  corrections: number;
}

export interface SessionTurn {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  corrections: CorrectionItem[] | null;
  createdAt: string;
}

export interface SessionDetail extends SessionListItem {
  endedAt: string | null;
  brief: string | null;
  briefTokens: number | null;
  turns: SessionTurn[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
  ) {
    // message dùng để hiện cho người dùng: ưu tiên thông báo cụ thể của server
    // ("Session 26 không có lượt nào để trích xuất") hơn mã lỗi chung.
    super(detail || code);
    this.name = 'ApiError';
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    credentials: 'same-origin',
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      body?.error ?? `http_${res.status}`,
      typeof body?.message === 'string' ? body.message : undefined,
    );
  }
  return body as T;
}

export const api = {
  authStatus: () => req<{ ok: boolean; auth: 'disabled' | 'enabled' }>('/api/auth/status'),
  login: (code: string) => req<{ ok: boolean }>('/api/auth', { method: 'POST', body: JSON.stringify({ code }) }),
  logout: () => req<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  start: (mode: 'duplex' | 'ptt', topic?: string) =>
    req<StartResult>('/api/session/start', {
      method: 'POST',
      body: JSON.stringify(topic ? { mode, topic } : { mode }),
    }),
  events: (id: number, payload: { turns?: TurnEvent[]; usage?: { audioSec?: number; tokens?: number } }) =>
    req<{ ok: boolean }>(`/api/session/${id}/events`, { method: 'POST', body: JSON.stringify(payload) }),
  rebrief: (id: number) =>
    req<{ brief: string; brief_tokens: number; live: StartResult['live'] }>(`/api/session/${id}/rebrief`, {
      method: 'POST',
    }),
  end: (id: number, durationSec: number) =>
    req<EndResult & { ok?: boolean }>(`/api/session/${id}/end`, {
      method: 'POST',
      body: JSON.stringify({ durationSec }),
    }),
  extract: (id: number) =>
    req<{ ok?: boolean; extract?: string; summary: string | null; topic?: string; corrections?: number; items?: CorrectionItem[]; phrases?: string[]; tomorrow?: TomorrowPhrase[] }>(
      `/api/session/${id}/extract`,
      { method: 'POST' },
    ),
  context: () => req<ContextResult>('/api/context'),
  listSessions: (limit = 20) => req<{ sessions: SessionListItem[] }>(`/api/sessions?limit=${limit}`),
  sessionDetail: (id: number) => req<SessionDetail>(`/api/sessions/${id}`),
  saveProfile: (contentMd: string) =>
    req<{ ok: boolean }>('/api/context/profile', { method: 'PUT', body: JSON.stringify({ contentMd }) }),
  removeMistake: (id: number) => req<{ ok: boolean }>(`/api/mistakes/${id}`, { method: 'DELETE' }),
};

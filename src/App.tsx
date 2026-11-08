import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, type ContextResult, type EndResult, type SessionDetail, type SessionListItem, type StartResult, type TurnEvent } from './api';
import { LiveSession, type LiveStatus } from './live';
import { probeMicrophone, type MicProbe } from './mic';

type View = 'home' | 'session' | 'summary' | 'context' | 'history';

const fmtTime = (sec: number): string =>
  `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;

const STATUS_LABEL: Record<LiveStatus, string> = {
  connecting: 'đang kết nối',
  ready: 'sẵn sàng',
  listening: 'đang nghe bạn',
  'ai-speaking': 'AI đang nói',
  error: 'lỗi',
  closed: 'đã đóng',
};

export default function App() {
  const [view, setView] = useState<View>('home');
  const [ctx, setCtx] = useState<ContextResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);

  const loadContext = useCallback(async () => {
    try {
      setCtx(await api.context());
      setLoadError(null);
      setNeedsAuth(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setNeedsAuth(true);
      else setLoadError(e instanceof Error ? e.message : 'không tải được dữ liệu');
    }
  }, []);

  useEffect(() => {
    void loadContext();
  }, [loadContext]);

  if (needsAuth) return <Login onDone={loadContext} />;

  return (
    <div className="app">
      <nav className="tabs">
        {(['home', 'history', 'context'] as const).map((v) => (
          <button key={v} className={view === v ? 'tab on' : 'tab'} onClick={() => setView(v)}>
            {v === 'home' ? 'Home' : v === 'history' ? 'History' : 'Context'}
          </button>
        ))}
        {view === 'session' && <span className="tab on">Session</span>}
        {view === 'summary' && <span className="tab on">Summary</span>}
      </nav>

      {loadError && <p className="error">{loadError}</p>}

      {view === 'home' && ctx && (
        <Home
          ctx={ctx}
          onStart={(mode, topic) => {
            sessionStorage.setItem('mode', mode);
            sessionStorage.setItem('topic', topic ?? '');
            setView('session');
          }}
        />
      )}

      {view === 'session' && <Session onFinished={() => { setView('summary'); void loadContext(); }} />}

      {view === 'summary' && <Summary onContext={() => setView('context')} onHome={() => setView('home')} />}

      {view === 'history' && <History />}

      {view === 'context' && ctx && (
        <Context ctx={ctx} reload={loadContext} />
      )}

      {!ctx && view !== 'session' && !loadError && <p className="hint">đang tải…</p>}
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="app narrow"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api.login(code);
          onDone();
        } catch {
          setError('sai access code');
        }
      }}
    >
      <h1>English Voice Coach</h1>
      <label htmlFor="code">Access code</label>
      <input id="code" type="password" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
      {error && <p className="error">{error}</p>}
      <button type="submit">Vào</button>
    </form>
  );
}

function Home({
  ctx,
  onStart,
}: {
  ctx: ContextResult;
  onStart: (mode: 'duplex' | 'ptt', topic?: string) => void;
}) {
  const [topic, setTopic] = useState('');
  const [mic, setMic] = useState<{ busy: boolean; result: MicProbe | null }>({ busy: false, result: null });

  const chips = ['daily standup', 'code review', 'technical disagreement', 'job interview'];

  const checkMic = async () => {
    setMic({ busy: true, result: null });
    try {
      setMic({ busy: false, result: await probeMicrophone() });
    } catch (e) {
      setMic({
        busy: false,
        result: { ok: false, level: 0, devices: 0, detail: e instanceof Error ? e.message : 'kiểm tra micro lỗi' },
      });
    }
  };

  return (
    <main className="stack">
      <section className="card">
        <h1>Hôm nay nói gì?</h1>
        <p className="hint">
          Tuần này: {ctx.week.minutes} phút · {ctx.week.sessions} phiên · hôm nay {Math.round(ctx.today.audioSec / 60)} phút
        </p>
        <label htmlFor="topic">Chủ đề (để trống thì app tự chọn)</label>
        <input
          id="topic"
          value={topic}
          maxLength={120}
          placeholder="ví dụ: explaining a database migration to my manager"
          onChange={(e) => setTopic(e.target.value)}
        />
        <div className="chips">
          {chips.map((c) => (
            <button key={c} type="button" className="chip" onClick={() => setTopic(c)}>
              {c}
            </button>
          ))}
        </div>
        <div className="row">
          <button className="primary" onClick={() => onStart('duplex', topic.trim() || undefined)}>
            Bắt đầu 10 phút
          </button>
          <button onClick={() => onStart('ptt', topic.trim() || undefined)}>Push-to-talk</button>
        </div>
        <div className="row">
          <button className="link" onClick={checkMic} disabled={mic.busy}>
            {mic.busy ? 'đang kiểm tra micro…' : 'Kiểm tra micro'}
          </button>
          {mic.result && (
            <span className={mic.result.ok ? 'hint ok' : 'error'}>
              {mic.result.detail}
              {mic.result.devices > 1 ? ` (${mic.result.devices} micro)` : ''}
            </span>
          )}
        </div>
      </section>

      <section className="card">
        <h2>Phiên trước sẽ được nhắc</h2>
        {ctx.mistakes.length === 0 && <p className="hint">chưa có lỗi nào được ghi</p>}
        <ul className="list">
          {ctx.mistakes.slice(0, 5).map((m) => (
            <li key={m.id}>
              <code>{m.pattern}</code> ×{m.count}
              <div>
                <s>{m.wrong}</s> → <b>{m.right}</b>
              </div>
            </li>
          ))}
        </ul>
        {ctx.dueVocab.length > 0 && (
          <p className="hint">Đến hạn ôn: {ctx.dueVocab.map((v) => v.phrase).join(' · ')}</p>
        )}
      </section>
    </main>
  );
}

interface Line {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
}

function Session({ onFinished }: { onFinished: () => void }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const [detail, setDetail] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [duplex, setDuplex] = useState(sessionStorage.getItem('mode') !== 'ptt');
  const [rebriefing, setRebriefing] = useState(false);
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const liveRef = useRef<LiveSession | null>(null);
  const startedRef = useRef<{ id: number; model: string } | null>(null);
  const startRef = useRef<Promise<StartResult> | null>(null);
  const sentRef = useRef(0);
  const linesRef = useRef<Line[]>([]);
  const lastRoleRef = useRef<'user' | 'assistant' | null>(null);
  const seqRef = useRef(1);

  linesRef.current = lines;

  const append = useCallback((role: 'user' | 'assistant', text: string) => {
    setLines((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === role && lastRoleRef.current === role) {
        const merged = [...prev];
        merged[merged.length - 1] = { ...last, text: last.text + text };
        return merged;
      }
      lastRoleRef.current = role;
      return [...prev, { id: seqRef.current++, role, text, createdAt: new Date().toISOString() }];
    });
  }, []);

  const flush = useCallback(async () => {
    const started = startedRef.current;
    if (!started) return;
    const pending = linesRef.current.slice(sentRef.current);
    if (pending.length === 0) return;
    sentRef.current = linesRef.current.length;
    const turns: TurnEvent[] = pending.map((l) => ({ role: l.role, text: l.text, createdAt: l.createdAt }));
    try {
      await api.events(started.id, { turns });
    } catch {
      sentRef.current -= pending.length; // gửi lại ở lần sau
    }
  }, []);

  const connect = useCallback(
    (started: StartResult) => {
      const live = new LiveSession({
        onStatus: (s, d) => {
          setStatus(s);
          setDetail(d ?? null);
        },
        onUserText: (t) => append('user', t),
        onAiText: (t) => append('assistant', t),
        onInterrupted: () => setLines((prev) => prev),
        onUsage: () => undefined,
      });
      liveRef.current = live;
      live.setDuplex(duplex);
      live.connect(started.live.socket, started.model);
    },
    [append, duplex],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // StrictMode ở dev mount effect hai lần; nếu gọi api.start hai lần thì
      // tạo hai row session (đã gặp: id 25 và 26). Giữ một promise dùng chung.
      startRef.current ??= api.start(duplex ? 'duplex' : 'ptt', sessionStorage.getItem('topic') || undefined);
      const started = await startRef.current;
      if (cancelled) return;
      const sessionId = started.session_id;
      if (!Number.isInteger(sessionId)) throw new Error('server không trả session_id');
      startedRef.current = { id: sessionId, model: started.model };
      sessionStorage.setItem('session_id', String(sessionId));
      connect(started);
    })().catch((e) => setError(e instanceof Error ? e.message : 'không kết nối được'));

    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    const flusher = setInterval(() => void flush(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      clearInterval(flusher);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Giữ màn hình sáng: Android tắt màn hình là Chrome treo mic và phiên chết.
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    let released = false;

    const acquire = async () => {
      if (released || document.visibilityState !== 'visible') return;
      try {
        lock = await navigator.wakeLock?.request('screen') ?? null;
      } catch { /* pin yếu hoặc trình duyệt từ chối — không chặn phiên */ }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      released = true;
      document.removeEventListener('visibilitychange', onVisibility);
      void lock?.release().catch(() => {});
    };
  }, []);

  useEffect(() => {
    liveRef.current?.setDuplex(duplex);
    sessionStorage.setItem('mode', duplex ? 'duplex' : 'ptt');
  }, [duplex]);

  const end = async () => {
    if (ending) return;
    setEnding(true);
    await flush();
    liveRef.current?.disconnect();
    const id = startedRef.current?.id;
    if (id) {
      try {
        const result = await api.end(id, seconds);
        sessionStorage.setItem('summary', result.summary ?? '');
        sessionStorage.setItem('summary_extract', result.extract);
        sessionStorage.setItem('summary_data', JSON.stringify(result));
        sessionStorage.setItem('summary_session', String(id));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'không kết thúc được phiên');
        setEnding(false);
        return;
      }
    }
    onFinished();
  };

  const rebrief = async () => {
    const id = startedRef.current?.id;
    if (!id || rebriefing) return;
    setRebriefing(true);
    try {
      await flush();
      const { live } = await api.rebrief(id);
      liveRef.current?.reconnect(live.socket, startedRef.current!.model);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'không nạp lại được ngữ cảnh');
    } finally {
      setRebriefing(false);
    }
  };

  return (
    <main className="stack session">
      <div className="session-head">
        <span className={status === 'error' ? 'dot error' : 'dot'} />
        <b>{fmtTime(seconds)}</b>
        <span className="hint">{STATUS_LABEL[status]}{detail && status === 'closed' ? ` (${detail})` : ''}</span>
      </div>

      <div className="transcript" aria-live="polite">
        {lines.map((l) => (
          <p key={l.id} className={l.role === 'user' ? 'bubble user' : 'bubble ai'}>
            {l.text}
          </p>
        ))}
        {lines.length === 0 && <p className="hint">Bắt đầu nói khi trạng thái là “sẵn sàng”.</p>}
      </div>

      <label className="switch">
        <input type="checkbox" checked={duplex} onChange={(e) => setDuplex(e.target.checked)} />
        Luôn mở mic (cần tai nghe)
      </label>

      {duplex ? (
        <p className="hint center">Đang full-duplex — cứ nói, AI sẽ tự nhường lượt.</p>
      ) : (
        <button
          className="talk"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            liveRef.current?.startTalking();
          }}
          onPointerUp={() => liveRef.current?.stopTalking()}
          onPointerLeave={() => liveRef.current?.stopTalking()}
        >
          Giữ để nói
        </button>
      )}

      <div className="row">
        <button onClick={() => void rebrief()} disabled={rebriefing || status === 'closed'}>
          {rebriefing ? 'đang nạp lại…' : 'Nhắc AI'}
        </button>
        <button className="danger" onClick={() => void end()} disabled={ending}>
          {ending ? 'đang xử lý…' : 'End'}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </main>
  );
}

function Summary({ onContext, onHome }: { onContext: () => void; onHome: () => void }) {
  const [data, setData] = useState<EndResult | null>(() => {
    try {
      return JSON.parse(sessionStorage.getItem('summary_data') || 'null') as EndResult | null;
    } catch {
      return null;
    }
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const id = Number(sessionStorage.getItem('summary_session') || 0) || data?.sessionId || 0;
  const minutes = data?.durationSec ? Math.max(1, Math.round(data.durationSec / 60)) : 0;

  const retry = async () => {
    if (!id || busy) return;
    setBusy(true);
    setErr('');
    try {
      const result = await api.extract(id);
      const next: EndResult = {
        ...(data ?? { sessionId: id, status: 'ended', durationSec: minutes * 60, alreadyEnded: true, corrections: 0 }),
        summary: result.summary,
        topic: result.topic ?? data?.topic ?? null,
        extract: 'done',
        items: result.items,
        phrases: result.phrases,
      };
      setData(next);
      sessionStorage.setItem('summary', next.summary ?? '');
      sessionStorage.setItem('summary_extract', 'done');
      sessionStorage.setItem('summary_data', JSON.stringify(next));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'chạy lại không được');
    } finally {
      setBusy(false);
    }
  };

  const pending = data ? data.extract !== 'done' && data.extract !== 'skipped' : false;

  // Tự chạy lại một lần khi lần end trước timeout/fail, để người dùng không
  // phải bấm "Phân tích lại". Chỉ một lần: không đốt request LLM lặp lại.
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current || !id || !pending) return;
    autoRan.current = true;
    void retry();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="stack">
      <section className="card">
        <h1>Xong phiên</h1>
        <p className="hint">
          {data?.topic ? data.topic : 'chưa rõ chủ đề'}
          {minutes ? ` · ${minutes} phút` : ''}
        </p>
        {data?.summary ? <p>{data.summary}</p> : <p className="hint">Chưa phân tích xong — nội dung phiên vẫn đã được lưu.</p>}

        {pending && (
          <div className="row">
            <button onClick={retry} disabled={busy}>
              {busy ? 'đang phân tích…' : 'Phân tích lại'}
            </button>
            {err && <span className="error">{err}</span>}
          </div>
        )}

        {(data?.items?.length ?? 0) > 0 && (
          <>
            <h2>Lỗi đã sửa</h2>
            <ul className="list">
              {data!.items!.map((c, i) => (
                <li key={i}>
                  <s>{c.wrong}</s> → {c.right}
                  <div className="hint">
                    {c.pattern}
                    {c.note ? ` · ${c.note}` : ''}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}

        {(data?.phrases?.length ?? 0) > 0 && (
          <>
            <h2>Cụm từ đáng nhớ</h2>
            <p>{data!.phrases!.join(' · ')}</p>
          </>
        )}

        <div className="row">
          <button onClick={onContext}>Xem Context</button>
          <button className="primary" onClick={onHome}>
            Về Home
          </button>
        </div>
      </section>
    </main>
  );
}

function Context({ ctx, reload }: { ctx: ContextResult; reload: () => Promise<void> }) {
  const [draft, setDraft] = useState(ctx.profile);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => setDraft(ctx.profile), [ctx.profile]);

  const tokenLine = useMemo(
    () => `Brief hiện tại: ${ctx.briefTokens ?? 0} tokens${ctx.briefSessionId ? ` (phiên #${ctx.briefSessionId})` : ''}`,
    [ctx.briefTokens, ctx.briefSessionId],
  );

  return (
    <main className="stack">
      <section className="card">
        <h2>Profile</h2>
        <p className="hint">Markdown. Càng cụ thể càng tốt — đây là thứ AI đọc mỗi phiên.</p>
        <textarea rows={12} value={draft} onChange={(e) => setDraft(e.target.value)} />
        <div className="row">
          <button
            className="primary"
            disabled={saving || draft === ctx.profile}
            onClick={async () => {
              setSaving(true);
              try {
                await api.saveProfile(draft);
                await reload();
                setSaved(true);
                setTimeout(() => setSaved(false), 1500);
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? 'đang lưu…' : 'Lưu profile'}
          </button>
          {saved && <span className="hint">đã lưu</span>}
        </div>
      </section>

      <section className="card">
        <h2>Brief đã nạp</h2>
        <p className="hint">{tokenLine}</p>
        <pre className="brief">{ctx.brief ?? '(chưa có phiên nào)'}</pre>
      </section>

      <section className="card">
        <h2>Lỗi đang lặp</h2>
        {ctx.mistakes.length === 0 && <p className="hint">chưa có</p>}
        <ul className="list">
          {ctx.mistakes.map((m) => (
            <li key={m.id}>
              <code>{m.pattern}</code> ×{m.count}
              <div>
                <s>{m.wrong}</s> → <b>{m.right}</b>
              </div>
              <button
                className="link"
                onClick={async () => {
                  await api.removeMistake(m.id);
                  await reload();
                }}
              >
                xoá
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>Cụm từ</h2>
        {ctx.dueVocab.length === 0 && <p className="hint">chưa có</p>}
        <ul className="list">
          {ctx.dueVocab.map((v) => (
            <li key={v.id}>
              <b>{v.phrase}</b> <span className="hint">×{v.count}</span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

const fmtDate = (iso: string): string =>
  new Date(iso).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

const fmtMinutes = (sec: number | null): string => (sec ? `${Math.max(1, Math.round(sec / 60))} phút` : '');

function History() {
  const [items, setItems] = useState<SessionListItem[] | null>(null);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .listSessions(30)
      .then((r) => {
        if (!cancelled) setItems(r.sessions);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'không tải được lịch sử');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const open = async (id: number) => {
    if (openId === id) {
      setOpenId(null);
      setDetail(null);
      return;
    }
    setOpenId(id);
    setDetail(null);
    setError('');
    setLoading(true);
    try {
      setDetail(await api.sessionDetail(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'không tải được phiên');
    } finally {
      setLoading(false);
    }
  };

  const corrections = detail?.turns.flatMap((t) => t.corrections ?? []) ?? [];

  return (
    <main className="stack">
      <section className="card">
        <h1>Lịch sử</h1>
        {error && <p className="error">{error}</p>}
        {items === null && !error && <p className="hint">đang tải…</p>}
        {items?.length === 0 && <p className="hint">chưa có phiên nào</p>}

        <ul className="list">
          {items?.map((s) => (
            <li key={s.id}>
              <button className="link" onClick={() => void open(s.id)}>
                {openId === s.id ? '▾' : '▸'} {fmtDate(s.startedAt)}
                {s.topic ? ` · ${s.topic}` : ' · chưa rõ chủ đề'}
              </button>
              <div className="hint">
                {fmtMinutes(s.durationSec)}
                {fmtMinutes(s.durationSec) ? ' · ' : ''}
                {s.corrections} lỗi
                {s.status === 'active' ? ' · đang mở' : ''}
              </div>
              {s.summary && openId !== s.id && <div className="hint">{s.summary}</div>}

              {openId === s.id && (
                <div>
                  {loading && <p className="hint">đang tải phiên…</p>}
                  {detail?.id === s.id && (
                    <>
                      {detail.summary && <p>{detail.summary}</p>}
                      {corrections.length > 0 && (
                        <>
                          <h2>Lỗi đã sửa</h2>
                          <ul className="list">
                            {corrections.map((c, i) => (
                              <li key={i}>
                                <s>{c.wrong}</s> → {c.right}
                                <div className="hint">
                                  {c.pattern}
                                  {c.note ? ` · ${c.note}` : ''}
                                </div>
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                      <h2>Transcript</h2>
                      <div className="transcript">
                        {detail.turns.map((t) => (
                          <p key={t.id} className={t.role === 'user' ? 'bubble user' : 'bubble ai'}>
                            {t.text}
                          </p>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

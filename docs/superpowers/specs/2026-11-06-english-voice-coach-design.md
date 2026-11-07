# English Voice Coach — Design

**Ngày:** 06/11/2026
**Người dùng:** 1 người (chủ dự án), luyện nói tiếng Anh cho công việc
**Trạng thái:** chờ duyệt — bản 2, viết lại sau spike Live API
**Khác bản 1 ở đâu:** §9–§13 đổi từ turn-based (Groq STT + LLM + browser TTS) sang Gemini Live API full-duplex. Lý do và bằng chứng ở §20.

---

## 1. Mục đích và lý do

Tôi luyện nói tiếng Anh mỗi ngày nhưng công cụ hiện tại không nhớ tôi là ai. Mỗi phiên là một lần bắt đầu lại: không biết tôi làm backend engineer, không biết tôi hay nói sai thì quá khứ, không biết tuần trước đã sửa "I have experience in..." thành "I have experience with...".

Kết quả là luyện 30 phút vẫn loanh quanh, vì không có vòng lặp: **nói → phát hiện lỗi → nhớ lỗi → gặp lại lỗi → sửa**.

App này tồn tại để đóng vòng lặp đó. Trí nhớ là tính năng chính, không phải phụ.

## 2. Ai dùng

Một người: kỹ sư phần mềm Việt Nam, trình độ B1–B2, cần nói tiếng Anh trong các tình huống công việc thật:

- standup hằng ngày (kể đã làm gì, đang làm gì, bị chặn gì)
- giải thích một quyết định kỹ thuật và bảo vệ nó khi bị hỏi lại
- small talk với đồng nghiệp nước ngoài
- phỏng vấn / trao đổi với khách hàng

Thiết bị chính: **Android + Chrome**. Thiết bị phụ: Mac + Chrome.

## 3. Mục tiêu

| # | Mục tiêu | Cách đo |
|---|---|---|
| G1 | Nói được 20 phút liên tục trên điện thoại | 10 phiên liên tiếp không lỗi mic, không crash |
| G2 | Độ trễ cảm nhận ≤ 1.5s | p50 `first audio` sau khi hết câu, đo ở chế độ push-to-talk |
| G3 | AI nhớ lỗi cũ | Phiên N+1 nhắc ≥ 3/5 lỗi của phiên N mà không cần tôi gợi ý |
| G4 | Trí nhớ nhìn thấy và sửa được | Tab Context hiển thị đúng khối text đã nạp + edit được |
| G5 | Chi phí 0đ | Không vượt free tier nào trong 30 ngày |
| G6 | AI không cắt lời | `early_responses = 0` trong 5 phút nói liên tục |

## 4. Không nằm trong phạm vi (non-goals)

- Không phải app học từ vựng kiểu Anki. SRS có, nhưng chỉ để chọn cụm từ nhắc lại, không có UI ôn tập riêng ở MVP.
- Không chấm điểm phát âm, không so sánh waveform. (Shadowing cần pipeline riêng — xem `docs/02-test-plan.md` §3.2.)
- Không multi-user, không đăng ký, không chia sẻ.
- Không lưu file audio.
- Không có app native. Chỉ PWA-able web.
- Không làm đồng bộ offline. Mất mạng thì dừng phiên, không xếp hàng lượt nói.

## 5. Anti-goals (nếu thành ra thế này thì là thất bại)

- **Chậm.** Nếu phải chờ 8–10s mỗi lượt thì sẽ bỏ sau 2 ngày.
- **AI cắt lời.** Nếu AI chen vào khi tôi còn đang nói, cảm giác tệ hơn cả chậm. Đây là lỗi đã gặp thật ở lần test đầu.
- **Nói chuyện với AI mà không có sửa lỗi.** Nếu AI chỉ trả lời như chatbot, không có giá trị gì hơn ChatGPT voice.
- **Trí nhớ là hộp đen.** Nếu không thấy được AI đang đọc gì, tôi sẽ không tin nó và không sửa được nó.
- **Context phình ra.** Nếu nhồi cả lịch sử vào system instruction, mỗi phiên lại đắt thêm và model bắt đầu lờ chỉ dẫn.

## 6. Ràng buộc

- **0đ.** Chỉ dùng free tier: Gemini API free, Vercel Hobby (non-commercial), Neon free.
- **`getUserMedia` chỉ chạy trong secure context.** `http://192.168.x.x` trên Android không xin được micro. Dev trên Mac dùng `localhost`; test trên điện thoại phải qua HTTPS thật.
- **Gemini Live API free tier** (đo 06/11/2026): các model Live hiển thị `Unlimited RPM / Unlimited RPD`, nhưng **TPM hữu hạn (65K cho `gemini-3.8-live`)**. Con số này có thể đổi; phải đọc lại trang rate limit trước khi tin.
- **Live API chỉ nhận cấu hình một lần lúc setup.** `systemInstruction` không sửa được giữa phiên. Đây là ràng buộc định hình toàn bộ §10.
- **Định dạng audio bắt buộc:** vào PCM16 mono 16kHz, ra PCM16 mono 24kHz. Chrome Android không tôn trọng `AudioContext({ sampleRate: 16000 })` — phải resample thủ công.
- **Không được để API key trong trình duyệt.** Bản deploy phải dùng ephemeral token do server cấp (§15).
- **Vercel Hobby** không có disk bền, function tối đa 300s, 2GB RAM. Không cho phép dùng thương mại.
- **Neon** ở Singapore (`ap-southeast-1`). Compute ngủ sau ~5 phút idle → truy vấn đầu phiên chậm thêm ~500ms.
- **Chrome Android** là môi trường chính. WebSocket + AudioWorklet + `getUserMedia` đều đã chạy được trên đó.
- **Thời gian:** MVP phải chạy được trong ~2 ngày làm việc.

## 7. Các phương án đã cân nhắc

### Phương án A — App mới, voice-first, tự host ✅ (đã chọn)

Web app riêng, memory 3 lớp, hội thoại qua Gemini Live API, phân tích sau phiên bằng text LLM.

- **Được:** kiểm soát hoàn toàn trí nhớ; chạy được trên Android; dữ liệu là Postgres, dump ra file `.sql`; không phụ thuộc nền tảng nào cho phần "nhớ"; độ trễ thấp và gần như không tốn token.
- **Mất:** phụ thuộc vào độ ổn định của Live API; không chèn được ngữ cảnh giữa phiên; phải tự làm pipeline audio PCM.
- **Vì sao chọn:** phương án duy nhất giải quyết đúng nguyên nhân gốc (memory thuộc về mình), và đã chứng minh chạy được thật (§20).

### Phương án B — Mở rộng ProEnglish (`~/personal/learning-english-tool`)

Project cũ đã có Angular 18 + Firebase + Gemini, SRS SM-2, shadowing, minigames.

- **Được:** có sẵn auth, dashboard, SRS, deploy.
- **Mất:** codebase Angular nặng, gắn Firebase + Gemini, phải nhét mô hình dữ liệu memory vào kiến trúc đã chốt. Thời gian > 2 ngày.
- **Vì sao loại:** mục tiêu là memory + voice, không phải học từ vựng.

### Phương án C — Không code, dùng ChatGPT + file profile thủ công

- **Được:** 0 giờ dev, làm được ngay.
- **Mất:** mỗi phiên phải dán profile, cuối phiên tự viết summary, không có số liệu lỗi lặp lại, voice mode không đọc memory ổn định.
- **Vì sao loại (nhưng vẫn dùng song song):** fallback trong lúc app chưa xong.

### Phương án D — Turn-based (Groq STT → LLM → browser TTS) ❌ đã loại sau spike

- **Được:** kiểm soát từng bước, dễ debug, thay provider từng phần.
- **Mất:** 3 chặng nối tiếp nên cộng dồn độ trễ; ~30K token/phiên; rate limit Groq 200K TPD chặn ở 6 phiên/ngày; không nói chen ngang được.
- **Vì sao loại:** đo thực tế Live API rẻ hơn ~20 lần và mượt hơn. Chi tiết §20.

## 8. Hạ tầng: đã cân nhắc và chốt

| | Vercel + Neon ✅ | Cloudflare Workers + D1 | AWS Lambda |
|---|---|---|---|
| Free request | 100GB-hours, 300s/function | 100k/ngày | 1M/tháng vĩnh viễn |
| Free DB | 0.5GB Postgres, 1 project | 5GB SQLite | không có DB kèm |
| Giới hạn chí mạng | compute ngủ sau ~5 phút idle → **cold start ~500ms** | **10ms CPU/request** | phải tự dựng DB |
| Full-text | `tsvector` + GIN index | FTS5 nhưng export fail | tự viết |
| Backup | `pg_dump` → `.sql`, Neon có branch + restore window | export fail nếu có bảng FTS5 | tự viết |
| Setup | **~5 phút, không cần CLI** | 2–3 giờ | 2–4 giờ |

**Chốt: Vercel + Neon.** Postgres chuẩn, Drizzle hỗ trợ hạng nhất, Neon có branch nên tách dev/prod không cần Postgres local.

**Đã đánh đổi:** bỏ SQLite/FTS5 để lấy Postgres; full-text giờ là generated column + GIN. Cold start ~500ms là thật → `session/start` phải hiện "đang khởi động" nếu quá 1s.

**Điều kiện chuyển sang Cloudflare:** có người dùng thứ hai, hoặc bắt đầu thu tiền.

**Backup:** GitHub Actions cron hằng ngày, `pg_dump "$DATABASE_URL_UNPOOLED" --no-owner --no-privileges > backup-$(date +%F).sql`, commit repo private. Lớp hai là restore window của Neon.

### Môi trường đã deploy (07/11/2026)

| Thứ | URL | Ghi chú |
|---|---|---|
| App | `https://english-voice-coach-five.vercel.app` | Vite build + `api/index.ts` (`@vercel/node`), Neon `production` |
| Spike | `https://spike-ecru-six.vercel.app` | HTML tĩnh, project Vercel riêng |

- `ACCESS_CODE=andy-b7f6` — đổi trước khi cho ai khác dùng.
- 6 env production: `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `GEMINI_API_KEY`, `ACCESS_CODE`, `AUTH_SECRET`, `SPIKE_LOG_KEY`.
- **`vercel.json` phải dùng `builds`/`routes` legacy**, không dùng `buildCommand`/`rewrites`: preset Vite tự chèn route `^/api(/.*)?$ → 404` và function không được đăng ký.
- Mọi import tương đối trong `server/` và `api/` phải có đuôi `.js` (function build ra ESM); thư mục thì trỏ `index.js`.
- Spike ghi log về `POST /api/spike-log` (header `x-spike-key`), đọc bằng `node tools/spike-runs.mjs list`.


### Provider AI

| Vai trò | Chọn | Dự phòng | Ghi chú |
|---|---|---|---|
| Hội thoại realtime | Gemini `gemini-3.8-live` | `gemini-2.5-flash-native-audio-latest` | WebSocket, PCM 16k/24k |
| Phân tích sau phiên | Groq `openai/gpt-oss-120b` | Gemini `gemma-4-31b-it` | 1 call/phiên, JSON schema |
| Embedding (v2) | — | Gemini `gemini-embedding-2` | 1.000 RPD |

Đã kiểm tra trong tài khoản: `gemini-3.8-live` chạy được. Các model Live khác có trong tài khoản: `gemini-3.1-flash-live-preview`, `gemini-2.5-flash-native-audio-latest`, `gemini-2.5-flash-native-audio-preview-{09,12}-2025`, `gemini-3.5-transcribe-live`, `gemini-3.5-live-translate-preview`, `gemini-3.8-live-extended-thinking`.

Quy tắc: model Live chính fail khi setup → thử model dự phòng 1 lần → nếu vẫn fail, báo lỗi rõ. Phân tích sau phiên fail → phiên vẫn được lưu, summary để trạng thái `pending` và chạy lại sau.

## 9. Hình dạng sản phẩm

### Luồng một phiên

```
Home  →  Recap card  →  Session (duplex)  →  Summary  →  Home
```

**Recap card** trước khi vào Session: 5 lỗi đang lặp lại và 3 cụm từ đến hạn ôn, lấy thẳng từ DB, không gọi AI. Đây là chỗ G3 kiểm chứng được một cách xác định: card có 5 lỗi thì phiên đó chắc chắn AI đã được nạp 5 lỗi.

### Màn hình

**Home**
- Streak, số phút nói tuần này.
- Nút lớn `Start 10 min`.
- 3 lỗi lặp lại nhiều nhất.
- Link sang Context.

**Session**
- Trên: đồng hồ 10:00, chủ đề phiên, trạng thái kết nối (`đang kết nối / đang nghe / AI đang nói`).
- Giữa: transcript cuộn, có gạch chân chỗ bị sửa (đánh dấu sau phiên, xem §10).
- Dưới: hai chế độ.
  - **Duplex (mặc định):** mic mở liên tục, nói chen ngang được. Bắt buộc tai nghe.
  - **Push-to-talk:** giữ để nói. Dùng khi ồn hoặc khi không có tai nghe.
- Nút `Nhắc AI` — nạp lại ngữ cảnh giữa phiên (§10.4).
- Nút `End`.

**Summary** (tự hiện khi hết giờ, xử lý vài giây)
- Chủ đề đã nói, số lượt, số phút.
- 3 lỗi: sai → đúng → lý do.
- 3 cụm từ mới kèm câu đã dùng.

**Context** (tab riêng)
- **Brief**: đúng khối text đã nhét vào `systemInstruction` phiên gần nhất, kèm số token. Read-only — vì nó là bản chụp, không phải nguồn.
- **Profile**: markdown, edit trực tiếp, kéo-thả `.md`/`.txt`.
- **State**: lỗi lặp lại (pattern, count, last seen), cụm từ đến hạn, phút nói tuần này.
- Dòng tổng: `Brief hiện tại: 1.043 tokens`.
- Nút xoá từng mục.

**History** (sau MVP): danh sách phiên, mở lại summary + transcript.

## 10. Trí nhớ — thiết kế cốt lõi

Live API chỉ nhận `systemInstruction` một lần. Vì vậy trí nhớ không thể "chèn thêm theo từng câu" như bản 1. Nó chuyển thành **hai pha**:

```
cuối phiên N:  transcript → trích xuất có cấu trúc → Postgres
đầu phiên N+1: Postgres → biên soạn brief → systemInstruction
```

Đây là đánh đổi trung tâm của bản 2, ghi rõ ở §19.

### 10.1 Brief — thứ duy nhất AI đọc lúc bắt đầu

Biên soạn từ ba nguồn, theo thứ tự cố định, cắt theo ngân sách token:

```
<rules>        ~250 token   cố định, không đổi giữa các phiên
<profile>      ~250 token   người dùng tự viết
<state>        ~250 token   app tự tính: lỗi lặp, từ đến hạn, streak
<recall>       ~150 token   đoạn summary cũ khớp chủ đề hôm nay
<today>        ~100 token   chủ đề phiên + 1 câu mở đầu gợi ý
---
tổng           ≤ 1.000 token
```

Brief được **lưu nguyên văn** vào `sessions.brief` để tab Context hiển thị đúng thứ AI đã đọc. Không render lại từ dữ liệu — vì dữ liệu có thể đã đổi sau đó.

### 10.2 Lớp 1 — Profile (người tự viết)

```markdown
## Who I am
Backend engineer (Node/TypeScript), 4 years, Vietnam. Team has 6 people, 3 timezones.

## Goals
- Run a 10-minute standup update without freezing.
- Defend a technical decision when challenged.

## Level
B1→B2. Understands fast speech, struggles with past tense and articles when speaking.

## Topics I care about
System design, database performance, code review, hiring, remote work.
```

Giới hạn mềm 1.500 ký tự, UI cảnh báo khi vượt.

### 10.3 Lớp 2 — State (app tự tính)

Không bao giờ do LLM viết. Sinh từ SQL mỗi lần mở phiên:

```
Last session: 2026-11-05, 10 min, topic "sprint planning"
Repeating mistakes (top 5):
  - past_tense (7x, last 11-05)  "I go yesterday" → "I went yesterday"
  - preposition (4x, last 11-04) "explain me" → "explain to me"
Due for review: "push back", "circle back", "on my plate"
This week: 42 min, 4 sessions, 3-day streak
```

Giới hạn cứng: 600 token. Nếu vượt, cắt từ dưới lên.

### 10.4 Lớp 3 — Recall, và cái mất đi

Bản 1 chèn recall theo từng câu người dùng nói. Bản 2 **không làm được** — không có kênh nào để sửa instruction giữa phiên.

Thay bằng ba cơ chế:

1. **Recall lúc mở phiên.** Chủ đề phiên (suy ra từ từ đến hạn + lỗi lặp, xem §12) dùng làm query full-text trên `sessions.summary`. Lấy tối đa 2 đoạn, 150 token.
2. **`Nhắc AI` giữa phiên.** Bấm nút → client đóng WebSocket, gọi `/api/session/:id/rebrief` lấy brief mới (đã cộng transcript tới giờ), mở lại kết nối với instruction mới. Mất ~1–2s, có thông báo "đang nạp lại ngữ cảnh". Đây là van xả khi cuộc nói chuyện đi xa chủ đề.
3. **Không có gì tự động.** Không giả vờ rằng AI "nhớ" thứ nó không được đọc.

Giới hạn đã biết: nếu buổi nói chuyện chuyển chủ đề ở phút thứ 2, AI sẽ không có recall cho chủ đề mới cho tới khi bấm `Nhắc AI`.

### 10.5 Pattern taxonomy (enum đóng)

LLM trích xuất **không được tự đặt tên lỗi**. Schema bắt `pattern` thuộc danh sách cố định; app map sang nhãn hiển thị. Không có enum này, "missing past tense" và "wrong past tense" thành hai lỗi khác nhau và `count` không bao giờ cộng.

| `pattern` | Nghĩa |
|---|---|
| `past_tense` | Sai thì quá khứ |
| `present_perfect` | Sai have/has + V3 |
| `third_person_s` | Thiếu -s ngôi thứ 3 |
| `article` | Thiếu/sai a/an/the |
| `preposition` | Sai giới từ (explain me, discuss about) |
| `plural` | Danh từ đếm được không chia số nhiều |
| `subject_verb_agreement` | Chủ ngữ – động từ không khớp |
| `word_order` | Trật tự từ |
| `missing_auxiliary` | Thiếu do/does/did/is/are |
| `verb_pattern` | Sai dạng sau động từ |
| `countable_uncountable` | information/advice/feedback + s |
| `comparative` | Sai so sánh |
| `conditional` | Sai câu điều kiện |
| `relative_clause` | Sai mệnh đề quan hệ |
| `phrasal_verb` | Sai cụm động từ |
| `vocabulary_choice` | Chọn từ sai nghĩa/sắc thái |
| `register` | Quá informal trong ngữ cảnh công việc |
| `filler_overuse` | Lạm dụng "actually", "like", "you know" |
| `run_on` | Câu quá dài, nối bằng "and" liên tục |
| `directness` | Quá thẳng/thiếu hedging khi phản biện |

Pattern ngoài enum → map về `vocabulary_choice`, ghi log để xem có cần mở rộng.

### 10.6 Trích xuất sau phiên

Một call text LLM, input là toàn bộ transcript (đã cắt còn 6.000 ký tự nếu quá dài, ưu tiên giữ phần đầu và phần cuối). Output JSON schema:

```json
{
  "topic": "sprint planning and a blocked migration",
  "summary": "Talked about... (2-3 câu)",
  "corrections": [
    { "wrong": "I go to the meeting yesterday",
      "right": "I went to the meeting yesterday",
      "pattern": "past_tense",
      "note": "yesterday → past simple" }
  ],
  "new_phrases": ["more work than expected", "push back on the estimate"]
}
```

Quy tắc: tối đa 5 correction/phiên, chỉ lỗi ảnh hưởng nghĩa hoặc lặp lại từ State. Không bịa lỗi nếu câu đúng. Không chấm phát âm.

Ghi DB bằng `insert ... on conflict (pattern) do update set count = count + 1, last_seen = now()`. Mỗi loại lỗi một dòng — `count` mới là thứ có nghĩa.

Nếu call fail: phiên vẫn lưu, `sessions.summary` null, `status = 'ended'`, có job `pnpm extract:retry` chạy lại các phiên thiếu summary.

## 11. Dữ liệu

Postgres 16 (Neon) + Drizzle.

```sql
create table learner_profile (
  id           smallint primary key default 1 check (id = 1),
  content_md   text not null,
  updated_at   timestamptz not null default now()
);

create table sessions (
  id            bigserial primary key,
  started_at    timestamptz not null,
  ended_at      timestamptz,
  duration_sec  integer,
  topic         text,
  summary       text,
  brief         text,                    -- nguyên văn systemInstruction đã nạp
  brief_tokens  integer,
  live_model    text,
  mode          text check (mode in ('duplex','ptt')),
  status        text not null default 'active'
                check (status in ('active','ended','abandoned')),
  search        tsvector generated always as
                (to_tsvector('english', coalesce(topic,'') || ' ' || coalesce(summary,''))) stored
);
create index sessions_search_idx on sessions using gin (search);

create table turns (
  id           bigserial primary key,
  session_id   bigint not null references sessions(id) on delete cascade,
  role         text not null check (role in ('user','assistant')),
  text         text not null,
  corrections  jsonb,                   -- chỉ có ở role='user', điền sau phiên
  audio_ms     integer,
  created_at   timestamptz not null,
  search       tsvector generated always as (to_tsvector('english', text)) stored
);
create index turns_search_idx on turns using gin (search);
create index turns_session_idx on turns (session_id, created_at);

create table mistakes (
  id           bigserial primary key,
  pattern      text not null,
  wrong        text not null,
  right        text not null,
  note         text,
  count        integer not null default 1,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  next_review  timestamptz,
  active       boolean not null default true
);
create unique index mistakes_pattern_idx on mistakes (pattern);

create table vocab (
  id           bigserial primary key,
  phrase       text not null unique,
  example      text,
  count        integer not null default 1,
  next_review  timestamptz,
  created_at   timestamptz not null default now()
);

create table usage_daily (
  day               date primary key,
  live_audio_sec    integer not null default 0,
  live_tokens       integer not null default 0,
  extract_tokens    integer not null default 0,
  extract_requests  integer not null default 0
);
```

Ghi chú:

- **Không lưu audio.** Chỉ transcript + `audio_ms`.
- `turns.corrections` điền sau phiên, không phải lúc nói — Live API không trả correction có cấu trúc.
- `sessions.brief` là bản chụp, không phải nguồn. Sửa profile không sửa brief của phiên cũ.
- `next_review` SM-2 rút gọn: đúng 3 lần liên tiếp → giãn; sai → về 1 ngày.
- `usage_daily` cập nhật sau mỗi phiên (Live API trả token usage trong `usageMetadata` khi đóng).

### Vòng đời session

- `start` tạo row `active`, biên soạn brief, trả session id + ephemeral token.
- Client lưu `session_id` ở `sessionStorage`. Reload trong 15 phút → resume (mở lại WebSocket, nạp lại brief cũ từ DB, không biên soạn mới).
- Hết 10:00 → client gửi event cuối rồi gọi `session/end`.
- Tab bị kill → row còn `active`; lần `start` kế tiếp đánh `abandoned` nếu quá 30 phút.
- `session/end` idempotent: gọi hai lần không sinh hai summary.

## 12. API

| Method | Path | Việc |
|---|---|---|
| POST | `/api/auth` | Đổi access code lấy cookie ký (HttpOnly, 90 ngày) |
| POST | `/api/session/start` | Tạo/resume session → `{ session_id, topic, brief, recap, token, model, live_config }` |
| POST | `/api/session/:id/rebrief` | Biên soạn brief mới giữa phiên → `{ brief, token }` |
| POST | `/api/session/:id/events` | Nhận batch event (`turn`, `interrupted`, `usage`), ghi `turns` + `usage_daily` |
| POST | `/api/session/:id/end` | Chạy trích xuất, ghi `mistakes`/`vocab`, trả summary |
| GET | `/api/context` | Profile + state + brief gần nhất + token count |
| PUT | `/api/context/profile` | Lưu profile markdown |
| POST | `/api/context/import` | Nhận `.md`/`.txt`, trả text chuẩn hoá |
| DELETE | `/api/mistakes/:id` | `active = false` |

### Cấu hình Live API gửi từ server

Client không tự dựng config — server trả nguyên khối để một chỗ duy nhất quyết định hành vi:

```json
{
  "model": "models/gemini-3.8-live",
  "generationConfig": {
    "responseModalities": ["AUDIO"],
    "speechConfig": { "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": "Puck" } } }
  },
  "systemInstruction": { "parts": [{ "text": "<brief>" }] },
  "inputAudioTranscription": {},
  "outputAudioTranscription": {},
  "realtimeInputConfig": {
    "automaticActivityDetection": {
      "startOfSpeechSensitivity": "START_SENSITIVITY_LOW",
      "endOfSpeechSensitivity": "END_SENSITIVITY_LOW",
      "prefixPaddingMs": 300,
      "silenceDurationMs": 1300
    }
  }
}
```

VAD là cấu hình lúc setup, đổi phải reconnect. `1300ms` là mặc định đã thử; 900ms gây cắt lời.

### Nguồn của `topic`

Suy ra từ State, không gọi LLM: (1) chủ đề của cụm từ đến hạn, (2) pattern lỗi lặp nhiều nhất, (3) xoay vòng 6 chủ đề công việc tĩnh (standup, code review, giải thích quyết định, tranh luận kỹ thuật, phỏng vấn, small talk).

## 13. Client — pipeline audio

Phần này là thứ dễ sai nhất và đã được kiểm chứng trên spike.

**Capture**
- `getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })`.
- `AudioWorklet` nạp qua Blob URL, gói 512 mẫu (~32ms ở 16kHz). Fallback `ScriptProcessor(512)`.
- **Resample tuyến tính về 16kHz là bắt buộc.** Chrome Android bỏ qua `AudioContext({ sampleRate: 16000 })` và chạy 48kHz. Giữ pha giữa các chunk, nếu không sẽ có tiếng lạch cạch.
- Gửi `{ realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: base64 } } }`.

**Phát lại**
- `AudioContext({ sampleRate: 24000 })`, decode PCM16 → Float32 → `AudioBuffer`, xếp hàng bằng `nextPlayTime`.
- `serverContent.interrupted` → dừng toàn bộ source đang xếp hàng ngay.
- Giới hạn mảng source đã phát để không rò bộ nhớ trong phiên 20 phút.

**Kết thúc lượt**
- Không có `audioStreamEnd`. Server dựa vào VAD. Ở chế độ PTT, sau khi thả nút phải **tiếp tục gửi ~1.2s im lặng**, nếu không server không bao giờ chốt câu.

**Khác**
- Giữ màn hình sáng bằng `navigator.wakeLock` khi vào Session.
- Mất mạng: đóng phiên, hiện "mất kết nối", cho phép nối lại trong 60s với brief cũ.
- PWA manifest + icon, không service worker.

## 14. Cấu trúc repo

```
english-voice-coach/
├── api/index.ts                 # Hono trên Vercel
├── src/
│   ├── pages/                   # Home, Session, Summary, Context
│   ├── components/              # MicButton, Transcript, CorrectionLine, ContextGauge
│   ├── lib/
│   │   ├── live.ts              # WebSocket + setup + reconnect
│   │   ├── audio-capture.ts     # AudioWorklet + resampler
│   │   ├── audio-playback.ts    # PCM16 24k queue
│   │   └── api.ts
│   └── main.tsx
├── server/
│   ├── live/
│   │   ├── config.ts            # buildLiveConfig(brief)
│   │   └── token.ts             # ephemeral token
│   ├── extract/
│   │   ├── prompt.ts
│   │   └── schema.ts            # zod, pattern enum
│   ├── memory/
│   │   ├── brief.ts             # profile + state + recall → brief
│   │   └── recall.ts            # full-text
│   ├── db/                      # schema, client, queries
│   ├── routes/
│   ├── auth.ts
│   └── env.ts
├── docs/
├── spike/index.html             # spike đã chạy, giữ làm tham chiếu
├── tools/
│   ├── dev-server.mjs           # static server + nhận log
│   └── logs.mjs                 # tra vấn log test
├── drizzle/
└── vercel.json
```

Dev: `pnpm dev` chạy Vite (5173) và API (3001), Vite proxy `/api`.

**DB khi dev:** Neon branch `dev` (copy-on-write từ `production`). Không trỏ vào branch production khi dev — vài trăm lượt test sẽ làm nhiễm `mistakes`/`vocab`.

**Env:** `GEMINI_API_KEY`, `DATABASE_URL` (pooled), `DATABASE_URL_UNPOOLED` (migration), `GROQ_API_KEY`, `ACCESS_CODE`, `AUTH_SECRET`. Validate bằng zod, fail fast.

## 15. Bảo mật

- **Không bao giờ gửi `GEMINI_API_KEY` xuống client.** Server gọi `POST v1alpha/auth_tokens` (header `x-goog-api-key`) để lấy ephemeral token (mặc định 30 phút, `uses: 1`), nhét luôn `bidiGenerateContentSetup` (model + systemInstruction + VAD) vào token. Client nối WebSocket bằng **method `BidiGenerateContentConstrained`**, không phải `BidiGenerateContent`:

  ```
  wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=auth_tokens/...
  ```

  Client vẫn gửi `{ setup: { model } }`; config thật lấy từ token, setup từ client bị bỏ qua (`field_mask` rỗng). Đã verify end-to-end ngày 06/11/2026 bằng `tools/verify-token.mjs`: `setupComplete: true`, 78.7KB audio, transcript đúng, `close 1000`. Ba bẫy đã gặp: (1) REST `v1beta` không có field `liveConnectConstraints` — tên REST là `bidiGenerateContentSetup`; (2) dùng method `BidiGenerateContent` trả `1008 Method doesn't allow unregistered callers`; (3) token tạo bằng `v1alpha` không dùng được cho WS `v1beta`.
- `ACCESS_CODE` → cookie `HttpOnly; Secure; SameSite=Lax`, ký HMAC bằng `AUTH_SECRET`. Mọi route `/api/*` trừ `/api/auth` kiểm tra cookie.
- `/api/session/:id/events` chỉ nhận event cho session đang `active` và thuộc cookie hiện tại.
- Body limit 4MB (Vercel chặn ở 4.5MB). Event batch bình thường vài chục KB.
- Rate limit trong memory function: 30 request/phút.

## 16. Rủi ro và cách xử lý

| Rủi ro | Xác suất | Ảnh hưởng | Xử lý |
|---|---|---|---|
| AI cắt lời vì VAD | **Đã xảy ra** | Rất khó chịu | Sensitivity LOW + 1300ms; nếu vẫn lỗi, PTT làm mặc định |
| Mất `systemInstruction` khi phiên dài (context compression) | Trung bình | AI hết sửa lỗi mà không báo | Test T3 canary ở phút 15; nếu fail → chủ động reconnect ở phút 8 |
| Đổi chủ đề giữa phiên, không có recall | **Chắc chắn xảy ra** | AI nói chung chung | Nút `Nhắc AI`; chấp nhận đây là giới hạn đã biết |
| Ephemeral token API khác tài liệu | **Đã loại** | — | Đã verify 06/11/2026: `v1alpha/auth_tokens` + `BidiGenerateContentConstrained` chạy được, `tools/verify-token.mjs` exit 0 |
| Chrome Android resample sai | **Đã xảy ra** | Audio méo, STT kém | Resampler tuyến tính có giữ pha — đã implement trong spike |
| Neon cold start | Cao | Lượt đầu chậm 0.5–1s | Hiện "đang khởi động", chạy query nhẹ đánh thức |
| Giải thích tiếng Việt bị đọc bằng giọng Anh | Cao | Khó nghe | Ba lựa chọn: chấp nhận; chỉ hiện chữ; tắt tiếng Việt. Chưa chốt — xem §18 |
| Live API free tier đổi quota | Trung bình | Chặn dùng | Đọc lại rate limit trước khi tin; giữ `usage_daily` để phát hiện sớm |
| Groq/Gemma hết quota cho bước trích xuất | Thấp | Không có summary | Phiên vẫn lưu; retry sau; UI hiện "chưa phân tích" |

## 17. Kế hoạch kiểm chứng

Đã có: spike chạy được 8 lượt, 117s audio, ~1.5K token, 0 lỗi (§20).

Còn phải đo, theo `docs/02-test-plan.md`:

1. **T1** — p50 `first audio` ở PTT ≥ 5 lượt. Đạt: < 1500ms.
2. **T3** — canary ở phút 15. Đạt: trả lời đúng.
3. **V1** — gieo 5 từ trong hội thoại, đếm số từ dùng lại. Đạt: ≥ 2/5.
4. **T0/T2** — 20 phút liên tục, `early_responses = 0`.
5. **T6/T7** — Android thật có tiếng ồn; 3 phiên trong một ngày.
6. Sau khi scaffold: kiểm tra brief thật trong `sessions.brief` khớp với những gì đã gửi.

Log tự gửi về `tools/dev-server.mjs`; đọc bằng `node tools/logs.mjs list|show|summary`.

## 18. Những gì để builder tự quyết

- Tokenizer full-text: `english` vs `simple`; có thêm `unaccent` không.
- Cách đánh dấu correction trong transcript (gạch chân sau phiên, hay bắt model nói "Quick fix:" để regex).
- Có hiển thị waveform khi ghi âm hay chỉ chấm nhấp nháy.
- Ngưỡng cắt transcript trước khi trích xuất (6.000 ký tự).
- Có `History` trong MVP hay không (khuyến nghị: không).
- Cách xử lý tiếng Việt trong giải thích — ba lựa chọn ở §16, cần thử trên tai nghe thật.

## 19. Các quyết định đã chốt

1. **Pattern lỗi là enum đóng 20 giá trị** (§10.5). Đổi lại: phải sửa tay khi gặp loại mới.
2. **Ghi mistakes sau phiên, không phải mỗi lượt** — vì Live API không trả correction có cấu trúc. Đổi lại: mất dữ liệu nếu không lưu transcript (đã bù bằng event batch).
3. **Trí nhớ hai pha thay vì chèn theo lượt** (§10). Đổi lại: mất recall động; bù bằng `Nhắc AI`.
4. **Topic suy ra từ State**, không gọi LLM.
5. **Recap đầu phiên là card**, không phải AI nói — để G3 đo được.
6. **Dev dùng Neon branch `dev`.**
7. **Upload limit 4MB.**
8. **Brief ≤ 1.000 token**, cứng.
9. **Live API là kiến trúc chính**, turn-based bị loại (§20).
10. **Đổi Turso → Neon** (Postgres) để đổi lấy setup 5 phút + branch.
11. **VAD mặc định 1300ms, sensitivity LOW.** 900ms đã thử và gây cắt lời.
12. **Duplex là mặc định, PTT là fallback** — vì duplex là lý do chọn Live API, nhưng ồn/tai nghe là ràng buộc thật.

## 20. Vì sao đổi kiến trúc (bằng chứng từ spike)

Spike ở `spike/index.html` chạy thật ngày 06/11/2026:

| Chỉ số | Turn-based (dự tính) | Live API (đo được) |
|---|---|---|
| Token/phiên | ~30.000 | **~1.500** (8 lượt, 117s) |
| Số call | 16 (8 STT + 8 LLM) | 8 (1 WebSocket) |
| Giới hạn ngày | 200K TPD → 6 phiên | TPM 65K, RPD unlimited |
| Nói chen ngang | Không | Có |
| Độ trễ | 2–4s cộng dồn 3 chặng | 1 audio stream |

Chất lượng: AI sửa "best problem" → "biggest problem" ngay trong câu trả lời, tự nhiên. Nhưng bỏ sót lỗi lặp từ ("the the", "streaming... streaming") — đúng loại lỗi mà lớp trích xuất sau phiên phải bắt.

Lỗi đã gặp và đã sửa trong spike: `mediaChunks` bị bỏ (ws đóng 1007), `audioStreamEnd` không còn, VAD cắt lời sau 3 từ, `AudioContext` 16kHz bị Android bỏ qua.

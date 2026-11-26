# English Voice Coach

Luyện nói tiếng Anh bằng giọng nói cho một người học — một kỹ sư backend Việt Nam (B1–B2) — có trí nhớ giữa các phiên. Nói 10–20 phút trên điện thoại; coach sửa lỗi ngay trong lúc nói và mang những cụm từ của ngày mai quay lại ở phiên sau.

**Bản tiếng Anh:** [README.md](./README.md)

- **App đang chạy:** https://english-voice-coach-five.vercel.app
- **Spike:** https://spike-ecru-six.vercel.app
- **Design spec:** [docs/superpowers/specs/2026-11-06-english-voice-coach-design.md](./docs/superpowers/specs/2026-11-06-english-voice-coach-design.md)
- **Thiết kế reason mode:** [docs/superpowers/specs/2026-11-24-reason-mode-design.md](./docs/superpowers/specs/2026-11-24-reason-mode-design.md)
- **Test plan:** [docs/02-test-plan.md](./docs/02-test-plan.md)
- **Cách chạy 3 bài test spike:** [docs/03-run-tests.md](./docs/03-run-tests.md)

## Tình trạng

Đã deploy lên Vercel production tại `https://english-voice-coach-five.vercel.app` ngày 25/11/2026 (commit `c788456`). Đây là app thật chứ không phải demo: chỉ một access code, data model xoay quanh một người học, và các lỗi lưu lại là để dùng vào ngày hôm sau. Kiểm tra hiện tại: 18 unit test, typecheck và build đều pass; `verify:brief` OK; `verify:api` 26/26; Live round-trip và socket-close đều pass.

## Mục đích / Vì sao

Luyện 30 phút mỗi ngày trước đây không tiến vì mỗi phiên bắt đầu từ số không: AI không biết tôi làm backend, không biết lỗi nào tôi hay lặp, cũng không nhớ tuần trước nó đã sửa "I have experience in..." thành "I have experience with...".

App này đóng vòng lặp đó:

```
nói → phát hiện lỗi → nhớ lỗi → gặp lại lỗi → sửa
```

Trí nhớ là tính năng chính, không phải phụ.

## Tính năng

### Bốn vai coach

Chọn vai ở Home (lựa chọn được lưu trong `sessionStorage`). Bạn cũng có thể gõ chủ đề hoặc bấm chip: daily standup, code review, technical disagreement, job interview. Để trống chủ đề thì app tự chọn từ những điểm bạn hay sai.

| Vai | AI làm gì | Dùng khi nào |
|---|---|---|
| `coach` — "Coach (sửa lỗi)" | Luôn nói tiếng Anh, 2–4 câu ngắn. Sửa tối đa 2 lỗi quan trọng mỗi lượt theo sai → đúng → một lý do ngắn, rồi tiếp tục hỏi. | Hội thoại công việc hằng ngày. |
| `interview` — "Phỏng vấn (không sửa)" | Giữ vai hội đồng tuyển dụng: không dạy, không sửa grammar, hỏi từng câu một, ép chi tiết và con số, cắt câu quá 90 giây. Phút thứ 8 chấm clarity / depth / numbers / honesty 1–5 rồi đưa một câu mẫu 4 câu. | Phỏng vấn thử dưới áp lực. |
| `reflex` — "Phản xạ (20 giây)" | 12–15 câu hỏi nhanh, mỗi câu tối đa 10 từ; trả lời trong 15–20 giây. Quá 20 giây thì cắt bằng "Next.". Cuối buổi: 3 câu trả lời dở nhất kèm câu mẫu 15 giây và một từ đệm cần bỏ. | Trả lời nhanh trong phỏng vấn và small talk. |
| `reason` — "Reason" | Trước khi trả lời bạn phải nêu khung 4 phần: PREP (Point, Reason, Example, Point), Problem–Cause–Fix–Impact, hoặc STAR. AI hỏi đúng một câu cho phần thiếu, cắt ngang ở 45 giây nếu chưa có khung, và bắt bạn hỏi lại một câu làm rõ sau mỗi 3 lượt. Không sửa grammar trong lúc chạy. Phút thứ 8 chấm structure / reasoning / evidence / conversation flow 1–5, mỗi mục một dòng bằng chứng, rồi đưa một câu mẫu 4 câu dùng khung bạn làm dở nhất. | Tư duy có cấu trúc và duy trì hội thoại. |

Vai chỉ đổi RULES và chủ đề được suy ra. Luồng Live API, trích xuất và summary dùng chung.

### Một phiên

```
Home → Recap (lỗi + từ đến hạn) → Session (Gemini Live, duplex hoặc push-to-talk)
     → Summary → Home
                 ↳ Drill (không audio, không tốn token Live) → brief sau
```

- **Recap** hiện lỗi và từ đến hạn trước khi bắt đầu.
- **Session** truyền audio full-duplex. Micro được kiểm tra trước; nút `Nhắc AI` dựng brief mới bằng cách nối lại (~1–2 giây).
- **Summary** đưa 3 câu viết lại dùng được ngay hôm sau, kèm nghĩa tiếng Việt và nút đọc.
- **History** liệt kê phiên cũ, mở ra xem lỗi đã sửa và toàn bộ transcript.
- **Context** hiện đúng brief model đã nhận và cho sửa profile.

### Trí nhớ và Drill

Live API chỉ nhận `systemInstruction` một lần mỗi kết nối, nên trí nhớ được biên soạn trước và ghi lại sau:

```
cuối phiên N:   transcript → LLM trích xuất → Postgres
đầu phiên N+1:  Postgres → brief (≤1000 token) → systemInstruction
```

Brief có 5 phần — `rules`, `profile`, `state`, `recall`, `today` — với RULES giới hạn 250 token. Nó được lưu nguyên văn trong `sessions.brief`. Không gọi LLM khi biên soạn; state được tính bằng SQL.

Drill là đường vào rẻ nhất: từng thẻ một, không micro. Sai thì item về ngày mai, đúng thì leo bậc 3/7/14/30 ngày cho tới khi "tốt nghiệp". Cùng chính sách đó đi vào phần `today` của brief phiên sau, nên ôn bằng Drill thật sự đổi thứ AI sẽ hỏi.

## Kết quả mong đợi

Đây là các mục tiêu thiết kế trong spec (cộng thêm mục tiêu của `reason`) cùng bằng chứng hiện có.

| # | Mục tiêu | Cách đo | Bằng chứng / trạng thái |
|---|---|---|---|
| G1 | Nói liên tục 20 phút trên điện thoại | 10 phiên liên tiếp trên Android + Chrome, không lỗi micro hay crash | Pipeline Live đã verify end-to-end (audio + transcript + đóng socket sạch); checklist dài hạn ở `docs/02-test-plan.md`. |
| G2 | Độ trễ cảm nhận ≤ 1,5 giây | p50 `first audio` sau khi người nói dừng, ở chế độ push-to-talk | Spike: 8 lượt / 117 giây audio / ~1,5K token / 0 lỗi. Ngưỡng im lặng VAD 1300 ms. |
| G3 | AI nhớ lỗi cũ | Phiên N+1 nhắc ≥ 3/5 lỗi của N không cần gợi ý | Unit test phủ dựng brief, chọn từ đến hạn và pattern lỗi. |
| G4 | Trí nhớ nhìn thấy và sửa được | Tab Context hiện đúng `sessions.brief`; sửa được profile | `/api/context`, `PUT` profile, và kiểm tra ngân sách token của `verify:brief`. |
| G5 | Chi phí 0đ | Không vượt free tier trong 30 ngày | Gemini API + Groq dự phòng + Vercel Hobby (phi thương mại) + Neon free. Một lần trích xuất/phiên ≈ 2,2K token; Gemini `gemini-3.8-flash` là chính, còn Groq `gpt-oss-120b` dự phòng cho 200K TPD ≈ 85–90 phiên/ngày. |
| G6 | AI không cắt lời | `early_responses = 0` trong 5 phút nói liên tục | VAD chỉnh 1300 ms sau đo đạc; socket-close và Live checks đều pass. |
| G7 (`reason`) | Debrief có cấu trúc sau phiên lập luận | Sau 8 phút: 1–5 trên 4 trục kèm bằng chứng, cộng một câu mẫu 4 câu | `verify:brief` kiểm RULES, xoay 6 chủ đề và luồn từ đến hạn; bước cuối là chạy thủ công 1 phiên ngắn. |

## Stack, model và provider

### Stack

| Lớp | Chọn | Vì sao |
|---|---|---|
| Hội thoại | Gemini Live API (`gemini-3.8-live`) | Audio full-duplex, ~1,5K token mỗi phiên |
| Trích xuất | Gemini `gemini-3.8-flash` (có Groq dự phòng) | ~3 giây mỗi phiên, JSON schema nghiêm ngặt |
| API | Hono trên Vercel Functions | Một file, không framework |
| DB | Neon Postgres + Drizzle | full-text tsvector, free tier, branching |
| Client | React 19 + Vite | Pipeline audio bằng WebAudio thuần |

### Provider và dự phòng

| Việc | Chính | Dự phòng | Ghi chú |
|---|---|---|---|
| Hội thoại realtime | Gemini Live `models/gemini-3.8-live` | `models/gemini-2.5-flash-native-audio-latest` | Server cấp ephemeral token; giọng `Puck`; VAD 1300 ms; PCM16 mono 16 kHz vào / 24 kHz ra. |
| Trích xuất sau phiên | Gemini `gemini-3.8-flash` | `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3-flash-preview`, rồi Groq `openai/gpt-oss-120b` → `qwen/qwen3.8-27b` → `openai/gpt-oss-20b` | Một call JSON nghiêm ngặt mỗi phiên (~2,2K token). Gemini thử lại một lần với 503; Groq chỉ chạy khi mọi model Gemini fail hoặc trả JSON sai schema; kết quả vẫn qua zod. |
| Trích xuất, override khi chẩn đoán | Groq `openai/gpt-oss-120b` | `qwen/qwen3.8-27b`, `openai/gpt-oss-20b` | Chỉ khi truyền rõ `provider: 'groq'`; bỏ model khi 404 / 429 / 5xx; bỏ `additionalProperties` khỏi response schema cho Gemini. |
| Embedding recall (v2, chưa ship) | — | Gemini `gemini-embedding-2` | Dự định cho recall tốt hơn; chưa chạy production. |

API key chỉ nằm trên server. Trình duyệt chỉ nhận token Live có hạn ngắn. Tên model nằm ở `server/live/config.ts` và `server/extract/providers.ts`; đổi model không cần đổi client.

## Cài đặt

### 1. Vercel (production)

Checklist:

1. Import `andy-pham-it/english-voice-coach`; dùng Node 22.x.
2. Chọn project `english-voice-coach` (phục vụ `-five.vercel.app`). Project gần giống `english-voice-coaching` thiếu env nên trả 500 ở mọi route — xem `vercel ls` trước khi kết luận deploy hỏng.
3. Đặt env production: `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `ACCESS_CODE`, `AUTH_SECRET`, `SPIKE_LOG_KEY`. Tạo secret bằng `openssl rand -hex 32` (tối thiểu 32 ký tự).
4. Áp migration **trong context env production của Vercel**:

   ```bash
   vercel env run -e production -- npx drizzle-kit migrate
   ```

   Đừng dùng `vercel env pull` với token OIDC: giá trị kéo về là placeholder `[env:NAME]`, không giải mã được secret thật.

5. Deploy và kiểm tra:

   ```bash
   npm run deploy          # tương đương: npx vercel --prod --yes
   curl https://english-voice-coach-five.vercel.app/api/health
   ```

   Health phải trả `200` với `ok: true`. Kiểm tra thêm title trang và bundle JS production có chứa `reason`.

6. Rollback: promote deployment trước đó trong dashboard Vercel, hoặc `git revert <commit> && git push` rồi deploy lại.

`vercel.json` cố ý dùng dạng `builds`/`routes` legacy: nếu không, preset Vite chèn route `^/api(/.*)?$ → 404` và function không bao giờ được đăng ký. Import tương đối trong `server/` và `api/` phải có đuôi `.js`; `tsconfig.json` không được đặt `"types": ["node"]` (lỗi `TS2688`).

### 2. Chạy local

```bash
npm install
cp .env.example .env.local     # rồi điền giá trị
npm run db:migrate             # tạo bảng trên branch Neon
npm run db:seed                # tuỳ chọn: profile mẫu, lỗi mẫu, cụm từ mẫu
npm run dev                    # http://localhost:5173 (UI + API một process)
```

Không đặt `ACCESS_CODE` thì local tắt auth, mở thẳng vào Home. Để test trên điện thoại cần HTTPS (Vercel preview hoặc tunnel): `getUserMedia` không chạy trên `http://192.168.x.x`.

Chạy kiểm tra trước khi sửa gì:

```bash
npm test
npm run typecheck
npm run build
npm run verify:brief
npm run verify:api
```

Script verify ghi dữ liệu thật rồi khôi phục trạng thái cũ, nên chạy trên branch dev là an toàn. Đừng trỏ vào dữ liệu production.

### 3. Self-hosted server Node

Dùng cho VPS, Docker, hoặc host Node bất kỳ thay cho Vercel.

1. Cài dependency. Node adapter và `tsx` đã được khai báo trong `package.json`, nên không cần cài thêm:

   ```bash
   npm install
   # container production: npm ci --omit=dev
   ```

2. Xuất 7 env giống Vercel, thêm `NODE_ENV=production` và tuỳ chọn `PORT` (mặc định `3000`). Áp migration với `DATABASE_URL_UNPOOLED` rồi build frontend:

   ```bash
   npm run db:migrate
   npm run build
   ```

3. Chạy API bằng script có sẵn:

   ```bash
   npm run start:node
   ```

   Điểm vào là `server/node.ts`; file này đã có trong repo. Script dùng `tsx` từ dependencies nên chạy được cả sau `npm ci --omit=dev`.

4. Phục vụ `dist/` cùng một origin. Ví dụ Caddyfile có TLS tự động và SPA fallback:

   ```caddyfile
   example.com {
     handle /api/* {
       reverse_proxy 127.0.0.1:3000
     }
     handle {
       root * /srv/english-voice-coach/dist
       try_files {path} /index.html
       file_server
     }
   }
   ```

   Nếu đổi `PORT`, cập nhật `reverse_proxy` cho khớp.

Lưu ý:

- Bắt buộc HTTPS để xin micro; terminate TLS ở Caddy/Nginx/load balancer.
- Không cần proxy WebSocket cho hội thoại: trình duyệt nối thẳng Gemini Live bằng ephemeral token do server cấp. Tiến trình Node chỉ phục vụ REST API.
- `api/index.ts` và `vercel.json` chỉ dùng cho Vercel, không dùng ở chế độ này.
- `ACCESS_CODE` và `AUTH_SECRET` là bắt buộc khi `NODE_ENV=production`; nếu thiếu `SPIKE_LOG_KEY` thì `/api/spike-log` trả 503.

## Nên đọc gì trước

Phần lớn quyết định thiết kế nằm ở năm chỗ:

- [`server/memory/brief.ts`](./server/memory/brief.ts) — biến database thành một prompt trong ngân sách cố định: hạn mức từng phần, cắt ở ranh giới từ, RULES theo từng vai, và state tính bằng SQL chứ không để model viết.
- [`src/live.ts`](./src/live.ts) — pipeline WebSocket + AudioWorklet tự viết (16 kHz lên, 24 kHz xuống), gồm bộ resample sinh ra vì Chrome Android bỏ qua `new AudioContext({ sampleRate: 16000 })`.
- [`server/extract/`](./server/extract) — trích xuất ràng buộc schema có fallback provider, và luật model chỉ được chọn cụm người học đã được hiện ra.
- [`server/review/drill.ts`](./server/review/drill.ts) — ôn tự chấm và lịch 3/7/14/30 ngày dùng chung với brief.
- [`server/session/service.ts`](./server/session/service.ts) — vòng đời phiên và đường nối lại giữ `durationSec` đúng khi khoá máy hoặc đóng tab.

## Scripts

| Lệnh | Việc |
|---|---|
| `npm run dev` | Vite + Hono API chung một cổng |
| `npm run build` | Build production vào `dist/` |
| `npm run preview` | Xem `dist/` đã build ở local |
| `npm test` | Bộ unit Vitest (18 test) |
| `npm run test:watch` | Vitest watch mode |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run deploy` | Deploy lên Vercel production |
| `npm run start:node` | Chạy REST API bằng Node adapter (self-hosted) |
| `npm run db:generate` | Sinh migration từ `server/db/schema.ts` |
| `npm run db:migrate` | Áp migration bằng `DATABASE_URL_UNPOOLED` |
| `npm run db:studio` | Mở Drizzle Studio |
| `npm run db:seed` | Seed profile, 3 lỗi, 3 cụm từ |
| `npm run db:seed:plan` | Seed fixture kế hoạch phỏng vấn |
| `npm run db:reset` | Xoá sessions/mistakes/vocab/usage rồi seed lại |
| `npm run verify:brief` | Dựng brief từ DB thật, kiểm ngân sách token |
| `npm run verify:live` | Brief → ephemeral token → gọi Live API thật |
| `npm run verify:token` | Chỉ kiểm tạo ephemeral token |
| `npm run verify:extract` | Chạy pipeline trích xuất trên phiên giả (tự dọn) |
| `npm run verify:live-close` | Cờ đóng socket: tự nối lại hay kết thúc (không cần mic, không cần mạng) |
| `npm run verify:api` | 26 assert API end-to-end (tự dọn) |
| `npm run verify:drill` | Kiểm lịch ôn Drill |
| `npm run verify:schedule` | Kiểm khoảng cách ôn |
| `npm run dev:spike` | Chạy spike đo ở `:8080` |

## Cấu trúc

```
api/index.ts          entry cho Vercel (Hono adapter)
server/
  app.ts              routes
  node.ts             điểm vào Node tự host (npm run start:node)
  auth.ts             cookie HMAC
  env.ts              validate env (fail fast)
  db/                 schema, client, singleton
  live/               config Live API + ephemeral token
  memory/brief.ts     profile + state + recall + RULES theo vai → brief
  extract/            prompt, zod schema, provider có fallback, ghi DB
  review/drill.ts     item đến hạn + lịch 3/7/14/30 ngày
  session/service.ts  start / events / rebrief / end
  session/history.ts  phiên cũ + transcript cho tab History
src/                  React client: Home, Session, Summary, History, Context
src/mic.ts            kiểm tra micro dùng ở Home
spike/index.html      bộ đo T1 / T3 / V1, không ship
tools/                dev server, truy vấn log, script verify
drizzle/              migration SQL đã sinh
docs/superpowers/     design spec và implementation plan
```

## Giới hạn đã biết

- Một người dùng. Access code không phải hệ thống tài khoản.
- Không chèn ngữ cảnh theo từng lượt: brief cố định lúc kết nối. `Nhắc AI` nối lại với brief mới khi cuộc nói chuyện đổi chủ đề.
- Correction được trích xuất sau phiên, không phải lúc đang nói. Ở vai `reason` và `interview`, grammar cố ý không bị sửa giữa phiên.
- Không chấm phát âm; nút Đọc dùng giọng text-to-speech của máy.
- Ephemeral token hết hạn sau 30 phút; nối lại sẽ cấp token mới.
- Phiên bị rớt (đóng tab, khoá máy) được nối tiếp nếu quay lại trong 15 phút: đồng hồ chạy tiếp từ lúc bắt đầu nên `durationSec` vẫn đúng. Quá 15 phút thì phiên bị đánh dấu `abandoned` và thời lượng bị cắt ở 15 phút, để một phiên bỏ quên không làm sai thống kê tuần.
- Vercel Hobby chỉ dùng phi thương mại; chuyển sang plan trả phí hoặc self-host nếu app không còn là công cụ cá nhân.

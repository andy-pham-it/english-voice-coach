# English Voice Coach

Luyện nói tiếng Anh bằng giọng nói, một người dùng, có trí nhớ giữa các phiên.
Nói 10–20 phút trên điện thoại; app sửa lỗi ngay trong lúc nói, rồi lưu lại những gì bạn nói sai
và mang ra nhắc ở phiên sau.

**Bản tiếng Anh:** [README.md](./README.md)

- **App đang chạy:** https://english-voice-coach-five.vercel.app
- **Design spec:** [docs/superpowers/specs/2026-11-06-english-voice-coach-design.md](./docs/superpowers/specs/2026-11-06-english-voice-coach-design.md)
- **Test plan:** [docs/02-test-plan.md](./docs/02-test-plan.md)
- **Cách chạy 3 bài test spike:** [docs/03-run-tests.md](./docs/03-run-tests.md)

## Tình trạng

Tự viết cho mình với đúng một người dùng, và đã deploy. Đây là app thật chứ không phải demo: chỉ có
một access code, toàn bộ data model xoay quanh một người học, và các lỗi nó lưu lại là để dùng vào
ngày hôm sau. Mọi thứ bên dưới mô tả thứ đang chạy, không phải kế hoạch.

## Cách hoạt động

```
Home → Recap (lỗi lặp + từ đến hạn) → Session (Gemini Live, full-duplex) → Summary → Home
                            ↳ Drill (không audio: tự chấm những gì đã đến hạn)
```

Ở Home bạn gõ được chủ đề (hoặc bấm chip: daily standup, code review, technical disagreement,
job interview) và kiểm tra micro trước khi vào phiên. Chủ đề đi thẳng vào brief nên AI mở đúng
câu chuyện bạn muốn. Để trống thì app tự chọn từ những lỗi bạn hay lặp.

Trí nhớ chạy hai pha, vì Live API chỉ nhận `systemInstruction` một lần mỗi kết nối:

```
cuối phiên N:    transcript → LLM trích xuất (Groq) → Postgres
đầu phiên N+1:   Postgres → brief (≤1000 token) → systemInstruction
```

Brief được lưu nguyên văn vào `sessions.brief`, nên tab Context hiện đúng thứ model đã đọc.

Sau mỗi phiên có 3 câu viết lại để dùng được ngay hôm sau (kèm nghĩa tiếng Việt và nút đọc),
và chúng quay lại trong brief phiên sau để ôn.
Tab History liệt kê các phiên cũ, mở ra xem lỗi đã sửa và toàn bộ transcript.

Drill là đường vào rẻ nhất: từng thẻ một, không micro, không tốn token Live API. Nó chỉ hiện thứ
thật sự đến hạn, và mỗi câu trả lời đặt lại hạn cho item đó — sai thì về ngày mai, đúng thì leo
bậc 3/7/14/30 ngày cho tới khi tốt nghiệp. Cùng một chính sách đó điều khiển phần ôn trong brief
phiên sau, nên ôn bằng Drill thật sự thay đổi thứ AI sẽ hỏi.

## Stack

| Lớp | Chọn | Vì sao |
|---|---|---|
| Hội thoại | Gemini Live API (`gemini-3.8-live`) | audio full-duplex, ~1,5K token mỗi phiên |
| Trích xuất | Groq `openai/gpt-oss-120b` | ~3 giây mỗi phiên, JSON schema |
| API | Hono trên Vercel Functions | một file, không framework |
| DB | Neon Postgres + Drizzle | full-text tsvector, free tier, branching |
| Client | React 19 + Vite | pipeline audio bằng WebAudio thuần |

## Nên đọc gì trước

Phần lớn quyết định thiết kế nằm ở bốn chỗ:

- [`server/memory/brief.ts`](./server/memory/brief.ts) — biến database thành một prompt trong ngân
  sách token cố định: chia hạn mức từng phần, cắt ở ranh giới từ, và state tính bằng SQL chứ không
  để model viết.
- [`src/live.ts`](./src/live.ts) — pipeline WebSocket + AudioWorklet tự viết (16 kHz lên, 24 kHz
  xuống), gồm cả bộ resample sinh ra vì Chrome trên Android bỏ qua
  `new AudioContext({ sampleRate: 16000 })`.
- [`server/extract/`](./server/extract) — trích xuất có ràng buộc schema trên Groq, và luật là model
  chỉ được chọn những cụm người học đã được hiện ra trước đó.
- [`server/session/service.ts`](./server/session/service.ts) — vòng đời phiên và đường nối lại giữ
  cho `durationSec` vẫn đúng khi khoá máy hoặc đóng tab.

## Chạy local

```bash
npm install
cp .env.example .env.local     # rồi điền giá trị
npm run db:migrate             # tạo bảng trên branch Neon
npm run db:seed                # tuỳ chọn: profile mẫu, lỗi mẫu, cụm từ mẫu
npm run dev                    # http://localhost:5173 (UI + API một process)
```

Không đặt `ACCESS_CODE` thì local tắt auth — mở thẳng vào Home.

## Scripts

| Lệnh | Việc |
|---|---|
| `npm run dev` | Vite + Hono API chung một cổng |
| `npm run build` | Build production vào `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:generate` | Sinh migration từ `server/db/schema.ts` |
| `npm run db:migrate` | Áp migration bằng `DATABASE_URL_UNPOOLED` |
| `npm run db:seed` | Seed profile, 3 lỗi, 3 cụm từ |
| `npm run db:reset` | Xoá sessions/mistakes/vocab/usage rồi seed lại |
| `npm run verify:brief` | Dựng brief từ DB thật, kiểm ngân sách token |
| `npm run verify:live` | Brief → ephemeral token → gọi Live API thật |
| `npm run verify:token` | Chỉ kiểm tạo ephemeral token |
| `npm run verify:extract` | Chạy pipeline trích xuất trên phiên giả (tự dọn) |
| `npm run verify:live-close` | Cờ đóng socket: tự nối lại hay kết thúc (không cần mic, không cần mạng) |
| `npm run verify:api` | 17 assert API end-to-end (tự dọn) |
| `npm run dev:spike` | Chạy spike đo ở `:8080` |

Các script verify ghi dữ liệu thật rồi khôi phục trạng thái cũ, nên chạy trên branch dev là an toàn.
Đừng trỏ vào dữ liệu production.

## Deploy

```bash
npx vercel --prod --yes
```

`vercel.json` cố ý dùng dạng `builds`/`routes` legacy: preset Vite tự chèn route
`^/api(/.*)?$ → 404` và function không được đăng ký. Hai ràng buộc nữa đã từng làm mất thời gian:

- Import tương đối trong `server/` và `api/` phải có đuôi `.js` (function build ra ESM).
- `tsconfig.json` không được đặt `"types": ["node"]`, nếu không build fail `TS2688`.

Env production: `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `GEMINI_API_KEY`, `GROQ_API_KEY`,
`ACCESS_CODE`, `AUTH_SECRET`, `SPIKE_LOG_KEY`.

## Cấu trúc

```
api/index.ts          entry cho Vercel (Hono adapter)
server/
  app.ts              routes
  auth.ts             cookie HMAC
  db/                 schema, client, singleton
  live/               config Live API + ephemeral token
  memory/brief.ts     profile + state + recall → brief
  extract/            prompt, zod schema, providers, ghi DB
  session/service.ts  start / events / rebrief / end
  session/history.ts  phiên cũ + transcript cho tab History
src/                  React client: Home, Session, Summary, History, Context
src/mic.ts            kiểm tra micro dùng ở Home
spike/index.html      bộ đo T1 / T3 / V1, không ship
tools/                dev server, truy vấn log, script verify
drizzle/              migration SQL đã sinh
```

## Giới hạn đã biết

- Một người dùng. Access code không phải hệ thống tài khoản.
- Không chèn ngữ cảnh theo từng lượt: brief cố định lúc kết nối. Nút `Nhắc AI` nối lại với brief mới
  khi cuộc nói chuyện đổi chủ đề.
- Correction được trích xuất sau phiên, không phải ngay lúc đang nói.
- Không chấm phát âm; nút Đọc dùng giọng text-to-speech của máy.
- Ephemeral token hết hạn sau 30 phút; nối lại sẽ cấp token mới.
- Phiên bị rớt (đóng tab, khoá máy) sẽ được nối tiếp nếu bạn quay lại trong 15 phút: đồng hồ
  chạy tiếp từ lúc bắt đầu nên `durationSec` vẫn đúng. Quá 15 phút thì phiên bị đánh dấu
  `abandoned` và thời lượng bị cắt ở mức 15 phút, để một phiên bỏ quên không làm sai thống kê tuần.

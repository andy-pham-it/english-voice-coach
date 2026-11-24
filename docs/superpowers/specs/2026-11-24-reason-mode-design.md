# Reason coach mode — short design

Ngày: 2026-11-24

## Intent & why

Người học muốn ba năng lực khi nói tiếng Anh: duy trì hội thoại (nối ý, hỏi lại, không freeze), có khung suy nghĩ trước khi mở miệng, và dùng được khung phân tích (PREP / Problem–Cause–Fix–Impact / STAR rút gọn) khi diễn đạt. Ba mode hiện tại (`coach`, `interview`, `reflex`) chỉ sửa ngữ pháp, ép số liệu, hoặc tập trả lời ngắn — chưa có chỗ luyện cấu trúc ý. Đây là kỹ năng tư duy khi nói, không phải sửa lỗi ngữ pháp.

## Goals

- Thêm mode `reason` với RULES riêng: bạn nêu khung 4 phần trước khi trả lời; AI hỏi đúng phần bị thiếu, cắt ngang nếu lan quá 45s, bắt bạn hỏi lại định kỳ để luyện duy trì hội thoại.
- Sau 8 phút AI thoát vai, chấm 1–5 theo `structure / reasoning / evidence / conversation flow` kèm 1 dòng bằng chứng mỗi mục, rồi đưa 1 câu mẫu 4 câu.
- Xoay 6 chủ đề bắt buộc phải lập luận (quyết định kỹ thuật, incident, tradeoff, tranh luận có số liệu, ưu tiên, giải thích cho người không kỹ thuật).
- Giữ nguyên luồng Live API: brief vẫn là 1 text blob lúc setup; rebrief vẫn dùng reconnect; extraction/summary không đổi.

## Non-goals / anti-goals

- Không sửa grammar trong lúc chạy mode `reason` (chỉ gom ở cuối) — tránh biến nó thành `coach`.
- Không thêm công cụ, model hay provider mới; không gọi LLM khi biên soạn brief.
- Không đụng `interview`/`reflex`. Không vượt ngân sách 250 token của RULES hay 1.000 token của brief.

## Constraints

- `Live API` chỉ nhận `systemInstruction` một lần lúc setup (`docs/.../2026-11-06...`, `docs/03-run-tests.md`). Mọi thứ phải nằm trong brief.
- `COACH_MODES` là enum trong `server/db/schema.ts` và có CHECK constraint trong DB (`drizzle/0005_reflex_mode_and_latency.sql`) — phải migrate.
- `src/api.ts` có union `CoachMode` riêng; `App.tsx` có 3 chip + restore từ `sessionStorage`.

## Approaches

1. **Mode `reason` riêng (đã chọn)** — RULES + topic rotation riêng, thêm enum, migration, toggle UI. Trực tiếp luyện (2)+(3), không làm loãng `reflex` (ngắn 15–20s) hay `interview` (không dạy). Chi phí: 1 migration + vài nhánh điều kiện.
2. **Gộp vào rule chung** — thêm “state your point first” vào RULES mọi mode. Ít file hơn nhưng xung đột với `reflex` (bắt ngắn) và `interview` (cấm teaching). Loại.
3. **Chỉ đo lường trong extraction** — sinh điểm hội thoại trên Summary. Dễ nhưng chỉ phản hồi, không tạo kỹ năng. Loại.

## Parts of the how (quyết định ở đây)

- `server/memory/brief.ts`: `REASON_RULES` (~170–200 từ, ≤250 token), thêm `'reason'` vào điều kiện `reviewLine` để cụm đến hạn vẫn được luồn vào tự nhiên, và `deriveTopic` trả 1 trong 6 chủ đề lập luận theo `sessionCount`.
- `server/db/schema.ts`: `COACH_MODES = ['coach','interview','reflex','reason']`.
- `drizzle/0006_reason_mode.sql`: drop/add CHECK constraint với 4 giá trị.
- `src/api.ts`: union `CoachMode` thêm `'reason'`.
- `src/App.tsx`: chip thứ 4, mô tả ngắn dưới chips, restore `sessionStorage` chấp nhận `'reason'`.
- `server/app.ts`, `server/session/service.ts`: không đổi logic — đã dùng `COACH_MODES.includes` và truyền `coach` vào `composeBrief`.

## Tests / verification

- Unit test mới cho `REASON_RULES` ≤250 token, `deriveTopic({ coach:'reason' })` xoay đúng 6 chủ đề, và `composeBrief(..., { coach:'reason' })` dùng REASON_RULES + giữ due vocab ở `reviewLine`.
- `npm run typecheck`, `npm test` (13+ test hiện tại), `npm run build`.
- `npm run db:migrate` trên local; verify thủ công 1 phiên ngắn mode `reason` qua `npm run dev` nếu có API key.

## Left to the builder

Viết plan bằng `writing-plans`, sau đó implement theo thứ tự: enum + migration → brief → api type → UI → test → verify. Không tự ý thêm mode thứ 5 hay sửa extraction.

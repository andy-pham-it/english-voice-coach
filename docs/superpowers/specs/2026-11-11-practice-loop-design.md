# Thiết kế: vòng luyện tập dùng được ngay

Ngày: 2026-11-11 · Trạng thái: chờ duyệt

## Vì sao

App hiện đã nói chuyện được (Gemini Live) và nhớ lỗi giữa các phiên, nhưng người học
vẫn không "dùng được tiếng Anh sớm hơn". Ba chỗ chặn:

1. Model chưa biết người học phải nói gì ở công việc thật — profile vẫn là dữ liệu mẫu.
2. Cuối phiên chỉ có danh sách lỗi, không có câu đúng nào để mang đi dùng ngay hôm sau.
3. Chỉ luyện được khi có micro và chỗ yên tĩnh, nên khó thành thói quen.

Thứ tự làm đã chốt với người dùng: **3 → 1 → 2**.

## Mục tiêu

- Sau mỗi phiên, người học có 3 câu tiếng Anh lấy từ chính lỗi của mình, dùng được ở
  standup / code review / họp ngay hôm sau, kèm nghĩa tiếng Việt và cách đọc.
- Ba câu đó quay lại ở phiên sau dưới dạng "cần dùng", và được tính là đã dùng nếu
  người học thật sự nói đúng trong phiên.
- Luyện được cả khi không tiện nói: gõ chữ trong phiên, AI vẫn trả lời bằng giọng.

## Không làm (đợt này)

- Không chấm phát âm. `speechSynthesis` chỉ để nghe mẫu.
- Không thêm bảng mới cho câu vận dụng — dùng lại `vocab` (đã có SRS) và một cột
  jsonb trên `sessions`.
- Không đổi model, voice, VAD.

## Thiết kế

### 1. Trích xuất sinh thêm "câu dùng ngay mai"

`server/extract/schema.ts` — thêm vào schema zod + JSON schema strict:

```ts
tomorrow: z.array(z.object({
  en: z.string().min(8).max(120),   // câu nói được ở chỗ làm
  vi: z.string().min(4).max(120),   // nghĩa tiếng Việt, ≤ 15 từ
  tag: z.enum(['standup','review','meeting','interview','smalltalk']),
})).max(3).default([]),
used_phrases: z.array(z.string().min(2).max(80)).max(5).default([]),
```

- `tomorrow`: prompt yêu cầu lấy từ chính lỗi trong phiên, viết lại thành câu hoàn
  chỉnh dùng được, không phải câu giải thích ngữ pháp.
- `used_phrases`: các cụm trong mục "Due for review" của brief mà người học đã dùng
  **đúng** trong phiên. Không có thì trả mảng rỗng — không bịa.

### 2. Lưu trữ

- Migration mới: `sessions.tomorrow jsonb` (nullable). Giữ nguyên lịch sử: phiên cũ
  không có thì null.
- `applyExtraction` ghi `tomorrow` vào session, và:
  - mỗi cụm trong `used_phrases` → `vocab.count += 1`, `next_review = now() + 7d`
    (đường SRS đã có, không thêm logic mới);
  - mỗi câu trong `tomorrow` → upsert `vocab` với `count = 1`,
    `next_review = now() + 1d`, `example` = câu đó. Nhờ vậy brief phiên sau tự nhắc.

### 3. UI

`Summary` thêm khối "3 câu dùng ngay mai" phía trên danh sách lỗi:

```
3 câu dùng ngay mai
1. "The migration is two days behind — I need one more day."   [standup] [Đọc]
   Migration chậm 2 ngày — cần thêm 1 ngày.
...
```

- `[Đọc]` gọi `speechSynthesis.speak(new SpeechSynthesisUtterance(en))`, `lang='en-US'`,
  rate 0.85. Không gọi API, không tốn tiền.
- Nếu `tomorrow` rỗng (phiên không có lỗi) → ẩn khối, không hiện khung trống.

`Session` thêm hàng nhập chữ dưới nút Push-to-talk:

```
[ Nhập câu để nói… ]  [Gửi]
```

- Gọi `live.sendText(text)` (hàm đã có, hiện chưa dùng) → gửi
  `{realtimeInput:{text}}`; vẫn nhận trả lời bằng audio như bình thường.
- Cho phép ở mọi trạng thái trừ `connecting`/`closed`; disable khi ô rỗng.
- Lưu ý: Live API có thể trả lời bằng transcription kèm audio; không cần xử lý thêm.

### 4. Kiểm chứng

- `tools/verify-extract.ts`: thêm assert `tomorrow ≤ 3` và mỗi câu có `en` + `vi`;
  assert cụm trong `used_phrases` làm `count` tăng đúng 1 (không tăng 2 lần khi gọi lại,
  nhờ idempotency đã có).
- `tools/verify-live-close.ts`: thêm assert `sendText` phát đúng payload
  `{realtimeInput:{text}}` trên FakeWs.
- Chạy tay: 1 phiên thật trên prod (có micro) để xem Summary hiện 3 câu và nút Đọc.

## Rủi ro

- Groq strict schema có thể flaky (đã gặp 1 lần) — nếu lỗi lặp lại thì bỏ `strict: true`,
  giữ validate zod.
- `tomorrow` làm extraction dài hơn ~100 token/call; vẫn trong 3000 max_tokens.
- `speechSynthesis` trên Chrome Android đọc được nhưng giọng theo máy; chấp nhận.

## Đợt sau (chưa làm)

1. **Onboarding 2 phút** — chọn mục tiêu + 5 câu về công việc → profile cấu trúc
   ~500 token; nâng `SECTION_BUDGET.profile` và `BRIEF_BUDGET`.
2. **Scenario có mục tiêu + điểm** — tình huống thật (báo trễ, từ chối deadline, review
   PR), AI đóng vai, cuối phiên chấm 3 tiêu chí.

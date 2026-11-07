# Brief — English Voice Coach

**Ngày:** 06/11/2026
**Trạng thái:** chờ duyệt

## Vấn đề

Luyện nói tiếng Anh bằng Gemini trên Android thất bại ở đúng một điểm: **không có trí nhớ giữa các phiên**. Mỗi lần mở là bắt đầu lại từ số 0 — không biết mình là ai, làm gì, đang yếu chỗ nào, tháng trước đã sửa lỗi gì.

Nguyên nhân gốc:

- Memory của Gemini chỉ có ở gói trả tiền.
- Gemini Live (voice) không đọc được Gems / knowledge file.
- Instructions free chỉ là "tính cách", không phải dữ liệu về người học.

## Giải pháp

Một web app voice-first, một người dùng, tự host. Mỗi phiên 10 phút nói tiếng Anh với AI. Cuối phiên app tự ghi lại: hôm nay nói về gì, lỗi nào lặp lại, cụm từ nào mới. Đầu phiên sau, app nhắc lại đúng những thứ đó.

Khác biệt cốt lõi so với dùng ChatGPT/Gemini: **trí nhớ do mình kiểm soát và nhìn thấy được**. Có tab `Context` hiển thị đúng đoạn text mà AI đang được đọc trước mỗi lượt.

## Phạm vi MVP (đúng 4 tính năng)

1. Push-to-talk: giữ nút để nói, thả để AI trả lời bằng giọng nói.
2. Phiên 10 phút, có đồng hồ đếm ngược.
3. Cuối phiên tự sinh summary (chủ đề, 3 lỗi, 3 cụm từ).
4. Đầu phiên nhắc 5 lỗi cũ + 3 cụm từ đến hạn ôn.

Không làm ở MVP: full-duplex realtime, multi-user, luyện phát âm chấm điểm, mobile app native, payment.

## Stack

| Lớp | Chọn | Free tier |
|---|---|---|
| Web | Vite + React + TypeScript + Tailwind | — |
| API | Hono trên Vercel Functions (Node 20) | Hobby, 300s/function |
| DB | Neon (Postgres 16) + Drizzle | 0.5GB, 1 project |
| STT | Groq `whisper-large-v3-turbo` | ~8 giờ audio/ngày |
| LLM | Groq `openai/gpt-oss-120b` | 30 RPM / 1K RPD / 200K TPD |
| TTS | Browser `speechSynthesis` | 0đ |

## Định nghĩa thành công

- Nói được 10 phút liên tục trên Chrome Android, không rớt phiên.
- Độ trễ mỗi lượt ≤ 4s (từ lúc thả nút đến lúc bắt đầu nghe câu trả lời).
- Sang phiên thứ 2, AI nhắc đúng ít nhất 3/5 lỗi của phiên 1 mà không cần mình nhắc.
- Mở tab Context thấy rõ: profile, state, recall — và sửa được.
- Tổng chi phí hạ tầng: 0đ/tháng ở mức 1 người, 1 phiên/ngày.

## Rủi ro lớn nhất

1. **Micro trên Android cần HTTPS** — không thể test qua LAN IP. Bắt buộc deploy hoặc dùng tunnel.
2. **Groq rate limit** — 200K token/ngày chỉ đủ ~6–7 phiên; phải đếm và cắt context.
3. **`speechSynthesis` chất lượng thấp và giọng không đều** trên Android — chấp nhận ở MVP, đã cô lập sau interface `TtsProvider` để thay Kokoro sau.
4. **Whisper nghe accent Việt** — cần test thực tế; nếu sai nhiều, chuyển sang gửi kèm prompt ngữ cảnh chủ đề để LLM tự sửa lỗi STT.

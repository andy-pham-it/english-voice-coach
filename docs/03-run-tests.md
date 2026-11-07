# Chạy ba bài test T1 / T3 / V1

**Ngày:** 06/11/2026
**Thời gian:** ~30 phút (5 phút chuẩn bị + 5 phút phiên A + 20 phút phiên B)
**Cần:** Chrome, tai nghe, phòng yên tĩnh, Gemini API key
**Đọc kèm:** `docs/02-test-plan.md` §9 (thiết kế test), spec §17 (ngưỡng đạt)

---

## 0. Sửa bộ đo trước khi chạy (06/11/2026)

Ba thay đổi trong `spike/index.html` và `tools/logs.mjs`, nếu chạy bản cũ thì V1 luôn sai:

1. **V1 trước đây không nạp 5 từ vào prompt.** 5 từ chỉ được đếm trong transcript, AI không hề biết chúng tồn tại — nên V1 chỉ đo xem người dùng có tự nói 5 từ đó không. Đã thêm khối chỉ dẫn ẩn vào `buildSystem()`:

   ```
   TARGET VOCABULARY: weave these phrases into your own replies when the topic
   allows, at most twice each, in a natural sentence: mitigate, tradeoff, ...
   Never announce this as a lesson, never list them, never tell the learner to use them.
   ```

2. **`seeded_first` trước đây không tồn tại.** Chỉ có `seeded_by_ai` (AI có dùng từ, không phân biệt trước/sau). Đã thêm mốc `wordFirstAiAt` / `wordFirstUserAt` theo thời điểm transcript, nên `seeded_first` nghĩa đúng: AI gieo từ **trước** khi người dùng dùng lại.

3. **`tools/logs.mjs` đọc được `.data/logs/inbox/*.json`** — cần cho phiên chạy trên Android, vì trang deploy không POST được về `localhost` của Mac.

Sau khi sửa: `node --check` cả hai file đều pass. Nếu tab Chrome đang mở, `Ctrl+Shift+R` để nạp lại.

---

## 1. Chuẩn bị (5 phút, làm một lần)

```bash
cd ~/personal/english-voice-coach
node tools/dev-server.mjs
```

Để terminal đó chạy suốt. Server tĩnh port 8080 + nhận log qua `POST /__log`.

Mở Chrome: `http://localhost:8080`

Checklist:

- [ ] Dán Gemini API key
- [ ] Model: `gemini-3.8-live`
- [ ] Giọng: chọn một cái và **giữ nguyên cả hai phiên** — đổi giữa chừng thì không so sánh được
- [ ] Tick `Giải thích lỗi bằng tiếng Việt` — bật ở cả hai phiên, vì đó là config thật của sản phẩm
- [ ] Panel "Bộ đo T1 / T3 / V1": để nguyên canary `My project codename is Bluebird. I work on SRS streaming.`, phút `15`, đáp án `Bluebird`, 5 từ mặc định
- [ ] Tai nghe đã cắm (bắt buộc cho phiên B)
- [ ] Phòng yên tĩnh, không TV, không nhạc

---

## 2. Phiên A — T1 (5 phút, push-to-talk)

Đo độ trễ từ lúc hết câu đến lúc có audio đầu tiên. Không cần nói hay, chỉ cần đủ lượt.

1. **Bỏ tick** `Luôn mở mic (full-duplex)`. Còn tick thì cột latency chỉ hiện `— (duplex)`, không có số nào.
2. Ô `Chờ bao lâu mới coi là hết câu`: chọn **900ms**.
3. Bấm **`Bắt đầu test`** — chưa bấm `Kết nối` vội.
4. Bấm **`Kết nối`**, đợi status `sẵn sàng — giữ nút để nói`.
5. Nói **8 lượt**. Mỗi lượt: giữ nút mic → nói 8–20 giây → thả → đợi AI nói xong hẳn → lượt tiếp.

Nếu bí chủ đề, dùng đúng 8 câu này:

| # | Nói về |
|---|---|
| 1 | Standup hôm nay: đã làm gì, đang làm gì, bị chặn gì |
| 2 | Một bug khó gần đây, giải thích nguyên nhân |
| 3 | Một quyết định kỹ thuật và lý do chọn nó |
| 4 | Trade-off giữa hai cách làm |
| 5 | Code review: một chỗ sẽ bắt bẻ và vì sao |
| 6 | Một lần estimate sai và học được gì |
| 7 | Giải thích system của mình cho người mới |
| 8 | Hôm nay muốn cải thiện gì trong cách nói |

6. Bấm **`Kết thúc`** — log tự POST về server, không tải file. Sau đó bấm `Ngắt`.

**Xong khi** panel hiện:

```
T1 latency: ĐẠT — n=8, p50=...ms
VAD cắt sớm: ĐẠT — 0 lần
```

**Đạt:** `n ≥ 5` **và** `p50 < 1500ms` **và** `early_responses = 0`.

**Nếu `VAD cắt sớm` > 0:** đổi silence lên `1300ms` → `Kết nối` lại → `Bắt đầu test` lại → chạy lại từ đầu. Không dùng số latency của lần đó: nó đo sai mốc kết thúc câu.

---

## 3. Phiên B — T3 + V1 (20 phút, full-duplex)

Đo trí nhớ dài phiên (T3) và việc gieo từ vựng (V1).

1. Bấm `Ngắt` nếu còn kết nối.
2. **Tick** `Luôn mở mic (full-duplex)`.
3. Ô silence: **1300ms**. Đổi xong phải Kết nối lại — VAD chỉ gửi lúc setup.
4. **Đeo tai nghe.** Loa ngoài khiến AI nghe chính nó và tự cắt lời.
5. Bấm **`Bắt đầu test`** lần nữa — reset bộ đếm, nạp lại canary + 5 từ.
6. Bấm **`Kết nối`**.
7. Nói liên tục ~20 phút, chia 5 chủ đề:

| Phút | Chủ đề |
|---|---|
| 0–4 | Standup tuần này, việc đang làm |
| 4–8 | Một sự cố production và cách xử lý |
| 8–12 | Tranh luận: nên refactor hay viết lại |
| 12–16 | Giải thích kiến trúc cho người ngoài team |
| 16–20 | Kế hoạch tuần sau, điều muốn học |

8. **Không tự nhắc tên project, "Bluebird", hay "SRS"** trong suốt phiên. Nếu người dùng nói ra, AI chỉ cần lặp lại là T3 pass giả.
9. **Phút 15** app tự gửi probe, status đổi thành `đang kiểm tra trí nhớ (probe)...`. Trả lời **một câu ngắn**, đúng câu hỏi, không gợi ý đáp án.
10. Nói tiếp tới phút 20 để chắc context còn sống sau probe.
11. **Không chủ động dùng 5 từ** (`mitigate, tradeoff, bottleneck, rollback, scope creep`). Để AI đưa vào câu trước; người dùng dùng lại khi thấy tự nhiên. Nói trước thì `seeded_first = false` và từ đó không được tính.
12. Bấm **`Kết thúc`** → `Ngắt`.

**Xong khi** panel hiện:

```
T3 canary: ĐẠT — "Bluebird..."        (câu trả lời thật của AI)
V1 từ vựng: ĐẠT — dùng lại 3/5, AI gieo trước 3/5
```

**T3 đạt:** câu trả lời ở phút 15 chứa `Bluebird`. Không có → `systemInstruction` đã bị nén mất giữa phiên. Đây là lỗi chặn: phải thêm reconnect định kỳ ở phút 8, ảnh hưởng cả §10 lẫn §12 của spec.

**V1 đạt:** dùng lại `≥ 2/5` **và** `seeded_first ≥ 2`. Nếu AI không gieo từ nào (chủ đề không hợp), V1 là *chưa đo được* chứ không phải fail — chạy lại phiên nói về planning/estimate.

---

## 4. Đọc kết quả

```bash
node tools/logs.mjs list        # bảng mọi lần chạy
node tools/logs.mjs show latest # chi tiết: p50, p95, từng từ, transcript
node tools/logs.mjs summary     # gộp: tỉ lệ đạt, p50/p95 toàn bộ
node tools/logs.mjs events '#1' # timeline từng sự kiện của lần chạy 1
```

Log nằm ở `.data/logs/events-YYYY-MM-DD.jsonl`. Không cần tải file, không cần copy/paste.

Sau khi chạy xong chỉ cần nói **"chạy xong rồi"** — người review tự mở log và nói cần sửa gì.

---

## 5. Bốn cái bẫy

| Bẫy | Hậu quả |
|---|---|
| Bấm `Kết nối` trước `Bắt đầu test` | Canary không vào prompt → T3 fail giả |
| Để tick duplex khi chạy T1 | Không có số latency, chỉ `— (duplex)` |
| Nói "Bluebird"/"SRS" trong phiên B | T3 pass giả, mất giá trị test |
| Tự dùng 5 từ trước AI | V1 fail giả |

---

## 6. Chạy trên Android

Spike đã deploy: **https://spike-ecru-six.vercel.app**

Trang deploy không gọi được `localhost` của Mac, nhưng log **tự đi thẳng vào Neon** qua `POST /api/spike-log`. Chỉ cần bấm `Kết thúc` là xong.

Mình đọc bằng:

```bash
node tools/spike-runs.mjs list      # các lần chạy trong Neon
node tools/spike-runs.mjs show 1    # run #1, đầy đủ JSON
node tools/spike-runs.mjs latest    # lần gần nhất
```

Nếu endpoint fail (mất mạng, key sai), panel hiện hint đỏ. Khi đó:

1. Bấm **`Copy JSON`** → dán thẳng vào chat.
2. Hoặc để nó tải `tests-all.json`, chuyển về Mac rồi bỏ vào `.data/logs/inbox/`:

```bash
mkdir -p ~/personal/english-voice-coach/.data/logs/inbox
mv ~/Downloads/tests-all.json ~/personal/english-voice-coach/.data/logs/inbox/
node tools/logs.mjs list
```

**Ba điều bắt buộc trên điện thoại:**

- Cắm tai nghe cho phiên B. Loa ngoài → AI nghe chính nó → `barge_ins` tăng vô nghĩa.
- Tắt tự khoá màn hình (hoặc đặt 10 phút). Spike không giữ `wakeLock`; màn hình tắt là Chrome treo mic.
- Không chuyển app giữa phiên. Android sẽ cắt `getUserMedia` và phiên chết.

---

## 7. Reset

- `xoá lịch sử đo` trong panel: xoá `localStorage` của trình duyệt.
- `rm -rf .data/logs/*`: xoá log trên đĩa.
- `node -e '…'` hoặc `psql` để xoá `spike_runs` nếu muốn sạch Neon:

```bash
node --input-type=module -e '
import {Client} from "pg"; import {readFileSync} from "node:fs";
const env=Object.fromEntries(readFileSync(".env.local","utf8").split("\n").filter(l=>l.includes("="))
  .map(l=>{const i=l.indexOf("=");return [l.slice(0,i),l.slice(i+1).replace(/^"|"$/g,"")]}));
const c=new Client({connectionString:env.DATABASE_URL}); await c.connect();
console.log(await c.query("delete from spike_runs returning id"));
await c.end();'
```

## 8. App thật (khác spike)

Bản app đã deploy: **https://english-voice-coach-five.vercel.app** — access code `andy-b7f6`.

Đây là app dùng hằng ngày, không phải bộ đo. Nó có: Home (streak, lỗi lặp, từ đến hạn), Session (duplex/PTT, transcript, `Nhắc AI`), Summary sau phiên, Context (sửa profile, xem brief, xoá lỗi). Không có panel đo T1/T3/V1 — muốn đo thì dùng spike.

Trên Android: cắm tai nghe, tắt tự khoá màn hình, không chuyển app giữa phiên.

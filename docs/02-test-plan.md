# Test Plan — English Voice Coach

**Ngày:** 06/11/2026
**Mục đích:** xác định mode nào đáng build, mode nào không, và cái gì phải đo trước khi cam kết kiến trúc.

---

## 0. Nguyên tắc

1. **Mỗi lần test đổi đúng một biến.** VAD 1.3s + đổi model + đổi prompt cùng lúc thì không biết cái nào gây ra kết quả.
2. **Không chấm bằng cảm giác.** Mỗi test phải có ngưỡng đạt/không đạt viết trước khi chạy.
3. **Ghi lại được.** Mọi lượt nói phải có timestamp, transcript, token. Không có log thì không so sánh được giữa các lần.
4. **Test trên thiết bị thật.** Mac + tai nghe cho kết quả đẹp hơn thực tế. Kết luận cuối cùng phải lấy từ Android, cầm tay, có tiếng ồn.
5. **Test cái rủi ro nhất trước.** Không phải cái dễ nhất.

## 1. Bốn trục phải test, đừng lẫn

| Trục | Câu hỏi | Nếu sai thì sao |
|---|---|---|
| **Kỹ thuật** | Nó có chạy ổn định 20 phút trên Android không? | Không có sản phẩm |
| **Sư phạm** | Nó có dạy được không, hay chỉ nói chuyện? | Là chatbot đội lốt |
| **Trí nhớ** | Nó có nhớ và dùng lại đúng không? | Mất lý do tồn tại |
| **Trải nghiệm** | Có muốn mở lại ngày mai không? | Chết sau 3 ngày |

Test sư phạm mà hệ thống lag thì kết luận vô nghĩa. Test kỹ thuật mà nội dung dở thì cũng vô nghĩa. Nên: **kỹ thuật trước, sư phạm sau, trí nhớ cuối** — vì trí nhớ chỉ đo được khi hai phiên đã chạy ổn.

## 2. Ma trận mode

Bốn mode anh nêu không cùng loại. Chúng luyện bốn cơ chế nhận thức khác nhau, sinh ra bốn loại dữ liệu khác nhau, và **không dùng chung một pipeline**.

| Mode | Kỹ năng thật | Dữ liệu sinh ra | Công nghệ cần | Độ khớp với Live API |
|---|---|---|---|---|
| **Conversation** | Cấu trúc câu dưới áp lực thời gian | Lỗi ngữ pháp, độ trôi chảy, từ vựng dùng được | Live API | Rất cao |
| **Shadowing** | Ngữ điệu, trọng âm, nối âm | Độ lệch âm thanh so với mẫu | Forced alignment + so sánh prosody | **Thấp** |
| **Vocabulary** | Truy hồi và dùng từ trong ngữ cảnh | Trạng thái SRS từng mục | SRS + LLM kiểm tra câu | Trung bình |
| **Retell / Explain** | Tổ chức diễn ngôn (claim → reason → example) | Cấu trúc bài nói, không phải lỗi câu | LLM rubric | Cao |
| **Role-play có áp lực** | Phản biện, hedging, giữ lập trường | Chuỗi phản hồi khi bị chất vấn | Live API + kịch bản | Cao |

**Cảnh báo lớn nhất:** đừng build 4 mode. Mỗi mode là một sản phẩm riêng về mặt dữ liệu. Nếu `mistakes` là bảng chung cho cả bốn, dữ liệu shadowing sẽ làm hỏng trí nhớ conversation — vì shadowing không sinh ra "lỗi ngữ pháp", nó sinh ra "độ lệch âm".

Đề xuất: **conversation là mode gốc**, mọi mode khác phải đổ dữ liệu vào cùng một vòng lặp trí nhớ, nếu không thì nó chỉ là app khác ghép vào.

## 3. Chi tiết từng mode

### 3.1 Conversation — mode gốc

**Mục tiêu:** đo khả năng tạo câu trong 1–2 giây, không phải độ chính xác tuyệt đối.

Ba bài, độ khó tăng:

| Bài | Thiết lập | Thời lượng | Đo gì |
|---|---|---|---|
| C1. Small talk | AI hỏi chuyện đời thường, không chủ đề kỹ thuật | 5 phút | Anh có nói được câu >8 từ không? Có im lặng >3s không? |
| C2. Standup | AI là teammate, hỏi "what did you do yesterday" | 5 phút | Dùng được thì quá khứ? Có nêu blocker không? |
| C3. Bảo vệ quyết định | AI phản biện: "why not Postgres?" | 10 phút | Có giữ được lập trường? Có hedging tự nhiên? Có bị đổi ý vô lý? |

**Chỉ số đo được từ transcript:**

- `words_per_turn` — trung bình độ dài lượt của anh.
- `filler_rate` — số "um/uh/like/you know" trên 100 từ.
- `self_repair_rate` — số lần tự sửa giữa câu.
- `ai_interruptions` — số lần AI chen vào khi anh chưa nói xong. **Đây là chỉ số quan trọng nhất của VAD.**
- `response_gap` — thời gian từ lúc hết câu đến lúc anh bắt đầu câu tiếp.

**Đạt:** C1 không có khoảng im lặng nào >5s trong 5 phút; `ai_interruptions` = 0.
**Không đạt:** AI cắt lời >2 lần/5 phút → VAD chưa đủ tốt, phải chuyển sang push-to-talk hoặc tăng silence.

### 3.2 Shadowing — mode khó nhất về kỹ thuật

Anh nêu hai biến thể: **cả đoạn** và **từng phrase**. Chúng khác nhau hoàn toàn về cách chấm.

**Shadowing theo phrase (2–5 giây):**
- Cho nghe mẫu → anh nhắc lại → so sánh.
- Chấm được bằng transcript: thiếu từ, sai trọng âm ở cấp từ (nếu có alignment).
- Cái **không** chấm được bằng transcript: ngữ điệu, độ dài nguyên âm, nối âm.

**Shadowing theo đoạn (30–60 giây):**
- Chấm bằng transcript gần như vô nghĩa — sai ngữ điệu vẫn ra transcript đúng 100%.
- Muốn chấm thật cần: forced alignment (Whisper word timestamps) + so sánh pitch contour + so sánh độ dài âm tiết.

**Kết luận kỹ thuật:** shadowing **không** phải bài toán của Live API. Nó là pipeline riêng:

```
reference audio → user audio → forced alignment → so sánh 3 thứ:
  1. từ (WER)
  2. thời lượng từng từ (rhythm)
  3. pitch contour (intonation)
```

**Test tối thiểu trước khi build:**
- **S1.** Cho AI đọc một câu, anh nhắc lại, hỏi AI "chỗ nào sai" → xem nó có phát hiện được lỗi ngữ điệu không. Dự đoán: **không**, vì nó chỉ có transcript.
- **S2.** Cùng câu đó, anh cố tình đọc sai trọng âm nhưng đúng từ → AI có nhận ra không. Dự đoán: **không**.
- **S3.** Anh đọc thiếu 1 từ → AI có nhận ra không. Dự đoán: **có**.

Nếu S1/S2 đều fail như dự đoán: **đừng làm shadowing trong MVP**. Làm nó sau, như một pipeline riêng, và đừng gọi nó là "shadowing" nếu chỉ chấm được từ — gọi là "repeat after me" cho đúng.

**Nguồn câu mẫu:** TTS của chính Gemini (giọng khác với giọng hội thoại) hoặc clip podcast. Dùng TTS rẻ hơn và kiểm soát được độ khó.

### 3.3 Vocabulary — mode rẻ nhất, dễ lừa nhất

Ba mức, đừng nhầm:

| Mức | Test | Chấm bằng |
|---|---|---|
| Nhận ra | "Từ này nghĩa là gì trong câu này?" | Đúng/sai |
| Dùng được | "Đặt câu với từ này" | LLM kiểm tra ngữ pháp + ngữ nghĩa |
| Dùng được dưới áp lực | Hội thoại tự nhiên, có ai đó dùng từ đó | Có tự dùng lại trong 10 phút không |

**Cái bẫy:** mức 1 và 2 đều dễ, và đều tạo cảm giác tiến bộ giả. Chỉ mức 3 mới là thứ chuyển sang nói thật.

**Test:**
- **V1.** Dạy 5 từ mới trong hội thoại, không nói "hôm nay học 5 từ". Sau 10 phút, đếm xem anh dùng lại được mấy từ. Đạt: ≥2/5.
- **V2.** Hôm sau, AI có chủ động dùng lại từ đó không (để anh gặp lại trong ngữ cảnh). Đạt: ≥3/5.
- **V3.** Từ đến hạn ôn có được chèn vào tình huống tự nhiên không, hay bị nhét thô ("please use the word 'mitigate'").

**Quan trọng:** từ vựng không nên có UI riêng ở MVP. Nó là thứ AI gieo vào hội thoại và thu hoạch ở cuối phiên.

### 3.4 Retell / Explain — gần công việc thật nhất

Đây là mode mình khuyên thêm, vì nó đúng thứ anh cần hơn cả small talk.

- Đưa một đoạn 150 từ (RFC, changelog, bug report) → anh giải thích lại trong 60 giây như nói với teammate.
- Chấm theo rubric 4 mục: **có nêu claim không**, **có lý do không**, **có ví dụ không**, **có trade-off không**.
- Không chấm ngữ pháp ở mode này. Chấm cấu trúc.

**Test:** cùng một đoạn, chạy 3 lần, xem rubric có ổn định không. Nếu 3 lần cho 3 kết quả khác nhau → rubric quá mơ hồ, phải viết lại.

### 3.5 Role-play có áp lực

- **R1. Interviewer khó tính:** hỏi dồn, cắt lời, "that doesn't answer my question".
- **R2. Đồng nghiệp hoài nghi:** "I don't think that's worth the effort."
- **R3. Khách hàng mất kiên nhẫn:** phàn nàn, đòi deadline.

Đo: anh có giữ được câu trả lời >15 từ khi bị ép không, có dùng hedging (`I'd argue`, `it depends`, `to be fair`) không, có bị chuyển sang tiếng Việt khi căng không.

**Đây là mode dễ gây nghiện nhất và cũng dễ gây nản nhất.** Test 1 lần/tuần, không phải mỗi ngày.

## 4. Level — có nên đưa vào?

**Có, nhưng "level" dạng CEFR là một con số vô dụng.**

Lý do:

1. **Tự khai luôn sai.** Người B1 thường khai B2; người B2 thật thường khai B1.
2. **Level không phải một số, nó là vector.** Cùng một người có thể tranh luận system design ở B2 nhưng đứng hình ở small talk. Chấm một con số là chấm trung bình của hai thứ không liên quan.
3. **Level thay đổi theo chủ đề, không theo thời gian.** Anh nói về SRS streaming trôi chảy hơn nói về cuối tuần. Đó không phải "level thấp", đó là "chưa quen chủ đề".
4. **Level tĩnh sẽ thành lời tiên tri tự ứng nghiệm.** Nếu app gắn nhãn B1, nó sẽ mãi hỏi câu B1.

### Thay vào đó: 5 trục + bản đồ quen chủ đề

**Năm trục đo được, cập nhật liên tục:**

| Trục | Đo bằng | Thang |
|---|---|---|
| Fluency | từ/phút, độ dài lượt, khoảng lặng | 1–5 |
| Accuracy | lỗi/100 từ, tách theo pattern | 1–5 |
| Range | type-token ratio, số từ hiếm dùng đúng | 1–5 |
| Discourse | cấu trúc câu trả lời (claim/reason/example) | 1–5 |
| Pronunciation | chỉ đo được nếu có pipeline audio riêng | — |

**Bản đồ chủ đề:** mỗi chủ đề có trạng thái `chưa gặp / đang luyện / thoải mái`, cập nhật theo hiệu suất thực tế trên chủ đề đó.

**Cách khởi tạo:** 3 bài 30 giây ở lần đầu (small talk, mô tả công việc, giải thích một khái niệm quen). Không hỏi "trình độ của bạn là gì".

**Cách dùng:** không hiển thị "Bạn là B1". Hiển thị "Accuracy đang tăng, Fluency đứng yên 2 tuần" — cái này hành động được, con số kia thì không.

**Núm điều chỉnh độ khó thay vì "level":**

- Tốc độ nói của AI (0.9x → 1.15x).
- Độ hiếm từ vựng AI dùng.
- Độ phức tạp câu hỏi (có mệnh đề phụ hay không).
- Thời gian chờ trước khi AI gợi ý.
- Mật độ sửa lỗi (0 → 2 lỗi/lượt).
- Có cho phép tiếng Việt giải thích hay không.

Sáu núm này điều khiển được độ khó thật, còn "level" chỉ là nhãn.

## 5. Test kỹ thuật bắt buộc (làm trước mọi thứ khác)

| # | Test | Cách làm | Đạt |
|---|---|---|---|
| T0 | VAD không cắt lời | Nói câu dài, dừng 1s giữa câu | AI không chen vào |
| T1 | Latency PTT | Đo `first audio` 10 lượt | p50 < 1.5s |
| T2 | Phiên 20 phút | Nói liên tục 20 phút | Không rớt kết nối, không mất system prompt |
| T3 | Mất trí nhớ theo phiên | Nhét vào system prompt: "My name is Andy, I work on SRS streaming". Hỏi lại ở phút 18 | Trả lời đúng |
| T4 | Drift chỉ dẫn | Sau 15 phút, kiểm tra còn tuân thủ "max 2 lỗi/lượt" không | Có |
| T5 | Đứt wifi giữa lượt | Tắt wifi 5s | Tự nối lại hoặc báo lỗi rõ, không treo |
| T6 | Android thật, tiếng ồn | Quạt + đường phố | Transcript vẫn đúng >90% |
| T7 | Nhiều phiên liên tiếp | 3 phiên trong 1 ngày | Không bị chặn quota |

**T3 là test quan trọng nhất và ít ai nghĩ tới.** Live API nén context khi phiên dài; nếu nó nén mất `systemInstruction`, AI sẽ quên mình là ai giữa phiên — mà triệu chứng rất khó thấy (nó vẫn trả lời trôi chảy, chỉ là hết sửa lỗi).

## 6. Rubric chấm sư phạm (dùng cho mọi mode)

Chấm 1–5, không chấm cảm tính:

1. **Có sửa lỗi không?** (0 lỗi/lượt = 1 điểm)
2. **Lỗi được chọn có đáng sửa không?** (sửa lỗi vô nghĩa = 2 điểm)
3. **Cách sửa có tự nhiên không?** (ngắt mạch để giảng = 2 điểm)
4. **Có giữ được đà nói của anh không?** (anh nói ít hơn 30% so với khi không có AI = 2 điểm)
5. **Cuối phiên có biết mình sai gì không?** (không nhớ gì = 1 điểm)

Điểm ≤ 3 ở bất kỳ mục nào → mode đó chưa dùng được, bất kể kỹ thuật có mượt.

## 7. Thứ tự thực hiện

```
Tuần 1: T0 → T1 → T2 → T3 → T4        (kỹ thuật, 1 buổi)
Tuần 1: C1 → C2                        (conversation cơ bản)
Tuần 2: C3 → R1                        (áp lực)
Tuần 2: V1 → V2                        (từ vựng, chèn vào conversation)
Tuần 3: S1 → S2 → S3                   (quyết định có làm shadowing không)
Tuần 3: T6 → T7                        (Android thật, nhiều phiên)
```

**Quyết định sau mỗi chặng:**

- T2/T3 fail → Live API không đủ ổn định cho phiên dài → quay lại turn-based.
- C1 fail vì AI cắt lời → push-to-talk thắng, bỏ duplex.
- S1/S2 fail → shadowing ra khỏi MVP, ghi vào backlog kèm lý do kỹ thuật.
- V1 < 2/5 → cơ chế gieo từ chưa hoạt động, đừng làm UI từ vựng.
- R1 quá khó, gây nản → hạ xuống 1 lần/tuần, không phải mỗi ngày.

## 8. Những thứ KHÔNG nên test ở giai đoạn này

- **Chấm phát âm.** Cần pipeline riêng, và kết quả sẽ tệ hơn kỳ vọng. Để sau.
- **So sánh model.** Đã chọn Live; so sánh Groq vs Gemini giờ là tối ưu hóa sai chỗ.
- **UI đẹp.** Spike cố tình xấu. Đẹp hóa trước khi biết mode nào sống là lãng phí.
- **Multi-user.** Không có người dùng thứ hai.
- **Mobile app native.** PWA là đủ cho đến khi có lý do thật.

## 9. Cách chạy 3 bài test (T1 / T3 / V1) với spike

Spike đã có sẵn bộ đo trong panel **"Bộ đo T1 / T3 / V1"**. Không cần sửa code.

### Chuẩn bị chung

1. `cd ~/personal/english-voice-coach && node tools/dev-server.mjs`
   (server tĩnh port 8080 + nhận log; không cần `python3 -m http.server` nữa)
2. Mở `http://localhost:8080` trên Chrome (Mac hoặc Android — trên Android phải dùng bản deploy HTTPS, xem ghi chú cuối).
3. Dán API key.
4. Chọn model `gemini-3.8-live`, chọn giọng.
5. **Bấm `Bắt đầu test` TRƯỚC khi bấm `Kết nối`.** Canary chỉ được nhét vào `systemInstruction` lúc setup; bấm sau khi kết nối thì bài T3 mất giá trị.
6. Nếu đổi model / giọng / độ nhạy VAD giữa chừng: phải `Kết thúc` → `Kết nối` lại → `Bắt đầu test` lại.

### Phiên A — đo T1 (5 phút, push-to-talk)

- Tắt "Luôn mở mic". Đặt silence về **900ms**.
- Nói ít nhất **8 lượt**, mỗi lượt 8–20 giây, giữ nút thật rồi thả.
- Bấm `Kết thúc` → log tự gửi về server, không tải file.

**Điều kiện hợp lệ:** `vad_early_responses.count` phải bằng **0**. Nếu > 0 nghĩa là AI trả lời khi anh còn đang nói, và mọi số latency đo được đều vô nghĩa (nó đo sai mốc kết thúc câu). Khi đó tăng silence lên 1300/1800ms rồi chạy lại.

**Đạt:** p50 < 1500ms và early_responses = 0.

### Phiên B — đo T3 + V1 (20 phút, full-duplex)

- Bật "Luôn mở mic", **đeo tai nghe** (loa ngoài sẽ tự cắt lời).
- Đặt silence **1300ms**.
- Nói chuyện bình thường, không nhìn đồng hồ. Đến phút 15 app tự gửi câu hỏi kiểm tra canary.
- Cố ý **không** dùng 5 từ đó trước. Để AI gieo từ vào câu của nó; anh chỉ dùng lại khi thấy tự nhiên. Nếu anh tự nói trước thì `seeded_first` = false và bài đo mất giá trị.
- Bấm `Kết thúc` → log tự gửi về server.

**T3 đạt:** câu trả lời ở phút 15 có chứa "Bluebird". Nếu không, system prompt đã bị nén mất giữa phiên — đây là lỗi chặn, không phải lỗi nhỏ.

**V1 đạt:** anh dùng lại ≥ 2/5 từ **và** `seeded_first` ≥ 2 — nghĩa là AI đã đưa từ vào câu trước, rồi anh dùng lại. Spike nạp 5 từ vào `systemInstruction` dưới dạng chỉ dẫn ẩn ("weave these in naturally, never announce"), nên AI phải gieo trước; nếu anh tự nói trước thì lần xuất hiện đó không tính.

**Sửa spike 06/11/2026:** trước bản này 5 từ chỉ được đếm chứ không hề được nạp vào prompt, nên V1 luôn đo nhầm thứ. Đã thêm khối `TARGET VOCABULARY` vào `buildSystem()` và mốc thời gian `wordFirstAiAt` / `wordFirstUserAt` để xác định ai dùng trước.

### Đọc kết quả

Không cần tải file, không cần copy/paste. Log nằm ở `.data/logs/events-YYYY-MM-DD.jsonl`, và mình đọc trực tiếp bằng:

```
node tools/logs.mjs list        # bảng mọi lần chạy
node tools/logs.mjs summary     # gộp: tỉ lệ đạt, p50/p95
node tools/logs.mjs show latest # chi tiết lần gần nhất
```

Sau khi anh chạy xong, chỉ cần nói "chạy xong rồi" — mình tự mở log, đọc số, và nói cần sửa gì. Nếu muốn xem cùng lúc, chạy `node tools/logs.mjs list` rồi bảo mình số thứ tự.

**Ghi chú Android:** trang deploy trên Vercel không gọi được `localhost` của máy Mac, nên log sẽ không tự gửi. Hai cách: (a) chạy phiên Android rồi tải JSON thủ công bằng nút `Kết thúc` và bỏ file vào `.data/logs/inbox/`; (b) deploy kèm một endpoint nhận log — để sau, chưa cần cho vòng test này.

**Reset:** bấm `xoá lịch sử đo` để xoá `localStorage` trước khi bắt đầu một loạt test mới. Log trên đĩa vẫn giữ, muốn xoá thì `rm -rf .data/logs`.

### Ba cái bẫy khi tự chạy

1. **Quên bấm Bắt đầu trước khi Kết nối** → canary không có, T3 luôn fail giả.
2. **Đo T1 trong lúc duplex** → không có số, chỉ hiện `— (duplex)`.
3. **Chạy phiên A quá ngắn (<5 lượt)** → p50 từ 3 mẫu là số rác.


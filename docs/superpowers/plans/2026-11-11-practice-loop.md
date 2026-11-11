# Practice Loop (3 câu dùng ngay mai + gõ chữ) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sau mỗi phiên, người học nhận 3 câu tiếng Anh dùng được ở chỗ làm, được nhắc lại ở phiên sau và tính là đã dùng khi nói đúng; đồng thời luyện được bằng cách gõ chữ.

**Architecture:** Mở rộng hợp đồng trích xuất (zod + JSON schema strict của Groq) thêm `tomorrow[]` và `used_phrases[]`; lưu `tomorrow` vào cột jsonb mới trên `sessions` và đẩy vào bảng `vocab` sẵn có để brief phiên sau tự nhắc (không thêm bảng, không thêm logic SRS). Client chỉ hiển thị thêm một khối trong Summary và một hàng nhập chữ trong Session.

**Tech Stack:** TypeScript, Hono, Drizzle + Neon Postgres, zod, Groq `openai/gpt-oss-120b` (structured output), React 19 + Vite.

**Spec:** `docs/superpowers/specs/2026-11-11-practice-loop-design.md`

## Global Constraints

- Mọi import tương đối trong `server/` và `api/` phải có đuôi `.js` (function build ra ESM).
- `tsconfig.json` không được đặt `"types": ["node"]` (gây `TS2688` khi Vercel build).
- Không đổi model Live (`models/gemini-3.8-live`), voice `Puck`, hay `DEFAULT_VAD`.
- Nội dung hiển thị cho người dùng bằng tiếng Việt; câu tiếng Anh là dữ liệu, không dịch.
- Không thêm dependency mới.
- Mọi script verify phải tự khôi phục DB về trạng thái trước khi chạy (snapshot/restore đã có sẵn).
- Giới hạn: `tomorrow` tối đa 3 phần tử, mỗi `en` ≤ 120 ký tự, mỗi `vi` ≤ 120 ký tự, `used_phrases` tối đa 5.

## Review Focus

- Groq strict schema từ chối payload có object thiếu `required` hoặc thiếu `additionalProperties: false` → phiên nào cũng mất phần trích xuất; test ở Task 1 và Task 3 phải chạy Groq thật.
- `tomorrow` rỗng ở phiên không có lỗi → Summary không được hiện khối trống (Task 5).
- Gọi lại `/extract` trên phiên đã có summary → `vocab.count` không được cộng lần hai (Task 3).
- Câu trong `tomorrow` trùng cụm đã có trong `vocab` → upsert, không tạo bản ghi thứ hai (Task 3).
- Gõ chữ khi socket chưa `ready` hoặc đã `closed` → không được ném lỗi hay treo UI (Task 6).

---

### Task 1: Hợp đồng trích xuất có `tomorrow` và `used_phrases`

**Files:**
- Modify: `server/extract/schema.ts`
- Modify: `server/extract/prompt.ts`
- Modify: `tools/verify-extract.ts`

**Interfaces:**
- Consumes: `MISTAKE_PATTERNS` từ `server/db/schema.js`.
- Produces:
  - `export const tomorrowSchema` (zod object `{ en, vi, tag }`), `export type TomorrowPhrase = z.infer<typeof tomorrowSchema>`.
  - `extractionSchema` thêm `tomorrow: TomorrowPhrase[]` (mặc định `[]`) và `used_phrases: string[]` (mặc định `[]`).
  - `extractionJsonSchema` thêm hai property tương ứng, cả hai nằm trong `required` của object gốc.

- [ ] **Step 1: Viết assert thất bại trong `tools/verify-extract.ts`**

Thêm sau assert `check('corrections ≤ 5', ...)`:

```ts
check('tomorrow ≤ 3', (res.extraction.tomorrow ?? []).length <= 3, `${(res.extraction.tomorrow ?? []).length}`);
check(
  'mỗi câu tomorrow có en + vi',
  (res.extraction.tomorrow ?? []).every((t) => t.en.length >= 8 && t.vi.length >= 4),
);
```

`res` là biến giữ kết quả `extractAndStore` đã có trong file (đặt tên theo biến hiện tại của script).

- [ ] **Step 2: Chạy để thấy fail**

Run: `npx tsx tools/verify-extract.ts 2>&1 | tail -20`
Expected: FAIL — `res.extraction.tomorrow` là `undefined`, hai assert mới đỏ (hoặc TypeScript báo property không tồn tại).

- [ ] **Step 3: Thêm schema zod**

Trong `server/extract/schema.ts`:

```ts
export const TOMORROW_TAGS = ['standup', 'review', 'meeting', 'interview', 'smalltalk'] as const;

export const tomorrowSchema = z.object({
  en: z.string().min(8).max(120),
  vi: z.string().min(4).max(120),
  tag: z.enum(TOMORROW_TAGS),
});

export type TomorrowPhrase = z.infer<typeof tomorrowSchema>;
```

và trong `extractionSchema` thêm:

```ts
tomorrow: z.array(tomorrowSchema).max(3).default([]),
used_phrases: z.array(z.string().min(2).max(80)).max(5).default([]),
```

- [ ] **Step 4: Thêm vào JSON schema strict**

Trong `extractionJsonSchema`, thêm hai property (giữ nguyên `additionalProperties: false` ở gốc) và thêm `'tomorrow'`, `'used_phrases'` vào `required`:

```ts
tomorrow: {
  type: 'array',
  maxItems: 3,
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      en: { type: 'string', description: 'Câu tiếng Anh hoàn chỉnh, dùng được ở chỗ làm' },
      vi: { type: 'string', description: 'Nghĩa tiếng Việt, ≤ 15 từ' },
      tag: { type: 'string', enum: [...TOMORROW_TAGS] },
    },
    required: ['en', 'vi', 'tag'],
  },
},
used_phrases: {
  type: 'array',
  maxItems: 5,
  items: { type: 'string', description: 'Cụm trong danh sách Due for review mà người học đã dùng đúng' },
},
```

- [ ] **Step 5: Thêm luật vào prompt**

Trong `server/extract/prompt.ts`, thêm vào `EXTRACT_SYSTEM` trước dòng trả JSON:

```
'13. `tomorrow`: up to 3 complete English sentences the learner can say at work tomorrow, each rewritten from a real mistake in the transcript — not grammar explanations, not new topics.',
'14. `tomorrow[].vi` is a Vietnamese gloss, at most 15 words. `tag` is where the sentence is used.',
'15. `used_phrases`: only phrases from the DUE list in the prompt that the learner actually used correctly. Empty array if none.',
```

Trong `buildExtractPrompt`, mở rộng `context` thêm `duePhrases?: string[]` và render khi có:

```
Phrases due for review (only fill used_phrases from this list):
- "push back"
- "circle back"
```

`ExtractContext` trong `server/extract/run.ts` thêm cùng field; `extractAndStore` truyền `duePhrases` lấy từ query vocab đang đến hạn (giống query `dueVocab` trong `brief.ts`, tối đa 5) — nếu không truyền thì nhánh `used_phrases` sẽ luôn rỗng.

- [ ] **Step 6: Chạy lại**

Run: `npx tsx tools/verify-extract.ts 2>&1 | tail -20`
Expected: PASS hết, có ít nhất 1 câu `tomorrow` (fixture có lỗi thật).

- [ ] **Step 7: Commit**

```bash
git add server/extract/schema.ts server/extract/prompt.ts tools/verify-extract.ts
git commit -m "Extraction contract: 3 usable sentences for tomorrow + phrases actually used"
```

---

### Task 2: Cột `sessions.tomorrow`

**Files:**
- Modify: `server/db/schema.ts` (bảng `sessions`, sau `briefTokens`)
- Create: `drizzle/0002_*.sql` (do drizzle-kit sinh)

**Interfaces:**
- Produces: `sessions.tomorrow` — `jsonb('tomorrow')`, nullable, kiểu TS `TomorrowPhrase[] | null` qua `$type<...>()` (khai báo type tại chỗ để không import chéo từ `extract/`).

- [ ] **Step 1: Thêm cột**

```ts
/** 3 câu dùng được ở chỗ làm, sinh từ lỗi của chính phiên này. */
tomorrow: jsonb('tomorrow').$type<{ en: string; vi: string; tag: string }[]>(),
```

- [ ] **Step 2: Sinh migration**

Run: `npm run db:generate`
Expected: tạo `drizzle/0002_*.sql` chỉ chứa `ALTER TABLE "sessions" ADD COLUMN "tomorrow" jsonb;`

- [ ] **Step 3: Áp migration**

Run: `npm run db:migrate`
Expected: chạy hết migration, không lỗi.

- [ ] **Step 4: Kiểm tra cột tồn tại**

```bash
node --input-type=module -e '
import {Client} from "pg"; import {readFileSync} from "node:fs";
const env=Object.fromEntries(readFileSync(".env.local","utf8").split("\n").filter(l=>l.includes("=")).map(l=>{const i=l.indexOf("=");return [l.slice(0,i),l.slice(i+1).replace(/^"|"$/g,"")]}));
const c=new Client({connectionString:env.DATABASE_URL_UNPOOLED}); await c.connect();
console.log((await c.query("select column_name,data_type from information_schema.columns where table_name=$1 and column_name=$2",["sessions","tomorrow"])).rows);
await c.end();'
```

Expected: một row `{ column_name: 'tomorrow', data_type: 'jsonb' }`.

- [ ] **Step 5: Commit**

```bash
git add server/db/schema.ts drizzle/
git commit -m "DB: sessions.tomorrow stores the three sentences worth reusing"
```

---

### Task 3: Ghi `tomorrow` và tính cụm đã dùng

**Files:**
- Modify: `server/extract/run.ts` (`applyExtraction`, phần sau `update ... returning`)
- Modify: `tools/verify-extract.ts`

**Interfaces:**
- Consumes: `extraction.tomorrow`, `extraction.used_phrases` (Task 1); `sessions.tomorrow` (Task 2).
- Produces: `applyExtraction` trả thêm `tomorrow: TomorrowPhrase[]` trong `ApplyResult`.

- [ ] **Step 1: Viết assert thất bại**

Trong `tools/verify-extract.ts`, sau assert vocab:

```ts
const tomorrowCount = (res.extraction.tomorrow ?? []).length;
check('tomorrow được lưu vào session', (after?.tomorrow ?? []).length === tomorrowCount, `${tomorrowCount}`);
const stored = await db.select({ c: vocab.count }).from(vocab);
check('câu tomorrow vào vocab', stored.length >= 3);
```

Và một assert idempotency mạnh hơn (đã có assert gọi lại): chụp `count` của một phrase trong `tomorrow` **trước** khi gọi lại `applyExtraction`, rồi so sau khi gọi lại — phải bằng nhau.

- [ ] **Step 2: Chạy để thấy fail**

Run: `npx tsx tools/verify-extract.ts 2>&1 | tail -20`
Expected: FAIL ở `tomorrow được lưu vào session` (null).

- [ ] **Step 3: Ghi `tomorrow` cùng lúc update session**

Trong `applyExtraction`, thêm `tomorrow: extraction.tomorrow` vào object `.set({...})` của câu `update(sessions)` hiện có.

- [ ] **Step 4: Cộng cụm đã dùng đúng**

Ngay sau vòng lặp `new_phrases`, thêm:

```ts
// Cụm đến hạn mà người học đã dùng đúng: đẩy hạn ôn xa 7 ngày.
for (const phrase of extraction.used_phrases) {
  await db
    .update(vocab)
    .set({ count: sql`${vocab.count} + 1`, nextReview: new Date(now.getTime() + 7 * DAY_MS) })
    .where(eq(vocab.phrase, phrase));
}
```

- [ ] **Step 5: Đưa câu `tomorrow` vào vocab**

Ngay sau vòng `used_phrases`:

```ts
for (const t of extraction.tomorrow) {
  await db
    .insert(vocab)
    .values({ phrase: t.en, example: t.vi, count: 1, nextReview: new Date(now.getTime() + DAY_MS) })
    .onConflictDoUpdate({
      target: vocab.phrase,
      set: { count: sql`${vocab.count} + 1`, nextReview: new Date(now.getTime() + DAY_MS) },
    });
}
```

- [ ] **Step 6: Trả `tomorrow` khỏi `applyExtraction`**

Thêm `tomorrow: extraction.tomorrow` vào object return cuối hàm và vào type `ApplyResult`.

- [ ] **Step 7: Chạy hai lần liên tiếp + kiểm DB**

```bash
for i in 1 2; do npx tsx tools/verify-extract.ts 2>&1 | grep -E "^extract:|FAIL|OK$|cleaned"; done
npm run db:reset
```

Expected: cả hai lần `OK`, không `FAIL`; sau reset `{ mistakes: 3, vocab: 3, sessions: 0, usage: 0 }`.

- [ ] **Step 8: Commit**

```bash
git add server/extract/run.ts tools/verify-extract.ts
git commit -m "Store tomorrow sentences and credit phrases the learner actually used"
```

---

### Task 4: Trả `tomorrow` ra API

**Files:**
- Modify: `server/session/service.ts` (`EndResult`, `endSession`)
- Modify: `server/app.ts` (route `POST /api/session/:id/extract`)
- Modify: `src/api.ts` (`EndResult`, kiểu trả của `api.extract`)
- Modify: `tools/verify-api.ts`

**Interfaces:**
- Produces: `EndResult.tomorrow?: { en: string; vi: string; tag: string }[]`; `/api/session/:id/extract` trả thêm `tomorrow`.

- [ ] **Step 1: Viết assert thất bại trong `tools/verify-api.ts`**

Ở chỗ gọi `/api/session/:id/extract`, thêm:

```ts
check('extract trả tomorrow', Array.isArray(body.tomorrow) && body.tomorrow.length <= 3);
```

- [ ] **Step 2: Chạy để thấy fail**

Run: `npx tsx tools/verify-api.ts 2>&1 | tail -6`
Expected: 1 FAIL ở assert mới.

- [ ] **Step 3: Thêm vào `EndResult` và `endSession`**

`server/session/service.ts`: thêm field và map từ `result.extraction.tomorrow` giống cách `items`/`phrases` đang làm.

- [ ] **Step 4: Route extract trả thêm**

`server/app.ts`: thêm `tomorrow: result.extraction.tomorrow` vào `c.json({...})`.

- [ ] **Step 5: Client type**

`src/api.ts`: thêm `tomorrow?: CorrectionItem`-style type `TomorrowPhrase { en: string; vi: string; tag: string }` và dùng trong `EndResult` + trả về của `api.extract`.

- [ ] **Step 6: Chạy lại**

Run: `npx tsx tools/verify-api.ts 2>&1 | tail -6`
Expected: 25/25 PASS.

- [ ] **Step 7: Commit**

```bash
git add server/session/service.ts server/app.ts src/api.ts tools/verify-api.ts
git commit -m "API: expose tomorrow sentences on end and re-extract"
```

---

### Task 5: Khối "3 câu dùng ngay mai" trong Summary

**Files:**
- Modify: `src/App.tsx` (`Summary`)
- Modify: `src/styles.css` (nếu cần class `.say`)

**Interfaces:**
- Consumes: `EndResult.tomorrow` (Task 4).

- [ ] **Step 1: Thêm hàm đọc**

```ts
function speak(text: string) {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US';
  u.rate = 0.85;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}
```

- [ ] **Step 2: Render khối, chỉ khi có dữ liệu**

Đặt ngay dưới phần summary, **trước** "Lỗi đã sửa":

```tsx
{(data?.tomorrow?.length ?? 0) > 0 && (
  <>
    <h2>3 câu dùng ngay mai</h2>
    <ul className="list">
      {data!.tomorrow!.map((t, i) => (
        <li key={i}>
          {i + 1}. “{t.en}”{' '}
          <button className="say" onClick={() => speak(t.en)}>Đọc</button>
          <div className="hint">{t.vi} · {t.tag}</div>
        </li>
      ))}
    </ul>
  </>
)}
```

- [ ] **Step 3: Build**

Run: `npx tsc --noEmit && npx vite build 2>&1 | tail -4`
Expected: 0 lỗi, build PASS.

- [ ] **Step 4: Kiểm tra bằng mắt trên prod sau khi deploy (Task 7)** — phiên không có lỗi thì khối phải biến mất.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/styles.css
git commit -m "Summary: three sentences to use tomorrow, with a read-aloud button"
```

---

### Task 6: Gõ chữ trong phiên

**Files:**
- Modify: `src/App.tsx` (`Session`)
- Modify: `tools/verify-live-close.ts`

**Interfaces:**
- Consumes: `LiveSession.sendText(text: string): void` (đã có trong `src/live.ts`, hiện chưa dùng).

- [ ] **Step 1: Viết assert thất bại**

Trong `tools/verify-live-close.ts`, thêm mục G: gán `FakeWs` mới, gọi `session.sendText('hello')` (đổi `sendText` thành public nếu đang private), assert `ws.sent` chứa `JSON.stringify({ realtimeInput: { text: 'hello' } })`.

- [ ] **Step 2: Chạy để thấy fail**

Run: `npx tsx tools/verify-live-close.ts 2>&1 | tail -8`
Expected: FAIL hoặc TypeScript báo `sendText` là private.

- [ ] **Step 3: Đổi `sendText` thành public**

`src/live.ts`: `sendText(text: string): void` (bỏ `private`), giữ nguyên thân hàm.

- [ ] **Step 4: Thêm hàng nhập chữ vào Session**

State `const [typed, setTyped] = useState('')`. Dưới khu vực nút nói:

```tsx
<form
  className="row"
  onSubmit={(e) => {
    e.preventDefault();
    const text = typed.trim();
    if (!text) return;
    liveRef.current?.sendText(text);
    setTyped('');
  }}
>
  <input
    value={typed}
    onChange={(e) => setTyped(e.target.value)}
    placeholder="Không tiện nói? Gõ câu tiếng Anh…"
    disabled={status === 'connecting' || status === 'closed'}
  />
  <button type="submit" disabled={!typed.trim() || status === 'connecting' || status === 'closed'}>
    Gửi
  </button>
</form>
```

- [ ] **Step 5: Chạy test + build**

Run: `npx tsx tools/verify-live-close.ts 2>&1 | tail -5 && npx tsc --noEmit && npx vite build 2>&1 | tail -3`
Expected: 12/12 PASS, 0 lỗi, build PASS.

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx src/live.ts tools/verify-live-close.ts
git commit -m "Session: type instead of speaking, AI still answers with voice"
```

---

### Task 7: Deploy, verify prod, cập nhật README

**Files:**
- Modify: `README.md`, `README.vi.md` (mục "Cách hoạt động" / "Known limits")

- [ ] **Step 1: Deploy**

Run: `npx vercel --prod --yes 2>&1 | tail -5`
Expected: alias vẫn là `https://english-voice-coach-five.vercel.app`.

- [ ] **Step 2: Verify prod**

```bash
curl -s https://english-voice-coach-five.vercel.app/api/health
curl -s -o /dev/null -w "root:%{http_code}\n" https://english-voice-coach-five.vercel.app/
```

Expected: `{"ok":true,...,"gemini":true,"groq":true}` và `root:200`.

- [ ] **Step 3: README**

Thêm 1 dòng vào phần mô tả vòng lặp: sau phiên có 3 câu dùng ngay mai, được nhắc lại ở phiên sau; và 1 dòng trong "Giới hạn đã biết" / "Known limits": không chấm phát âm, nút Đọc dùng giọng của máy.

- [ ] **Step 4: Commit + báo người dùng**

```bash
git add README.md README.vi.md
git commit -m "Docs: tomorrow sentences and typed input"
```

Nhắn người dùng: hard-refresh, thử 1 phiên thật, kiểm tra Summary có khối 3 câu và nút Đọc; DB dev đã reset về seed.

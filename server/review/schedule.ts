// Chính sách ôn tập dùng chung cho `vocab` và `mistakes`.
// Xem spec §10.6. Không import gì từ DB: đây là hàm thuần để test bằng fake clock.
//
// Trước đây mỗi bảng tự đặt khoảng cách riêng bằng hằng số, không đọc `count`,
// nên `mistakes` kẹt ở "1 ngày" vĩnh viễn còn `vocab` trần ở "7 ngày". Cả hai
// đều không bao giờ "tốt nghiệp", và một lỗi đã sửa vẫn bị hỏi lại mỗi ngày.

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Số ngày tới lần ôn kế tiếp, theo bậc. Phần tử cuối là trần. */
export const REVIEW_LADDER_DAYS = [3, 7, 14, 30] as const;

/** Sai lại thì quay về ôn ngay hôm sau, bất kể đã đúng bao nhiêu lần. */
export const RELEARN_DAYS = 1;

/**
 * Số lần đúng liên tiếp để coi là đã nhớ. Bằng đúng độ dài bậc thang: chạm
 * trần 30 ngày thì thôi nhắc, và lỗi quay lại sẽ tự bật lại.
 */
export const GRADUATE_STREAK = REVIEW_LADDER_DAYS.length;

export type ReviewOutcome = 'again' | 'correct';

export interface ReviewState {
  /** Số lần đúng liên tiếp hiện tại; về 0 mỗi khi sai lại. */
  streak: number;
  nextReview: Date;
  /** Đã đủ chuỗi đúng để rời khỏi danh sách nhắc. */
  graduated: boolean;
}

/**
 * Khoảng cách tới lần ôn sau, tính bằng ngày.
 *
 * `streak` là số lần đúng TRƯỚC lần này, nên lần đúng đầu tiên (streak 0) rơi
 * vào bậc đầu tiên là 3 ngày — không phải 0.
 */
export function reviewIntervalDays(outcome: ReviewOutcome, streak: number): number {
  if (outcome === 'again') return RELEARN_DAYS;
  const step = Math.min(Math.max(streak, 0) + 1, REVIEW_LADDER_DAYS.length);
  return REVIEW_LADDER_DAYS[step - 1]!;
}

/** Chuỗi đúng sau lần này. Sai lại thì đứt chuỗi. */
export function nextStreak(outcome: ReviewOutcome, streak: number): number {
  if (outcome === 'again') return 0;
  return Math.min(Math.max(streak, 0) + 1, GRADUATE_STREAK);
}

/**
 * Trạng thái ôn kế tiếp sau một lần gặp mục này.
 *
 * @param now thời điểm hiện tại, truyền vào để test được bằng fake clock
 * @param outcome `correct` khi người học dùng đúng, `again` khi lặp lại lỗi
 * @param streak chuỗi đúng hiện có (0 nếu mục mới hoặc vừa sai)
 */
export function scheduleReview(now: Date, outcome: ReviewOutcome, streak: number): ReviewState {
  const next = nextStreak(outcome, streak);
  const days = reviewIntervalDays(outcome, streak);
  return {
    streak: next,
    nextReview: new Date(now.getTime() + days * DAY_MS),
    graduated: outcome === 'correct' && next >= GRADUATE_STREAK,
  };
}

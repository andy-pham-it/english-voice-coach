import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  GRADUATE_STREAK,
  RELEARN_DAYS,
  REVIEW_LADDER_DAYS,
  nextStreak,
  reviewIntervalDays,
  scheduleReview,
} from './schedule';

const NOW = new Date('2026-11-13T09:00:00.000Z');

/** Số ngày giữa `now` và hạn ôn, làm tròn để so sánh được. */
function daysUntil(next: Date, now: Date = NOW): number {
  return Math.round((next.getTime() - now.getTime()) / DAY_MS);
}

describe('reviewIntervalDays', () => {
  it('đi từng bậc 3 → 7 → 14 → 30 theo số lần đúng', () => {
    expect(reviewIntervalDays('correct', 0)).toBe(3);
    expect(reviewIntervalDays('correct', 1)).toBe(7);
    expect(reviewIntervalDays('correct', 2)).toBe(14);
    expect(reviewIntervalDays('correct', 3)).toBe(30);
  });

  it('giữ nguyên trần 30 ngày sau khi đã chạm bậc cuối', () => {
    expect(reviewIntervalDays('correct', 4)).toBe(30);
    expect(reviewIntervalDays('correct', 99)).toBe(30);
  });

  it('sai lại thì luôn quay về 1 ngày, bất kể chuỗi dài bao nhiêu', () => {
    for (const streak of [0, 1, 3, 10]) {
      expect(reviewIntervalDays('again', streak)).toBe(RELEARN_DAYS);
    }
  });

  it('bậc thang tăng dần và phần tử cuối đúng là trần', () => {
    const days = [...REVIEW_LADDER_DAYS];
    expect(days).toEqual([...days].sort((a, b) => a - b));
    expect(days.at(-1)).toBe(30);
    expect(days).toHaveLength(GRADUATE_STREAK);
  });
});

describe('nextStreak', () => {
  it('cộng một mỗi lần đúng', () => {
    expect(nextStreak('correct', 0)).toBe(1);
    expect(nextStreak('correct', 2)).toBe(3);
  });

  it('không vượt quá ngưỡng tốt nghiệp', () => {
    expect(nextStreak('correct', GRADUATE_STREAK)).toBe(GRADUATE_STREAK);
    expect(nextStreak('correct', 99)).toBe(GRADUATE_STREAK);
  });

  it('sai lại thì đứt chuỗi về 0', () => {
    expect(nextStreak('again', 3)).toBe(0);
  });
});

describe('scheduleReview', () => {
  it('lần đúng đầu tiên hẹn 3 ngày, không phải hôm nay', () => {
    const s = scheduleReview(NOW, 'correct', 0);
    expect(daysUntil(s.nextReview)).toBe(3);
    expect(s.streak).toBe(1);
    expect(s.graduated).toBe(false);
  });

  it('bốn lần đúng liên tiếp thì tốt nghiệp ở mốc 30 ngày', () => {
    let streak = 0;
    const seen: number[] = [];
    for (let i = 0; i < GRADUATE_STREAK; i++) {
      const s = scheduleReview(NOW, 'correct', streak);
      seen.push(daysUntil(s.nextReview));
      streak = s.streak;
    }
    expect(seen).toEqual([3, 7, 14, 30]);
    expect(streak).toBe(GRADUATE_STREAK);
    expect(scheduleReview(NOW, 'correct', streak - 1).graduated).toBe(true);
  });

  it('một lỗi lặp lại kéo mục về 1 ngày và xoá sạch chuỗi', () => {
    const s = scheduleReview(NOW, 'again', 3);
    expect(daysUntil(s.nextReview)).toBe(1);
    expect(s.streak).toBe(0);
    expect(s.graduated).toBe(false);
  });

  it('mục đã tốt nghiệp mà tái phát thì bị kéo lại, không bị bỏ qua', () => {
    const fresh = scheduleReview(NOW, 'again', GRADUATE_STREAK);
    expect(daysUntil(fresh.nextReview)).toBe(1);
    expect(fresh.graduated).toBe(false);
  });

  it('tính hạn ôn bằng ms tuyệt đối, không phụ thuộc giờ trong ngày', () => {
    const late = new Date('2026-11-13T23:45:00.000Z');
    const s = scheduleReview(late, 'correct', 1);
    expect(s.nextReview.toISOString()).toBe('2026-11-20T23:45:00.000Z');
  });

  it('không sửa `now` truyền vào', () => {
    const before = NOW.getTime();
    scheduleReview(NOW, 'correct', 2);
    expect(NOW.getTime()).toBe(before);
  });
});

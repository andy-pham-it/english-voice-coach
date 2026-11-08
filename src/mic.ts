// Kiểm tra micro trước khi vào phiên. Chạy trên điện thoại thật là nơi hay hỏng
// nhất: HTTPS, quyền micro, hoặc mic bị app khác chiếm. Thà biết trước 2 giây
// còn hơn nói 10 phút rồi mới phát hiện không ai nghe thấy gì.

export interface MicProbe {
  ok: boolean;
  /** Biên độ đỉnh đo được, 0..1. */
  level: number;
  /** Số thiết bị thu âm nhìn thấy được (0 khi chưa có quyền). */
  devices: number;
  detail: string;
}

const ERROR_TEXT: Record<string, string> = {
  NotAllowedError: 'Bạn chưa cho phép micro. Mở khoá trong cài đặt trang (biểu tượng 🔒 trên thanh địa chỉ) rồi thử lại.',
  PermissionDeniedError: 'Bạn chưa cho phép micro. Mở khoá trong cài đặt trang rồi thử lại.',
  NotFoundError: 'Không tìm thấy micro nào trên máy.',
  DevicesNotFoundError: 'Không tìm thấy micro nào trên máy.',
  NotReadableError: 'Micro đang bị ứng dụng khác chiếm.',
  TrackStartError: 'Micro đang bị ứng dụng khác chiếm.',
  OverconstrainedError: 'Micro không đáp ứng được cấu hình yêu cầu.',
};

export async function probeMicrophone(ms = 2000): Promise<MicProbe> {
  if (!window.isSecureContext) {
    return { ok: false, level: 0, devices: 0, detail: 'Trang phải chạy HTTPS (hoặc localhost) mới mở được micro.' };
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return { ok: false, level: 0, devices: 0, detail: 'Trình duyệt này không hỗ trợ getUserMedia.' };
  }

  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    const devices = (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter(
      (d) => d.kind === 'audioinput',
    ).length;

    ctx = new AudioContext();
    await ctx.resume().catch(() => undefined);
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);

    const buf = new Float32Array(analyser.fftSize);
    let peak = 0;
    const until = performance.now() + ms;
    while (performance.now() < until) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      analyser.getFloatTimeDomainData(buf);
      for (let i = 0; i < buf.length; i++) {
        const v = Math.abs(buf[i] ?? 0);
        if (v > peak) peak = v;
      }
    }

    const pct = Math.round(peak * 100);
    if (peak > 0.02) {
      return { ok: true, level: peak, devices, detail: `Nghe thấy tiếng (mức ${pct}%). Micro dùng được.` };
    }
    return {
      ok: false,
      level: peak,
      devices,
      detail:
        pct === 0
          ? 'Micro mở nhưng không có tín hiệu — kiểm tra đang dùng đúng micro (tai nghe?) và không bị tắt tiếng.'
          : `Tín hiệu quá nhỏ (${pct}%). Nói to hơn hoặc đổi micro đầu vào rồi thử lại.`,
    };
  } catch (e) {
    const name = e instanceof Error ? e.name : '';
    return {
      ok: false,
      level: 0,
      devices: 0,
      detail: ERROR_TEXT[name] ?? `Không mở được micro (${name || 'lỗi không rõ'}).`,
    };
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
    void ctx?.close().catch(() => undefined);
  }
}

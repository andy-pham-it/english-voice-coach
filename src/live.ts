/**
 * Live API WebSocket client: mic capture → PCM16 16k, PCM16 24k playback.
 *
 * Hai điểm dễ sai đã được kiểm chứng trên spike:
 *  - Chrome Android bỏ qua AudioContext({ sampleRate: 16000 }) nên phải resample
 *    tuyến tính, giữ pha giữa các chunk.
 *  - Không có `audioStreamEnd`: ở chế độ PTT phải gửi thêm ~1.2s im lặng sau khi
 *    thả nút, nếu không server không bao giờ chốt câu.
 */

export type LiveStatus = 'connecting' | 'ready' | 'listening' | 'ai-speaking' | 'error' | 'closed';

export interface LiveUsage {
  promptTokens?: number;
  responseTokens?: number;
  totalTokens?: number;
}

export interface LiveHandlers {
  onStatus: (status: LiveStatus, detail?: string) => void;
  onUserText: (text: string) => void;
  onAiText: (text: string) => void;
  onInterrupted: () => void;
  onUsage: (usage: LiveUsage) => void;
  /**
   * Socket đóng. `intentional` = false nghĩa là Google/mạng cắt ngang giữa
   * phiên — UI nên nối lại chứ không bỏ im lặng (phiên 10–20 phút rất dễ bị).
   */
  onClose?: (intentional: boolean, reason: string) => void;
}

const WORKLET = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(512); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('capture', CaptureProcessor);
`;

const b64 = (bytes: Uint8Array): string => {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode(...bytes.subarray(i, i + CH));
  }
  return btoa(s);
};

export class LiveSession {
  private ws: WebSocket | null = null;
  private acIn: AudioContext | null = null;
  private acOut: AudioContext | null = null;
  private mic: MediaStream | null = null;
  private proc: AudioWorkletNode | ScriptProcessorNode | null = null;
  private muted = true;
  private duplex = false;
  private silenceUntil = 0;
  private nextPlayTime = 0;
  private queued: AudioBufferSourceNode[] = [];
  private rsPhase = 0;
  private audioBytes = 0;

  constructor(private readonly handlers: LiveHandlers) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get audioSeconds(): number {
    return this.audioBytes / 32000;
  }

  connect(socketUrl: string, model: string): void {
    this.handlers.onStatus('connecting');
    // Cờ đóng gắn vào từng socket: khi reconnect, socket cũ đóng *sau* khi
    // socket mới đã mở, nên không thể dùng một cờ chung trên instance.
    const ws = new WebSocket(socketUrl) as WebSocket & { closing?: boolean };
    this.ws = ws;

    ws.onopen = () => {
      // Config thật nằm trong ephemeral token; client chỉ khai model.
      ws.send(JSON.stringify({ setup: { model } }));
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      let msg: any;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      this.handle(msg);
    };

    ws.onerror = () => this.handlers.onStatus('error', 'websocket error');
    ws.onclose = (e) => {
      this.stopAudio();
      const reason = `${e.code}${e.reason ? ' ' + e.reason : ''}`;
      this.handlers.onStatus('closed', reason);
      this.handlers.onClose?.(Boolean(ws.closing), reason);
    };
  }

  private handle(msg: any): void {
    if (msg.setupComplete) {
      this.handlers.onStatus('ready');
      void this.initAudio();
      return;
    }

    const sc = msg.serverContent;
    if (sc) {
      if (sc.inputTranscription?.text) this.handlers.onUserText(sc.inputTranscription.text);
      if (sc.outputTranscription?.text) {
        this.handlers.onStatus('ai-speaking');
        this.handlers.onAiText(sc.outputTranscription.text);
      }
      if (sc.interrupted) {
        this.stopPlayback();
        this.handlers.onInterrupted();
      }
      if (sc.turnComplete && !this.duplex) this.handlers.onStatus('ready');
    }

    if (msg.usageMetadata) {
      this.handlers.onUsage({
        promptTokens: msg.usageMetadata.promptTokenCount,
        responseTokens: msg.usageMetadata.responseTokenCount,
        totalTokens: msg.usageMetadata.totalTokenCount,
      });
    }
  }

  setDuplex(on: boolean): void {
    this.duplex = on;
    this.muted = !on;
    if (on) this.silenceUntil = 0;
    if (this.connected) this.handlers.onStatus('ready');
  }

  /** PTT: gọi khi bắt đầu giữ nút. */
  startTalking(): void {
    if (this.duplex) return;
    this.muted = false;
    this.silenceUntil = 0;
    this.handlers.onStatus('listening');
  }

  /** PTT: gọi khi thả nút — gửi thêm 1.2s im lặng để server chốt câu. */
  stopTalking(): void {
    if (this.duplex || this.muted) return;
    this.muted = true;
    this.silenceUntil = performance.now() + 1200;
    this.handlers.onStatus('ready');
  }

  private sendText(text: string): void {
    this.ws?.send(JSON.stringify({ realtimeInput: { text } }));
  }

  async initAudio(): Promise<void> {
    if (this.acIn) return;
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      this.handlers.onStatus('error', 'không lấy được micro — cần HTTPS hoặc localhost');
      return;
    }

    this.acIn = new AudioContext({ sampleRate: 16000 });
    const src = this.acIn.createMediaStreamSource(this.mic);

    try {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      await this.acIn.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNode(this.acIn, 'capture');
      node.port.onmessage = (e: MessageEvent<Float32Array>) => this.sendChunk(e.data);
      this.proc = node;
    } catch {
      const node = this.acIn.createScriptProcessor(512, 1, 1);
      node.onaudioprocess = (e) => this.sendChunk(e.inputBuffer.getChannelData(0));
      this.proc = node;
    }

    const sink = this.acIn.createGain();
    sink.gain.value = 0;
    src.connect(this.proc as AudioNode);
    (this.proc as AudioNode).connect(sink);
    sink.connect(this.acIn.destination);

    this.acOut = new AudioContext({ sampleRate: 24000 });
    this.nextPlayTime = 0;
  }

  private sendChunk(input: Float32Array): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const now = performance.now();
    const silent = this.muted;
    if (silent && now > this.silenceUntil) return;

    let pcm: Float32Array;
    if (silent) {
      // Toàn số 0: VAD cần thấy im lặng thật để chốt câu.
      pcm = new Float32Array(input.length);
    } else {
      pcm = this.resample(input, this.acIn?.sampleRate ?? 16000);
      this.audioBytes += pcm.length * 2;
    }

    const i16 = new Int16Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      const s = Math.max(-1, Math.min(1, pcm[i] ?? 0));
      i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    ws.send(
      JSON.stringify({
        realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: b64(new Uint8Array(i16.buffer)) } },
      }),
    );
  }

  private resample(input: Float32Array, inRate: number): Float32Array {
    if (inRate === 16000) return input;
    const ratio = inRate / 16000;
    const out = new Float32Array(Math.max(1, Math.floor((input.length - this.rsPhase) / ratio)));
    let pos = this.rsPhase;
    let n = 0;
    while (pos < input.length && n < out.length) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const s0 = input[i] ?? 0;
      const s1 = input[i + 1] ?? s0;
      out[n++] = s0 + (s1 - s0) * frac;
      pos += ratio;
    }
    this.rsPhase = pos - input.length;
    return n === out.length ? out : out.subarray(0, n);
  }

  private play(base64: string): void {
    if (!this.acOut) return;
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const i16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
    const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = (i16[i] ?? 0) / 32768;

    const buf = this.acOut.createBuffer(1, f32.length, 24000);
    buf.copyToChannel(f32, 0);
    const src = this.acOut.createBufferSource();
    src.buffer = buf;
    src.connect(this.acOut.destination);

    const now = this.acOut.currentTime;
    if (this.nextPlayTime < now + 0.02) this.nextPlayTime = now + 0.06;
    src.start(this.nextPlayTime);
    this.nextPlayTime += buf.duration;

    this.queued.push(src);
    if (this.queued.length > 40) this.queued = this.queued.slice(-20);
  }

  stopPlayback(): void {
    for (const s of this.queued) {
      try {
        s.stop();
      } catch {
        /* đã dừng */
      }
    }
    this.queued = [];
    if (this.acOut) this.nextPlayTime = this.acOut.currentTime;
  }

  private stopAudio(): void {
    this.stopPlayback();
    this.proc?.disconnect();
    this.proc = null;
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = null;
    void this.acIn?.close();
    void this.acOut?.close();
    this.acIn = null;
    this.acOut = null;
  }

  disconnect(): void {
    const ws = this.ws as (WebSocket & { closing?: boolean }) | null;
    if (ws) ws.closing = true;
    ws?.close(1000);
    this.ws = null;
    this.stopAudio();
  }

  /** Hook cho UI khi cần nạp brief mới giữa phiên. */
  reconnect(socketUrl: string, model: string): void {
    this.disconnect();
    // Trạng thái mic không được rò sang kết nối mới: nếu đang PTT và socket rớt
    // đúng lúc đang giữ nút thì mic phải đóng lại, chờ người dùng giữ lại.
    this.muted = !this.duplex;
    this.silenceUntil = 0;
    this.connect(socketUrl, model);
  }

  ask(text: string): void {
    this.sendText(text);
  }
}

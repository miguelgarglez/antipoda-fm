/**
 * A real waveform for engines where MediaElementAudioSourceNode returns
 * silence on live streams (WebKit). The <audio> element keeps playing the
 * broadcast; this re-fetches the stream and decodes it through WebCodecs
 * purely to feed the scope. It costs a second connection of the same
 * bitrate and is only engaged after the element path proves dead.
 *
 * Pipeline: fetch → strip ICY metadata → frame-align (ADTS / MP3) →
 * AudioDecoder → mono PCM ring → getWave().
 */

const RING = 2048;
const MAX_PENDING = 1 << 18; // 256 KB — drop front on runaway input
const QUEUE_CAP = 48; // decoded-ahead chunks before we drop input frames

const AAC_SR = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025,
  8000, 7350,
];
// MPEG-1 Layer III / MPEG-2+2.5 Layer III bitrate tables (kbps).
const MP3_BR_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_BR_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MP3_SR = [
  [44100, 48000, 32000],
  [22050, 24000, 16000],
  [11025, 12000, 8000],
];

export type Format = "aac" | "mp3";

/**
 * Removes interleaved ICY metadata (<metaint audio><len><meta>) across
 * arbitrary network chunk boundaries. Exported for tests.
 */
export class IcyStripper {
  private audioLeft: number;
  private metaLeft = 0;
  private metaint: number;

  constructor(metaint: number) {
    this.metaint = metaint;
    this.audioLeft = metaint > 0 ? metaint : Infinity;
  }

  feed(chunk: Uint8Array): Uint8Array {
    if (this.metaint <= 0) return chunk;
    const keep = new Uint8Array(chunk.length);
    let kept = 0;
    for (let k = 0; k < chunk.length; k++) {
      if (this.metaLeft > 0) {
        this.metaLeft--;
      } else if (this.audioLeft === 0) {
        this.metaLeft = chunk[k] * 16;
        this.audioLeft = this.metaint;
      } else {
        this.audioLeft--;
        keep[kept++] = chunk[k];
      }
    }
    return keep.subarray(0, kept);
  }
}

/** Frame length at i for the format; 0 needs more bytes; -1 not a sync. */
export function nextFrame(fmt: Format, b: Uint8Array, i: number): number {
  return fmt === "aac" ? adtsFrame(b, i) : mp3Frame(b, i);
}

export class StreamMeter {
  private ring = new Float32Array(RING);
  private head = 0; // index of the oldest valid sample
  private count = 0;
  private outBuf = new Float32Array(1024);
  private abort: AbortController | null = null;
  private decoder: AudioDecoder | null = null;
  private dead = true;
  private told = false;
  private lastPcm = 0; // Date.now() of the last decoded sample
  private startTimer: number | null = null;
  private staleTimer: number | null = null;
  onDead: (() => void) | null = null;

  /**
   * Latest PCM window, chronological. Null before enough signal, and null
   * again once samples go stale — a stalled connection returning the last
   * waveform is not metering.
   */
  getWave(): Float32Array | null {
    if (
      this.dead ||
      this.count < this.outBuf.length ||
      Date.now() - this.lastPcm > 1600
    )
      return null;
    const start = (this.head + this.count - this.outBuf.length + RING) % RING;
    for (let i = 0; i < this.outBuf.length; i++) {
      this.outBuf[i] = this.ring[(start + i) % RING];
    }
    return this.outBuf;
  }

  private push(data: AudioData) {
    const n = data.numberOfFrames;
    const ch = Math.max(1, data.numberOfChannels);
    const mono = new Float32Array(n);
    const plane = new Float32Array(n);
    for (let c = 0; c < ch; c++) {
      try {
        data.copyTo(plane, {
          planeIndex: c,
          format: "f32-planar",
        } as AudioDataCopyToOptions);
        for (let i = 0; i < n; i++) mono[i] += plane[i] / ch;
      } catch {
        break; // unexpected layout — keep what mixed so far
      }
    }
    data.close();
    this.lastPcm = Date.now();
    for (let i = 0; i < n; i++) {
      const pos = (this.head + this.count) % RING;
      this.ring[pos] = mono[i];
      if (this.count === RING) this.head = (this.head + 1) % RING;
      else this.count++;
    }
  }

  /**
   * Begin metering a stream. Resolves true once the pump is armed; false
   * when the stream clearly cannot be decoded (no WebCodecs, fetch
   * refused). An undetectable container resolves optimistically — if the
   * byte sniff then fails, onDead fires and the caller falls back.
   */
  async start(url: string): Promise<boolean> {
    this.stop();
    if (
      typeof AudioDecoder === "undefined" ||
      typeof EncodedAudioChunk === "undefined"
    )
      return false;
    const ctrl = new AbortController();
    this.abort = ctrl;
    this.dead = false;
    this.told = false;
    // The deadline opens before the fetch — a server that never answers
    // headers must not hold the meter forever either.
    this.startTimer = window.setTimeout(() => {
      if (this.count === 0) this.fail();
    }, 8000);
    // And once PCM flows, a permanent stall must hand the scope back to
    // the carrier — getWave() already goes stale; this releases the
    // fetch/decoder and tells the player why.
    this.staleTimer = window.setInterval(() => {
      if (!this.dead && this.count > 0 && Date.now() - this.lastPcm > 3000) {
        this.fail();
      }
    }, 1000);
    let res: Response;
    try {
      res = await fetch(url, { signal: ctrl.signal });
    } catch {
      this.kill();
      return false;
    }
    if (!res.ok || !res.body) {
      this.kill();
      return false;
    }
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    const metaint = Number(res.headers.get("icy-metaint")) || 0;
    const fmt = /aac|aacp|x-hx-aac|mp4a/.test(ct)
      ? "aac"
      : /mpeg|mp3|x-mpeg/.test(ct)
        ? "mp3"
        : null; // ogg/m3u8/unknown — sniff bytes in the pump
    if (fmt) {
      const ok = await this.configure(fmt, null);
      if (ctrl.signal.aborted) {
        this.kill();
        return false;
      }
      if (!ok) {
        this.kill();
        return false;
      }
    }
    void this.pump(res, metaint, fmt, ctrl);
    return true;
  }

  private sniffBytes(b: Uint8Array): Format | null {
    let i = 0;
    // Skip an ID3v2 tag if one opens the stream.
    if (b.length > 10 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
      i =
        10 +
        (b[6] & 0x7f) * (1 << 21) +
        (b[7] & 0x7f) * (1 << 14) +
        (b[8] & 0x7f) * (1 << 7) +
        (b[9] & 0x7f);
    }
    for (; i + 4 < b.length; i++) {
      if (b[i] !== 0xff) continue;
      if (adtsFrame(b, i) > 0) return "aac";
      if (mp3FrameLen(b, i) > 0) return "mp3";
    }
    return null;
  }

  private async configure(fmt: Format, head: Uint8Array | null): Promise<boolean> {
    const candidates: AudioDecoderConfig[] = [];
    if (fmt === "aac") {
      let profile = 2;
      let sampleRate = 44100;
      let numberOfChannels = 2;
      if (head) {
        for (let i = 0; i + 7 < head.length; i++) {
          if (adtsFrame(head, i) <= 0) continue;
          profile = ((head[i + 2] & 0xc0) >> 6) + 1;
          sampleRate = AAC_SR[(head[i + 2] >> 2) & 0xf] ?? 44100;
          numberOfChannels =
            (((head[i + 2] & 1) << 2) | ((head[i + 3] >> 6) & 3)) || 2;
          break;
        }
      }
      candidates.push({ codec: `mp4a.40.${profile}`, sampleRate, numberOfChannels });
      if (profile !== 2) candidates.push({ codec: "mp4a.40.2", sampleRate, numberOfChannels });
    } else {
      let sampleRate = 44100;
      let numberOfChannels = 2;
      if (head) {
        const m = mp3Header(head, 0);
        if (m) {
          sampleRate = m.sampleRate;
          numberOfChannels = m.channels;
        }
      }
      candidates.push({ codec: "mp3", sampleRate, numberOfChannels });
    }
    let config: AudioDecoderConfig | null = null;
    for (const c of candidates) {
      try {
        if ((await AudioDecoder.isConfigSupported(c)).supported) {
          config = c;
          break;
        }
      } catch {
        /* malformed config — try the next */
      }
    }
    if (!config || !this.abort || this.abort.signal.aborted) return false;
    try {
      this.decoder = new AudioDecoder({
        output: (d) => this.push(d),
        error: () => this.fail(),
      });
      this.decoder.configure(config);
      return true;
    } catch {
      return false;
    }
  }

  /** Release the fetch, the decoder, and the samples. Idempotent. */
  private kill() {
    this.dead = true;
    if (this.startTimer !== null) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    if (this.staleTimer !== null) {
      clearInterval(this.staleTimer);
      this.staleTimer = null;
    }
    this.abort?.abort();
    this.abort = null;
    const d = this.decoder;
    this.decoder = null;
    if (d && d.state !== "closed") {
      try {
        d.close();
      } catch {
        /* already closed */
      }
    }
    this.count = 0;
    this.head = 0;
  }

  private fail() {
    if (this.dead) return;
    const report = !this.told;
    this.kill();
    if (report) {
      this.told = true;
      this.onDead?.();
    }
  }

  private async pump(
    res: Response,
    metaint: number,
    fmt: Format | null,
    ctrl: AbortController,
  ) {
    const reader = res.body!.getReader();
    const strip = new IcyStripper(metaint);
    let pending = new Uint8Array(0);
    let ts = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || ctrl.signal.aborted) break;
        const chunk = strip.feed(value);
        if (chunk.length === 0) continue;
        const next = new Uint8Array(pending.length + chunk.length);
        next.set(pending);
        next.set(chunk, pending.length);
        pending = next.length > MAX_PENDING ? next.slice(next.length - MAX_PENDING) : next;

        if (!fmt) {
          if (pending.length < 4096) continue;
          fmt = this.sniffBytes(pending);
          if (!fmt || !(await this.configure(fmt, pending))) {
            this.fail();
            break;
          }
        }

        let consumed = 0;
        while (consumed < pending.length && !this.dead) {
          const f = nextFrame(fmt, pending, consumed);
          if (f === 0) break; // need more bytes
          if (f < 0) {
            consumed++;
            continue;
          }
          const dec = this.decoder;
          if (dec && dec.state === "configured") {
            if (dec.decodeQueueSize < QUEUE_CAP) {
              dec.decode(
                new EncodedAudioChunk({
                  type: "key",
                  timestamp: ts,
                  data: pending.slice(consumed, consumed + f),
                }),
              );
            }
            ts += 23000; // stale audio is useless to a meter — drop, don't queue
          }
          consumed += f;
        }
        if (consumed > 0) pending = pending.slice(consumed);
        if (this.dead) break;
      }
    } catch {
      /* aborted or the network went away */
    } finally {
      try {
        // cancel() can reject (socket teardown) — swallow it, it is
        // cleanup, not a failure state.
        reader.cancel().catch(() => {});
      } catch {
        /* already closed */
      }
      // A stream that ends under a live meter is a dead meter.
      if (!ctrl.signal.aborted && !this.dead) this.fail();
    }
  }

  stop() {
    this.told = true; // an intentional stop is not a failure to report
    this.kill();
  }
}

/**
 * ADTS frame length at i.
 * Returns >0 when a complete, contiguous frame sits there;
 * 0 when more bytes are needed; -1 when it is not an ADTS sync.
 */
function adtsFrame(b: Uint8Array, i: number): number {
  if (i + 7 > b.length) return 0;
  if (b[i] !== 0xff || (b[i + 1] & 0xf6) !== 0xf0) return -1;
  const fl = ((b[i + 3] & 3) << 11) | (b[i + 4] << 3) | ((b[i + 5] & 0xe0) >> 5);
  if (fl < 7) return -1;
  if (i + fl > b.length) return 0;
  if (i + fl < b.length) {
    // Sync that does not tile is coincidence, not a frame — but only when
    // the lookahead bytes exist. A lone trailing 0xff is consistent with
    // the next frame's header and must not invalidate this one.
    if (b[i + fl] !== 0xff) return -1;
    if (i + fl + 1 < b.length && (b[i + fl + 1] & 0xf6) !== 0xf0) return -1;
  }
  return fl;
}

interface Mp3Header {
  len: number;
  sampleRate: number;
  channels: number;
}

function mp3Header(b: Uint8Array, i: number): Mp3Header | null {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const ver = (b[i + 1] >> 3) & 3; // 0=2.5 2=2 3=1
  const layer = (b[i + 1] >> 1) & 3;
  if (ver === 1 || layer !== 1) return null; // Layer III only
  const bri = (b[i + 2] >> 4) & 15;
  const sri = (b[i + 2] >> 2) & 3;
  if (bri === 0 || bri === 15 || sri === 3) return null;
  const vix = ver === 3 ? 0 : ver === 2 ? 1 : 2;
  const br = (vix === 0 ? MP3_BR_V1 : MP3_BR_V2)[bri] * 1000;
  const sr = MP3_SR[vix][sri];
  const pad = (b[i + 2] >> 1) & 1;
  const len = Math.floor(((vix === 0 ? 144 : 72) * br) / sr) + pad;
  const channels = ((b[i + 3] >> 6) & 3) === 3 ? 1 : 2;
  return { len, sampleRate: sr, channels };
}

function mp3Frame(b: Uint8Array, i: number): number {
  const h = mp3Header(b, i);
  if (!h) return b[i] === 0xff && i + 4 > b.length ? 0 : -1;
  if (i + h.len > b.length) return 0;
  if (i + h.len < b.length && b[i + h.len] !== 0xff) return -1;
  return h.len;
}

/** Frame length from a standalone header (sniffing). */
function mp3FrameLen(b: Uint8Array, i: number): number {
  return mp3Header(b, i)?.len ?? 0;
}

import type Hls from "hls.js";

export type PlayerState = "idle" | "connecting" | "playing" | "blocked" | "error";

/**
 * Wraps a single <audio> element. Every play() gets an attempt token; only
 * the latest attempt may report state, so stale errors and late HLS imports
 * can't overwrite a newer stream. HLS playlists route through hls.js unless
 * the browser plays them natively (Safari).
 *
 * Optional metering: when the stream answers a CORS probe, the element is
 * routed through an AnalyserNode so the scope draws the real waveform. The
 * probe must pass BEFORE the src is assigned — a non-CORS resource stays
 * "tainted" forever, and routing it through the graph would mute it. When
 * analysis isn't possible the element plays direct and callers fall back to
 * a synthetic carrier.
 */
export class Player {
  private audio: HTMLAudioElement;
  private hls: Hls | null = null;
  private onState: (s: PlayerState) => void;
  private stallTimer: number | null = null;
  private attempt = 0;
  private live = false;

  private actx: AudioContext | null = null;
  private sourceNode: MediaElementAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private waveBuf: Float32Array<ArrayBuffer> | null = null;
  private wantGraph = false;

  constructor(onState: (s: PlayerState) => void) {
    this.onState = onState;
    this.audio = this.newAudio();
  }

  private newAudio(): HTMLAudioElement {
    const a = new Audio();
    a.preload = "none";
    a.addEventListener("playing", () => {
      if (this.live) this.set("playing");
    });
    a.addEventListener("waiting", () => {
      if (this.live) this.armStall();
    });
    a.addEventListener("error", () => {
      if (this.live) this.set("error");
    });
    a.addEventListener("ended", () => {
      if (this.live) this.set("error");
    });
    a.addEventListener("stalled", () => {
      if (this.live) this.armStall();
    });
    return a;
  }

  /** True when the scope is drawing real audio data. */
  get analysing(): boolean {
    return this.analyser !== null;
  }

  /** Latest time-domain samples, or null when the stream can't be analysed. */
  getWave(): Float32Array<ArrayBuffer> | null {
    if (!this.analyser || !this.waveBuf) return null;
    this.analyser.getFloatTimeDomainData(this.waveBuf);
    return this.waveBuf;
  }

  /** Decide before play() whether the next stream may be routed for metering. */
  setAnalyse(ok: boolean) {
    this.wantGraph = ok;
  }

  private set(s: PlayerState) {
    if (this.stallTimer !== null) {
      window.clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
    this.onState(s);
  }

  private armStall() {
    if (this.stallTimer !== null) window.clearTimeout(this.stallTimer);
    this.stallTimer = window.setTimeout(() => {
      if (this.live) this.set("error");
    }, 9000);
  }

  private fail(e: unknown): PlayerState {
    return e instanceof DOMException && e.name === "NotAllowedError" ? "blocked" : "error";
  }

  /**
   * Route audio through an AnalyserNode, or rebuild a direct element.
   * Runs only while halted (no live stream), so swapping the element is safe.
   */
  private async setupRoute(want: boolean): Promise<void> {
    if (want && !this.sourceNode && "AudioContext" in window) {
      if (!this.actx) this.actx = new AudioContext();
      if (this.actx.state === "suspended") {
        try {
          await this.actx.resume();
        } catch {
          /* stays suspended */
        }
      }
      if (this.actx.state === "running") {
        this.sourceNode = this.actx.createMediaElementSource(this.audio);
        this.analyser = this.actx.createAnalyser();
        this.analyser.fftSize = 1024;
        this.analyser.smoothingTimeConstant = 0.72;
        this.waveBuf = new Float32Array(this.analyser.fftSize);
        this.sourceNode.connect(this.analyser).connect(this.actx.destination);
        this.audio.crossOrigin = "anonymous";
      }
    }
    if (!want && this.sourceNode) {
      // Once routed, an element can never emit CORS-tainted audio again —
      // rebuild it so un-probed streams still play.
      this.audio.pause();
      this.audio = this.newAudio();
      this.sourceNode = null;
      this.analyser = null;
      this.waveBuf = null;
    }
  }

  async play(url: string, isHls: boolean): Promise<void> {
    const token = ++this.attempt;
    this.halt();
    await this.setupRoute(this.wantGraph);
    if (token !== this.attempt) return;
    if (this.sourceNode) this.audio.crossOrigin = "anonymous";
    this.live = true;
    this.set("connecting");
    const hlsUrl = isHls || /\.m3u8(\?|$)/i.test(url);
    const nativeHls = this.audio.canPlayType("application/vnd.apple.mpegurl") !== "";
    try {
      if (hlsUrl && !nativeHls) {
        const { default: HlsCtor } = await import("hls.js");
        if (token !== this.attempt) return;
        if (HlsCtor.isSupported()) {
          this.hls = new HlsCtor({ maxBufferLength: 20 });
          this.hls.on(HlsCtor.Events.ERROR, (_e, data) => {
            // No token check: the same instance can outlive pause()/resume()
            // bumps. live gates delivery; halt() destroys stale instances.
            if (data.fatal && this.live) this.set("error");
          });
          this.hls.loadSource(url);
          this.hls.attachMedia(this.audio);
        } else {
          this.set("error");
          return;
        }
      } else {
        this.audio.src = url;
      }
      this.armStall();
      await this.audio.play().catch((e) => {
        if (token === this.attempt) throw e;
      });
    } catch (e) {
      if (token === this.attempt) this.set(this.fail(e));
    }
  }

  pause() {
    // Bump attempt so a pending play()/resume() rejection can't report
    // after the user has paused.
    this.attempt++;
    this.live = false;
    this.audio.pause();
    this.set("idle");
  }

  resume() {
    // Nothing to resume while a play() is still initializing its source —
    // bumping the token here would cancel that import and strand the card.
    if (!this.audio.src && !this.hls) return;
    const token = ++this.attempt;
    this.live = true;
    this.set("connecting");
    this.armStall();
    if (this.actx?.state === "suspended") void this.actx.resume();
    this.audio.play().catch((e) => {
      if (token === this.attempt && this.live) this.set(this.fail(e));
    });
  }

  private halt() {
    this.live = false;
    if (this.stallTimer !== null) {
      window.clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
  }

  stop() {
    this.attempt++;
    this.halt();
    this.set("idle");
  }
}

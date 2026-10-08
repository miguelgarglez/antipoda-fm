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
  private onMeter: (on: boolean) => void;
  private stallTimer: number | null = null;
  private attempt = 0;
  private live = false;

  private actx: AudioContext | null = null;
  private sourceNode: MediaElementAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private waveBuf: Float32Array<ArrayBuffer> | null = null;
  private wantGraph = false;
  private wireOnGesture: (() => void) | null = null;
  private lastUrl: string | null = null;
  private lastHls = false;

  constructor(onState: (s: PlayerState) => void, onMeter: (on: boolean) => void = () => {}) {
    this.onState = onState;
    this.onMeter = onMeter;
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
      if (!this.live) return;
      // A positive CORS probe can still lie (redirect chains, per-mount
      // policy). Replay the same stream untainted once instead of
      // burning a detent on a phantom failure.
      if (this.wantGraph && this.lastUrl) {
        const url = this.lastUrl;
        const hls = this.lastHls;
        this.wantGraph = false;
        void this.play(url, hls);
        return;
      }
      this.set("error");
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
   * Runs only while halted (no live stream), so swapping the element is
   * safe. The attempt token is re-checked before mutating the element —
   * resume() may resolve long after a newer attempt took over.
   */
  private async setupRoute(want: boolean, token: number): Promise<void> {
    if (want && !this.sourceNode && "AudioContext" in window) {
      if (!this.actx) this.actx = new AudioContext();
      if (this.actx.state === "suspended") {
        try {
          // Without user activation resume() can stay pending forever —
          // bound the wait, then decide from the resulting state.
          await Promise.race([
            this.actx.resume(),
            new Promise((r) => setTimeout(r, 350)),
          ]);
        } catch {
          /* stays suspended */
        }
      }
      if (token !== this.attempt) return;
      if (this.actx.state === "running") {
        try {
          this.sourceNode = this.actx.createMediaElementSource(this.audio);
        } catch {
          return; // already sourced — fall through to direct playback
        }
        this.analyser = this.actx.createAnalyser();
        this.analyser.fftSize = 1024;
        this.analyser.smoothingTimeConstant = 0.72;
        this.waveBuf = new Float32Array(this.analyser.fftSize);
        this.sourceNode.connect(this.analyser).connect(this.actx.destination);
        this.onMeter(true);
      } else {
        // The context needs a real user activation (the bore completes on
        // an animation frame, not a gesture). The stream was fetched with
        // CORS — it survives a late wiring — so arm a one-shot retry on
        // the next pointer or key press instead of staying flat forever.
        this.armGestureWire();
      }
    }
    if (!want) {
      this.disarmGestureWire();
      if (this.sourceNode) this.teardownRoute();
    }
  }

  private armGestureWire() {
    if (this.wireOnGesture) return;
    const retry = async () => {
      this.wireOnGesture = null;
      if (this.actx?.state === "suspended") {
        // Inside the activation the resume() actually resolves — but
        // `state` only flips after the promise, so await it.
        try {
          await this.actx.resume();
        } catch {
          /* stays suspended */
        }
      }
      if (this.wantGraph && !this.sourceNode && this.actx?.state === "running") {
        try {
          this.sourceNode = this.actx.createMediaElementSource(this.audio);
          this.analyser = this.actx.createAnalyser();
          this.analyser.fftSize = 1024;
          this.analyser.smoothingTimeConstant = 0.72;
          this.waveBuf = new Float32Array(this.analyser.fftSize);
          this.sourceNode.connect(this.analyser).connect(this.actx.destination);
          this.onMeter(true);
        } catch {
          /* element already sourced elsewhere — stay direct */
        }
      }
      // Still suspended (a non-activation event fired) — re-arm.
      if (this.wantGraph && !this.sourceNode && this.actx && this.actx.state !== "running") {
        this.armGestureWire();
      }
    };
    this.wireOnGesture = retry;
    window.addEventListener("pointerdown", retry, { once: true });
    window.addEventListener("keydown", retry, { once: true });
  }

  private disarmGestureWire() {
    if (!this.wireOnGesture) return;
    window.removeEventListener("pointerdown", this.wireOnGesture);
    window.removeEventListener("keydown", this.wireOnGesture);
    this.wireOnGesture = null;
  }

  private teardownRoute() {
    // Once routed, an element can never emit CORS-tainted audio again —
    // rebuild it so un-probed streams still play.
    this.audio.pause();
    try {
      this.sourceNode?.disconnect();
    } catch {
      /* already disconnected */
    }
    try {
      this.analyser?.disconnect();
    } catch {
      /* already disconnected */
    }
    this.audio = this.newAudio();
    this.sourceNode = null;
    this.analyser = null;
    this.waveBuf = null;
    this.onMeter(false);
  }

  async play(url: string, isHls: boolean): Promise<void> {
    const token = ++this.attempt;
    this.halt();
    this.lastUrl = url;
    this.lastHls = isHls;
    await this.setupRoute(this.wantGraph, token);
    if (token !== this.attempt) return;
    // Fetch CORS-mode whenever the probe passed — even if the graph is not
    // wired yet — so the armed gesture retry can route the element later
    // without muting a tainted stream. An untainted replay (probe lied)
    // must clear it again or the element keeps fetching CORS-mode.
    this.audio.crossOrigin = this.wantGraph ? "anonymous" : null;
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
    // A real activation (the Listen press) — retry the graph now, since
    // the bore-time attempt may have found the context suspended.
    if (this.wantGraph && !this.sourceNode) void this.setupRoute(true, token);
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

  /** Full teardown — the component is gone, close the context for good. */
  dispose() {
    this.stop();
    this.disarmGestureWire();
    try {
      this.sourceNode?.disconnect();
      this.analyser?.disconnect();
    } catch {
      /* already disconnected */
    }
    this.sourceNode = null;
    this.analyser = null;
    this.waveBuf = null;
    this.lastUrl = null;
    if (this.actx) {
      void this.actx.close().catch(() => {});
      this.actx = null;
    }
  }
}

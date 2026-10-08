import type Hls from "hls.js";
import { StreamMeter } from "./stream-meter";

export type PlayerState = "idle" | "connecting" | "playing" | "blocked" | "error";

const gvdbg =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).has("gvdbg");

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

  // Some engines (WebKit) run the element's audio fine but return exact
  // digital silence from MediaElementAudioSourceNode. A watchdog proves it:
  // all-zero samples while audio advances for ~2.4 s. Once proven, this
  // session skips the element path and a StreamMeter re-decodes the stream
  // purely to feed the scope.
  private meter: StreamMeter | null = null;
  private elemDead = false;
  private watchTimer: number | null = null;
  private silentTicks = 0;
  private lastCT = -1;

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
    return this.analyser !== null || this.meter !== null;
  }

  /** Latest time-domain samples, or null when the stream can't be analysed. */
  getWave(): Float32Array | null {
    const m = this.meter?.getWave();
    if (m) return m;
    if (!this.analyser || !this.waveBuf) return null;
    this.analyser.getFloatTimeDomainData(this.waveBuf);
    return this.waveBuf;
  }

  /** Decide before play() whether the next stream may be routed for metering. */
  setAnalyse(ok: boolean) {
    this.wantGraph = ok;
  }

  /** Meter state report: drives the UI flag and, under ?gvdbg, a test hook. */
  private meterReport(on: boolean) {
    this.onMeter(on);
    if (gvdbg) {
      (window as unknown as { __meter: { src: string; real: boolean } }).__meter =
        {
          src: this.meter ? "decode" : this.analyser ? "element" : "none",
          real: on,
        };
    }
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
    if (want && this.elemDead) {
      // The element path proved silent earlier this session — skip the
      // wasted graph and go straight to the decode meter.
      void this.engageMeter();
      return;
    }
    if (want && "AudioContext" in window) {
      if (!this.actx) this.actx = new AudioContext();
      // Whether or not the graph is already wired, a suspended or
      // interrupted context (iOS Safari bounces to "interrupted" after
      // leaving the page) silences it — recovery is attempted every time,
      // not only when sourceNode is missing.
      if (this.actx.state !== "running") {
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
        if (!this.sourceNode) {
          try {
            this.sourceNode = this.actx.createMediaElementSource(this.audio);
          } catch {
            /* already sourced — fall through to reporting */
          }
        }
        if (this.sourceNode && !this.analyser) {
          this.analyser = this.actx.createAnalyser();
          this.analyser.fftSize = 1024;
          this.analyser.smoothingTimeConstant = 0.72;
          this.waveBuf = new Float32Array(this.analyser.fftSize);
          this.sourceNode.connect(this.analyser).connect(this.actx.destination);
        }
        // Replays must re-report: App resets metered=false on each tune,
        // and a reused graph would otherwise silently claim unmetered.
        if (this.analyser) {
          this.meterReport(true);
          if (!this.meter && !this.elemDead) this.armWatch();
        }
      } else {
        // The context needs a real user activation (the bore completes on
        // an animation frame, not a gesture). The stream was fetched with
        // CORS — it survives a late wiring — so arm a retry on the next
        // activation-capable event instead of staying flat forever.
        this.armGestureWire();
      }
    }
    if (!want) {
      this.disarmGestureWire();
      if (this.sourceNode) this.teardownRoute();
    }
  }

  private wireEvents = ["pointerdown", "pointerup", "keydown", "click"] as const;

  private armGestureWire() {
    if (this.wireOnGesture) return;
    const retry = async () => {
      // Strip EVERY registration first — each event type holds its own
      // listener, and clearing the shared ref before removing them would
      // strand the siblings.
      this.disarmGestureWire();
      const actx = this.actx;
      if (actx && actx.state !== "running") {
        // Inside the activation resume() resolves — but `state` only
        // flips after the promise, and the promise itself may never
        // settle, so bound the await.
        try {
          await Promise.race([actx.resume(), new Promise((r) => setTimeout(r, 400))]);
        } catch {
          /* stays suspended */
        }
      }
      if (this.wantGraph && this.actx?.state === "running") {
        try {
          if (!this.sourceNode) {
            this.sourceNode = this.actx.createMediaElementSource(this.audio);
          }
          if (!this.analyser) {
            this.analyser = this.actx.createAnalyser();
            this.analyser.fftSize = 1024;
            this.analyser.smoothingTimeConstant = 0.72;
            this.waveBuf = new Float32Array(this.analyser.fftSize);
            this.sourceNode.connect(this.analyser).connect(this.actx.destination);
          }
          if (this.analyser) {
            this.meterReport(true);
            if (!this.meter && !this.elemDead) this.armWatch();
          }
        } catch {
          /* element already sourced elsewhere — stay direct */
        }
      }
      // Still unmetered (a non-activation event fired, or the resume
      // timed out) — re-arm and wait for the next gesture.
      if (this.wantGraph && (!this.analyser || this.actx?.state !== "running")) {
        this.armGestureWire();
      }
    };
    this.wireOnGesture = retry;
    // pointerdown activates for mouse/pen only; touch earns activation on
    // release — listen on all of them, drop the whole set on first fire.
    for (const ev of this.wireEvents) window.addEventListener(ev, retry);
  }

  private disarmGestureWire() {
    const fn = this.wireOnGesture;
    if (!fn) return;
    for (const ev of this.wireEvents) window.removeEventListener(ev, fn);
    this.wireOnGesture = null;
  }

  /**
   * While the element graph is wired, watch for the dead-source signature:
   * exact digital silence in the analyser while playback time advances.
   * Real audio has a noise floor — literal zeros for four consecutive
   * checks mean the engine is feeding the graph nothing.
   */
  private armWatch() {
    if (this.watchTimer !== null) return;
    this.silentTicks = 0;
    this.lastCT = -1;
    this.watchTimer = window.setInterval(() => this.watchTick(), 600);
  }

  private disarmWatch() {
    if (this.watchTimer !== null) {
      window.clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
    this.silentTicks = 0;
  }

  private watchTick() {
    const an = this.analyser;
    const buf = this.waveBuf;
    if (!an || !buf || !this.live || this.audio.paused) {
      this.silentTicks = 0;
      return;
    }
    const ct = this.audio.currentTime;
    const advancing = this.lastCT >= 0 && ct > this.lastCT + 0.05;
    this.lastCT = ct;
    if (!advancing) return;
    an.getFloatTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
    if (peak > 1e-6) {
      this.silentTicks = 0;
      return;
    }
    if (++this.silentTicks >= 4) {
      this.elemDead = true;
      this.disarmWatch();
      void this.engageMeter();
    }
  }

  /**
   * Decode the stream for the scope when the element path is dead. Only
   * ever runs on CORS-cleared streams (wantGraph was probed); HLS and any
   * container WebCodecs cannot read fall back to the honest carrier.
   */
  private async engageMeter() {
    const url = this.lastUrl;
    if (!this.wantGraph || !url || this.lastHls || this.meter) {
      if (this.wantGraph && url && this.lastHls && !this.meter) this.meterReport(false);
      return;
    }
    const att = this.attempt;
    const meter = new StreamMeter();
    meter.onDead = () => {
      if (this.meter === meter) {
        this.meter = null;
        this.meterReport(false);
      }
    };
    const ok = await meter.start(url);
    // A newer play attempt took over, or a meter engaged meanwhile —
    // retire this one rather than leave a second fetch running.
    if (att !== this.attempt || this.meter) {
      meter.stop();
      return;
    }
    if (!ok) {
      this.meterReport(false);
      return;
    }
    this.meter = meter;
    this.meterReport(true);
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
    this.meterReport(false);
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
    if (this.wantGraph && this.analyser && !this.meter && !this.elemDead)
      this.armWatch();
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
    this.disarmWatch();
    if (this.meter) {
      this.meter.stop();
      this.meter = null;
    }
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
    // the bore-time attempt may have found the context suspended. The
    // context itself may also need resuming independently of the graph
    // (interrupted while away), which setupRoute handles either way.
    if (this.wantGraph) void this.setupRoute(true, token);
    if (this.wantGraph && this.analyser && !this.meter && !this.elemDead)
      this.armWatch();
    this.audio.play().catch((e) => {
      if (token === this.attempt && this.live) this.set(this.fail(e));
    });
  }

  private halt() {
    this.live = false;
    this.disarmWatch();
    if (this.meter) {
      this.meter.stop();
      this.meter = null;
    }
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

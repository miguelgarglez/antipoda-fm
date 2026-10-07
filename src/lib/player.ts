import type Hls from "hls.js";

export type PlayerState = "idle" | "connecting" | "playing" | "blocked" | "error";

/**
 * Wraps a single <audio> element. Every play() gets an attempt token; only
 * the latest attempt may report state, so stale errors and late HLS imports
 * can't overwrite a newer stream. HLS playlists route through hls.js unless
 * the browser plays them natively (Safari).
 */
export class Player {
  private audio: HTMLAudioElement;
  private hls: Hls | null = null;
  private onState: (s: PlayerState) => void;
  private stallTimer: number | null = null;
  private attempt = 0;
  private live = false;

  constructor(onState: (s: PlayerState) => void) {
    this.onState = onState;
    this.audio = new Audio();
    this.audio.preload = "none";
    this.audio.addEventListener("playing", () => {
      if (this.live) this.set("playing");
    });
    this.audio.addEventListener("waiting", () => {
      if (this.live) this.armStall();
    });
    this.audio.addEventListener("error", () => {
      if (this.live) this.set("error");
    });
    this.audio.addEventListener("ended", () => {
      if (this.live) this.set("error");
    });
    this.audio.addEventListener("stalled", () => {
      if (this.live) this.armStall();
    });
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

  async play(url: string, isHls: boolean): Promise<void> {
    const token = ++this.attempt;
    this.halt();
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
            if (data.fatal && token === this.attempt) this.set("error");
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
    this.live = false;
    this.audio.pause();
    this.set("idle");
  }

  resume() {
    this.live = true;
    this.set("connecting");
    this.armStall();
    this.audio.play().catch((e) => this.set(this.fail(e)));
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

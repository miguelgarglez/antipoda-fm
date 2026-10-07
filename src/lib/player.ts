import type Hls from "hls.js";

export type PlayerState = "idle" | "connecting" | "playing" | "error";

/**
 * Wraps a single <audio> element. Tries a direct stream first; lazily loads
 * hls.js only when a candidate is an HLS playlist the browser can't play.
 */
export class Player {
  private audio: HTMLAudioElement;
  private hls: Hls | null = null;
  private onState: (s: PlayerState) => void;
  private stallTimer: number | null = null;

  constructor(onState: (s: PlayerState) => void) {
    this.onState = onState;
    this.audio = new Audio();
    this.audio.preload = "none";
    this.audio.addEventListener("playing", () => this.set("playing"));
    this.audio.addEventListener("error", () => this.set("error"));
    this.audio.addEventListener("stalled", () => this.armStall());
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
    this.stallTimer = window.setTimeout(() => this.set("error"), 8000);
  }

  get volume() {
    return this.audio.volume;
  }

  setVolume(v: number) {
    this.audio.volume = v;
  }

  async play(url: string): Promise<void> {
    this.stop();
    this.set("connecting");
    const isHls = /\.m3u8(\?|$)/i.test(url);
    const nativeHls = this.audio.canPlayType("application/vnd.apple.mpegurl") !== "";
    try {
      if (isHls && !nativeHls) {
        const { default: HlsCtor } = await import("hls.js");
        if (HlsCtor.isSupported()) {
          this.hls = new HlsCtor({ maxBufferLength: 20 });
          this.hls.on(HlsCtor.Events.ERROR, (_e, data) => {
            if (data.fatal) this.set("error");
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
      await this.audio.play();
    } catch {
      this.set("error");
    }
  }

  pause() {
    this.audio.pause();
    this.set("idle");
  }

  resume() {
    this.set("connecting");
    this.audio.play().catch(() => this.set("error"));
  }

  stop() {
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
  }
}

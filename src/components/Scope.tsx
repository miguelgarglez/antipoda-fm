import { useEffect, useRef } from "react";
import { Player } from "../lib/player";

type Props = {
  player: Player | null;
  active: boolean; // audio is meant to be sounding
  connecting: boolean;
  /** the stream is actually routed through the analyser */
  metered?: boolean;
  className?: string;
};

/**
 * A phosphor oscilloscope line for the carrier. When the stream answers
 * CORS it draws the real waveform through the player's analyser. When it
 * can't — the usual case for plain HTTP radio mounts — it draws a flat
 * carrier and says so. An invented waveform would be a lie.
 */
export function Scope({ player, active, connecting, metered = false, className }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const phase = useRef(0);
  const lastWave = useRef<Float32Array | null>(null); // last real samples
  const rest = useRef(0); // paused decay: 1 live trace → 0 quiet baseline
  const gvdbg = new URLSearchParams(window.location.search).has("gvdbg");

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    const rmq = window.matchMedia("(prefers-reduced-motion: reduce)");
    let raf = 0;
    let last = 0;

    const draw = (now: number) => {
      const reduced = rmq.matches; // live read — the pref can flip mid-session
      const dt = last ? (now - last) / 1000 : 0;
      last = now;
      const w = canvas.getBoundingClientRect().width;
      const h = canvas.getBoundingClientRect().height;
      const mid = h / 2;
      // Phosphor persistence: the last frames die slowly instead of a
      // hard clear, so a real trace leaves a faint ghost of itself.
      ctx.fillStyle = "rgba(4,5,8,0.55)";
      ctx.fillRect(0, 0, w, h);

      // Faint center line + edge ticks.
      ctx.strokeStyle = "rgba(242,238,227,0.09)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, mid);
      ctx.lineTo(w, mid);
      ctx.stroke();
      ctx.strokeStyle = "rgba(242,238,227,0.14)";
      ctx.beginPath();
      ctx.moveTo(0.5, 4); ctx.lineTo(0.5, h - 4);
      ctx.moveTo(w - 0.5, 4); ctx.lineTo(w - 0.5, h - 4);
      ctx.stroke();

      const running = active || connecting;
      // Pause is a physical act on the trace: the last real samples settle
      // to a quiet baseline instead of the line vanishing mid-frame.
      rest.current += ((running ? 1 : 0) - rest.current) * Math.min(1, dt * 6);

      let wave = metered && running ? (player?.getWave() ?? null) : null;
      if (wave) {
        // Exact digital silence while ON AIR is a dead analyser, not a
        // quiet broadcast — draw the live carrier until the real signal
        // (or the honest unmetered note) replaces it. A flat green line
        // reads as broken.
        let silent = true;
        for (let i = 0; i < wave.length; i += 7) {
          if (Math.abs(wave[i]) > 1e-4) {
            silent = false;
            break;
          }
        }
        if (silent) wave = null;
        else lastWave.current = wave; // the player's buffer is stable while paused
      }
      // Paused: ghost the last waveform decaying to rest. Connecting or
      // unmetered live never borrows old samples.
      const ghost =
        !running && !wave && lastWave.current && rest.current > 0.02
          ? lastWave.current
          : null;
      if (gvdbg) {
        (window as unknown as { __meter: unknown }).__meter = {
          src: player?.meterKind ?? "none",
          real: wave !== null,
        };
      }
      phase.current += dt;

      ctx.beginPath();
      const n = Math.max(2, Math.floor(w / 2));
      const t = phase.current;
      let peak = 0;
      // A live-but-unmetered stream draws a designed carrier: a breathing
      // trace plus a slow pulse sweeping the band. Alive enough to read as
      // signal, honest enough that it never pretends to be the audio.
      const pulseX = ((t * 0.11) % 1) * w;
      const amp = wave ? 1 : ghost ? rest.current : 0;
      const disp = wave ?? ghost;
      for (let i = 0; i <= n; i++) {
        const x = (i / n) * w;
        let v = 0;
        if (disp) {
          const s = disp[Math.floor((i / n) * (disp.length - 1))];
          v = s * (h * 0.44) * amp;
        } else if (connecting) {
          // Searching: restless jitter.
          v = Math.sin(i * 43.7 + t * 60) * Math.sin(i * 7.3) * h * 0.1;
        } else if (active) {
          const breathe = 0.7 + 0.3 * Math.sin(t * 0.83);
          v =
            Math.sin(i * 0.05 + t * 1.7) *
            Math.sin(i * 0.019 - t * 0.61) *
            h *
            0.075 *
            breathe;
          const d = x - pulseX;
          v += Math.exp(-(d * d) / 800) * Math.sin(t * 7) * h * 0.09;
        }
        peak = Math.max(peak, Math.abs(v));
        if (i === 0) ctx.moveTo(x, mid - v);
        else ctx.lineTo(x, mid - v);
      }
      const on = active || connecting;
      ctx.strokeStyle = on
        ? wave
          ? `rgba(124,255,178,${0.55 + Math.min(0.35, peak / (h || 1))})`
          : "rgba(124,255,178,0.32)"
        : ghost
          ? "rgba(124,255,178,0.28)"
          : "rgba(152,161,184,0.25)";
      ctx.lineWidth = 1.2;
      ctx.stroke();

      // The meter state is announced in DOM text beside the scope, not as
      // dim canvas pixels inside an aria-hidden element.

      if (!reduced) {
        raf = requestAnimationFrame(draw);
      } else {
        raf = 0; // leave 0 so a later resize can schedule a single repaint
      }
    };

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Resizing clears the bitmap — queue one paint so a stopped loop
      // (reduced motion) doesn't leave the scope blank.
      if (raf === 0) raf = requestAnimationFrame(draw);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();
    if (raf === 0) raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [player, active, connecting, metered]);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}

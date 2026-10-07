import { useEffect, useRef } from "react";
import { Player } from "../lib/player";

type Props = {
  player: Player | null;
  active: boolean; // audio is meant to be sounding
  connecting: boolean;
  className?: string;
};

/**
 * A phosphor oscilloscope line for the carrier. When the stream answers CORS
 * it draws the real waveform through the player's analyser; otherwise it
 * falls back to a synthetic carrier — a breathing trace that still moves with
 * play state, never pretending to be data it doesn't have (the drift is
 * honest: "signal meter", not spectrum).
 */
export function Scope({ player, active, connecting, className }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const phase = useRef(0);

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let last = 0;

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    const draw = (now: number) => {
      const dt = last ? (now - last) / 1000 : 0;
      last = now;
      const w = canvas.getBoundingClientRect().width;
      const h = canvas.getBoundingClientRect().height;
      const mid = h / 2;
      ctx.clearRect(0, 0, w, h);

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

      const wave = active || connecting ? player?.getWave() ?? null : null;
      phase.current += dt;

      ctx.beginPath();
      const n = Math.max(2, Math.floor(w / 2));
      const t = phase.current;
      let peak = 0;
      for (let i = 0; i <= n; i++) {
        const x = (i / n) * w;
        let v = 0;
        if (wave) {
          const s = wave[Math.floor((i / n) * (wave.length - 1))];
          v = s * (h * 0.44);
        } else if (active) {
          // Synthetic carrier: two sines + a slow breathe + light jitter.
          const env = 0.55 + 0.45 * Math.sin(t * 1.7);
          v =
            (Math.sin(x * 0.09 + t * 5.1) * 0.55 +
              Math.sin(x * 0.023 - t * 2.3) * 0.45 +
              (Math.sin(i * 12.9898 + t * 31) * 0.5) * 0.22) *
            env * h * 0.3;
        } else if (connecting) {
          v = Math.sin(i * 43.7 + t * 60) * Math.sin(i * 7.3) * h * 0.1;
        }
        peak = Math.max(peak, Math.abs(v));
        if (i === 0) ctx.moveTo(x, mid - v);
        else ctx.lineTo(x, mid - v);
      }
      const on = active || connecting;
      ctx.strokeStyle = on
        ? `rgba(124,255,178,${0.55 + Math.min(0.35, peak / (h || 1))})`
        : "rgba(255,77,0,0.35)";
      ctx.lineWidth = 1.2;
      ctx.stroke();

      if (!reduced && (on || phase.current < 1e9)) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [player, active, connecting]);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}

import { useEffect, useRef } from "react";
import {
  Vec3,
  dot,
  cross,
  norm,
  add,
  scale,
  slerp,
  rotateAroundAxis,
  latLonToVec3,
} from "../lib/geo-math";
import { coastRings } from "../lib/earth";

type Props = {
  axis: Vec3;
  origin: Vec3 | null;
  antipode: Vec3 | null;
  locked: boolean;
  className?: string;
};

const BONE = "#F2EEE3";
const ORANGE = "#FF4D00";
const PHOSPHOR = "#7CFFB2";

const DRIFT = 0.045; // rad/s camera orbit around the vertical axis

// Precomputed graticule: parallels every 30deg, meridians every 30deg.
const GRATICULE: Vec3[][] = (() => {
  const lines: Vec3[][] = [];
  for (let lat = -60; lat <= 60; lat += 30) {
    const ring: Vec3[] = [];
    for (let lon = 0; lon <= 360; lon += 6) ring.push(latLonToVec3(lat, lon));
    lines.push(ring);
  }
  for (let lon = 0; lon < 360; lon += 30) {
    const line: Vec3[] = [];
    for (let lat = -90; lat <= 90; lat += 6) line.push(latLonToVec3(lat, lon));
    lines.push(line);
  }
  return lines;
})();

// Static 2D starfield, generated once.
const STARS: { x: number; y: number; r: number; a: number }[] = Array.from(
  { length: 170 },
  () => ({
    x: Math.random() * 2 - 1,
    y: Math.random() * 2 - 1,
    r: 0.4 + Math.random() * 0.9,
    a: 0.08 + Math.random() * 0.3,
  }),
);

export function Globe({ axis, origin, antipode, locked, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const state = useRef({
    shownAxis: axis,
    fromAxis: axis,
    toAxis: axis,
    transitionStart: 0,
    // Camera forward vector, rotated incrementally so it never snaps.
    u: null as Vec3 | null,
    lastT: 0,
    dirty: true,
  });

  useEffect(() => {
    const s = state.current;
    if (dot(s.toAxis, axis) < 0.999999) {
      s.fromAxis = s.shownAxis;
      s.toAxis = axis;
      s.transitionStart = performance.now();
      s.dirty = true;
    }
  }, [axis]);

  useEffect(() => {
    state.current.dirty = true;
  }, [origin, antipode, locked]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let cssSize = 0;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      cssSize = Math.min(rect.width, rect.height);
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      state.current.dirty = true;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    type P = { x: number; y: number; z: number };
    const draw = (now: number) => {
      const s = state.current;
      const dt = s.lastT ? (now - s.lastT) / 1000 : 0;
      s.lastT = now;

      const moving = !reduced || s.dirty;

      // Axis transition (1.4s ease-in-out), instant under reduced motion.
      const T = reduced ? 0 : 1400;
      const k = T === 0 ? 1 : Math.min(1, (now - s.transitionStart) / T);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      s.shownAxis = slerp(s.fromAxis, s.toAxis, e);
      const ax = norm(s.shownAxis);

      // Camera orbits the vertical axis incrementally; the axis itself is
      // screen-up, so the chord stays vertical while the world spins.
      if (!s.u) {
        const ref: Vec3 = Math.abs(ax[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
        s.u = norm(cross(ax, ref));
      }
      if (moving && dt > 0) {
        s.u = norm(rotateAroundAxis(s.u, ax, DRIFT * dt));
      }
      // Re-orthogonalize u against the (possibly moving) axis.
      let u = s.u;
      u = norm(add(u, scale(ax, -dot(u, ax))));
      s.u = u;

      const w = canvas.getBoundingClientRect().width;
      const h = canvas.getBoundingClientRect().height;
      const cx = w / 2;
      const cy = h / 2;
      const R = cssSize * 0.4;

      const eR = norm(cross(ax, u)); // screen right
      const eU = ax; // screen up

      const proj = (v: Vec3): P => ({
        x: cx + dot(v, eR) * R,
        y: cy - dot(v, eU) * R,
        z: dot(v, u),
      });

      ctx.clearRect(0, 0, w, h);

      // Stars
      for (const st of STARS) {
        if (st.x * st.x + st.y * st.y < 0.45) continue; // keep out of the disc
        ctx.beginPath();
        ctx.arc(cx + st.x * R * 1.35, cy + st.y * R * 1.35, st.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(242,238,227,${st.a})`;
        ctx.fill();
      }

      // Earth disc + rim
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(242,238,227,0.025)";
      ctx.fill();
      ctx.strokeStyle = "rgba(242,238,227,0.4)";
      ctx.lineWidth = 1;
      ctx.stroke();

      // Hemisphere-clipped polyline pass.
      const strokeRing = (
        ring: Vec3[],
        closed: boolean,
        front: boolean,
        style: string,
        lw: number,
      ) => {
        ctx.strokeStyle = style;
        ctx.lineWidth = lw;
        ctx.beginPath();
        let pen = false;
        const n = closed ? ring.length : ring.length - 1;
        for (let i = 0; i < n; i++) {
          const a = proj(ring[i]);
          const b = proj(ring[(i + 1) % ring.length]);
          const aVis = front ? a.z > 0 : a.z <= 0;
          const bVis = front ? b.z > 0 : b.z <= 0;
          const clip = (p: P, q: P) => {
            const tt = p.z / (p.z - q.z);
            return { x: p.x + (q.x - p.x) * tt, y: p.y + (q.y - p.y) * tt };
          };
          if (aVis && bVis) {
            if (!pen) ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            pen = true;
          } else if (aVis && !bVis) {
            if (!pen) ctx.moveTo(a.x, a.y);
            const c = clip(a, b);
            ctx.lineTo(c.x, c.y);
            pen = false;
          } else if (!aVis && bVis) {
            const c = clip(a, b);
            ctx.moveTo(c.x, c.y);
            ctx.lineTo(b.x, b.y);
            pen = true;
          } else {
            pen = false;
          }
        }
        ctx.stroke();
      };

      for (const ring of GRATICULE) {
        strokeRing(ring, false, false, "rgba(242,238,227,0.045)", 0.6);
      }
      for (const ring of coastRings) {
        strokeRing(ring, true, false, "rgba(90,100,120,0.14)", 0.7);
      }
      for (const ring of GRATICULE) {
        strokeRing(ring, false, true, "rgba(242,238,227,0.10)", 0.7);
      }
      for (const ring of coastRings) {
        strokeRing(ring, true, true, "rgba(122,139,168,0.65)", 1);
      }

      // Chord through the planet: the diameter joining the two points.
      if (origin && antipode) {
        ctx.save();
        ctx.setLineDash([1.5, 5]);
        ctx.strokeStyle = ORANGE;
        ctx.lineWidth = 5;
        ctx.globalAlpha = 0.14;
        ctx.beginPath();
        ctx.moveTo(cx, cy - R);
        ctx.lineTo(cx, cy + R);
        ctx.stroke();
        ctx.lineWidth = 1.4;
        ctx.globalAlpha = locked ? 0.95 : 0.7;
        ctx.beginPath();
        ctx.moveTo(cx, cy - R);
        ctx.lineTo(cx, cy + R);
        ctx.stroke();
        ctx.restore();

        // Origin marker (top): bone dot + quiet ring.
        ctx.beginPath();
        ctx.arc(cx, cy - R, 3, 0, Math.PI * 2);
        ctx.fillStyle = BONE;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(cx, cy - R, 6.5, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(242,238,227,0.5)";
        ctx.lineWidth = 1;
        ctx.stroke();

        // Antipode marker (bottom): orange ember; ping when locked.
        const t = now / 1000;
        const glow = locked && !reduced ? 1 + Math.sin(t * 2.2) * 0.25 : 1;
        const g = ctx.createRadialGradient(cx, cy + R, 0, cx, cy + R, 16 * glow);
        g.addColorStop(0, "rgba(255,77,0,0.75)");
        g.addColorStop(1, "rgba(255,77,0,0)");
        ctx.beginPath();
        ctx.arc(cx, cy + R, 16 * glow, 0, Math.PI * 2);
        ctx.fillStyle = g;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(cx, cy + R, 3.6, 0, Math.PI * 2);
        ctx.fillStyle = ORANGE;
        ctx.fill();
        if (locked && !reduced) {
          const ph = (t % 1.8) / 1.8;
          ctx.beginPath();
          ctx.arc(cx, cy + R, 4 + ph * 26, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(255,77,0,${(1 - ph) * 0.45})`;
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }
        if (locked) {
          ctx.beginPath();
          ctx.arc(cx, cy + R, 5.5, 0, Math.PI * 2);
          ctx.strokeStyle = PHOSPHOR;
          ctx.globalAlpha = 0.8;
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }

      // In reduced-motion mode, draw once per change then idle.
      if (reduced) s.dirty = false;
      if (!reduced || s.dirty || k < 1) {
        raf = requestAnimationFrame(draw);
      }
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [origin, antipode, locked]);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}

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
import { drawSection, layerAt, DIAMETER_KM, BOUNDS } from "../lib/section";

type Props = {
  axis: Vec3;
  origin: Vec3 | null;
  antipode: Vec3 | null;
  locked: boolean;
  /** Bore sequence: the disc opens into a cross-section while the probe descends. */
  boring: boolean;
  /** Resolver finished — the probe may punch through and exit. */
  armed: boolean;
  /** Fired once when the probe exits the far surface. */
  onBoreComplete?: () => void;
  className?: string;
};

const BONE = "#F2EEE3";
const ORANGE = "#FF4D00";
const PHOSPHOR = "#7CFFB2";

const DRIFT = 0.045; // rad/s camera orbit around the vertical axis

// Boundary crossings as chord fractions -> boundary circle radius / R.
const CROSSINGS = [BOUNDS.mantleCore, BOUNDS.outerInner, 1 - BOUNDS.outerInner, 1 - BOUNDS.mantleCore].map(
  (f) => ({ frac: f, r: Math.abs(1 - 2 * f) }),
);

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

export function Globe({ axis, origin, antipode, locked, boring, armed, onBoreComplete, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const state = useRef({
    shownAxis: axis,
    fromAxis: axis,
    toAxis: axis,
    transitionStart: 0,
    // Camera forward vector, rotated incrementally so it never snaps.
    u: null as Vec3 | null,
    userVel: 0,
    dragging: false,
    lastX: 0,
    lastMoveT: 0,
    morphT: 0,
    probeT: -1,
    boreDone: false,
    flashes: [] as { t: number; at: number }[],
    crossed: new Set<number>(),
    lastT: 0,
    dirty: true,
    requestDraw: () => {},
    boring,
    armed,
    locked,
    origin,
    antipode,
    onBoreComplete,
  });
  const s = state.current;
  s.boring = boring;
  s.armed = armed;
  s.locked = locked;
  s.origin = origin;
  s.antipode = antipode;
  s.onBoreComplete = onBoreComplete;

  useEffect(() => {
    const s = state.current;
    if (dot(s.toAxis, axis) < 0.999999) {
      s.fromAxis = s.shownAxis;
      s.toAxis = axis;
      s.transitionStart = performance.now();
      s.dirty = true;
      s.requestDraw();
    }
  }, [axis]);

  useEffect(() => {
    const s = state.current;
    if (boring) {
      s.boreDone = false;
      s.crossed.clear();
      if (s.probeT < 0) s.probeT = 0;
    } else {
      s.probeT = -1;
      s.flashes = [];
    }
    s.dirty = true;
    s.requestDraw();
  }, [boring, armed]);

  useEffect(() => {
    state.current.dirty = true;
    state.current.requestDraw();
  }, [origin, antipode, locked]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let cssSize = 0;

    const requestDraw = () => {
      if (reduced && raf === 0) raf = requestAnimationFrame(draw);
    };
    state.current.requestDraw = requestDraw;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      cssSize = Math.min(rect.width, rect.height);
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      state.current.dirty = true;
      // Under reduced motion the loop stops between changes — schedule a
      // single redraw so a resize doesn't leave a blank canvas.
      requestDraw();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    // Drag to spin: horizontal drag rotates the camera around the chord axis.
    const onDown = (e: PointerEvent) => {
      const s = state.current;
      s.dragging = true;
      s.lastX = e.clientX;
      s.lastMoveT = performance.now();
      s.userVel = 0;
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = "grabbing";
    };
    const onMove = (e: PointerEvent) => {
      const s = state.current;
      if (!s.dragging || !s.u) return;
      const dx = e.clientX - s.lastX;
      const now = performance.now();
      const dt = Math.max(1, now - s.lastMoveT);
      s.lastX = e.clientX;
      s.lastMoveT = now;
      const rot = dx * 0.007;
      const ax = norm(s.shownAxis);
      s.u = norm(rotateAroundAxis(s.u, ax, rot));
      s.userVel = reduced ? 0 : rot / (dt / 1000); // rad/s for release inertia
      s.dirty = true;
      s.requestDraw();
    };
    const onUp = () => {
      const s = state.current;
      s.dragging = false;
      canvas.style.cursor = "grab";
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);

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

      if (!s.u) {
        const ref: Vec3 = Math.abs(ax[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
        s.u = norm(cross(ax, ref));
      }
      if (moving && dt > 0 && !s.dragging) {
        // Baseline drift plus decaying release inertia.
        s.userVel *= Math.pow(0.12, dt);
        if (Math.abs(s.userVel) < 0.01) s.userVel = 0;
        s.u = norm(rotateAroundAxis(s.u, ax, (DRIFT + s.userVel) * dt));
      }
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

      // Bore morph: 0 = wireframe planet, 1 = opened cross-section.
      const morphTarget = s.boring ? 1 : 0;
      if (reduced) s.morphT = morphTarget;
      else s.morphT += (morphTarget - s.morphT) * Math.min(1, dt * 5.2);
      if (Math.abs(morphTarget - s.morphT) < 0.004) s.morphT = morphTarget;
      const morph = s.morphT;

      // Probe travel: decelerating crawl to a hold at 90%, punch on armed.
      if (s.boring && s.probeT >= 0 && !s.boreDone) {
        if (reduced) {
          s.probeT = s.armed ? 1 : 0.9;
        } else {
          const target = s.armed ? 1 : 0.9;
          const rate = s.armed ? 3.4 : 1.05;
          s.probeT += (target - s.probeT) * Math.min(1, dt * rate);
        }
        // Boundary crossings flash their circle.
        for (const c of CROSSINGS) {
          if (s.probeT >= c.frac && !s.crossed.has(c.frac)) {
            s.crossed.add(c.frac);
            s.flashes.push({ t: now / 1000, at: c.r });
          }
        }
        if (s.probeT >= 0.995 && s.armed) {
          s.probeT = 1;
          s.boreDone = true;
          navigator.vibrate?.(12);
          s.onBoreComplete?.();
        }
      }

      // Earth disc fill.
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(242,238,227,${0.025 * (1 - morph)})`;
      ctx.fill();

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

      const wireA = 1 - morph;
      if (wireA > 0.02) {
        ctx.save();
        ctx.globalAlpha = wireA;
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
        ctx.restore();
      }

      // The opened planet.
      if (morph > 0.02) {
        ctx.save();
        ctx.globalAlpha = morph;
        drawSection(ctx, cx, cy, R, {
          probe: s.boring ? s.probeT : -1,
          beamAlpha: 1,
          flashes: reduced ? [] : s.flashes,
          t: now / 1000,
        });
        ctx.restore();
      }

      // Rim — shared by both views.
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(242,238,227,${morph > 0.5 ? 0.55 : 0.4})`;
      ctx.lineWidth = morph > 0.5 ? 1.4 : 1;
      ctx.stroke();

      // Chord through the planet: the diameter joining the two points.
      if (s.origin && s.antipode && morph < 0.02) {
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
        ctx.globalAlpha = s.locked ? 0.95 : 0.7;
        ctx.beginPath();
        ctx.moveTo(cx, cy - R);
        ctx.lineTo(cx, cy + R);
        ctx.stroke();
        ctx.restore();
      }

      if (s.origin && s.antipode) {
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
        const glow = s.locked && !reduced ? 1 + Math.sin(t * 2.2) * 0.25 : 1;
        const g = ctx.createRadialGradient(cx, cy + R, 0, cx, cy + R, 16 * glow);
        g.addColorStop(0, `rgba(255,77,0,${s.boring && !s.boreDone ? 0.3 : 0.75})`);
        g.addColorStop(1, "rgba(255,77,0,0)");
        ctx.beginPath();
        ctx.arc(cx, cy + R, 16 * glow, 0, Math.PI * 2);
        ctx.fillStyle = g;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(cx, cy + R, 3.6, 0, Math.PI * 2);
        ctx.fillStyle = ORANGE;
        ctx.fill();
        if (s.locked && !reduced) {
          const ph = (t % 1.8) / 1.8;
          ctx.beginPath();
          ctx.arc(cx, cy + R, 4 + ph * 26, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(255,77,0,${(1 - ph) * 0.45})`;
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }
        if (s.locked) {
          ctx.beginPath();
          ctx.arc(cx, cy + R, 5.5, 0, Math.PI * 2);
          ctx.strokeStyle = PHOSPHOR;
          ctx.globalAlpha = 0.8;
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }

      // Depth counter under the disc while boring.
      if (s.boring && s.probeT >= 0 && morph > 0.5) {
        const depth = Math.round(s.probeT * DIAMETER_KM).toLocaleString("en-US");
        const parts: [string, string][] = [
          ["depth ", "rgba(152,161,184,0.9)"],
          [`${depth} km`, "rgba(124,255,178,0.95)"],
          [` · ${layerAt(s.probeT)}`, "rgba(152,161,184,0.9)"],
        ];
        ctx.font = "11px 'IBM Plex Mono', monospace";
        ctx.textAlign = "left";
        const totalW = parts.reduce((acc, [txt]) => acc + ctx.measureText(txt).width, 0);
        let x0 = cx - totalW / 2;
        for (const [txt, color] of parts) {
          ctx.fillStyle = color;
          ctx.fillText(txt, x0, cy + R + 26);
          x0 += ctx.measureText(txt).width;
        }
      }

      // In reduced-motion mode, draw once per change then idle. The armed
      // flip re-enters through requestDraw, so a waiting probe can rest here.
      if (reduced) s.dirty = false;
      if (!reduced || s.dirty || k < 1) {
        raf = requestAnimationFrame(draw);
      } else {
        raf = 0;
      }
    };

    // Initial layout + first frame — after draw exists. resize() may have
    // already scheduled one under reduced motion; don't double-schedule.
    resize();
    if (raf === 0) raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
    };
  }, [origin, antipode, locked]);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}

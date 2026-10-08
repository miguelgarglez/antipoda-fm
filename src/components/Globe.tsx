import { useEffect, useRef } from "react";
import {
  Vec3,
  dot,
  cross,
  norm,
  scale,
  add,
  sub,
  latLonToVec3,
} from "../lib/geo-math";
import {
  Quat,
  qAxis,
  qForward,
  qFromRows,
  qLookAt,
  qMul,
  qNorm,
  qRot,
  qSlerp,
} from "../lib/quat";
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
const NORTH: Vec3 = [0, 0, 1];

const DRIFT = 0.05; // rad/s idle turntable spin (view space +y)
const ZOOM_MIN = 0.55;
const ZOOM_MAX = 2.8;

// Boundary crossings as chord fractions -> boundary circle radius / R.
const CROSSINGS = [BOUNDS.mantleCore, BOUNDS.outerInner, 1 - BOUNDS.outerInner, 1 - BOUNDS.mantleCore].map(
  (f) => ({ frac: f, r: Math.abs(1 - 2 * f) }),
);

// The bore runs on a fixed clock, not the network's: the camera first
// flies to where you stand, swings around to slice the chord, then the
// planet opens and the probe descends on a decelerating approach, rests
// at the far rim while the resolver answers, and the shell reseals.
const BORE_T = {
  openAt: 180, // ms after boreStart — boreStart itself trails the shots
  openDur: 320,
  travelAt: 460,
  travelDur: 920,
  hold: 90,
  resealDur: 240,
};
// Camera prelude: fly-to-origin, then swing to the chord view.
const SHOT_MS = { toOrigin: 640, toChord: 540, settle: 160 };
const PRE_BORE = SHOT_MS.toOrigin + SHOT_MS.toChord + SHOT_MS.settle;

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

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

// Rest view: tilted pole up, lens on the Atlantic side.
const HOME_Q: Quat = (() => {
  const eU = norm([Math.sin(0.41), 0, Math.cos(0.41)]);
  const f = latLonToVec3(16, -30);
  let eV = sub(f, scale(eU, dot(f, eU)));
  eV = norm(eV);
  const eR = cross(eU, eV);
  return qFromRows(eR, eU, eV);
})();

/** Orientation with world dir `axis` pinned to screen-up, facing `hint`. */
function qAxisUp(axis: Vec3, facingHint: Vec3): Quat {
  const eU = norm(axis);
  let eV = sub(facingHint, scale(eU, dot(facingHint, eU)));
  if (Math.hypot(eV[0], eV[1], eV[2]) < 1e-6) {
    const ref: Vec3 = Math.abs(eU[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    eV = norm(cross(eU, ref));
  } else {
    eV = norm(eV);
  }
  const eR = cross(eU, eV);
  return qFromRows(eR, eU, eV);
}

type Shot = { at: number; dur: number; q1: Quat; z1: number };

export function Globe({ axis, origin, antipode, locked, boring, armed, onBoreComplete, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const state = useRef({
    q: HOME_Q as Quat,
    zoom: 1,
    zoomT: 1,
    wvel: [0, 0, 0] as Vec3, // view-space angular velocity, rad/s
    pointers: new Map<number, { x: number; y: number }>(),
    pinch0: 0,
    pinchZoom0: 1,
    shots: [] as Shot[],
    shotFrom: null as { q: Quat; z: number; t0: number } | null,
    morphT: 0,
    probeT: -1,
    boreDone: false,
    boreStart: 0,
    holdStart: 0,
    resealing: false,
    resealStart: 0,
    flashes: [] as { t: number; at: number }[],
    crossed: new Set<number>(),
    hadMarkers: false,
    lastT: 0,
    dirty: true,
    requestDraw: () => {},
    boring,
    armed,
    locked,
    axis,
    origin,
    antipode,
    onBoreComplete,
  });
  const s = state.current;
  s.boring = boring;
  s.armed = armed;
  s.locked = locked;
  s.axis = axis;
  s.origin = origin;
  s.antipode = antipode;
  s.onBoreComplete = onBoreComplete;

  const queueShots = (shots: Shot[]) => {
    s.shots = shots;
    s.shotFrom = null;
    s.wvel = [0, 0, 0];
    s.dirty = true;
    s.requestDraw();
  };

  // The tune choreography. Camera: fly to where you stand, swing to put
  // the chord vertical, open the planet; after the probe exits, swing to
  // the far side and zoom in on the station's home, then pull back out.
  useEffect(() => {
    const s = state.current;
    const now = performance.now();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (boring) {
      s.boreDone = false;
      s.crossed.clear();
      s.resealing = false;
      s.holdStart = 0;
      s.boreStart = now + (reduced ? 0 : PRE_BORE);
      if (s.probeT < 0) s.probeT = 0;
      if (!reduced) {
        queueShots([
          { at: now, dur: SHOT_MS.toOrigin, q1: qLookAt(s.axis, NORTH), z1: 1.45 },
          {
            at: now + SHOT_MS.toOrigin + SHOT_MS.settle,
            dur: SHOT_MS.toChord,
            q1: qAxisUp(s.axis, qForward(s.q)),
            z1: 1,
          },
        ]);
      }
    } else {
      s.probeT = -1;
      s.flashes = [];
      s.resealing = false;
      // The bore resealed — reveal the far side, then hand the planet
      // back to the user.
      if (s.boreDone && s.antipode && !reduced) {
        const up = Math.abs(dot(s.antipode, NORTH)) > 0.93 ? [0, 1, 0] as Vec3 : NORTH;
        queueShots([
          { at: now + 120, dur: 1050, q1: qLookAt(s.antipode, up), z1: 1.5 },
          { at: now + 120 + 1050 + 620, dur: 720, q1: qLookAt(s.antipode, up), z1: 1 },
        ]);
      }
    }
    s.dirty = true;
    s.requestDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boring]);

  // `armed` only needs to wake a sleeping (reduced-motion) loop — the bore
  // clock must NOT restart when it lands mid-sequence.
  useEffect(() => {
    state.current.dirty = true;
    state.current.requestDraw();
  }, [armed]);

  useEffect(() => {
    const s = state.current;
    if (origin && antipode) s.hadMarkers = true;
    // Reset: markers vanished — glide home.
    if (!origin && s.hadMarkers) {
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      s.hadMarkers = false;
      s.shots = reduced ? [] : [{ at: performance.now(), dur: 700, q1: HOME_Q, z1: 1 }];
      if (reduced) {
        s.q = HOME_Q;
        s.zoom = 1;
        s.zoomT = 1;
      }
      s.zoomT = s.shots.length ? s.zoomT : 1;
      s.wvel = [0, 0, 0];
    }
    s.dirty = true;
    s.requestDraw();
  }, [origin, antipode, locked]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let cssSize = 0;
    let baseR = 0;
    let dead = false;

    const requestDraw = () => {
      if (!dead && reduced && raf === 0) raf = requestAnimationFrame(draw);
    };
    state.current.requestDraw = requestDraw;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      cssSize = Math.min(rect.width, rect.height);
      baseR = cssSize * 0.4;
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

    // --- Direct manipulation: grab the planet ---
    const onDown = (e: PointerEvent) => {
      const s = state.current;
      canvas.setPointerCapture(e.pointerId);
      s.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (s.pointers.size === 2) {
        const [a, b] = [...s.pointers.values()];
        s.pinch0 = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        s.pinchZoom0 = s.zoomT;
      }
      s.shots = []; // a grab interrupts the camera
      s.shotFrom = null;
      s.wvel = [0, 0, 0];
      canvas.style.cursor = "grabbing";
      s.dirty = true;
      s.requestDraw();
    };
    const onMove = (e: PointerEvent) => {
      const s = state.current;
      const p = s.pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      s.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (s.pointers.size === 2) {
        const [a, b] = [...s.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        s.zoomT = clamp(s.pinchZoom0 * (d / s.pinch0), ZOOM_MIN, ZOOM_MAX);
        s.dirty = true;
        s.requestDraw();
        return;
      }
      if (s.pointers.size !== 1) return;
      // Trackball: rotation axis is the drag vector rotated 90° in the
      // view plane, so the surface follows the pointer.
      const r = Math.max(40, baseR * s.zoom);
      const theta = Math.hypot(dx, dy) / r;
      if (theta < 1e-5) return;
      const ax = norm([dy, dx, 0]);
      s.q = qNorm(qMul(qAxis(ax, theta), s.q));
      // Track release inertia as an EMA of instantaneous angular speed.
      const dtms = 16; // pointer events arrive ~per frame
      const inst = theta / (dtms / 1000);
      s.wvel = add(scale(s.wvel, 0.65), scale(ax, inst * 0.35));
      s.dirty = true;
      s.requestDraw();
    };
    const onUp = (e: PointerEvent) => {
      const s = state.current;
      s.pointers.delete(e.pointerId);
      if (s.pointers.size < 2) s.pinch0 = 0;
      if (s.pointers.size === 0) canvas.style.cursor = "grab";
      s.dirty = true;
      s.requestDraw();
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const s = state.current;
      const k = e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 0.4 : 0.0016;
      s.zoomT = clamp(s.zoomT * Math.exp(-e.deltaY * k), ZOOM_MIN, ZOOM_MAX);
      // A wheel gesture takes the camera back — cancel scripted moves.
      s.shots = [];
      s.shotFrom = null;
      s.dirty = true;
      s.requestDraw();
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.style.touchAction = "none";
    canvas.style.cursor = "grab";

    type P = { x: number; y: number; z: number };
    const draw = (now: number) => {
      const s = state.current;
      const dt = s.lastT ? Math.min(0.05, (now - s.lastT) / 1000) : 0;
      s.lastT = now;

      const moving = !reduced || s.dirty;

      // --- camera state ---
      if (s.shots.length && !s.pointers.size) {
        const nx = s.shots[0];
        if (now >= nx.at) {
          if (!s.shotFrom) s.shotFrom = { q: s.q, z: s.zoom, t0: now };
          const k = reduced || nx.dur <= 0 ? 1 : Math.min(1, (now - s.shotFrom.t0) / nx.dur);
          const e = easeInOut(k);
          s.q = qSlerp(s.shotFrom.q, nx.q1, e);
          s.zoom = s.shotFrom.z + (nx.z1 - s.shotFrom.z) * e;
          if (k >= 1) {
            s.shots.shift();
            s.shotFrom = null;
            s.q = nx.q1;
            s.zoom = nx.z1;
            s.zoomT = nx.z1;
          }
        }
      } else {
        s.zoom += (s.zoomT - s.zoom) * Math.min(1, 11 * dt);
        if (moving && dt > 0 && !s.pointers.size) {
          const sp = Math.hypot(s.wvel[0], s.wvel[1], s.wvel[2]);
          if (sp > 0.015) {
            s.q = qNorm(qMul(qAxis(norm(s.wvel), sp * dt), s.q));
            s.wvel = scale(s.wvel, Math.pow(0.06, dt));
          } else {
            s.wvel = [0, 0, 0];
            s.q = qNorm(qMul(qAxis([0, 1, 0], DRIFT * dt), s.q));
          }
        }
      }

      const w = canvas.getBoundingClientRect().width;
      const h = canvas.getBoundingClientRect().height;
      const cx = w / 2;
      const cy = h / 2;
      const R = baseR * s.zoom;

      const proj = (v: Vec3): P => {
        const r = qRot(s.q, v);
        return { x: cx + r[0] * R, y: cy - r[1] * R, z: r[2] };
      };

      ctx.clearRect(0, 0, w, h);

      // Stars
      for (const st of STARS) {
        if (st.x * st.x + st.y * st.y < 0.45) continue; // keep out of the disc
        ctx.beginPath();
        ctx.arc(cx + st.x * baseR * 1.35, cy + st.y * baseR * 1.35, st.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(242,238,227,${st.a})`;
        ctx.fill();
      }

      // Bore morph: 0 = wireframe planet, 1 = opened cross-section. The
      // timeline is wall-clock staged; only the reseal waits on `armed`.
      if (s.boring && !s.boreDone) {
        if (reduced) {
          // Static opened planet until the resolver answers, then done.
          s.morphT = s.armed ? 0 : 1;
          s.probeT = 1;
          if (s.armed) {
            s.boreDone = true;
            s.onBoreComplete?.();
          }
        } else {
          const el = now - s.boreStart;
          const open = easeInOut(clamp01((el - BORE_T.openAt) / BORE_T.openDur));
          if (!s.resealing) {
            s.morphT = open;
            const pt = clamp01((el - BORE_T.travelAt) / BORE_T.travelDur);
            // Ease-in-out with a dwell inside the core — the heart of the
            // planet must register as a place, not the fastest stretch.
            // The gaussian pull stays monotonic and preserves endpoints.
            const t = easeInOut(pt);
            const wgt = Math.exp(-Math.pow((pt - 0.5) / 0.22, 2));
            s.probeT = t - (t - 0.5) * 0.68 * wgt;
            if (pt >= 1) s.probeT = 1;
            // Rest at the far rim until the resolver answers.
            if (pt >= 1 && s.armed) {
              if (!s.holdStart) s.holdStart = now;
              if (now - s.holdStart >= BORE_T.hold) {
                s.resealing = true;
                s.resealStart = now;
              }
            }
          } else {
            const rt = clamp01((now - s.resealStart) / BORE_T.resealDur);
            s.morphT = 1 - easeInOut(rt);
            if (rt >= 1) {
              s.morphT = 0;
              s.boreDone = true;
              navigator.vibrate?.(12);
              s.onBoreComplete?.();
            }
          }
        }
        // Boundary crossings flash their circle.
        for (const c of CROSSINGS) {
          if (s.probeT >= c.frac && !s.crossed.has(c.frac)) {
            s.crossed.add(c.frac);
            s.flashes.push({ t: c.r, at: now / 1000 });
          }
        }
      } else if (!s.boring) {
        s.morphT = reduced ? 0 : Math.max(0, s.morphT - dt * 4);
      }
      const morph = s.morphT;

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
          const clip = (p: P, q2: P) => {
            const tt = p.z / (p.z - q2.z);
            return { x: p.x + (q2.x - p.x) * tt, y: p.y + (q2.y - p.y) * tt };
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
      if (wireA > 0.02 || s.boring) {
        // While the planet opens, the shell parts along the chord first —
        // two hemispheres slide apart, then settle into a ghost contour
        // that stays legible over the exposed section until it reseals.
        const openSplit = Math.min(1, morph / 0.3);
        const dissolve = 1 - clamp01((morph - 0.62) / 0.33);
        const splitPx = Math.min(openSplit, dissolve) * 16;
        const halves: readonly (readonly [number, number, number])[] =
          splitPx > 0.4
            ? [[-splitPx, 0, cx + 1], [splitPx, cx - 1, w]]
            : [[0, 0, w]];
        for (const [dx, clipX0, clipX1] of halves) {
          ctx.save();
          if (dx !== 0 || halves.length > 1) {
            ctx.beginPath();
            ctx.rect(clipX0, 0, clipX1 - clipX0, h);
            ctx.clip();
            ctx.translate(dx, 0);
          }
          const ghost =
            s.boring && !s.boreDone && morph > 0.9 ? 0.12 : 0;
          ctx.globalAlpha = Math.max(wireA, splitPx > 0.4 ? 0.3 : 0, ghost);
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

      // Markers. In the opened section they sit at the cut's ends; on the
      // solid planet they track the real surface points and fade at limb.
      const drawMarker = (v: Vec3, kind: "origin" | "anti") => {
        const p = proj(v);
        const face = clamp01((p.z + 0.12) / 0.3);
        if (face <= 0) return;
        ctx.save();
        ctx.globalAlpha = face;
        if (kind === "origin") {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
          ctx.fillStyle = BONE;
          ctx.fill();
          ctx.beginPath();
          ctx.arc(p.x, p.y, 6.5, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(242,238,227,0.5)";
          ctx.lineWidth = 1;
          ctx.stroke();
        } else {
          const t = now / 1000;
          const glow = s.locked && !reduced ? 1 + Math.sin(t * 2.2) * 0.25 : 1;
          const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 16 * glow);
          g.addColorStop(0, `rgba(255,77,0,${s.boring && !s.boreDone ? 0.3 : 0.75})`);
          g.addColorStop(1, "rgba(255,77,0,0)");
          ctx.beginPath();
          ctx.arc(p.x, p.y, 16 * glow, 0, Math.PI * 2);
          ctx.fillStyle = g;
          ctx.fill();
          ctx.beginPath();
          ctx.arc(p.x, p.y, 3.6, 0, Math.PI * 2);
          ctx.fillStyle = ORANGE;
          ctx.fill();
          if (s.locked && !reduced) {
            const ph = (t % 1.8) / 1.8;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 4 + ph * 26, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(255,77,0,${(1 - ph) * 0.45})`;
            ctx.lineWidth = 1.2;
            ctx.stroke();
          }
          if (s.locked) {
            ctx.beginPath();
            ctx.arc(p.x, p.y, 5.5, 0, Math.PI * 2);
            ctx.strokeStyle = PHOSPHOR;
            ctx.globalAlpha = 0.8 * face;
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.globalAlpha = face;
          }
        }
        ctx.restore();
      };

      if (s.origin && s.antipode) {
        if (morph < 0.02) {
          // The chord is the signal path — a diameter, drawn straight
          // through the body between the two surface points.
          const po = proj(s.origin);
          const pa = proj(s.antipode);
          ctx.save();
          ctx.setLineDash([1.5, 5]);
          ctx.strokeStyle = ORANGE;
          ctx.lineWidth = 5;
          ctx.globalAlpha = 0.14;
          ctx.beginPath();
          ctx.moveTo(po.x, po.y);
          ctx.lineTo(pa.x, pa.y);
          ctx.stroke();
          ctx.lineWidth = 1.4;
          ctx.globalAlpha = s.locked ? 0.95 : 0.7;
          ctx.beginPath();
          ctx.moveTo(po.x, po.y);
          ctx.lineTo(pa.x, pa.y);
          ctx.stroke();
          ctx.restore();
          drawMarker(s.origin, "origin");
          drawMarker(s.antipode, "anti");
        } else {
          // Section diagram: fixed endpoints at the cut.
          const top = { x: cx, y: cy - R };
          const bot = { x: cx, y: cy + R };
          ctx.save();
          ctx.beginPath();
          ctx.arc(top.x, top.y, 3, 0, Math.PI * 2);
          ctx.fillStyle = BONE;
          ctx.fill();
          ctx.beginPath();
          ctx.arc(top.x, top.y, 6.5, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(242,238,227,0.5)";
          ctx.lineWidth = 1;
          ctx.stroke();
          const g = ctx.createRadialGradient(bot.x, bot.y, 0, bot.x, bot.y, 16);
          g.addColorStop(0, `rgba(255,77,0,${s.boring && !s.boreDone ? 0.3 : 0.75})`);
          g.addColorStop(1, "rgba(255,77,0,0)");
          ctx.beginPath();
          ctx.arc(bot.x, bot.y, 16, 0, Math.PI * 2);
          ctx.fillStyle = g;
          ctx.fill();
          ctx.beginPath();
          ctx.arc(bot.x, bot.y, 3.6, 0, Math.PI * 2);
          ctx.fillStyle = ORANGE;
          ctx.fill();
          ctx.restore();
        }
      }

      // Depth counter under the disc while boring — depth below the
      // nearest surface, so it falls back to 0 as the probe emerges.
      if (s.boring && s.probeT >= 0 && morph > 0.5) {
        const d = Math.min(s.probeT, 1 - s.probeT);
        const depth = Math.round(d * DIAMETER_KM).toLocaleString("en-US");
        const parts: [string, string][] = [
          ["depth ", "rgba(152,161,184,0.9)"],
          [`${depth} km`, "rgba(242,238,227,0.95)"],
          [` · ${layerAt(s.probeT)}`, "rgba(152,161,184,0.9)"],
        ];
        ctx.font = "11px 'IBM Plex Mono', monospace";
        ctx.textAlign = "left";
        const totalW = parts.reduce((acc, [txt]) => acc + ctx.measureText(txt).width, 0);
        let x0 = cx - totalW / 2;
        // On small windows the disc nearly fills the canvas — clamp the
        // readout inside the bottom edge instead of clipping it.
        const textY = Math.min(cy + R + 26, h - 8);
        for (const [txt, color] of parts) {
          ctx.fillStyle = color;
          ctx.fillText(txt, x0, textY);
          x0 += ctx.measureText(txt).width;
        }
      }

      // In reduced-motion mode, draw once per change then idle. The armed
      // flip re-enters through requestDraw, so a waiting probe can rest here.
      if (reduced) s.dirty = false;
      if (!reduced || s.dirty || s.shots.length || s.pointers.size) {
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
      dead = true;
      cancelAnimationFrame(raf);
      // Unpublish this scheduler before any replacement frame can queue
      // onto the disposed effect.
      state.current.requestDraw = () => {};
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("wheel", onWheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin, antipode, locked]);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}

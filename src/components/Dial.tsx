import { useCallback, useEffect, useRef } from "react";

type Props = {
  count: number; // candidates on the dial
  index: number; // currently tuned detent
  sweeping: boolean; // resolver still searching — needle roams
  live: boolean; // station actually playing — green is earned by audio
  names?: string[]; // candidate names — shown under the needle while dragging
  onSelect: (i: number) => void;
  onPreview?: (i: number) => void; // candidate under the needle, -1 when released
  onMove?: () => void; // called while the needle travels (static sound hook)
  onLock?: () => void; // called when the needle settles on a detent
  label: string; // aria description of the current detent
};

const PAD = 14; // px inside the track

/**
 * The signal band: a horizontal tuner with one detent per candidate station.
 * Drag the needle — detents are magnetic and click as you cross them — or
 * step with arrow keys. Release selects the nearest detent; the needle is a
 * damped spring that glides, overshoots a hair, and settles like a real
 * tuner. Noise speckle density follows needle speed.
 */
export function Dial({ count, index, sweeping, live, names, onSelect, onPreview, onMove, onLock, label }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const st = useRef({
    x: 0,
    v: 0,
    dragging: false,
    dragX: 0,
    lastX: 0,
    w: 0,
    raf: 0,
    seed: Math.random() * 1e4,
    settled: true,
    lastMoveT: 0,
    // latest props for the draw loop
    count,
    index,
    sweeping,
    names,
    speckle: [] as { x: number; y: number; a: number }[],
    magIx: -1, // detent the needle is magnetically snapped to while dragging
    pid: null as number | null, // the one pointer owning the drag
    clickBurst: 0, // staggered detent clicks queued this gesture
    burstT: [] as number[], // their timer ids — cleared on cancel/unmount
    lastT: 0, // frame clock for dt-normalized physics
    acc: 0, // pending seconds for the fixed-substep spring solver
    flashIx: -1, // detent that just locked — flashes its notch
    flashUntil: 0,
    live,
  });
  st.current.count = count;
  st.current.index = index;
  st.current.sweeping = sweeping;
  st.current.live = live;
  st.current.names = names;

  const detentX = useCallback((i: number, w: number) => {
    if (st.current.count <= 1) return w / 2;
    return PAD + (i / (st.current.count - 1)) * (w - PAD * 2);
  }, []);

  const nearestDetent = useCallback(
    (x: number, w: number) => {
      const n = st.current.count;
      if (n <= 1) return 0;
      let best = 0;
      let bd = Infinity;
      for (let i = 0; i < n; i++) {
        const d = Math.abs(detentX(i, w) - x);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      return best;
    },
    [detentX],
  );

  const kick = () => {
    const s = st.current;
    if (s.raf === 0) s.raf = requestAnimationFrame(tickRef.current);
  };

  const tickRef = useRef<(t: number) => void>(() => {});
  tickRef.current = (now: number) => {
    const s = st.current;
    const canvas = canvasRef.current;
    if (!canvas) {
      s.raf = 0;
      return;
    }
    const ctx = canvas.getContext("2d")!;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(rect.width * dpr)) {
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = rect.width;
    const h = rect.height;
    s.w = w;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Normalize per-frame factors to elapsed time so the spring settles
    // identically at 30/60/120Hz.
    const dt = s.lastT ? Math.min(3, (now - s.lastT) / 16.667) : 1;
    s.lastT = now;

    // Needle physics.
    let target: number;
    if (s.sweeping && !s.dragging) {
      // Roaming search: slow ping-pong across the band. Under reduced
      // motion the needle sits mid-band and the label carries the state.
      target = reduced ? w / 2 : w / 2 + Math.sin(now / 640) * (w / 2 - PAD - 4);
    } else if (s.dragging) {
      target = s.dragX;
    } else {
      target = detentX(s.index, w);
    }
    if (s.x === 0) s.x = target;
    if (reduced) {
      s.v = 0;
      s.x = target; // no travel under reduced motion — snap into place
    } else if (s.dragging || s.sweeping) {
      s.v = 0;
      s.x += (target - s.x) * Math.min(1, (s.sweeping ? 0.06 : 0.5) * dt);
    } else {
      // Damped spring on fixed 1/120s substeps — the same glide and hair
      // of overshoot at every refresh rate, not a per-frame approximation
      // whose overshoot drifts with dt. dt is in 60fps-frame units, so
      // dt/60 is the pending time in seconds (capped against tab stalls).
      s.acc = Math.min(0.1, s.acc + dt / 60);
      while (s.acc >= 1 / 120) {
        s.v += (target - s.x) * 0.08;
        s.v *= 0.883;
        s.x += s.v * 0.5;
        s.acc -= 1 / 120;
      }
    }
    const speed = Math.abs(target - s.x) + Math.abs(s.v);
    const wasSettled = s.settled;
    s.settled = speed < 0.6;
    if (!s.settled && now - s.lastMoveT > 90) {
      s.lastMoveT = now;
      onMove?.();
    }
    if (!wasSettled && s.settled && !s.sweeping && !s.dragging) {
      s.flashIx = s.index;
      s.flashUntil = now + 320;
      onLock?.();
      navigator.vibrate?.(8);
    }

    // Paint.
    ctx.clearRect(0, 0, w, h);
    const top = 14;
    const bot = h - 14;

    // Track.
    ctx.strokeStyle = "rgba(242,238,227,0.16)";
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, top + 0.5, w - 1, bot - top - 1);

    // Static speckle, density follows needle speed.
    const density = s.dragging || !s.settled ? Math.min(160, 14 + speed * 3) : s.sweeping ? 60 : 10;
    if (!reduced || s.settled) {
      for (let i = 0; i < density; i++) {
        ctx.fillStyle = `rgba(242,238,227,${Math.random() * 0.16})`;
        ctx.fillRect(Math.random() * w, top + 1 + Math.random() * (bot - top - 2), 1, 1);
      }
    }

    // Detents. Phosphor is earned by audible playback only — a selected
    // but still-connecting detent stays warm.
    for (let i = 0; i < s.count; i++) {
      const x = detentX(i, w);
      const cur = i === s.index;
      // A detent that just locked flashes its notch — the landing is
      // visible, not only audible.
      if (i === s.flashIx && now < s.flashUntil) {
        const f = (s.flashUntil - now) / 320;
        ctx.fillStyle = `rgba(124,255,178,${0.3 * f})`;
        ctx.fillRect(x - 4, top + 1, 8, bot - top - 2);
      }
      ctx.strokeStyle = cur
        ? s.live
          ? "rgba(124,255,178,0.75)"
          : "rgba(255,122,40,0.85)"
        : "rgba(242,238,227,0.32)";
      ctx.lineWidth = cur ? 1.2 : 0.8;
      ctx.beginPath();
      ctx.moveTo(x, top + (cur ? 3 : 7));
      ctx.lineTo(x, bot - (cur ? 3 : 7));
      ctx.stroke();
    }

    // Needle with travel trail and a grip tab — the finger has something
    // to hold, not just a line to chase.
    if (s.x > 0) {
      const dir = s.v > 0 ? -1 : 1;
      const trailLen = Math.min(70, Math.abs(s.v) * 18 + (s.dragging ? 26 : 0));
      if (trailLen > 2) {
        const g = ctx.createLinearGradient(s.x + dir * trailLen, 0, s.x, 0);
        g.addColorStop(0, "rgba(242,238,227,0)");
        g.addColorStop(1, "rgba(242,238,227,0.22)");
        ctx.fillStyle = g;
        ctx.fillRect(Math.min(s.x + dir * trailLen, s.x), top + 1, trailLen, bot - top - 2);
      }
      const locked = s.settled && !s.sweeping;
      // Green means audible signal — a settled selection that is still
      // connecting stays bone until playback actually starts.
      ctx.fillStyle = locked && s.live ? "rgba(124,255,178,0.95)" : "rgba(242,238,227,0.9)";
      ctx.fillRect(s.x - 1, top - 3, 2, bot - top + 3);
      if (locked && s.live) {
        ctx.fillStyle = "rgba(124,255,178,0.25)";
        ctx.fillRect(s.x - 4, top + 1, 8, bot - top - 2);
      }
      // The grip: a knurled thumb riding the track's lower edge — wide
      // enough to read as the thing you hold, not a tick you chase.
      const gy = bot + 1;
      ctx.beginPath();
      ctx.roundRect(s.x - 13, gy, 26, 13, 3);
      ctx.fillStyle = s.dragging
        ? "rgba(242,238,227,0.34)"
        : "rgba(242,238,227,0.14)";
      ctx.fill();
      ctx.strokeStyle = s.dragging
        ? "rgba(242,238,227,0.95)"
        : "rgba(242,238,227,0.5)";
      ctx.lineWidth = 1;
      ctx.stroke();
      for (const dx of [-6, 0, 6]) {
        ctx.beginPath();
        ctx.moveTo(s.x + dx, gy + 3.5);
        ctx.lineTo(s.x + dx, gy + 9.5);
        ctx.stroke();
      }
    }

    // While dragging, the name under the needle is the preview — you hear
    // it before you commit to it.
    const names = s.names;
    if (s.dragging && names && names.length) {
      const i = s.magIx >= 0 ? s.magIx : nearestDetent(s.dragX, w);
      const nm = names[i];
      if (nm) {
        ctx.font = "12px 'IBM Plex Mono', monospace";
        ctx.textBaseline = "top";
        ctx.textAlign = "center";
        ctx.fillStyle = "rgba(242,238,227,0.9)";
        const tx = Math.min(Math.max(s.x, 84), w - 84);
        ctx.fillText(
          `${i + 1}/${s.count} · ${nm.length > 22 ? nm.slice(0, 21) + "…" : nm}`,
          tx,
          1,
        );
      }
    }

    // Chrome text — the detent readout; the step keys carry the how-to.
    ctx.font = "11px 'IBM Plex Mono', monospace";
    ctx.textBaseline = "top";
    ctx.fillStyle = "rgba(152,161,184,0.9)";
    ctx.textAlign = "left";
    ctx.fillText(
      s.sweeping ? "SWEEPING THE BAND…" : `STATION ${s.index + 1} OF ${s.count}`,
      6,
      2,
    );

    // Keep animating while anything moves; once settled this frame is
    // final. Reduced motion never holds a live loop — even mid-sweep.
    if (!reduced && (!s.settled || s.dragging || s.sweeping)) {
      s.raf = requestAnimationFrame(tickRef.current);
    } else {
      s.raf = 0;
    }
  };

  // React to prop/index changes by waking the loop — `live` included, or
  // a settled needle would keep its stale color after play/pause.
  useEffect(() => {
    kick();
  }, [index, count, sweeping, live]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ro = new ResizeObserver(() => kick());
    ro.observe(canvas);
    kick();
    return () => {
      cancelAnimationFrame(st.current.raf);
      st.current.raf = 0; // a cancelled id must not look "running" to kick()
      ro.disconnect();
      for (const t of st.current.burstT) window.clearTimeout(t);
      st.current.burstT = [];
    };
  }, []);

  const posFromEvent = (e: React.PointerEvent | PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return Math.min(r.width, Math.max(0, e.clientX - r.left));
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (count < 1 || st.current.pid !== null) return; // one active pointer
    const s = st.current;
    s.pid = e.pointerId;
    s.dragging = true;
    s.dragX = posFromEvent(e);
    s.lastX = s.dragX;
    s.clickBurst = 0;
    canvasRef.current!.setPointerCapture(e.pointerId);
    kick();
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const s = st.current;
    if (!s.dragging || e.pointerId !== s.pid) return;
    let x = posFromEvent(e);
    // Magnetism with hysteresis: snapped until 7px away, re-engages at 4,
    // so hovering near a detent doesn't chatter.
    if (s.magIx >= 0 && Math.abs(x - detentX(s.magIx, s.w)) <= 7) {
      x = detentX(s.magIx, s.w);
    } else {
      const near = nearestDetent(x, s.w);
      if (Math.abs(detentX(near, s.w) - x) <= 4) {
        x = detentX(near, s.w);
        if (near !== s.magIx) {
          s.magIx = near;
          onPreview?.(near);
          onLock?.();
        }
      } else {
        if (s.magIx !== -1) onPreview?.(-1);
        s.magIx = -1;
      }
    }
    // Fast drags may jump over detents between events — each crossing
    // still earns its click, staggered so it reads as a sequence.
    const lo = Math.min(s.lastX, x);
    const hi = Math.max(s.lastX, x);
    for (let i = 0; i < s.count; i++) {
      const dx = detentX(i, s.w);
      if (dx > lo && dx <= hi && i !== s.magIx && s.clickBurst < 5) {
        const delay = s.clickBurst++ * 40;
        s.burstT.push(
          window.setTimeout(() => {
            s.burstT.shift();
            if (s.dragging) onLock?.();
          }, delay),
        );
      }
    }
    s.lastX = x;
    s.dragX = x;
    kick(); // reduced motion still repaints each move — no live loop
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const s = st.current;
    if (!s.dragging || e.pointerId !== s.pid) return;
    s.dragging = false;
    s.pid = null;
    s.magIx = -1;
    s.clickBurst = 0;
    onPreview?.(-1);
    const i = nearestDetent(s.dragX, s.w);
    if (i !== index) onSelect(i);
    kick();
  };
  // A cancelled gesture restores the tuned detent instead of retuning.
  const onPointerCancel = () => {
    const s = st.current;
    if (!s.dragging) return;
    s.dragging = false;
    s.pid = null;
    s.magIx = -1;
    s.clickBurst = 0;
    onPreview?.(-1);
    for (const t of s.burstT) window.clearTimeout(t);
    s.burstT = [];
    kick();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const s = st.current;
    // Keys retune and let the spring carry the needle — a press glides
    // to its detent instead of teleporting.
    const snap = (i: number) => {
      if (s.w > 0) s.v = 0; // start the glide clean, no stale velocity
      onSelect(i);
    };
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      e.preventDefault();
      if (index > 0) snap(index - 1);
    } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      e.preventDefault();
      if (index < count - 1) snap(index + 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      snap(0);
    } else if (e.key === "End") {
      e.preventDefault();
      snap(count - 1);
    }
  };

  return (
    <div
      ref={wrapRef}
      className="dial"
      role="slider"
      tabIndex={count > 0 ? 0 : -1}
      aria-label="Signal dial"
      aria-valuemin={1}
      aria-valuemax={Math.max(1, count)}
      aria-valuenow={index + 1}
      aria-valuetext={label}
      onKeyDown={onKeyDown}
    >
      <canvas
        ref={canvasRef}
        className="dial-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      />
    </div>
  );
}

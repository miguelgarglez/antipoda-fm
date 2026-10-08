import { useCallback, useEffect, useRef } from "react";

type Props = {
  count: number; // candidates on the dial
  index: number; // currently tuned detent
  sweeping: boolean; // resolver still searching — needle roams
  onSelect: (i: number) => void;
  onMove?: () => void; // called while the needle travels (static sound hook)
  onLock?: () => void; // called when the needle settles on a detent
  label: string; // aria description of the current detent
};

const PAD = 14; // px inside the track

/**
 * The signal band: a horizontal tuner with one detent per candidate station.
 * Drag the needle, flick it, click a detent, or use arrow keys. The needle is
 * a damped spring — it glides, overshoots a hair, and settles like a real
 * tuner. Noise speckle density follows needle speed.
 */
export function Dial({ count, index, sweeping, onSelect, onMove, onLock, label }: Props) {
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
    speckle: [] as { x: number; y: number; a: number }[],
    magIx: -1, // detent the needle is magnetically snapped to while dragging
  });
  st.current.count = count;
  st.current.index = index;
  st.current.sweeping = sweeping;

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
      s.x += (target - s.x) * (s.sweeping ? 0.06 : 0.5);
    } else {
      // Damped spring — glide with a hair of overshoot.
      const k = 0.16;
      s.v += (target - s.x) * k;
      s.v *= 0.78;
      s.x += s.v;
    }
    const speed = Math.abs(target - s.x) + Math.abs(s.v);
    const wasSettled = s.settled;
    s.settled = speed < 0.6;
    if (!s.settled && now - s.lastMoveT > 90) {
      s.lastMoveT = now;
      onMove?.();
    }
    if (!wasSettled && s.settled && !s.sweeping && !s.dragging) {
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

    // Detents.
    for (let i = 0; i < s.count; i++) {
      const x = detentX(i, w);
      const cur = i === s.index;
      ctx.strokeStyle = cur ? "rgba(124,255,178,0.75)" : "rgba(242,238,227,0.32)";
      ctx.lineWidth = cur ? 1.2 : 0.8;
      ctx.beginPath();
      ctx.moveTo(x, top + (cur ? 3 : 7));
      ctx.lineTo(x, bot - (cur ? 3 : 7));
      ctx.stroke();
    }

    // Needle with travel trail.
    if (s.x > 0) {
      const dir = s.v > 0 ? -1 : 1;
      const trailLen = Math.min(70, Math.abs(s.v) * 18 + (s.dragging ? 26 : 0));
      if (trailLen > 2) {
        const g = ctx.createLinearGradient(s.x + dir * trailLen, 0, s.x, 0);
        g.addColorStop(0, "rgba(255,77,0,0)");
        g.addColorStop(1, "rgba(255,77,0,0.45)");
        ctx.fillStyle = g;
        ctx.fillRect(Math.min(s.x + dir * trailLen, s.x), top + 1, trailLen, bot - top - 2);
      }
      const locked = s.settled && !s.sweeping;
      ctx.fillStyle = locked ? "rgba(124,255,178,0.95)" : "#FF4D00";
      ctx.fillRect(s.x - 1, top - 3, 2, bot - top + 6);
      if (locked) {
        ctx.fillStyle = "rgba(124,255,178,0.25)";
        ctx.fillRect(s.x - 4, top + 1, 8, bot - top - 2);
      }
    }

    // Chrome text.
    ctx.font = "9px 'IBM Plex Mono', monospace";
    ctx.textBaseline = "top";
    ctx.fillStyle = "rgba(152,161,184,0.85)";
    ctx.textAlign = "left";
    ctx.fillText(s.sweeping ? "SWEEPING THE BAND…" : `SIG ${s.index + 1}/${s.count}`, 2, 2);
    ctx.textAlign = "right";
    ctx.fillText("DRAG TO TUNE", w - 2, 2);

    // Keep animating while anything moves; once settled this frame is
    // final. Reduced motion never holds a live loop — even mid-sweep.
    if (!reduced && (!s.settled || s.dragging || s.sweeping)) {
      s.raf = requestAnimationFrame(tickRef.current);
    } else {
      s.raf = 0;
    }
  };

  // React to prop/index changes by waking the loop.
  useEffect(() => {
    kick();
  }, [index, count, sweeping]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ro = new ResizeObserver(() => kick());
    ro.observe(canvas);
    kick();
    return () => {
      cancelAnimationFrame(st.current.raf);
      st.current.raf = 0; // a cancelled id must not look "running" to kick()
      ro.disconnect();
    };
  }, []);

  const posFromEvent = (e: React.PointerEvent | PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return Math.min(r.width, Math.max(0, e.clientX - r.left));
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (count < 1) return;
    const s = st.current;
    s.dragging = true;
    s.dragX = posFromEvent(e);
    canvasRef.current!.setPointerCapture(e.pointerId);
    kick();
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const s = st.current;
    if (!s.dragging) return;
    let x = posFromEvent(e);
    // Detents are magnetic: inside 4px the needle snaps, and each fresh
    // detent gives a quiet click so the band feels segmented.
    const near = nearestDetent(x, s.w);
    if (Math.abs(detentX(near, s.w) - x) <= 4) {
      x = detentX(near, s.w);
      if (near !== s.magIx) {
        s.magIx = near;
        onLock?.();
      }
    } else {
      s.magIx = -1;
    }
    s.dragX = x;
  };
  const onPointerUp = () => {
    const s = st.current;
    if (!s.dragging) return;
    s.dragging = false;
    s.magIx = -1;
    const i = nearestDetent(s.dragX, s.w);
    if (i !== index) onSelect(i);
    kick();
  };
  // A cancelled gesture restores the tuned detent instead of retuning.
  const onPointerCancel = () => {
    const s = st.current;
    if (!s.dragging) return;
    s.dragging = false;
    s.magIx = -1;
    kick();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      e.preventDefault();
      if (index > 0) onSelect(index - 1);
    } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      e.preventDefault();
      if (index < count - 1) onSelect(index + 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      onSelect(0);
    } else if (e.key === "End") {
      e.preventDefault();
      onSelect(count - 1);
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

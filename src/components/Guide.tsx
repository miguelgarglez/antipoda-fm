import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const KEY = "antipoda.guide.v2";

export function guideSeen(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return true; // storage blocked — don't nag every visit
  }
}

export function markGuideSeen() {
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    /* private mode — guide simply won't persist */
  }
}

type Step = {
  sel: string;
  text: string;
  /** ms before the step gives up quietly — dismissal, not advancement */
  timeout: number;
  onlyPhase?: string;
  /** place the tip above the target when what sits below are controls */
  above?: boolean;
  /** anchor inside the target's bottom edge — a callout on the thing itself */
  inside?: boolean;
  /** clear this sibling's bottom edge too when placing below the target */
  belowAfter?: string;
  /** ring the planet with two curved marks on its limb, not a rectangle */
  ring?: "rect" | "arc";
  /** render as a slim row inside .dial-lesson-slot instead of a floating card */
  inline?: boolean;
};

const coarse =
  typeof window !== "undefined" &&
  window.matchMedia("(pointer: coarse)").matches;

const STEPS: Step[] = [
  {
    // The arcs must hug the planet's window — the .stage box now carries
    // a header strip and captions, so measuring it rings empty air.
    sel: "canvas.globe",
    text: coarse
      ? "The planet is a body — drag to turn, pinch to zoom."
      : "The planet is a body — drag to turn, scroll to approach.",
    timeout: 12000,
    onlyPhase: "idle",
    inside: true, // below the stage sits its own caption; above it is header
    ring: "arc",
  },
  {
    sel: ".actions",
    text: "Name a place, or press the orange key — the planet will open.",
    timeout: 15000,
    onlyPhase: "idle",
    belowAfter: ".quick", // the place links are this step's controls — clear them
  },
  {
    sel: ".dial",
    text: "Each notch is another station — drag to listen.",
    timeout: 14000,
    onlyPhase: "tuned",
    inline: true, // in-flow above the dial — never floats over the transport
  },
];

type Props = {
  phase: string;
  globeTouched: boolean;
  dialTouched: boolean;
  /** learned=false means the guide bowed out unseen — keep the quiet hint */
  onDone: (learned: boolean) => void;
};

/**
 * First-run guide: two or three contextual steps on the real UI. Each step
 * marks one control and waits for the visitor to do the thing — a grab, a
 * tune, a dial drag. A step that times out collapses the guide back to the
 * quiet "drag to turn" hint rather than marching on by itself. Skippable,
 * remembered in localStorage, replayable from the "?" in the header.
 */
export function Guide({ phase, globeTouched, dialTouched, onDone }: Props) {
  const [ix, setIx] = useState(0);
  // A beat of quiet before the full lesson appears — the planet alone is
  // the first impression; a small "drag to turn" pill bridges the wait.
  const [booted, setBooted] = useState(false);
  // The tracked rect is tagged with the step it was measured for — without
  // the tag a step change reads the old target's rect for one frame and a
  // hidden step's leash timer would arm anyway.
  const [view, setView] = useState<{ ix: number; x: number; y: number; w: number; h: number } | null>(
    null,
  );
  const done = useRef(false);
  const tipRef = useRef<HTMLDivElement>(null);
  const learnedRef = useRef(false);
  learnedRef.current = globeTouched || ix > 0;
  // Dismissals dissolve in place — the in-flow dial row keeps its box for
  // the session, but a hard unmount mid-gesture would still steal the
  // ring around the tuner's edge.
  const [fading, setFading] = useState(false);

  const dismiss = (learned: boolean) => {
    if (done.current || fading) return;
    setFading(true);
    markGuideSeen();
    window.setTimeout(() => {
      done.current = true;
      onDone(learned);
    }, 520);
  };
  const finish = () => dismiss(true); // opted out or completed — kill the hint
  // A timeout is dismissal, not failure — the hint survives only if the
  // visitor genuinely never touched the planet.
  const bowOut = () => dismiss(learnedRef.current);

  // Absolute leash: however the steps stall (an idle visitor, a target
  // that never appears), the guide bows out within a minute.
  useEffect(() => {
    const t = setTimeout(bowOut, 60_000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The full lesson holds back for a breath — first the mini annotation.
  useEffect(() => {
    const t = setTimeout(() => setBooted(true), 1500);
    return () => clearTimeout(t);
  }, []);

  // The real actions advance the guide. A completed tune while the guide
  // was still on an early step jumps straight to the dial lesson.
  useEffect(() => {
    if (dialTouched) finish();
    else if (phase === "tuned" && ix < 2) setIx(2);
    else if (phase !== "idle" && ix < 2) setIx(2); // tuning/failed — dial step waits for its target
    else if (globeTouched && ix === 0) setIx(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, globeTouched, dialTouched, ix]);

  // Per-step leash: if the visitor just watches, the guide collapses to
  // the quiet hint — it never advances on a clock alone. The clock runs
  // only while the step's target is actually on screen.
  const rect = view && view.ix === ix ? view : null;
  const visible = rect !== null;
  useEffect(() => {
    if (done.current || !visible || !booted) return;
    const t = setTimeout(bowOut, STEPS[ix].timeout);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ix, visible, booted]);

  // Track the target rect every frame — the stage resizes between phases.
  useEffect(() => {
    if (done.current) return;
    let raf = 0;
    const tick = () => {
      const step = STEPS[ix];
      const el = step ? document.querySelector(step.sel) : null;
      if (el && (!step.onlyPhase || step.onlyPhase === phase)) {
        const r = el.getBoundingClientRect();
        setView({ ix, x: r.left, y: r.top, w: r.width, h: r.height });
      } else {
        setView(null);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ix, phase]);

  if (done.current) return null;

  // The bridging annotation: a small pill inside the stage's lower edge.
  if (!booted) {
    return rect ? (
      <div
        className="guide-mini"
        style={{ left: rect.x + rect.w / 2, top: rect.y + rect.h - 30 }}
      >
        drag to turn
      </div>
    ) : null;
  }

  const step = STEPS[ix];
  if (!step) return null;

  const pad = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const tipW = Math.min(260, vw - 32);
  // Measure the real card height after mount — an estimate strands the
  // flip logic when the copy wraps differently on narrow screens.
  const tipH = tipRef.current?.getBoundingClientRect().height || 112;
  const tipX = rect ? clamp(rect.x + rect.w / 2 - tipW / 2, 12, vw - tipW - 12) : vw / 2 - tipW / 2;
  // Prefer below the target; flip above when the bottom edge is tight or
  // the step marks its underside as controls (the dial's transport row).
  let below = rect ? rect.y + rect.h + 14 : vh / 2;
  if (rect && step.belowAfter) {
    const sib = document.querySelector(step.belowAfter);
    if (sib) below = Math.max(below, sib.getBoundingClientRect().bottom + 14);
  }
  const tipY = !rect
    ? vh / 2
    : step.inside && vw > 720 // inside-bottom reads as a callout on the planet — on small stages it would cover it
      ? Math.max(12, rect.y + rect.h - tipH - 10)
      : step.above || below + tipH >= vh
        ? Math.max(12, rect.y - 14 - tipH)
        : below;

  const slot = step.inline ? document.querySelector(".dial-lesson-slot") : null;
  // Small screens: the opening lesson flows between the planet and the
  // headline — a floating tip would cover one or the other.
  const introSlot =
    ix === 0 && vw <= 720 && !step.inline
      ? document.querySelector(".guide-intro-slot")
      : null;
  const rowSlot = slot || introSlot;

  return (
    <div className={`guide${fading ? " fading" : ""}`}>
      {rect && step.ring === "arc" ? (
        <GuideArc rect={rect} />
      ) : (
        rect && (
          <div
            className="guide-ring"
            style={{
              left: rect.x - pad,
              top: rect.y - pad,
              width: rect.w + pad * 2,
              height: rect.h + pad * 2,
            }}
          />
        )
      )}
      {rect && rowSlot ? (
        createPortal(
          <div className={`guide-row${fading ? " fading" : ""}`} role="status">
            <span className="guide-row-dot" aria-hidden="true" />
            <p>{step.text}</p>
            <button className="guide-skip" onClick={finish}>
              skip
            </button>
          </div>,
          rowSlot,
        )
      ) : (
        rect && (
          <div
            ref={tipRef}
            className="guide-tip"
            style={{ left: tipX, top: tipY, width: tipW }}
            role="status"
          >
            <span className="guide-step">step {ix + 1} of {STEPS.length}</span>
            <p>{step.text}</p>
            <button className="guide-skip" onClick={finish}>
              skip
            </button>
          </div>
        )
      )}
      {!rect && (
        <button className="guide-skip guide-skip-floating" onClick={finish}>
          skip intro
        </button>
      )}
    </div>
  );
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * Two curved marks on the planet's limb — a ring that belongs to a body,
 * not a dashed rectangle around a UI region. The planet renders at 0.4×
 * the stage's short side at idle zoom, so the arcs hug the disc itself
 * plus a breath of clearance; the chevrons read as rotation.
 */
function GuideArc({ rect }: { rect: { x: number; y: number; w: number; h: number } }) {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const r = Math.min(rect.w, rect.h) * 0.4 + 14;
  const arc = (a0: number, a1: number) => {
    const p = (a: number) => `${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)}`;
    return `M ${p(a0)} A ${r} ${r} 0 0 1 ${p(a1)}`;
  };
  return (
    <svg className="guide-arc" style={{ left: 0, top: 0 }}>
      <path d={arc(-0.95, 0.45)} className="guide-arc-path" />
      <path d={arc(Math.PI - 0.95, Math.PI + 0.45)} className="guide-arc-path" />
      {/* chevrons on each limb point along the spin direction */}
      <g transform={`translate(${cx}, ${cy - r - 2})`}>
        <path d="M -6 3 L 0 -3 L 6 3" className="guide-arc-chev" />
      </g>
      <g transform={`translate(${cx}, ${cy + r + 2}) rotate(180)`}>
        <path d="M -6 3 L 0 -3 L 6 3" className="guide-arc-chev" />
      </g>
    </svg>
  );
}

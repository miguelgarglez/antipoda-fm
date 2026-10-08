import { useEffect, useRef, useState } from "react";

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
  /** ms before the step lets go on its own — the guide never traps */
  timeout: number;
  onlyPhase?: string;
  /** place the tip above the target when what sits below are controls */
  above?: boolean;
  /** anchor inside the target's bottom edge — a callout on the thing itself */
  inside?: boolean;
  /** clear this sibling's bottom edge too when placing below the target */
  belowAfter?: string;
};

const STEPS: Step[] = [
  {
    sel: ".stage",
    text: "The planet is a body. Grab it, spin it — scroll or pinch to zoom.",
    timeout: 12000,
    onlyPhase: "idle",
    inside: true, // below the stage sits its own caption; above it is header
  },
  {
    sel: ".actions",
    text: "Name a place, or press the orange key — the planet will open.",
    timeout: 15000,
    onlyPhase: "idle",
    belowAfter: ".quick", // the chips are this step's controls — clear them
  },
  {
    sel: ".dial",
    text: "Every notch is a live signal near your antipode. Drag the needle.",
    timeout: 12000,
    onlyPhase: "tuned",
    above: true, // the transport row below the dial is the app's controls
  },
];

type Props = {
  phase: string;
  globeTouched: boolean;
  dialTouched: boolean;
  onDone: () => void;
};

/**
 * First-run guide: two or three contextual steps on the real UI. Each step
 * rings one control and waits for the visitor to do the thing — a grab, a
 * tune, a dial drag — or lets go on its own after a few seconds. Skippable,
 * remembered in localStorage, replayable from the "?" in the header.
 */
export function Guide({ phase, globeTouched, dialTouched, onDone }: Props) {
  const [ix, setIx] = useState(0);
  // The tracked rect is tagged with the step it was measured for — without
  // the tag a step change reads the old target's rect for one frame and a
  // hidden step's leash timer would arm anyway.
  const [view, setView] = useState<{ ix: number; x: number; y: number; w: number; h: number } | null>(
    null,
  );
  const done = useRef(false);

  const finish = () => {
    if (done.current) return;
    done.current = true;
    markGuideSeen();
    onDone();
  };

  // Absolute leash: however the steps stall (an idle visitor, a target
  // that never appears), the guide bows out within a minute.
  useEffect(() => {
    const t = setTimeout(finish, 60_000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Per-step leash: if the visitor just watches, the step bows out. The
  // clock runs only while the step's target is actually on screen — a
  // step waiting for a phase (the dial needs "tuned") stays patient.
  const rect = view && view.ix === ix ? view : null;
  const visible = rect !== null;
  useEffect(() => {
    if (done.current || !visible) return;
    const t = setTimeout(() => {
      if (ix >= STEPS.length - 1) finish();
      else setIx(ix + 1);
    }, STEPS[ix].timeout);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ix, visible]);

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
  const step = STEPS[ix];
  if (!step) return null;

  const pad = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const tipW = Math.min(260, vw - 32);
  const tipH = 118; // tip content height — measured generously
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
    : step.inside
      ? Math.max(12, rect.y + rect.h - tipH - 10)
      : step.above || below + tipH >= vh
        ? Math.max(12, rect.y - 14 - tipH)
        : below;

  return (
    <div className="guide">
      {rect && (
        <div
          className="guide-ring"
          style={{
            left: rect.x - pad,
            top: rect.y - pad,
            width: rect.w + pad * 2,
            height: rect.h + pad * 2,
          }}
        />
      )}
      {rect && (
        <div className="guide-tip" style={{ left: tipX, top: tipY, width: tipW }} role="status">
          <span className="guide-step">step {ix + 1} of {STEPS.length}</span>
          <p>{step.text}</p>
          <button className="guide-skip" onClick={finish}>
            skip
          </button>
        </div>
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

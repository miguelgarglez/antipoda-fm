// Earth rendered as a bore cross-section: the globe disc opens into mantle,
// outer core and inner core while the signal travels the chord. All
// boundaries are the real depths, mapped onto the diameter.

export const DIAMETER_KM = 12742;

// Fractions of the chord travelled (0 = origin surface, 1 = antipode).
export const BOUNDS = {
  crust: 35 / DIAMETER_KM, // ~0.003
  mantleCore: 2890 / DIAMETER_KM, // ~0.227
  outerInner: 5150 / DIAMETER_KM, // ~0.404
};

export function layerAt(t: number): string {
  const d = t <= 0.5 ? t : 1 - t;
  if (d < BOUNDS.crust) return "crust";
  if (d < BOUNDS.mantleCore) return "mantle";
  if (d < BOUNDS.outerInner) return "outer core";
  return "inner core";
}

export function drawSection(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  R: number,
  opts: {
    probe: number; // 0..1 travel origin -> antipode; <0 hides the probe
    beamAlpha: number;
    flashes: { t: number; at: number }[]; // boundary-crossing pulses
    t: number; // seconds, for the molten breathe
    exitFlash?: number; // 0..1 while the probe's exit flare burns, else -1
  },
) {
  const { probe, beamAlpha, flashes, t, exitFlash = -1 } = opts;
  const breathe = 1 + Math.sin(t * 1.4) * 0.012;

  // Mantle fill: dark warm gradient out to the rim.
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.995, 0, Math.PI * 2);
  const mantle = ctx.createRadialGradient(cx, cy, R * 0.18, cx, cy, R);
  mantle.addColorStop(0, "rgba(255,90,20,0.20)");
  mantle.addColorStop(0.65, "rgba(120,44,14,0.16)");
  mantle.addColorStop(1, "rgba(242,238,227,0.045)");
  ctx.fillStyle = mantle;
  ctx.fill();

  // Outer core: molten disc.
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.546 * breathe, 0, Math.PI * 2);
  const outer = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.546 * breathe);
  outer.addColorStop(0, "rgba(255,150,70,0.62)");
  outer.addColorStop(0.72, "rgba(255,77,0,0.34)");
  outer.addColorStop(1, "rgba(255,77,0,0.10)");
  ctx.fillStyle = outer;
  ctx.fill();

  // Inner core: the hot heart — kept dim enough that the travelling probe
  // is always the brightest thing on the plate.
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.192 * breathe, 0, Math.PI * 2);
  const inner = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.192 * breathe);
  inner.addColorStop(0, "rgba(255,224,190,0.65)");
  inner.addColorStop(0.55, "rgba(255,96,20,0.85)");
  inner.addColorStop(1, "rgba(255,77,0,0.04)");
  ctx.fillStyle = inner;
  ctx.fill();

  // Boundaries.
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(242,238,227,0.22)";
  ctx.beginPath(); ctx.arc(cx, cy, R * 0.546, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = "rgba(242,238,227,0.30)";
  ctx.beginPath(); ctx.arc(cx, cy, R * 0.192, 0, Math.PI * 2); ctx.stroke();

  // Boundary-crossing flashes: a ring pulse at the crossed boundary.
  // Entries with t<0 are chord pulses the caller draws itself.
  for (const f of flashes) {
    if (f.t < 0) continue;
    const age = (t - f.at) / 0.7;
    if (age < 0 || age > 1) continue;
    ctx.beginPath();
    ctx.arc(cx, cy, f.t * R, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,140,60,${(1 - age) * 0.5})`;
    ctx.lineWidth = 1.5 * (1 - age);
    ctx.stroke();
  }

  // The shell itself: a solid crust band around the molten interior —
  // the plate reads as a sliced body with thickness, not a diagram.
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.arc(cx, cy, R * 0.962, 0, Math.PI * 2, true);
  ctx.fillStyle = "rgba(46,30,22,0.92)";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.962, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255,120,50,0.30)";
  ctx.lineWidth = 1;
  ctx.stroke();

  // Crust rim.
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(242,238,227,0.55)";
  ctx.lineWidth = 1.4;
  ctx.stroke();

  // The beam.
  if (beamAlpha > 0) {
    ctx.save();
    ctx.globalAlpha = beamAlpha;
    ctx.strokeStyle = "rgba(255,77,0,0.9)";
    ctx.lineWidth = 1.2;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(cx, cy - R);
    ctx.lineTo(cx, cy + R);
    ctx.stroke();
    ctx.restore();
  }

  // The probe: a hot point + comet tail. Warm through the journey —
  // phosphor green is reserved for actual playback lock.
  if (probe >= 0) {
    const py = cy - R + probe * 2 * R;
    // The bore lights its host layer, not the whole plate: a glow clipped
    // to the annulus the probe is actually inside.
    const band: Record<string, [number, number]> = {
      crust: [0.962, 1],
      mantle: [0.546, 0.962],
      "outer core": [0.192, 0.546],
      "inner core": [0, 0.192],
    };
    const [rIn, rOut] = band[layerAt(probe)];
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, rOut * R, 0, Math.PI * 2);
    if (rIn > 0) ctx.arc(cx, cy, rIn * R, 0, Math.PI * 2, true);
    ctx.clip();
    const wash = ctx.createRadialGradient(cx, py, 0, cx, py, R * 0.4);
    wash.addColorStop(0, "rgba(255,190,120,0.42)");
    wash.addColorStop(0.5, "rgba(255,120,40,0.16)");
    wash.addColorStop(1, "rgba(255,120,40,0)");
    ctx.fillStyle = wash;
    ctx.fillRect(cx - R, cy - R, 2 * R, 2 * R);
    ctx.restore();
    const tail = ctx.createLinearGradient(cx, py - 42, cx, py);
    tail.addColorStop(0, "rgba(255,77,0,0)");
    tail.addColorStop(1, "rgba(255,77,0,0.85)");
    ctx.strokeStyle = tail;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, py - 42);
    ctx.lineTo(cx, py);
    ctx.stroke();
    const g = ctx.createRadialGradient(cx, py, 0, cx, py, 11);
    g.addColorStop(0, "rgba(255,240,222,0.95)");
    g.addColorStop(0.4, "rgba(255,122,40,0.8)");
    g.addColorStop(1, "rgba(255,77,0,0)");
    ctx.beginPath();
    ctx.arc(cx, py, 11, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, py, 2.4, 0, Math.PI * 2);
    ctx.fillStyle = "#fff1e0";
    ctx.fill();
  }

  // Exit flare: 120ms of bone-white light where the probe punches out.
  if (exitFlash >= 0) {
    const g = ctx.createRadialGradient(cx, cy + R, 0, cx, cy + R, 26);
    const a = (1 - exitFlash) * 0.9;
    g.addColorStop(0, `rgba(255,244,230,${a})`);
    g.addColorStop(1, "rgba(255,244,230,0)");
    ctx.beginPath();
    ctx.arc(cx, cy + R, 26, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
  }
}

// Shared renderer: Earth as a cross-section ("the bore"). Both the sketch
// and, later, the production globe use this. Schematic layer radii — crust is
// a rim stroke, mantle to 0.55R, outer core to 0.19R, inner core center.

export const LAYERS = [
  { name: "MANTLE", from: 1.0, to: 0.55, depth: "0–2,890 km" },
  { name: "OUTER CORE", from: 0.55, to: 0.19, depth: "2,890–5,150 km" },
  { name: "INNER CORE", from: 0.19, to: 0.0, depth: "5,150–6,371 km" },
];

export function drawSection(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  R: number,
  opts: {
    probe: number; // 0..1 travel origin -> antipode, -1 hides
    beamAlpha: number; // 0..1 chord beam
    wireAlpha: number; // 0..1 ghost wireframe underneath (unused here)
    labels: boolean;
    t: number; // seconds for shimmer
  },
) {
  const { probe, beamAlpha, labels, t } = opts;

  // Mantle: warm dark fill with a faint radial gradient.
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.995, 0, Math.PI * 2);
  const mantle = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R);
  mantle.addColorStop(0, "rgba(255,77,0,0.16)");
  mantle.addColorStop(0.7, "rgba(120,44,14,0.20)");
  mantle.addColorStop(1, "rgba(242,238,227,0.05)");
  ctx.fillStyle = mantle;
  ctx.fill();

  // Outer core: molten orange disc, breathing slightly.
  const breathe = 1 + Math.sin(t * 1.4) * 0.012;
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.55 * breathe, 0, Math.PI * 2);
  const outer = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.55 * breathe);
  outer.addColorStop(0, "rgba(255,140,60,0.55)");
  outer.addColorStop(0.75, "rgba(255,77,0,0.32)");
  outer.addColorStop(1, "rgba(255,77,0,0.14)");
  ctx.fillStyle = outer;
  ctx.fill();

  // Inner core: hot phosphor-orange heart.
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.19 * breathe, 0, Math.PI * 2);
  const inner = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.19 * breathe);
  inner.addColorStop(0, "rgba(255,220,180,0.95)");
  inner.addColorStop(0.6, "rgba(255,77,0,0.8)");
  inner.addColorStop(1, "rgba(255,77,0,0.05)");
  ctx.fillStyle = inner;
  ctx.fill();

  // Layer boundaries.
  ctx.strokeStyle = "rgba(242,238,227,0.20)";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, R * 0.55, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, R * 0.19, 0, Math.PI * 2); ctx.stroke();

  // Crust rim.
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(242,238,227,0.55)";
  ctx.lineWidth = 1.4;
  ctx.stroke();

  // Layer labels, tucked to the left edge on their boundary lines.
  if (labels) {
    ctx.font = "9px 'IBM Plex Mono', monospace";
    ctx.fillStyle = "rgba(152,161,184,0.85)";
    ctx.textAlign = "left";
    const lx = cx - R - 74;
    for (const L of LAYERS) {
      const y = cy - R * L.to - 4;
      ctx.fillText(L.name, lx, y);
      ctx.strokeStyle = "rgba(152,161,184,0.28)";
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(lx + ctx.measureText(L.name).width + 6, y - 3);
      ctx.lineTo(cx - Math.sqrt(Math.max(0, R * R - (R * L.to) ** 2)) * 0.96, y - 3);
      ctx.stroke();
    }
  }

  // The beam: the chord as an ignited signal path.
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

  // The probe: phosphor dot + orange comet tail descending the chord.
  if (probe >= 0) {
    const py = cy - R + probe * 2 * R;
    const tail = ctx.createLinearGradient(cx, py - 40, cx, py);
    tail.addColorStop(0, "rgba(255,77,0,0)");
    tail.addColorStop(1, "rgba(255,77,0,0.8)");
    ctx.strokeStyle = tail;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, py - 40);
    ctx.lineTo(cx, py);
    ctx.stroke();
    const g = ctx.createRadialGradient(cx, py, 0, cx, py, 10);
    g.addColorStop(0, "rgba(124,255,178,0.95)");
    g.addColorStop(1, "rgba(124,255,178,0)");
    ctx.beginPath();
    ctx.arc(cx, py, 10, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, py, 2.6, 0, Math.PI * 2);
    ctx.fillStyle = "#eafff2";
    ctx.fill();
  }
}

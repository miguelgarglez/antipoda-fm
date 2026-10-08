// Reproduces "the globe clips its container during the first-tune zoom".
// Captures the .stage element every ~100ms from the tune click through the
// bore, and also measures whether globe strokes touch the canvas edge.
// Usage: node video/repro-clip.mjs <url> <outdir>
import { createRequire } from "node:module";
const require = createRequire(process.cwd() + "/");
const { chromium } = require("playwright");
import fs from "node:fs";

const url = process.argv[2] || "http://localhost:5401";
const out = process.argv[3] || "/tmp/antipoda-clip";
fs.mkdirSync(out, { recursive: true });

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto(url, { waitUntil: "networkidle" });
// Skip the first-run guide so it cannot block the click.
await p.evaluate(() => localStorage.setItem("antipoda.guide.v2", "1"));
await p.reload({ waitUntil: "networkidle" });

const stage = p.locator(".stage");
const t0 = Date.now();
await p.getByRole("button", { name: "Madrid" }).click();
let i = 0;
const report = [];
while (Date.now() - t0 < 4200) {
  const path = `${out}/f${String(i).padStart(3, "0")}.png`;
  await stage.screenshot({ path });
  // Edge-touch probe: is there drawn (non-background) content in the
  // outermost 2px ring of the globe canvas?
  const r = await p.evaluate(() => {
    const c = document.querySelector("canvas.globe");
    if (!c) return null;
    const ctx = c.getContext("2d");
    const w = c.width, h = c.height;
    const d = ctx.getImageData(0, 0, w, h).data;
    let edge = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (x > 2 && x < w - 3 && y > 2 && y < h - 3) continue;
        const a = d[(y * w + x) * 4 + 3];
        if (a > 24) edge++;
      }
    }
    const z = c.getBoundingClientRect();
    return { edgePx: edge, w, h, zoom: window.__gz ?? null };
  });
  report.push({ i, ms: Date.now() - t0, ...r });
  i++;
  await p.waitForTimeout(100);
}
console.log(JSON.stringify(report.filter((x) => x && x.edgePx > 0), null, 0));
console.log("total frames:", i);
await p.screenshot({ path: `${out}/page-end.png` });
await b.close();

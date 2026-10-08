import { chromium } from "playwright";

// Regression check for the live scope: while a station is ON AIR the trace
// must never sit on a flat line. Two passes:
//   A) autoplay allowed   — the stream plays straight after the bore.
//   B) gesture required   — play() is blocked; the user presses Listen and
//      the meter wiring must retry inside that activation (this was the
//      bug: AudioContext stayed suspended, so even CORS-clean streams
//      showed a dead flat carrier forever).
// Pass criteria: while ON AIR, the scope changes between samples AND its
// trace deviates from the midline at least once.

const URL = process.env.TARGET_URL ?? "http://localhost:5199/";

const probe = async (page) => {
  return page.evaluate(() => {
    const c = document.querySelector("canvas.scope");
    if (!c) return null;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, c.width, c.height).data;
    const mid = c.height / 2;
    let maxDev = 0;
    let lit = 0;
    const bits = [];
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x += 4) {
        const a = img[(y * c.width + x) * 4 + 3];
        if (a > 60) {
          lit++;
          bits.push(x + ":" + y);
          const d = Math.abs(y - mid);
          if (d > maxDev) maxDev = d;
        }
      }
    }
    return { lit, maxDev, hash: bits.join(",").length };
  });
};

const run = async (label, extraArgs) => {
  const browser = await chromium.launch({ args: extraArgs });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto(URL + "?lat=40.4&lon=-3.7&from=Madrid", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".station-name", { timeout: 45000 });
  // Give the first candidate a moment; if autoplay was blocked, Listen.
  await page.waitForTimeout(3500);
  const status = await page.locator(".onair").textContent();
  if (status.includes("PAUSED")) await page.click("button.btn.primary");
  await page.waitForFunction(
    () => document.querySelector(".onair")?.textContent?.includes("ON AIR"),
    { timeout: 30000 },
  );
  const samples = [];
  for (let i = 0; i < 6; i++) {
    samples.push(await probe(page));
    await page.waitForTimeout(450);
  }
  const note = await page.locator(".scope-note").count();
  await browser.close();

  const moved = samples.some(
    (s, i) => i > 0 && s && samples[i - 1] && s.hash !== samples[i - 1].hash,
  );
  const peaked = samples.some((s) => s && s.maxDev > 4);
  const ok = moved && peaked;
  console.log(
    `${label}: ${ok ? "PASS" : "FAIL"} — moved=${moved} maxDev=${Math.max(...samples.map((s) => s?.maxDev ?? 0))}px meterNote=${note}`,
  );
  return ok;
};

const a = await run("autoplay", []);
const b = await run("gesture-gated", ["--autoplay-policy=user-gesture-required"]);
if (!a || !b) process.exit(1);
console.log("scope-check: PASS");

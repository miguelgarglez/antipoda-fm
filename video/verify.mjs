import { chromium, devices } from "playwright";

const URL = process.env.TARGET_URL ?? "http://localhost:5199/";
const OUT = process.env.OUT_DIR ?? "raw/verify";
const errors = [];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`[console] ${m.text()}`);
});
page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`));

await page.goto(URL + (URL.includes("?") ? "&" : "?") + "gvdbg", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1800);
await page.screenshot({ path: `${OUT}/01-idle-1440.png` });

// --- guide: step 1 should ring the planet on a first visit ---
const guideStep1 = await page.locator(".guide-step").textContent().catch(() => null);
console.log("guide step:", guideStep1);

// --- globe drag + inertia: pixels must move after release, then settle ---
const globe = page.locator("canvas.globe");
const gbox = await globe.boundingBox();
const cx = gbox.x + gbox.width / 2;
const cy = gbox.y + gbox.height / 2;
// Change-rate probe: count of sampled pixels that differ between two
// frames `gap` ms apart. The planet always drifts (turntable), so we
// compare rates — a fling must move pixels far faster than idle drift.
const changeScore = (gap = 300) =>
  page.evaluate(async (g) => {
    const c = document.querySelector("canvas.globe");
    const x = c.getContext("2d");
    const grab = () => x.getImageData(0, 0, c.width, c.height).data;
    const a = grab();
    await new Promise((r) => setTimeout(r, g));
    const b = grab();
    let n = 0;
    for (let i = 0; i < a.length; i += 4 * 499) {
      if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 24) n++;
    }
    return n;
  }, gap);
await page.mouse.move(cx, cy);
await page.mouse.down();
for (let i = 0; i < 8; i++) {
  await page.mouse.move(cx + i * 22, cy - i * 6);
  await page.waitForTimeout(24);
}
await page.mouse.up();
// __gv exposes live angular speed (rad/s): must start well above drift
// and decay under damping — real fling inertia, not teleport-and-stop.
const gv = () => page.evaluate(() => window.__gv ?? 0);
await page.waitForTimeout(120);
const v0 = await gv();
await page.waitForTimeout(800);
const v1 = await gv();
await page.waitForTimeout(3400); // coast to the drift floor
const vEnd = await gv();
// decay must be monotonic and converge toward the 0.05 rad/s drift floor
const inertiaOK = v0 > 0.15 && v1 < v0 && vEnd < 0.12;
console.log(
  `drag inertia: ${v0.toFixed(2)}→${v1.toFixed(2)}→...→${vEnd.toFixed(3)} rad/s`,
  inertiaOK ? "PASS" : "FAIL",
);
await page.screenshot({ path: `${OUT}/02-dragged.png` });

// --- wheel zoom ---
// zoom is internal — measure via coast-style pixel delta after a wheel
await page.mouse.move(cx, cy);
await page.mouse.wheel(0, -600);
await page.waitForTimeout(150);
const zoomChange = await changeScore(200);
console.log("wheel zoom px change:", zoomChange, zoomChange > 30 ? "PASS" : "FAIL");
await page.mouse.wheel(0, 600);
await page.waitForTimeout(700);

// --- Madrid tune: catch the bore mid-flight ---
await page.click('button.chip:has-text("Madrid")');
for (const ms of [400, 800, 1200]) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/03-bore-${ms}ms.png` });
}
await page.waitForSelector(".station-name", { timeout: 30000 });
await page.waitForFunction(
  () => document.querySelector(".onair")?.textContent?.includes("ON AIR"),
  { timeout: 30000 },
);
await page.waitForTimeout(1800);
await page.screenshot({ path: `${OUT}/04-tuned-1440.png` });
const guideStep3 = await page.locator(".guide-step").textContent().catch(() => null);
console.log("guide at tuned:", guideStep3);

// --- dial drag interaction finishes the guide ---
const dbox = await page.locator(".dial").boundingBox();
if (dbox) {
  await page.mouse.move(dbox.x + dbox.width * 0.7, dbox.y + dbox.height / 2);
  await page.mouse.down();
  await page.mouse.move(dbox.x + dbox.width * 0.3, dbox.y + dbox.height / 2, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(1200);
}
const guideGone = (await page.locator(".guide").count()) === 0;
console.log("guide dismissed after dial drag:", guideGone);
await page.screenshot({ path: `${OUT}/05-dial-next.png` });

// --- copy link ---
await page.click('button:has-text("COPY LINK")').catch(() => null);
await page.waitForTimeout(300);
const clipboardOK = await page.evaluate(
  () => navigator.clipboard.readText().catch(() => "denied"),
);
console.log("clipboard:", clipboardOK);

// --- pause / resume ---
await page.click('button:has-text("PAUSE")');
await page.waitForTimeout(400);
const resumeVisible = await page.locator('button:has-text("LISTEN")').count();
await page.screenshot({ path: `${OUT}/06-paused.png` });
console.log("resume button:", resumeVisible);
await page.click('button:has-text("LISTEN")').catch(() => null);
await page.waitForTimeout(1200);

// --- elsewhere: back to idle ---
await page.click('button:has-text("ELSEWHERE")');
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/07-back-idle.png` });

// --- ocean antipode: Denver -> Indian Ocean ---
await page.click('button.chip:has-text("Denver")').catch(async () => {
  await page.fill("#place", "Denver");
  await page.waitForSelector(".place-list li button", { timeout: 15000 });
  await page.click(".place-list li button");
});
await page.waitForSelector(".station-name, .dead-end, .tuning-log", { timeout: 30000 });
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/08-ocean.png` });
console.log("ocean URL:", page.url());

// --- mobile 375 (guide pre-seeded as seen) ---
const mctx = await browser.newContext({
  ...devices["iPhone 13"],
  viewport: { width: 375, height: 812 },
});
await mctx.addInitScript(() => {
  try { localStorage.setItem("antipoda.guide.v2", "1"); } catch {}
});
const mp = await mctx.newPage();
mp.on("pageerror", (e) => errors.push(`[mobile pageerror] ${e.message}`));
await mp.goto(URL, { waitUntil: "domcontentloaded" });
await mp.waitForTimeout(1500);
await mp.screenshot({ path: `${OUT}/09-idle-375.png` });
const hscroll = await mp.evaluate(() => document.documentElement.scrollWidth);
console.log("mobile scrollWidth:", hscroll);
await mp.click('button.chip:has-text("Madrid")');
await mp.waitForTimeout(700);
await mp.screenshot({ path: `${OUT}/10-bore-375.png` });
await mp.waitForSelector(".station-name", { timeout: 30000 });
await mp.waitForFunction(
  () => document.querySelector(".onair")?.textContent?.includes("ON AIR"),
  { timeout: 30000 },
).catch(() => console.log("mobile: ON AIR not reached (may be blocked autoplay)"));
await mp.waitForTimeout(1500);
await mp.screenshot({ path: `${OUT}/11-tuned-375.png` });
console.log("mobile scrollWidth tuned:", await mp.evaluate(() => document.documentElement.scrollWidth));
await mctx.close();

// --- reduced motion ---
const rctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  reducedMotion: "reduce",
});
await rctx.addInitScript(() => {
  try { localStorage.setItem("antipoda.guide.v2", "1"); } catch {}
});
const rp = await rctx.newPage();
rp.on("pageerror", (e) => errors.push(`[rm pageerror] ${e.message}`));
await rp.goto(URL, { waitUntil: "domcontentloaded" });
await rp.waitForTimeout(1200);
await rp.click('button.chip:has-text("Madrid")');
await rp.waitForTimeout(2500);
await rp.screenshot({ path: `${OUT}/12-reduced-tuned.png` });
await rctx.close();

await ctx.close();
await browser.close();
console.log("\n=== ERRORS ===");
console.log(errors.length ? errors.join("\n") : "none");
console.log("inertia:", inertiaOK ? "PASS" : "FAIL");

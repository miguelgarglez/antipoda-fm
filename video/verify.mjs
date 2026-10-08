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

await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1800);
await page.screenshot({ path: `${OUT}/01-idle-1440.png` });

// --- Madrid tune: catch the bore mid-flight ---
await page.click('button.chip:has-text("Madrid")');
for (const ms of [250, 500, 750, 1000]) {
  await page.waitForTimeout(ms === 250 ? 250 : 250);
  await page.screenshot({ path: `${OUT}/02-bore-${ms}ms.png` });
}
await page.waitForSelector(".station-name", { timeout: 30000 });
await page.waitForFunction(
  () => document.querySelector(".onair")?.textContent?.includes("ON AIR"),
  { timeout: 30000 },
);
await page.waitForTimeout(1800);
await page.screenshot({ path: `${OUT}/03-tuned-1440.png` });

// --- dial keyboard interaction ---
const dial = page.locator(".dial");
await dial.focus();
await page.keyboard.press("ArrowRight");
await page.waitForTimeout(1200);
const sigLabel = await page
  .locator(".dial")
  .getAttribute("aria-valuetext")
  .catch(() => null);
await page.screenshot({ path: `${OUT}/04-dial-next.png` });
console.log("dial label after ArrowRight:", sigLabel);

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
await page.screenshot({ path: `${OUT}/05-paused.png` });
console.log("resume button:", resumeVisible);
await page.click('button:has-text("LISTEN")').catch(() => null);
await page.waitForTimeout(1200);

// --- elsewhere: back to idle ---
await page.click('button:has-text("ELSEWHERE")');
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/06-back-idle.png` });

// --- ocean antipode: Denver -> Indian Ocean ---
await page.click('button.chip:has-text("Denver")').catch(async () => {
  // no Denver chip; use search
  await page.fill("#place", "Denver");
  await page.waitForSelector(".place-list li button", { timeout: 15000 });
  await page.click(".place-list li button");
});
await page.waitForSelector(".station-name, .dead-end, .tuning-log", { timeout: 30000 });
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/07-ocean.png` });
console.log("ocean URL:", page.url());

// --- mobile 375 ---
const mctx = await browser.newContext({
  ...devices["iPhone 13"],
  viewport: { width: 375, height: 812 },
});
const mp = await mctx.newPage();
mp.on("pageerror", (e) => errors.push(`[mobile pageerror] ${e.message}`));
await mp.goto(URL, { waitUntil: "domcontentloaded" });
await mp.waitForTimeout(1500);
await mp.screenshot({ path: `${OUT}/08-idle-375.png` });
const hscroll = await mp.evaluate(() => document.documentElement.scrollWidth);
console.log("mobile scrollWidth:", hscroll);
await mp.click('button.chip:has-text("Madrid")');
await mp.waitForTimeout(700);
await mp.screenshot({ path: `${OUT}/09-bore-375.png` });
await mp.waitForSelector(".station-name", { timeout: 30000 });
await mp.waitForFunction(
  () => document.querySelector(".onair")?.textContent?.includes("ON AIR"),
  { timeout: 30000 },
).catch(() => console.log("mobile: ON AIR not reached (may be blocked autoplay)"));
await mp.waitForTimeout(1500);
await mp.screenshot({ path: `${OUT}/10-tuned-375.png` });
console.log("mobile scrollWidth tuned:", await mp.evaluate(() => document.documentElement.scrollWidth));
await mctx.close();

// --- reduced motion ---
const rctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  reducedMotion: "reduce",
});
const rp = await rctx.newPage();
rp.on("pageerror", (e) => errors.push(`[rm pageerror] ${e.message}`));
await rp.goto(URL, { waitUntil: "domcontentloaded" });
await rp.waitForTimeout(1200);
await rp.click('button.chip:has-text("Madrid")');
await rp.waitForTimeout(2500);
await rp.screenshot({ path: `${OUT}/11-reduced-tuned.png` });
await rctx.close();

await ctx.close();
await browser.close();
console.log("\n=== ERRORS ===");
console.log(errors.length ? errors.join("\n") : "none");

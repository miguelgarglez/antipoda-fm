import { chromium } from "playwright";

const URL = process.env.TARGET_URL ?? "https://antipoda-fm.vercel.app/";

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: "raw", size: { width: 1280, height: 720 } },
});
const page = await ctx.newPage();

await page.goto(URL, { waitUntil: "networkidle" });
// Let the globe settle into view.
await page.waitForTimeout(2500);

// Tune Madrid: the search resolves, the globe swings to the chord, ON AIR.
await page.click('button.chip:has-text("Madrid")');
await page.waitForSelector(".station-name", { timeout: 30000 });
await page.waitForSelector(".onair", { timeout: 30000 });
await page.waitForFunction(
  () => document.querySelector(".onair")?.textContent?.includes("ON AIR"),
  { timeout: 30000 },
);
await page.waitForTimeout(4500);

// Move to the next signal for a beat of the dial working.
await page.click('button:has-text("Another signal")');
await page.waitForTimeout(3500);

await page.waitForTimeout(1500);
const video = page.video();
await ctx.close();
await browser.close();
console.log("saved:", await video.path());

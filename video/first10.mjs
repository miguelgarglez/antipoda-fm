import { chromium } from "playwright";
const URL = process.env.TARGET_URL ?? "http://localhost:5199/";
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: "raw", size: { width: 1440, height: 900 } },
});
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2200);
await page.click('button.chip:has-text("Madrid")');
await page.waitForTimeout(7800);
await ctx.close();
await browser.close();

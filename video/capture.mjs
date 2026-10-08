import { chromium } from "playwright";

const URL = process.env.TARGET_URL ?? "http://localhost:5174/";
const OUT = process.env.OUT_DIR ?? "raw/capture";
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  geolocation: { latitude: 40.4168, longitude: -3.7038 },
  permissions: ["geolocation"],
});
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2200);
await page.screenshot({ path: `${OUT}/idle-1440.png` });

// Guide step 1 ring visible on first visit.
await page.screenshot({ path: `${OUT}/guide-s1-1440.png` });

// Tune Madrid via the chip → origin shot.
await page.getByText("Madrid", { exact: false }).first().click().catch(async () => {
  await page.locator("input").first().fill("Madrid");
  await page.waitForTimeout(900);
  await page.keyboard.press("Enter");
});
await page.waitForTimeout(1400); // mid approach / origin dwell
await page.screenshot({ path: `${OUT}/shot-origin.png` });
await page.waitForTimeout(1400); // bore opening
await page.screenshot({ path: `${OUT}/bore-open.png` });
await page.waitForTimeout(1600); // probe mid-travel
await page.screenshot({ path: `${OUT}/bore-mid.png` });
await page.waitForTimeout(6500); // reveal + settle
await page.screenshot({ path: `${OUT}/tuned-1440.png` });
await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUT}/tuned-1440-b.png` });

// Mobile
const mctx = await browser.newContext({
  viewport: { width: 375, height: 720 },
  geolocation: { latitude: 40.4168, longitude: -3.7038 },
  permissions: ["geolocation"],
  isMobile: true,
  hasTouch: true,
});
const mp = await mctx.newPage();
await mp.goto(URL, { waitUntil: "domcontentloaded" });
await mp.waitForTimeout(2200);
await mp.screenshot({ path: `${OUT}/idle-375.png` });
await mp.getByText("Madrid", { exact: false }).first().click().catch(async () => {
  await mp.locator("input").first().fill("Madrid");
  await mp.waitForTimeout(900);
  await mp.keyboard.press("Enter");
});
await mp.waitForTimeout(11500);
await mp.screenshot({ path: `${OUT}/tuned-375.png` });

await browser.close();
console.log("done");

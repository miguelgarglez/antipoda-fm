import { chromium } from "playwright";
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1440, height: 900 } });
await pg.goto("http://localhost:5174/");
await pg.click("text=Madrid");
// wait for ON AIR or PAUSED state
await pg.waitForSelector(".play-btn", { timeout: 40000 });
await pg.waitForTimeout(1500);
await pg.screenshot({ path: "raw/d2-tuned-transport.png" });
// mobile
const pm = await b.newPage({ viewport: { width: 375, height: 720 } });
await pm.goto("http://localhost:5174/");
await pm.click("text=Madrid");
await pm.waitForSelector(".play-btn", { timeout: 40000 });
await pm.waitForTimeout(1200);
await pm.screenshot({ path: "raw/d2-mobile-tuned.png" });
const sw = await pm.evaluate(() => document.documentElement.scrollWidth);
console.log("mobile scrollWidth:", sw);
await b.close();

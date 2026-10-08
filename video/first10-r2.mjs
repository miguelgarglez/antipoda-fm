import { chromium } from "playwright";
const b = await chromium.launch();
const ctx = await b.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: "raw", size: { width: 1440, height: 900 } },
});
const pg = await ctx.newPage();
await pg.goto("http://localhost:5174/");
await pg.waitForTimeout(2200);
// drag the planet — guide step 1 completes on real gesture
await pg.mouse.move(430, 420);
await pg.mouse.down();
await pg.mouse.move(580, 390, { steps: 14 });
await pg.mouse.up();
await pg.waitForTimeout(2500);
// wheel zoom
await pg.mouse.wheel(0, -400);
await pg.waitForTimeout(1500);
await pg.mouse.wheel(0, 400);
await pg.waitForTimeout(1200);
// click Madrid — step 2 completes
await pg.click("text=Madrid");
await pg.waitForTimeout(3200);
await ctx.close();
await b.close();

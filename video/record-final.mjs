import { chromium } from "playwright";
const b = await chromium.launch();
const ctx = await b.newContext({
  viewport: { width: 1920, height: 1080 },
  recordVideo: {
    dir: new URL("./raw/launch2/", import.meta.url).pathname,
    size: { width: 1920, height: 1080 },
  },
});
const pg = await ctx.newPage();
await pg.goto("http://localhost:5174/");
await pg.waitForTimeout(2600);            // idle + guide arcs
await pg.mouse.move(560, 520);
await pg.mouse.down();                    // step 1: drag the planet
await pg.mouse.move(760, 470, { steps: 16 });
await pg.mouse.up();
await pg.waitForTimeout(2000);
await pg.mouse.wheel(0, -420);            // zoom in — a body you can approach
await pg.waitForTimeout(1400);
await pg.mouse.wheel(0, 420);
await pg.waitForTimeout(1200);
await pg.click("text=Madrid");            // step 2: name a place
await pg.waitForTimeout(11000);           // prelude + full 1500ms bore + resolve
const tuned = await pg.locator(".play-btn").count();
if (tuned) {
  const d = await pg.locator(".dial").boundingBox();
  if (d) {                                // step 3: drag the dial
    await pg.mouse.move(d.x + d.width * 0.62, d.y + d.height / 2);
    await pg.mouse.down();
    await pg.mouse.move(d.x + d.width * 0.34, d.y + d.height / 2, { steps: 10 });
    await pg.mouse.up();
    await pg.waitForTimeout(3500);        // settle on new signal
  }
}
await pg.waitForTimeout(5200);            // hold on tuned state — the URL frame needs footage through 29.2s
await ctx.close();
await b.close();
console.log("recorded");

import { chromium } from "playwright";
const b = await chromium.launch();
const ctx = await b.newContext({
  viewport: { width: 1920, height: 1080 },
  recordVideo: {
    dir: new URL("./raw/launch3/", import.meta.url).pathname,
    size: { width: 1920, height: 1080 },
  },
});
const pg = await ctx.newPage();
await pg.goto("http://localhost:5199/");
await pg.waitForTimeout(1500);
await pg.getByRole("button", { name: "guide" }).click(); // step-1 arcs on the limb — the hook
await pg.waitForTimeout(2000);
const g = await pg.locator(".globe").boundingBox();
if (g) {
  const gx = g.x + g.width / 2, gy = g.y + g.height / 2;
  await pg.mouse.move(gx - 120, gy + 60);
  await pg.mouse.down(); // step 1: drag the planet
  await pg.mouse.move(gx + 90, gy - 20, { steps: 16 });
  await pg.mouse.up();
}
await pg.waitForTimeout(2000);
await pg.mouse.wheel(0, -420); // zoom in — a body you can approach
await pg.waitForTimeout(1400);
await pg.mouse.wheel(0, 420);
await pg.waitForTimeout(1200);
await pg.click("text=Madrid"); // step 2: name a place
await pg.waitForTimeout(11000); // prelude + bore + resolve
const tuned = await pg.locator(".dial").count();
if (tuned) {
  const d = await pg.locator(".dial").boundingBox();
  if (d) {
    // step 3: drag the dial
    await pg.mouse.move(d.x + d.width * 0.62, d.y + d.height / 2);
    await pg.mouse.down();
    await pg.mouse.move(d.x + d.width * 0.34, d.y + d.height / 2, {
      steps: 10,
    });
    await pg.mouse.up();
    await pg.waitForTimeout(3500); // settle on new signal
  }
}
await pg.waitForTimeout(5200); // hold on tuned state — URL frame needs footage through ~29s
await ctx.close();
await b.close();
console.log("recorded");

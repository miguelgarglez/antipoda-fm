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
// Footage only: a drag across the face must never light a text
// selection — the screencast paints ::selection behind every line.
await pg.addStyleTag({ content: "* { user-select: none !important }" });
await pg.waitForTimeout(1200);
await pg.getByRole("button", { name: "Replay the intro" }).click(); // arcs on the limb — the hook
await pg.waitForTimeout(1800); // ~3.0s mark
const g = await pg.locator(".globe").boundingBox();
if (g) {
  const gx = g.x + g.width / 2, gy = g.y + g.height / 2;
  await pg.mouse.move(gx - 120, gy + 60);
  await pg.mouse.down(); // drag the planet
  await pg.mouse.move(gx + 90, gy - 20, { steps: 14 });
  await pg.mouse.up();
}
await pg.waitForTimeout(900); // ~4.5s
await pg.mouse.wheel(0, -420); // zoom in — a body you can approach
await pg.waitForTimeout(1000);
await pg.mouse.wheel(0, 420);
await pg.waitForTimeout(900); // ~7.5s
await pg.click("text=Madrid"); // ~8.5s — bore starts on the storyboard's mark
await pg.waitForTimeout(9500); // prelude + bore + resolve → ~18s
const tuned = await pg.locator(".dial").count();
if (tuned) {
  const d = await pg.locator(".dial").boundingBox();
  if (d) {
    await pg.mouse.move(d.x + d.width * 0.62, d.y + d.height / 2);
    await pg.mouse.down(); // drag the dial — preview under the needle
    await pg.mouse.move(d.x + d.width * 0.34, d.y + d.height / 2, {
      steps: 10,
    });
    await pg.mouse.up();
    await pg.waitForTimeout(3500); // settle on new signal
  }
}
await pg.evaluate(() => window.getSelection()?.removeAllRanges());
await pg.waitForTimeout(5500); // hold tuned — URL frame needs footage through ~29s
await ctx.close();
await b.close();
console.log("recorded");

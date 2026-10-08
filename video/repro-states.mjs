// Full-page state captures: idle + tuned at several sizes.
// Usage: node video/repro-states.mjs <url> <outdir>
import { createRequire } from "node:module";
const require = createRequire(process.cwd() + "/");
const { chromium } = require("playwright");
import fs from "node:fs";

const url = process.argv[2] || "http://localhost:5401";
const out = process.argv[3] || "/tmp/antipoda-states";
fs.mkdirSync(out, { recursive: true });

const b = await chromium.launch();
for (const [w, h, tag] of [
  [1440, 900, "1440"],
  [1280, 720, "1280"],
  [1024, 600, "1024"],
  [1920, 1080, "1920"],
  [375, 720, "375"],
]) {
  const p = await b.newPage({ viewport: { width: w, height: h } });
  await p.goto(url, { waitUntil: "networkidle" });
  await p.evaluate(() => localStorage.setItem("antipoda.guide.v2", "1"));
  await p.reload({ waitUntil: "networkidle" });
  await p.waitForTimeout(600);
  await p.screenshot({ path: `${out}/idle-${tag}.png` });
  if (w > 400) {
    await p.getByRole("button", { name: "Madrid" }).click();
    await p.waitForTimeout(9000);
    await p.screenshot({ path: `${out}/tuned-${tag}.png` });
    const m = await p.evaluate(() => ({
      scroll: document.documentElement.scrollHeight > innerHeight + 1,
      sh: document.documentElement.scrollHeight,
      ih: innerHeight,
    }));
    console.log(tag, JSON.stringify(m));
  }
  await p.close();
}
await b.close();

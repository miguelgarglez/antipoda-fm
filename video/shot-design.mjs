import { chromium } from "playwright";
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1440, height: 900 } });
await pg.goto("http://localhost:5174/");
await pg.waitForTimeout(1200);
await pg.screenshot({ path: "raw/d2-guide.png" });
// drag the globe — should advance guide via onInteract
await pg.mouse.move(430, 420);
await pg.mouse.down();
await pg.mouse.move(560, 400, { steps: 12 });
await pg.mouse.up();
await pg.waitForTimeout(600);
await pg.screenshot({ path: "raw/d2-guide2.png" });
// tune Madrid
await pg.click("text=Madrid");
await pg.waitForTimeout(6500);
await pg.screenshot({ path: "raw/d2-bore.png" });
await pg.waitForTimeout(9000);
await pg.screenshot({ path: "raw/d2-tuned.png" });
const errs = [];
await b.close();
console.log("done");

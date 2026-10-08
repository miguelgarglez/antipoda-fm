import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await (await browser.newContext({viewport:{width:1440,height:900}})).newPage();
await page.goto("http://localhost:5199/", {waitUntil:"domcontentloaded"});
await page.waitForTimeout(1600);
// throttle resolveSignals? no — just catch early frames
await page.click('button.chip:has-text("Madrid")');
for (const t of [280, 340, 420, 520]) {
  const wait = t === 280 ? 280 : 60;
  await page.waitForTimeout(t === 280 ? 280 : (t - (t===340?280:t===420?340:420)));
  await page.screenshot({path:`raw/verify/open-${t}.png`});
}
await browser.close();

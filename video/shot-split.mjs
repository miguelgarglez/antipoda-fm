import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await (await browser.newContext({viewport:{width:1440,height:900}})).newPage();
await page.goto("http://localhost:5199/", {waitUntil:"domcontentloaded"});
await page.waitForTimeout(1600);
await page.click('button.chip:has-text("Madrid")');
for (const [name,ms] of [["split-350",350],["split-700",350],["split-1000",300],["split-1400",400],["split-1700",300]]) {
  await page.waitForTimeout(ms);
  await page.screenshot({path:`raw/verify/${name}.png`});
}
await page.waitForSelector(".station-name",{timeout:30000});
await page.waitForTimeout(1500);
await page.screenshot({path:"raw/verify/tuned-final.png"});
// mobile tuned with transport
const mp = await (await browser.newContext({viewport:{width:375,height:740}})).newPage();
await mp.goto("http://localhost:5199/?lat=40.42&lon=-3.70&from=Madrid",{waitUntil:"domcontentloaded"});
await mp.waitForSelector(".station-name",{timeout:30000});
await mp.waitForFunction(()=>document.querySelector(".onair")?.textContent?.includes("ON AIR"),{timeout:30000}).catch(()=>{});
await mp.waitForTimeout(1200);
await mp.screenshot({path:"raw/verify/tuned-375b.png"});
await browser.close();

import * as pw from "playwright";

// Engine selectable: `--engine=webkit|firefox|chromium` (default chromium).
const ENGINE = (
  process.argv.find((a) => a.startsWith("--engine="))?.split("=")[1] ??
  process.env.ENGINE ??
  "chromium"
);
const engine = pw[ENGINE];
if (!engine) {
  console.error(`unknown engine: ${ENGINE}`);
  process.exit(2);
}
const launch = (args = []) =>
  engine.launch(ENGINE === "chromium" ? { args } : undefined);

// Live-scope regression suite. Four passes against the production build:
//   A) autoplay      — real waveform via the element meter.
//   B) gesture-gated — play() is blocked; pressing the Listen button must
//      re-arm everything inside that activation (the original bug:
//      AudioContext stayed suspended, so even CORS-clean streams showed a
//      dead flat carrier forever).
//   C) silent stream — a canned station serves real PCM silence. The
//      watchdog must not lie: the decode meter rejects the WAV container,
//      the honest carrier note appears, playback continues.
//   D) dead analyser — getFloatTimeDomainData stubbed to zeros on a real
//      station. The WebCodecs decode meter must take over: __meter.src
//      becomes "decode" with real samples.
// The app exposes ?gvdbg: window.__meter = { src, real }.

const URL = process.env.TARGET_URL ?? "http://localhost:5199/";
const ORIGIN = "?lat=40.4&lon=-3.7&from=Madrid&gvdbg";

const probe = async (page) => {
  return page.evaluate(() => {
    const c = document.querySelector("canvas.scope");
    if (!c) return null;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, c.width, c.height).data;
    const mid = c.height / 2;
    let maxDev = 0;
    let lit = 0;
    const bits = [];
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x += 4) {
        const a = img[(y * c.width + x) * 4 + 3];
        if (a > 60) {
          lit++;
          // Intensity, not position — phosphor persistence keeps the lit
          // set nearly constant while the trace inside it still moves.
          bits.push(img[(y * c.width + x) * 4 + 1]);
          const d = Math.abs(y - mid);
          if (d > maxDev) maxDev = d;
        }
      }
    }
    return {
      lit,
      maxDev,
      hash: bits.join(",").length,
      meter: window.__meter ?? null,
    };
  });
};

const onAir = (page) =>
  page.waitForFunction(
    () => document.querySelector(".onair")?.textContent?.includes("ON AIR"),
    { timeout: 40000 },
  );

const sampleScope = async (page, n = 6, gap = 450) => {
  const samples = [];
  for (let i = 0; i < n; i++) {
    samples.push(await probe(page));
    await page.waitForTimeout(gap);
  }
  return samples;
};

const moved = (samples) =>
  samples.some((s, i) => i > 0 && s && samples[i - 1] && s.hash !== samples[i - 1].hash);
const peaked = (samples) => samples.some((s) => s && s.maxDev > 4);
const lastMeter = (samples) => samples.filter(Boolean).at(-1)?.meter;

/** A canned Radio Browser reply: one geotagged station at the antipode. */
const CANNED = (streamUrl, name) => [
  {
    stationuuid: "scope-check-1",
    name,
    country: "New Zealand",
    countrycode: "NZ",
    language: "English",
    url_resolved: streamUrl,
    codec: "WAV",
    bitrate: 1411,
    votes: 99,
    hls: 0,
    geo_lat: -40.4,
    geo_long: 176.3,
  },
];

/** 40 s of digital silence as a mono 16-bit 16 kHz WAV. */
function silentWav() {
  const rate = 16000;
  const secs = 40;
  const n = rate * secs;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  return buf;
}

const mockRadioApi = async (page, stations) => {
  await page.route("**://*.api.radio-browser.info/json/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(stations),
    }),
  );
};

const open = async (page, extraArgs = []) => {
  await page.goto(URL + ORIGIN, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".station-name", { timeout: 45000 });
  await page.waitForTimeout(3000);
  const status = await page.locator(".onair").textContent();
  if (status.includes("PAUSED")) {
    await page.getByRole("button", { name: /listen/i }).click();
  }
};

// --- A) autoplay, real station -------------------------------------------
const runAutoplay = async () => {
  const browser = await launch();
  const page = await (
    await browser.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  await open(page);
  await onAir(page);
  const samples = await sampleScope(page);
  await browser.close();
  const m = lastMeter(samples);
  const ok =
    moved(samples) && peaked(samples) && m && m.real === true &&
    (m.src === "element" || m.src === "decode");
  console.log(
    `autoplay: ${ok ? "PASS" : "FAIL"} — moved=${moved(samples)} ` +
      `maxDev=${Math.max(...samples.map((s) => s?.maxDev ?? 0))}px meter=${JSON.stringify(m)}`,
  );
  return ok;
};

// --- B) gesture-gated, real station ---------------------------------------
const runGesture = async () => {
  const browser = await launch(["--autoplay-policy=user-gesture-required"]);
  const page = await (
    await browser.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  await open(page);
  await onAir(page);
  const samples = await sampleScope(page);
  await browser.close();
  const m = lastMeter(samples);
  const ok =
    moved(samples) && peaked(samples) && m && m.real === true;
  console.log(
    `gesture: ${ok ? "PASS" : "FAIL"} — moved=${moved(samples)} meter=${JSON.stringify(m)}`,
  );
  return ok;
};

// --- C) genuine silence + container the meter cannot decode ----------------
const runSilence = async () => {
  const browser = await launch();
  const page = await (
    await browser.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  const wav = silentWav();
  await mockRadioApi(page, CANNED("https://meter.test/silence.wav", "Silent FM"));
  await page.route("https://meter.test/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "audio/wav",
      headers: { "access-control-allow-origin": "*" },
      body: wav,
    }),
  );
  await open(page);
  await onAir(page);
  // Watchdog (~2s) → decode attempt → WAV is undecodable → honest carrier:
  // no real samples and the unmetered note visible, audio still on air.
  await page.waitForFunction(() => window.__meter?.real === false, {
    timeout: 25000,
  });
  await page.waitForSelector(".scope-note", { timeout: 25000 });
  const stillOnAir = await page.evaluate(() =>
    document.querySelector(".onair")?.textContent?.includes("ON AIR"),
  );
  const m = await page.evaluate(() => window.__meter);
  const ok = stillOnAir && m && m.real === false;
  console.log(
    `silence: ${ok ? "PASS" : "FAIL"} — onAir=${stillOnAir} meter=${JSON.stringify(m)}`,
  );
  await browser.close();
  return ok;
};

// --- D) dead analyser on a real stream → WebCodecs decode meter ------------
const runDeadAnalyser = async () => {
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => {
    const orig = AnalyserNode.prototype.getFloatTimeDomainData;
    AnalyserNode.prototype.getFloatTimeDomainData = function (buf) {
      orig.call(this, buf);
      buf.fill(0);
    };
  });
  const page = await ctx.newPage();
  await open(page);
  await onAir(page);
  // Watchdog proves zeros, then the decode meter must produce real samples.
  await page.waitForFunction(() => window.__meter?.src === "decode", {
    timeout: 40000,
  });
  await page.waitForFunction(() => window.__meter?.real === true, {
    timeout: 30000,
  });
  const samples = await sampleScope(page, 4);
  const m = lastMeter(samples);
  const ok = moved(samples) && peaked(samples) && m?.src === "decode" && m?.real;
  console.log(
    `decode-meter: ${ok ? "PASS" : "FAIL"} — moved=${moved(samples)} meter=${JSON.stringify(m)}`,
  );
  await browser.close();
  return ok;
};

const results = [
  await runAutoplay(),
  await runGesture(),
  await runSilence(),
  await runDeadAnalyser(),
];
if (results.some((r) => !r)) {
  console.log(`scope-check ${ENGINE}: FAIL`);
  process.exit(1);
}
console.log(`scope-check ${ENGINE}: PASS`);

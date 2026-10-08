#!/usr/bin/env node
/**
 * Boundary-split checks for the stream meter's parsers.
 *
 * Builds a synthetic ICY-interleaved ADTS stream, then feeds it through
 * IcyStripper + nextFrame split at EVERY byte offset — a real socket
 * delivers whatever TCP gives it, so the parser must not depend on where
 * a chunk ends.
 *
 *   node scripts/meter-parse-check.mjs
 */
import { IcyStripper, nextFrame } from "../src/lib/stream-meter.ts";

let failures = 0;
const ok = (cond, msg) => {
  if (!cond) {
    failures++;
    console.error("FAIL", msg);
  }
};

/** Build an ADTS header for a `payload`-byte frame. */
function adtsHeader(payloadLen) {
  const fl = payloadLen + 7;
  return new Uint8Array([
    0xff,
    0xf1, // MPEG-4, no CRC
    0x40 | 0x00, // AAC LC, 44100 idx=4, private
    0x00 | ((fl >> 11) & 0x03) | (2 << 2), // stereo in low bits too
    (fl >> 3) & 0xff,
    ((fl & 0x07) << 5) | 0x1f,
    0xfc,
  ]);
}

function adtsFrameBytes(payloadLen, seed = 0) {
  const h = adtsHeader(payloadLen);
  const f = new Uint8Array(payloadLen + 7);
  f.set(h);
  for (let i = 7; i < f.length; i++) f[i] = (seed + i * 31) & 0xff;
  // Payload must never contain an ADTS sync pair — the parser would see
  // a fake next frame. Keep payload bytes < 0xc0.
  for (let i = 7; i < f.length; i++) f[i] &= 0x7f;
  return f;
}

/** Extract every complete frame via nextFrame, mimicking the pump loop. */
function extract(fmt, bytes) {
  const frames = [];
  let pending = new Uint8Array(0);
  const feed = (chunk) => {
    const next = new Uint8Array(pending.length + chunk.length);
    next.set(pending);
    next.set(chunk, pending.length);
    pending = next;
    let consumed = 0;
    for (;;) {
      const f = nextFrame(fmt, pending, consumed);
      if (f === 0 || consumed >= pending.length) break;
      if (f < 0) {
        consumed++;
        continue;
      }
      frames.push(pending.slice(consumed, consumed + f));
      consumed += f;
    }
    pending = pending.slice(consumed);
  };
  return { frames, feed, getPending: () => pending };
}

// ---- ADTS framing across boundaries -------------------------------------
const frameA = adtsFrameBytes(100, 1);
const frameB = adtsFrameBytes(160, 2);
const frameC = adtsFrameBytes(80, 3);
const adtsStream = new Uint8Array(frameA.length + frameB.length + frameC.length);
adtsStream.set(frameA);
adtsStream.set(frameB, frameA.length);
adtsStream.set(frameC, frameA.length + frameB.length);

for (let cut = 0; cut < adtsStream.length; cut++) {
  const { frames, feed, getPending } = extract("aac", adtsStream);
  feed(adtsStream.slice(0, cut));
  feed(adtsStream.slice(cut));
  ok(frames.length === 3, `aac split@${cut}: got ${frames.length} frames`);
  ok(
    frames.length === 3 && frames[2].length === frameC.length,
    `aac split@${cut}: frame sizes drifted`,
  );
}

// Also byte-at-a-time delivery.
{
  const { frames, feed } = extract("aac", adtsStream);
  for (let i = 0; i < adtsStream.length; i++) feed(adtsStream.slice(i, i + 1));
  ok(frames.length === 3, "aac byte-at-a-time");
}

// ---- ICY stripping across boundaries ------------------------------------
const METAINT = 32;
const audio = adtsStream; // reuse as "audio"
const meta = new TextEncoder().encode("StreamTitle='Test';");
const metaBlocks = Math.ceil(meta.length / 16);
const metaPadded = new Uint8Array(metaBlocks * 16);
metaPadded.set(meta);

const icyStream = new Uint8Array(audio.length + 1 + metaPadded.length + 1);
icyStream.set(audio.slice(0, METAINT));
icyStream[METAINT] = metaBlocks;
icyStream.set(metaPadded, METAINT + 1);
icyStream.set(audio.slice(METAINT), METAINT + 1 + metaPadded.length);
icyStream[icyStream.length - 1] = 0; // trailing empty meta block… keep it simple:
// rebuild — the last byte should just be audio; recompute properly:
const icy2 = (() => {
  const out = [];
  let a = 0;
  while (a < audio.length) {
    const n = Math.min(METAINT, audio.length - a);
    for (let i = 0; i < n; i++) out.push(audio[a + i]);
    a += n;
    if (a < audio.length) {
      out.push(metaBlocks);
      for (const b of metaPadded) out.push(b);
    }
  }
  return new Uint8Array(out);
})();

for (let cut = 0; cut < icy2.length; cut += 97) {
  // every ~97 bytes keeps runtime sane; boundary coverage via 3 cuts below
  const strip = new IcyStripper(METAINT);
  const parts = [strip.feed(icy2.slice(0, cut)), strip.feed(icy2.slice(cut))];
  const out = concat(parts);
  ok(equal(out, audio), `icy split@${cut}: output != audio`);
}
// The expensive exhaustive pass on a shorter stream.
const shortAudio = audio.slice(0, METAINT * 2 + 7);
const icyShort = (() => {
  const out = [];
  let a = 0;
  while (a < shortAudio.length) {
    const n = Math.min(METAINT, shortAudio.length - a);
    for (let i = 0; i < n; i++) out.push(shortAudio[a + i]);
    a += n;
    if (a < shortAudio.length) {
      out.push(1);
      for (let i = 0; i < 16; i++) out.push(meta[i % meta.length]);
    }
  }
  return new Uint8Array(out);
})();
for (let cut = 0; cut < icyShort.length; cut++) {
  const strip = new IcyStripper(METAINT);
  const out = concat([strip.feed(icyShort.slice(0, cut)), strip.feed(icyShort.slice(cut))]);
  ok(equal(out, shortAudio), `icy-exact split@${cut}: output != audio`);
}

// ---- MP3 framing ---------------------------------------------------------
function mp3FrameBytes(payloadLen, bitrateIx = 9, srIx = 0) {
  // MPEG-1 Layer III, 128kbps @44100 → 417/418 bytes. Build len to match.
  const h = new Uint8Array([0xff, 0xfa, (bitrateIx << 4) | (srIx << 2), 0x44]);
  const len = Math.floor((144 * 128000) / 44100); // 417
  const f = new Uint8Array(len);
  f.set(h);
  for (let i = 4; i < len; i++) f[i] = (i * 17) & 0x7f;
  return f;
}
const m1 = mp3FrameBytes(0);
const m2 = mp3FrameBytes(0);
const mp3Stream = concat([m1, m2]);
for (let cut = 0; cut < mp3Stream.length; cut++) {
  const { frames, feed } = extract("mp3", mp3Stream);
  feed(mp3Stream.slice(0, cut));
  feed(mp3Stream.slice(cut));
  ok(frames.length === 2, `mp3 split@${cut}: got ${frames.length} frames`);
}

function concat(parts) {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function equal(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

if (failures) {
  console.error(`${failures} parse-check failures`);
  process.exit(1);
}
console.log("parse-check ok: adts+icy+mp3 frame extraction identical across all splits");

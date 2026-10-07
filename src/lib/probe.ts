// A GET-with-abort probe: does this stream send CORS headers? A positive
// answer means the audio element may be routed through WebAudio for real
// metering. Results are cached per origin — one request per stream host.

const cache = new Map<string, Promise<boolean>>();

export function probeCors(url: string): Promise<boolean> {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return Promise.resolve(false);
  }
  const hit = cache.get(origin);
  if (hit) return hit;
  const p = (async () => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { Range: "bytes=0-0" },
      });
      ctrl.abort();
      clearTimeout(timer);
      return res.ok || res.status === 206;
    } catch {
      return false;
    }
  })();
  cache.set(origin, p);
  return p;
}

// A GET-with-abort probe: does this stream send CORS headers? A positive
// answer means the audio element may be routed through WebAudio for real
// metering. Cached by full URL — mounts on the same host can carry
// different CORS policies.

const cache = new Map<string, Promise<boolean>>();

export function probeCors(url: string): Promise<boolean> {
  if (new URLSearchParams(window.location.search).has("nocors")) {
    return Promise.resolve(false); // preview hook for the unmetered carrier
  }
  try {
    new URL(url);
  } catch {
    return Promise.resolve(false);
  }
  const hit = cache.get(url);
  if (hit) return hit;
  const p = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { Range: "bytes=0-0" },
      });
      return res.ok || res.status === 206;
    } catch {
      return false;
    } finally {
      // Abort quietly and drop the timer however the fetch ended —
      // failures previously left the 3s callback armed on dead entries.
      ctrl.abort();
      clearTimeout(timer);
    }
  })();
  // Bound the cache — a session of retuning across mounts would grow it
  // forever; oldest-first eviction is enough for a per-URL verdict.
  if (cache.size > 300) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(url, p);
  return p;
}

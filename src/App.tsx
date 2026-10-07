import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Globe } from "./components/Globe";
import {
  GeoPoint,
  Vec3,
  antipodeOf,
  formatKm,
  formatCoord,
  haversineKm,
  latLonToVec3,
  norm,
} from "./lib/geo-math";
import { resolveSignals, stationDistanceKm, Station, TuneResult } from "./lib/radio";
import { searchPlaces, describePlace, Place } from "./lib/geocode";
import { Player, PlayerState } from "./lib/player";

type Phase = "idle" | "tuning" | "tuned" | "failed";

const POLE_AXIS: Vec3 = norm([Math.sin(0.41), 0, Math.cos(0.41)]); // ~23.5deg tilt

const QUICK_PLACES = ["Madrid", "Tokyo", "Buenos Aires", "Reykjavík", "Cape Town"];

export default function App() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [log, setLog] = useState<string[]>([]);
  const [tune, setTune] = useState<TuneResult | null>(null);
  const [stationIx, setStationIx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [failMsg, setFailMsg] = useState("");
  const [copied, setCopied] = useState(false);
  const [geoDenied, setGeoDenied] = useState(false);
  const [query, setQuery] = useState("");
  const [places, setPlaces] = useState<Place[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchNote, setSearchNote] = useState<string | null>(null);
  const [lastSignalNote, setLastSignalNote] = useState(false);

  const player = useRef<Player | null>(null);
  const candidatesRef = useRef<Station[]>([]);
  const stationIxRef = useRef(0);
  const playingRef = useRef(false);
  const phaseRef = useRef<Phase>("idle");
  const runId = useRef(0);
  const searchSeq = useRef(0);

  const placeInputRef = useRef<HTMLInputElement>(null);
  const playBtnRef = useRef<HTMLButtonElement>(null);
  const failBtnRef = useRef<HTMLButtonElement>(null);

  phaseRef.current = phase;
  playingRef.current = playing;

  const pushLog = (line: string) => setLog((l) => [...l, line]);

  const tryStation = useCallback((ix: number) => {
    const c = candidatesRef.current[ix];
    if (!c) {
      setPhase("failed");
      setFailMsg("Every signal near your antipode is asleep right now.");
      return;
    }
    stationIxRef.current = ix;
    setStationIx(ix);
    setLastSignalNote(false);
    player.current?.play(c.urlResolved, c.hls === 1);
  }, []);

  const nextCandidate = useCallback(
    (note: string) => {
      if (phaseRef.current !== "tuning" && phaseRef.current !== "tuned") return;
      const next = stationIxRef.current + 1;
      if (next >= candidatesRef.current.length) {
        if (playingRef.current) {
          // The last station is still alive — keep it rather than
          // killing a working stream for an empty dial.
          pushLog("that was the last signal on the dial");
          setLastSignalNote(true);
        } else {
          player.current?.stop();
          setPhase("failed");
          setFailMsg("Every signal near your antipode is asleep right now.");
        }
        return;
      }
      if (note) pushLog(note);
      tryStation(next);
    },
    [tryStation],
  );

  const nextCandidateRef = useRef(nextCandidate);
  nextCandidateRef.current = nextCandidate;

  const onPlayerState = useCallback((s: PlayerState) => {
    if (s === "playing") {
      setPlaying(true);
      setConnecting(false);
      setPhase("tuned");
    } else if (s === "connecting") {
      setConnecting(true);
      setPlaying(false);
    } else if (s === "blocked") {
      // Autoplay was denied (e.g. arriving from a shared link). The station
      // is fine — present the card paused and let the user press Listen.
      setPlaying(false);
      setConnecting(false);
      if (phaseRef.current !== "tuned") setPhase("tuned");
    } else if (s === "error") {
      setConnecting(false);
      setPlaying(false);
      // The stream just died — mark the ref stale synchronously so an
      // exhausted dial fails instead of pretending it still plays.
      playingRef.current = false;
      nextCandidateRef.current("signal lost — trying the next frequency");
    } else {
      setPlaying(false);
      setConnecting(false);
    }
  }, []);

  useEffect(() => {
    player.current = new Player(onPlayerState);
    return () => player.current?.stop();
  }, [onPlayerState]);

  const startTune = useCallback(
    async (origin: GeoPoint) => {
      const id = ++runId.current;
      searchSeq.current++; // cancel any in-flight place search
      player.current?.stop();
      candidatesRef.current = [];
      setPhase("tuning");
      setLog([]);
      setTune(null);
      setPlaying(false);
      setConnecting(false);
      setCopied(false);
      setLastSignalNote(false);
      const anti = antipodeOf(origin);
      pushLog("piercing the planet…");

      let res: TuneResult;
      try {
        [res] = await Promise.all([
          resolveSignals(origin, anti),
          new Promise((r) => setTimeout(r, 1500)),
        ]);
      } catch {
        if (id !== runId.current) return;
        setPhase("failed");
        setFailMsg("Couldn't reach the dial — check your connection and try again.");
        return;
      }
      if (id !== runId.current) return;

      pushLog("asking the far side for its stations…");
      const tuned: TuneResult = { ...res, origin, antipode: anti };
      setTune(tuned);
      candidatesRef.current = res.candidates;

      if (res.candidates.length === 0) {
        setPhase("failed");
        setFailMsg("The other side is silent tonight — no living station found.");
        return;
      }
      pushLog(`locking signal 1 of ${res.candidates.length}…`);
      tryStation(0);
    },
    [tryStation],
  );

  const locateAndTune = useCallback(() => {
    if (!("geolocation" in navigator)) {
      setGeoDenied(true);
      return;
    }
    const id = ++runId.current;
    searchSeq.current++;
    setPhase("tuning");
    setLog([]);
    pushLog("acquiring position…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (id !== runId.current) return; // cancelled or superseded
        startTune({ lat: pos.coords.latitude, lon: pos.coords.longitude });
      },
      () => {
        if (id !== runId.current) return;
        setPhase("idle");
        setGeoDenied(true);
      },
      { timeout: 8000, maximumAge: 600000 },
    );
  }, [startTune]);

  const pickPlace = useCallback(
    (p: Place) => {
      searchSeq.current++;
      setPlaces([]);
      setQuery("");
      setSearchNote(null);
      setSearching(false);
      startTune({ lat: p.lat, lon: p.lon, label: describePlace(p) });
    },
    [startTune],
  );

  const quickPlace = useCallback(
    async (name: string) => {
      const seq = ++searchSeq.current;
      setSearching(true);
      setSearchNote(null);
      try {
        const res = await searchPlaces(name);
        if (seq !== searchSeq.current) return;
        if (res[0]) pickPlace(res[0]);
        else setSearchNote("nothing on the map by that name");
      } catch {
        if (seq === searchSeq.current) setSearchNote("place search failed — try again");
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    },
    [pickPlace],
  );

  // Debounced place search; results from superseded queries are dropped.
  // Every run bumps the sequence — including clears — so a late reply can
  // never repopulate a stale field.
  useEffect(() => {
    const seq = ++searchSeq.current;
    if (query.trim().length < 2) {
      setPlaces([]);
      setSearchNote(null);
      setSearching(false);
      return;
    }
    const q = query.trim();
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await searchPlaces(q);
        if (seq !== searchSeq.current) return;
        setPlaces(res);
        setSearchNote(res.length === 0 ? "nothing on the map by that name" : null);
      } catch {
        if (seq === searchSeq.current) {
          setPlaces([]);
          setSearchNote("place search failed — try again");
        }
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  // Restore a shared tune from the URL. Strict: both params present,
  // full-number parse, in range.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const latRaw = params.get("lat");
    const lonRaw = params.get("lon");
    if (latRaw === null || lonRaw === null) return;
    const parse = (s: string) => (/^-?\d+(\.\d+)?$/.test(s.trim()) ? Number(s) : NaN);
    const lat = parse(latRaw);
    const lon = parse(lonRaw);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || !Number.isFinite(lat + lon)) return;
    startTune({ lat, lon, label: params.get("from") ?? undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reflect the tuned state in the URL for sharing. Coordinates are coarsened
  // to two decimals (~1 km) — the link still reproduces the same tune.
  useEffect(() => {
    if (phase === "tuned" && tune) {
      const u = new URL(window.location.href);
      u.searchParams.set("lat", tune.origin.lat.toFixed(2));
      u.searchParams.set("lon", tune.origin.lon.toFixed(2));
      if (tune.origin.label) u.searchParams.set("from", tune.origin.label);
      window.history.replaceState(null, "", u.toString());
    }
  }, [phase, tune]);

  // Move focus into the arriving panel when the previous control vanished.
  useEffect(() => {
    const dead =
      document.activeElement === null ||
      document.activeElement === document.body ||
      !document.contains(document.activeElement);
    if (!dead) return;
    if (phase === "tuned") playBtnRef.current?.focus();
    else if (phase === "failed") failBtnRef.current?.focus();
    else if (phase === "idle") placeInputRef.current?.focus();
  }, [phase]);

  const axis: Vec3 = useMemo(() => {
    if (tune) return latLonToVec3(tune.origin.lat, tune.origin.lon);
    return POLE_AXIS;
  }, [tune]);

  const originVec = useMemo(
    () => (tune ? latLonToVec3(tune.origin.lat, tune.origin.lon) : null),
    [tune],
  );
  const antiVec = useMemo(
    () => (tune ? latLonToVec3(tune.antipode.lat, tune.antipode.lon) : null),
    [tune],
  );

  const station: Station | null =
    phase === "tuned" || phase === "tuning"
      ? (candidatesRef.current[stationIx] ?? null)
      : null;

  const reset = () => {
    runId.current++;
    player.current?.stop();
    candidatesRef.current = [];
    setTune(null);
    setPhase("idle");
    setLog([]);
    setPlaying(false);
    setConnecting(false);
    setLastSignalNote(false);
    const u = new URL(window.location.href);
    u.search = "";
    window.history.replaceState(null, "", u.toString());
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const stationKm = tune && station ? stationDistanceKm(station, tune.origin) : null;
  const offPointKm =
    tune && station ? stationDistanceKm(station, tune.antipode) : null;
  const nearPoint = offPointKm === null || offPointKm <= 600;

  const liveMsg =
    phase === "tuned" && station
      ? playing
        ? `Now playing ${station.name}, ${station.country || "far side"}`
        : connecting
          ? `Connecting to ${station.name}`
          : `Paused — ${station.name}`
      : phase === "failed"
        ? "The other side is quiet."
        : phase === "tuning"
          ? "Tuning."
          : "";

  return (
    <div className="shell">
      <p className="visually-hidden" aria-live="polite">
        {liveMsg}
      </p>
      <header className="top">
        <div className="wordmark">ANTÍPODA.FM</div>
        <div className="top-sub">the broadcast from underneath you</div>
      </header>

      <main>
        <section className="stage" aria-label="Earth">
          <Globe
            className="globe"
            axis={axis}
            origin={originVec}
            antipode={antiVec}
            locked={phase === "tuned" && playing}
          />
          {phase === "tuned" && station && tune && (
            <div className="dial-caption" aria-hidden="true">
              <span className="dial-you">you · {tune.origin.label ?? formatCoord(tune.origin)}</span>
              <span className="dial-far">
                {tune.land.country.name || "open ocean"} · {formatCoord(tune.antipode)}
              </span>
            </div>
          )}
        </section>

        <section className="panel">
          {phase === "idle" && (
            <div className="intro">
              <h1>
                Somewhere on the far side of the planet, a radio is playing.
              </h1>
              <p className="lede">
                Every radio app finds the station nearest you. This one points
                straight down, through the Earth, to the station broadcasting
                nearest your antipode, as far as live sound gets.
              </p>
              <div className="actions">
                <button className="btn primary" onClick={locateAndTune}>
                  Tune the other side
                </button>
                <div className="search">
                  <label className="visually-hidden" htmlFor="place">
                    or name a place
                  </label>
                  <input
                    ref={placeInputRef}
                    id="place"
                    type="text"
                    autoComplete="off"
                    placeholder="or name a place…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && places[0]) pickPlace(places[0]);
                    }}
                  />
                  {places.length > 0 && (
                    <ul className="place-list">
                      {places.map((p, i) => (
                        <li key={i}>
                          <button onClick={() => pickPlace(p)}>
                            {describePlace(p)}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
              {geoDenied && (
                <p className="note">
                  Position unavailable. Name a place instead.
                </p>
              )}
              {searchNote && <p className="note">{searchNote}</p>}
              {searching && <p className="note dim">looking…</p>}
              <div className="quick">
                {QUICK_PLACES.map((q) => (
                  <button key={q} className="chip" onClick={() => quickPlace(q)}>
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {phase === "tuning" && (
            <div className="tuning">
              <ul className="log">
                {log.map((l, i) => (
                  <li key={i} className={i === log.length - 1 ? "cur" : ""}>
                    {l}
                  </li>
                ))}
              </ul>
              {station && (
                <p className="note">
                  trying {station.name} · {station.country}
                </p>
              )}
              <button className="btn ghost" onClick={reset}>
                step back
              </button>
            </div>
          )}

          {phase === "tuned" && station && tune && (
            <div className="card">
              <div className="carrier" aria-hidden="true" data-on={playing} />
              <div className="onair">
                <span className={`dot ${playing ? "on" : ""}`} />
                {playing ? "ON AIR" : connecting ? "CONNECTING" : "PAUSED"}
              </div>
              <h2 className="station-name">{station.name}</h2>
              <p className="station-meta">
                {[station.country, station.language]
                  .filter(Boolean)
                  .join(" · ") || "somewhere far away"}
                {station.codec && station.bitrate > 0
                  ? ` · ${station.codec} ${station.bitrate}k`
                  : ""}
              </p>
              {stationKm !== null ? (
                <p className="distance">
                  ≈{formatKm(stationKm)} away over the surface
                  {nearPoint && " — nearly the span of Earth"}
                </p>
              ) : (
                <p className="distance">
                  antipode {formatKm(haversineKm(tune.origin, tune.antipode))}{" "}
                  away over the surface · station position unmapped
                </p>
              )}
              {tune.land.oceanKm !== null ? (
                <p className="note">
                  your antipode is open ocean · nearest landfall{" "}
                  {tune.land.country.name}, {formatKm(tune.land.oceanKm)} from
                  the point
                </p>
              ) : (
                <p className="note">
                  antipode {formatCoord(tune.antipode)} · {tune.land.country.name}
                </p>
              )}
              {!nearPoint && offPointKm !== null && (
                <p className="note">
                  this signal drifts {formatKm(offPointKm)} from the exact
                  point — a straggler on the dial
                </p>
              )}
              <div className="controls">
                <button
                  ref={playBtnRef}
                  className="btn primary"
                  disabled={connecting}
                  onClick={() => (playing ? player.current?.pause() : player.current?.resume())}
                >
                  {playing ? "Pause" : "Listen"}
                </button>
                <button className="btn" onClick={() => nextCandidate("")}>
                  Another signal
                </button>
                <button className="btn" onClick={copyLink}>
                  {copied ? "Copied" : "Copy link"}
                </button>
                <button className="btn ghost" onClick={reset}>
                  Elsewhere
                </button>
              </div>
              <p className="note dim">
                station {stationIx + 1} of {candidatesRef.current.length} near
                the point
                {lastSignalNote && " · last one on the dial"}
              </p>
            </div>
          )}

          {phase === "failed" && (
            <div className="failed">
              <h2>The other side is quiet.</h2>
              <p className="lede">{failMsg}</p>
              <div className="actions">
                <button ref={failBtnRef} className="btn primary" onClick={reset}>
                  Try another place
                </button>
              </div>
            </div>
          )}
        </section>
      </main>

      <footer className="foot">
        <span>stations · radio-browser.info</span>
        <span>earth · natural earth</span>
        <span>signals sometimes sleep — try another</span>
      </footer>
    </div>
  );
}

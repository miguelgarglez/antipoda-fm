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
import { Player } from "./lib/player";

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
  const searchBox = useRef<HTMLDivElement>(null);

  const player = useRef<Player | null>(null);
  const candidatesRef = useRef<Station[]>([]);
  const stationIxRef = useRef(0);
  const phaseRef = useRef<Phase>("idle");
  const runId = useRef(0);

  phaseRef.current = phase;

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
    player.current?.play(c.urlResolved);
  }, []);

  const nextCandidate = useCallback(
    (note: string) => {
      if (phaseRef.current !== "tuning" && phaseRef.current !== "tuned") return;
      const next = stationIxRef.current + 1;
      if (next >= candidatesRef.current.length) {
        setPhase("failed");
        setFailMsg("Every signal near your antipode is asleep right now.");
        return;
      }
      if (note) pushLog(note);
      tryStation(next);
    },
    [tryStation],
  );

  const nextCandidateRef = useRef(nextCandidate);
  nextCandidateRef.current = nextCandidate;

  const onPlayerState = useCallback((s: "idle" | "connecting" | "playing" | "error") => {
    if (s === "playing") {
      setPlaying(true);
      setConnecting(false);
      setPhase("tuned");
    } else if (s === "connecting") {
      setConnecting(true);
      setPlaying(false);
    } else if (s === "error") {
      setConnecting(false);
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
      setPhase("tuning");
      setLog([]);
      setTune(null);
      setPlaying(false);
      setCopied(false);
      const anti = antipodeOf(origin);

      const result: TuneResult = {
        origin,
        antipode: anti,
        candidates: [],
        land: { country: { id: "", name: "", iso2: null, polygons: [] }, oceanKm: null, nearPoint: null },
        signalKm: null,
      };
      setTune({ ...result });
      pushLog("piercing the planet…");

      const [res] = await Promise.all([
        resolveSignals(origin, anti),
        new Promise((r) => setTimeout(r, 1500)),
      ]);
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
    setPhase("tuning");
    setLog([]);
    pushLog("acquiring position…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        startTune({ lat: pos.coords.latitude, lon: pos.coords.longitude });
      },
      () => {
        setPhase("idle");
        setGeoDenied(true);
      },
      { timeout: 8000, maximumAge: 600000 },
    );
  }, [startTune]);

  const pickPlace = useCallback(
    (p: Place) => {
      setPlaces([]);
      setQuery("");
      startTune({ lat: p.lat, lon: p.lon, label: describePlace(p) });
    },
    [startTune],
  );

  const quickPlace = useCallback(async (name: string) => {
    setSearching(true);
    try {
      const res = await searchPlaces(name);
      if (res[0]) pickPlace(res[0]);
    } finally {
      setSearching(false);
    }
  }, [pickPlace]);

  // Debounced place search.
  useEffect(() => {
    if (query.trim().length < 2) {
      setPlaces([]);
      return;
    }
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        setPlaces(await searchPlaces(query.trim()));
      } catch {
        setPlaces([]);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  // Restore a shared tune from the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const lat = parseFloat(params.get("lat") ?? "");
    const lon = parseFloat(params.get("lon") ?? "");
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      startTune({ lat, lon, label: params.get("from") ?? undefined });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reflect the tuned state in the URL for sharing.
  useEffect(() => {
    if (phase === "tuned" && tune) {
      const u = new URL(window.location.href);
      u.searchParams.set("lat", tune.origin.lat.toFixed(4));
      u.searchParams.set("lon", tune.origin.lon.toFixed(4));
      if (tune.origin.label) u.searchParams.set("from", tune.origin.label);
      window.history.replaceState(null, "", u.toString());
    }
  }, [phase, tune]);

  const axis: Vec3 = useMemo(() => {
    if (tune) return latLonToVec3(tune.origin.lat, tune.origin.lon);
    return POLE_AXIS;
  }, [tune]);

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
  const headlineKm = tune
    ? (stationKm ?? haversineKm(tune.origin, tune.antipode))
    : null;
  const nearPoint = offPointKm === null || offPointKm <= 600;

  return (
    <div className="shell">
      <header className="top">
        <div className="wordmark">ANTÍPODA.FM</div>
        <div className="top-sub">the broadcast from underneath you</div>
      </header>

      <main>
        <section className="stage" aria-label="Earth">
          <Globe
            className="globe"
            axis={axis}
            origin={tune ? latLonToVec3(tune.origin.lat, tune.origin.lon) : null}
            antipode={tune ? latLonToVec3(tune.antipode.lat, tune.antipode.lon) : null}
            locked={phase === "tuned" && playing}
          />
          {phase === "tuned" && station && tune && (
            <div className="dial-caption" aria-hidden="true">
              <span className="dial-you">you · {tune.origin.label ?? formatCoord(tune.origin)}</span>
              <span className="dial-far">
                {station.name} · {formatCoord(tune.antipode)}
              </span>
            </div>
          )}
        </section>

        <section className="panel" aria-live="polite">
          {phase === "idle" && (
            <div className="intro">
              <h1>
                Somewhere on the far side of the planet, a radio is playing.
              </h1>
              <p className="lede">
                Every radio app finds the station nearest you. This one points
                straight down, through the Earth, to the station broadcasting at
                your antipode, the most distant live sound on the planet.
              </p>
              <div className="actions">
                <button className="btn primary" onClick={locateAndTune}>
                  Tune the other side
                </button>
                <div className="search" ref={searchBox}>
                  <label className="visually-hidden" htmlFor="place">
                    or name a place
                  </label>
                  <input
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
                    <ul className="place-list" role="listbox">
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
              <p className="distance">
                ≈{formatKm(headlineKm!)} away
                {nearPoint && " — through the planet"}
              </p>
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
              {!nearPoint && (
                <p className="note">
                  this signal drifts {formatKm(offPointKm!)} from the exact
                  point — a straggler on the dial
                </p>
              )}
              <div className="controls">
                <button
                  className="btn primary"
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
              </p>
            </div>
          )}

          {phase === "failed" && (
            <div className="failed">
              <h2>The other side is quiet.</h2>
              <p className="lede">{failMsg}</p>
              <div className="actions">
                <button className="btn primary" onClick={reset}>
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

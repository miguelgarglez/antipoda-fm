import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Globe } from "./components/Globe";
import { Dial } from "./components/Dial";
import { Scope } from "./components/Scope";
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
import { fetchThere, thereTime, There } from "./lib/there";
import { Guide, guideSeen } from "./components/Guide";
import { probeCors } from "./lib/probe";
import { toggleSound, staticBurst, detentClick, lockBlip } from "./lib/sound";

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
  const [copyFailed, setCopyFailed] = useState(false);
  const [geoDenied, setGeoDenied] = useState(false);
  const [query, setQuery] = useState("");
  const [places, setPlaces] = useState<Place[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchNote, setSearchNote] = useState<string | null>(null);
  const [lastSignalNote, setLastSignalNote] = useState(false);
  const [armed, setArmed] = useState(false);
  const [boreDone, setBoreDone] = useState(false);
  const [there, setThere] = useState<There | null>(null);
  const [metered, setMetered] = useState(false);
  const [prevName, setPrevName] = useState<string | null>(null); // crossfade tail
  const [snd, setSnd] = useState(false);
  const [dragHint, setDragHint] = useState(true);
  const [guideOn, setGuideOn] = useState(() => !guideSeen());
  const [guideRun, setGuideRun] = useState(0);
  // Once the dial lesson has been shown this session its slot keeps the
  // height — the tuner must never move under a resting thumb.
  const guideWasOnRef = useRef(guideOn);
  if (guideOn) guideWasOnRef.current = true;
  const [globeTouched, setGlobeTouched] = useState(false);
  const [dialTouched, setDialTouched] = useState(false);
  const [, setClock] = useState(0); // minute tick — keeps the antipode time moving
  useEffect(() => {
    if (!there) return;
    const t = window.setInterval(() => setClock((c) => c + 1), 30_000);
    return () => window.clearInterval(t);
  }, [there]);

  const player = useRef<Player | null>(null);
  const candidatesRef = useRef<Station[]>([]);
  const stationIxRef = useRef(0);
  const playingRef = useRef(false);
  const phaseRef = useRef<Phase>("idle");
  const runId = useRef(0);
  const searchSeq = useRef(0);
  const selToken = useRef(0); // invalidates in-flight probe→play continuations

  const placeInputRef = useRef<HTMLInputElement>(null);
  const playBtnRef = useRef<HTMLButtonElement>(null);
  const dialGrabX = useRef<number | null>(null);
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
    const tok = ++selToken.current;
    const cur = candidatesRef.current[stationIxRef.current];
    setPrevName(cur && cur.name !== c.name ? cur.name : null);
    stationIxRef.current = ix;
    setStationIx(ix);
    setLastSignalNote(false);
    // Silence the previous signal at once — while the probe runs, the card
    // must say CONNECTING, not keep playing the old station under the new
    // name.
    player.current?.stop();
    setPlaying(false);
    setConnecting(true);
    void (async () => {
      // Metered playback needs the stream's CORS verdict before play() wires
      // the element — a non-CORS source routed through WebAudio is muted.
      const ok = await probeCors(c.urlResolved);
      if (tok !== selToken.current) return; // superseded mid-probe
      player.current?.setAnalyse(ok);
      void player.current?.play(c.urlResolved, c.hls === 1);
    })();
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
      lockBlip(); // the lock lands when the signal does, not before
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
    player.current = new Player(onPlayerState, setMetered);
    return () => {
      selToken.current++;
      player.current?.dispose();
      player.current = null;
    };
  }, [onPlayerState]);

  const onBoreComplete = useCallback(() => {
    setBoreDone(true);
    const n = candidatesRef.current.length;
    if (n === 0) {
      setPhase("failed");
      setFailMsg("The other side is silent tonight — no living station found.");
      return;
    }
    pushLog(`locking signal 1 of ${n}…`);
    tryStation(0);
  }, [tryStation]);

  const startTune = useCallback(
    async (origin: GeoPoint) => {
      const id = ++runId.current;
      searchSeq.current++; // cancel any in-flight place search
      selToken.current++; // cancel any in-flight probe→play
      player.current?.stop();
      candidatesRef.current = [];
      setPhase("tuning");
      setLog([]);
      setTune(null);
      setPlaying(false);
      setConnecting(false);
      setCopied(false);
      setLastSignalNote(false);
      setArmed(false);
      setBoreDone(false);
      setThere(null);
      setMetered(false);
      setPendingOrigin(origin);
      const anti = antipodeOf(origin);
      pushLog("piercing the planet…");

      let res: TuneResult;
      try {
        res = await resolveSignals(origin, anti);
      } catch {
        if (id !== runId.current) return;
        setPhase("failed");
        setFailMsg(
          navigator.onLine === false
            ? "You're off the grid — the far side can't hear you right now."
            : "Couldn't reach the dial — check your connection and try again.",
        );
        return;
      }
      if (id !== runId.current) return;

      pushLog("asking the far side for its stations…");
      const tuned: TuneResult = { ...res, origin, antipode: anti };
      setTune(tuned);
      candidatesRef.current = res.candidates;
      setArmed(true); // the probe may now punch through

      // Warm the CORS verdict on the lead candidate while the probe is
      // still travelling, so the first play() doesn't wait on it.
      if (res.candidates[0]) void probeCors(res.candidates[0].urlResolved);

      // What it's like over there, once the signal is the story.
      const where = res.land.oceanKm !== null ? res.land.point : anti;
      void fetchThere(where).then((t) => {
        if (id === runId.current && t) setThere(t);
      });
    },
    [],
  );

  const locateAndTune = useCallback(() => {
    if (!("geolocation" in navigator)) {
      setGeoDenied(true);
      return;
    }
    const id = ++runId.current;
    searchSeq.current++;
    setSearching(false);
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
  // never repopulate a stale field. Results are also tagged with their
  // query: Enter may only pick what the visitor is actually looking at.
  const placesFor = useRef("");
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
        placesFor.current = q;
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
    // idle gets no autofocus — the orange action keeps first priority
  }, [phase]);

  const axis: Vec3 = useMemo(() => {
    if (tune) return latLonToVec3(tune.origin.lat, tune.origin.lon);
    if (phase === "tuning") return latLonToVec3(0, 0); // placeholder until tune lands
    return POLE_AXIS;
  }, [tune, phase]);

  // State, not a ref: the geolocation path sets phase="tuning" first and
  // fills in the origin later — the camera prelude must react when it
  // finally resolves, not stay aimed at the (0,0) placeholder.
  const [pendingOrigin, setPendingOrigin] = useState<GeoPoint | null>(null);
  const axisVec: Vec3 = useMemo(() => {
    if (pendingOrigin && phase === "tuning") {
      return latLonToVec3(pendingOrigin.lat, pendingOrigin.lon);
    }
    return axis;
  }, [axis, phase, pendingOrigin]);

  const originVec = useMemo(
    () => (tune ? latLonToVec3(tune.origin.lat, tune.origin.lon) : null),
    [tune],
  );
  const antiVec = useMemo(
    () => (tune ? latLonToVec3(tune.antipode.lat, tune.antipode.lon) : null),
    [tune],
  );

  const station: Station | null =
    phase === "tuned" || (phase === "tuning" && boreDone)
      ? (candidatesRef.current[stationIx] ?? null)
      : null;

  const reset = () => {
    runId.current++;
    selToken.current++;
    player.current?.stop();
    candidatesRef.current = [];
    setPendingOrigin(null);
    setTune(null);
    setPhase("idle");
    setLog([]);
    setPlaying(false);
    setConnecting(false);
    setLastSignalNote(false);
    setArmed(false);
    setBoreDone(false);
    setThere(null);
    setMetered(false);
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
      // denied clipboard (non-secure embed, permission) — say so, not silent
      setCopyFailed(true);
      setTimeout(() => setCopyFailed(false), 2200);
    }
  };

  const selectSignal = (i: number) => {
    if (i === stationIxRef.current || i < 0 || i >= candidatesRef.current.length) return;
    if (phaseRef.current !== "tuned" && phaseRef.current !== "tuning") return;
    setDialTouched(true);
    pushLog(`retuning to signal ${i + 1}…`);
    tryStation(i);
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

  const boring = phase === "tuning" && !boreDone;

  return (
    <div className={`shell ph-${phase}`}>
      <p className="visually-hidden" aria-live="polite">
        {liveMsg}
      </p>
      <main className="hero">
        <section
          className={`stage${boring ? " boring" : ""}${phase === "tuned" ? " on" : ""}`}
          aria-label="Earth"
        >
          <Globe
            className="globe"
            axis={axisVec}
            origin={originVec}
            antipode={antiVec}
            locked={phase === "tuned" && playing}
            boring={boring}
            armed={armed}
            onBoreComplete={onBoreComplete}
            onInteract={() => setGlobeTouched(true)}
          />
          <span className="stage-tag">antípoda.fm</span>
          <span className="stage-sub">the broadcast from underneath you</span>
          <div className="stage-ctl">
            <button
              className={`snd ${snd ? "on" : ""}`}
              onClick={() => {
                setSnd(toggleSound());
                if (!snd) detentClick();
              }}
              aria-pressed={snd}
              aria-label="Interface sounds"
              title={snd ? "Mute interface sounds" : "Enable interface sounds"}
            >
              {snd ? "FX·ON" : "FX·OFF"}
            </button>
            <button
              className="snd"
              onClick={() => {
                // A replay teaches the gestures again — the lessons it
                // carries must see untouched controls or it skips itself.
                setGlobeTouched(false);
                setDialTouched(false);
                setGuideRun((r) => r + 1);
                setGuideOn(true);
              }}
              aria-label="Replay the intro"
              title="Replay the intro"
            >
              ?
            </button>
          </div>
          {phase !== "idle" && (
            <div className="dial-caption" aria-hidden="true">
              {/* Mount from the start of tuning — the rows exist before
                  the resolver answers, so nothing shifts when they fill. */}
              <span className="dial-you">
                {tune ? `you · ${tune.origin.label ?? formatCoord(tune.origin)}` : " "}
              </span>
              <span className="dial-far">
                {tune
                  ? `${tune.land.country.name || "open ocean"} · ${formatCoord(tune.antipode)}`
                  : " "}
              </span>
            </div>
          )}
          {phase === "idle" && (
            <div className="idle-hints">
              <p className="earth-hint">12,742 km through the planet</p>
              {dragHint && !guideOn && (
                <button
                  className="drag-hint"
                  onClick={() => setDragHint(false)}
                  aria-hidden="true"
                  tabIndex={-1}
                >
                  drag the planet
                </button>
              )}
            </div>
          )}
        </section>

        {/* On small screens the opening lesson lives here in flow —
            between the planet and the headline, covering neither. The
            space is reserved while the guide owns it so the headline
            never shifts when the row appears. */}
        <div
          className={`guide-intro-slot${guideOn && phase === "idle" ? " reserved" : ""}`}
        />

        <section className="panel">
          {phase === "idle" && (
            <div className="intro">
              <h1>
                Somewhere on the far side of the planet, a radio is playing.
              </h1>
              <p className="lede">
                Straight down through the Earth, to the station broadcasting
                nearest your antipode.
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
                      if (
                        e.key === "Enter" &&
                        places[0] &&
                        placesFor.current === query.trim()
                      )
                        pickPlace(places[0]);
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
              <p className="quick">
                {QUICK_PLACES.map((q, i) => (
                  <span key={q}>
                    {i > 0 && <span className="quick-sep">·</span>}
                    <button className="place-link" onClick={() => quickPlace(q)}>
                      {q}
                    </button>
                  </span>
                ))}
              </p>
            </div>
          )}

          {phase === "tuning" && (
            <div className="tuning">
              <ul className="log">
                {/* One beat at a time: the previous line stays as memory,
                    the current line owns the readout. */}
                {log.slice(-2).map((l, i, arr) => (
                  <li key={`${log.length - arr.length + i}-${l}`} className={i === arr.length - 1 ? "cur" : ""}>
                    {l}
                  </li>
                ))}
              </ul>
              {station && (
                <p className="note">
                  trying {station.name} · {station.country}
                </p>
              )}
              <Dial
                count={candidatesRef.current.length}
                index={stationIx}
                sweeping={!boreDone}
                live={false}
                onSelect={selectSignal}
                onMove={() => snd && staticBurst(90, 0.028)}
                label="searching the band"
              />
              <button className="btn ghost" onClick={reset}>
                step back
              </button>
            </div>
          )}

          {phase === "tuned" && station && tune && (
            <div className="card">
              <div className="onair">
                <span className={`dot ${playing ? "on" : ""}`} />
                {playing ? "ON AIR" : connecting ? "CONNECTING" : "PAUSED"}
              </div>
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
                  ≈{formatKm(stationKm)} over the surface
                  {nearPoint && " — nearly the span of Earth"}
                </p>
              ) : (
                <p className="distance">
                  antipode {formatKm(haversineKm(tune.origin, tune.antipode))}{" "}
                  away over the surface · station position unmapped
                </p>
              )}
              <p className="bore-line">signal path 12,742 km — through the mantle and core</p>
              <Scope
                className="scope"
                player={player.current}
                active={playing}
                connecting={connecting}
                metered={metered}
              />
              {playing && !metered && (
                <p className="scope-note">
                  carrier live — this stream can’t feed the meter
                </p>
              )}
              <div
                className={`dial-lesson-slot${guideWasOnRef.current ? " held" : ""}`}
              />
              <div
                className="dial-wrap"
                onPointerDownCapture={(e) => {
                  dialGrabX.current = e.clientX;
                }}
                onPointerMoveCapture={(e) => {
                  // the lesson completes on real travel, not a resting thumb
                  if (dialGrabX.current !== null && Math.abs(e.clientX - dialGrabX.current) > 12) {
                    dialGrabX.current = null;
                    setDialTouched(true);
                  }
                }}
                onPointerUpCapture={() => {
                  dialGrabX.current = null;
                }}
                onPointerCancelCapture={() => {
                  dialGrabX.current = null;
                }}
              >
                {/* The name is the tuner's identification plate — it
                    belongs on the instrument, not the document. */}
                <div className="dial-plate">
                  <h2 className="station-name">
                    {prevName && prevName !== station.name && (
                      <span
                        className="stn-old"
                        onAnimationEnd={() => setPrevName(null)}
                      >
                        {prevName}
                      </span>
                    )}
                    <span className="stn-new" key={station.name}>
                      {station.name}
                    </span>
                  </h2>
                </div>
                <Dial
                  count={candidatesRef.current.length}
                  index={stationIx}
                  sweeping={false}
                  live={playing}
                  onSelect={selectSignal}
                  onMove={() => snd && staticBurst(90, 0.028)}
                  onLock={() => {
                    if (snd) detentClick();
                  }}
                  label={station.name}
                />
              </div>
              {tune.land.oceanKm !== null ? (
                <p className="note">
                  your antipode is open ocean · nearest landfall{" "}
                  {tune.land.country.name}, {formatKm(tune.land.oceanKm)} from
                  the point
                </p>
              ) : (
                <p className="note anti-coord">
                  antipode {formatCoord(tune.antipode)} · {tune.land.country.name}
                </p>
              )}
              {there && (
                <p className="there">
                  {there.isDay ? "☀" : "☾"}{" "}
                  {tune.land.oceanKm !== null
                    ? `${tune.land.country.name} reads `
                    : "there it's "}
                  <b>{thereTime(there.tz)}</b>, {there.tempC}°, {there.phrase}
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
                  className={`play-btn${playing ? " on" : ""}`}
                  disabled={connecting}
                  onClick={() => (playing ? player.current?.pause() : player.current?.resume())}
                  aria-label={
                    playing ? "Pause the broadcast" : connecting ? "Connecting" : "Listen"
                  }
                  title={playing ? "Pause" : "Listen"}
                >
                  {playing ? (
                    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                      <rect x="6" y="5" width="4" height="14" fill="currentColor" />
                      <rect x="14" y="5" width="4" height="14" fill="currentColor" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                      <path d="M8 5v14l11-7z" fill="currentColor" />
                    </svg>
                  )}
                </button>
                <button
                  className={`icon-btn${copyFailed ? " bad" : ""}`}
                  onClick={copyLink}
                  aria-label={
                    copyFailed ? "Couldn't copy — copy the address bar" : copied ? "Link copied" : "Copy a link to this signal"
                  }
                  title={copyFailed ? "Couldn't copy — the address bar has the link" : copied ? "Copied" : "Copy link"}
                >
                  {copied ? (
                    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                      <path
                        d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"
                        fill="currentColor"
                      />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                      <path
                        d="M10.6 13.4a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                      />
                      <path
                        d="M13.4 10.6a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                      />
                    </svg>
                  )}
                </button>
                <button className="link-btn" onClick={reset}>
                  elsewhere
                </button>
                {copyFailed && (
                  <span className="copy-note" role="status">
                    couldn’t copy — the address bar has the link
                  </span>
                )}
              </div>
              {lastSignalNote && (
                <p className="note dim">last signal on the dial</p>
              )}
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

      {guideOn && (
        <Guide
          key={guideRun}
          phase={phase}
          globeTouched={globeTouched}
          dialTouched={dialTouched}
          onDone={(learned) => {
            setGuideOn(false);
            if (learned) setDragHint(false); // a bowed-out guide leaves the hint
          }}
        />
      )}

      <footer className="foot">
        <details className="sources">
          <summary>sources</summary>
          <p>
            stations · radio-browser.info · earth · natural earth · weather ·
            open-meteo
          </p>
        </details>
        <span className="foot-hint">
          {phase === "idle" ? "drag the planet" : "arrows or drag tune the dial"}
        </span>
      </footer>
    </div>
  );
}

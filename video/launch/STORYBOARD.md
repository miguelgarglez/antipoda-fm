---
format: 1920x1080
duration: 30s
message: "The radio station playing at the exact opposite point of the Earth from you"
arc: Hook → Touch → Transit → Arrival → URL
audience: makers and radio-curious on X
mode: autonomous
music: none
---

## Frame 1 — A radio underneath you

- scene: Cold open on the real product — planet drifting with orange guide arcs on its limb; the hook line lands over it
- duration: 3.4s
- poster: 2s
- transition_in: cut
- status: outline
- src: compositions/frames/01-hook.html
- asset_candidates: assets/session-1080.mp4 — [video] 29s real product session at 1920x1080: idle guide arcs, drag+wheel, Madrid tune, bore, ON AIR, dial retune

Footage session-1080.mp4, media_start 0s → 3.4s, full-bleed. The product's own first-run guide arcs already ring the planet — the footage carries the "grab me" cue by itself.

Text (seek-safe, GSAP):
- kicker (IBM Plex Mono, upper, signal orange): "ANTÍPODA.FM" — fades in at 0.2s, top-left safe zone.
- headline (Fraunces italic, cream, ~72px, lower-left): "somewhere on the far side of the planet, a radio is playing." — rises in 0.4–1.4s, ease-out; subtle.
Both texts sit over the dark right side of frame (the product's own panel area is dim there). Text opacity keeps footage readable — headline is the focal element, footage is ground.

## Frame 2 — It's a body

- scene: Real drag + wheel-zoom footage — the planet turns under the cursor and approaches
- duration: 5.2s
- poster: 3s
- transition_in: cut
- status: outline
- src: compositions/frames/02-body.html
- asset_candidates: assets/session-1080.mp4 — [video] 29s real product session at 1920x1080: idle guide arcs, drag+wheel, Madrid tune, bore, ON AIR, dial retune

Footage session-1080.mp4, media_start 3.4s → 8.6s, full-bleed, continuous with frame 1 (same element geometry — see handoff). The cursor drags the planet, it glides on release, wheel zooms in and back.

Text: one mono label lower-left, "drag it — the planet is a body" in IBM Plex Mono 24px signal-orange, fades in 0.2s, out at -0.6s before cut. No other chrome; the interaction is the content.

handoff_in: session-1080.mp4, full-bleed, scale 1, opacity 1, playing continuously from 3.4s
handoff_out: session-1080.mp4, full-bleed, scale 1, opacity 1, at media time 8.6s

## Frame 3 — Through the planet

- scene: Madrid link clicked; camera flies to the origin, the Earth opens molten, the probe crosses the core with the km counter running
- duration: 6s
- poster: 4s
- transition_in: cut
- status: outline
- src: compositions/frames/03-bore.html
- asset_candidates: assets/session-1080.mp4 — [video] 29s real product session at 1920x1080: idle guide arcs, drag+wheel, Madrid tune, bore, ON AIR, dial retune

Footage media_start 8.6s → 14.6s. This is the signature moment — the planet splits, the probe descends through mantle and core, "x / 12,742 km" counts under the disc, exit flare on punch-out.

Text: mono label top-center fades in at 2.2s (as the planet opens): "12,742 km through the planet" — phosphor #7CFFB2, 26px, letterspaced. Holds through the crossing, fades at -0.5s.

handoff_in: session-1080.mp4, full-bleed, scale 1, opacity 1, from media 8.6s
handoff_out: session-1080.mp4, full-bleed, scale 1, opacity 1, at media 14.6s

## Frame 4 — The other side answers

- scene: Camera swings around the planet, New Zealand marker pulses, ON AIR lights, the real station card settles with the circular transport
- duration: 5.4s
- poster: 3s
- transition_in: cut
- status: outline
- src: compositions/frames/04-there.html
- asset_candidates: assets/session-1080.mp4 — [video] 29s real product session at 1920x1080: idle guide arcs, drag+wheel, Madrid tune, bore, ON AIR, dial retune

Footage media_start 14.6s → 20s. The reveal swing lands on the antipode; the product's own ON AIR dot and station name carry the arrival.

Text: Fraunces italic cream 56px, right side, "the live station nearest your antipode" — rises in at 1.2s when the reveal settles, holds, fades -0.5s.

handoff_in: session-1080.mp4, full-bleed, scale 1, opacity 1, from media 14.6s
handoff_out: session-1080.mp4, full-bleed, scale 1, opacity 1, at media 20s

## Frame 5 — antipoda-fm.vercel.app

- scene: The dial drags to another signal, the broadcast holds; the URL lands over the drifting planet and stays
- duration: 9.2s
- poster: 7s
- transition_in: cut
- status: outline
- src: compositions/frames/05-url.html
- asset_candidates: assets/session-1080.mp4 — [video] 29s real product session at 1920x1080: idle guide arcs, drag+wheel, Madrid tune, bore, ON AIR, dial retune

Footage media_start 20s → 29.16s (end). The dial drag around 20–23s proves the product is a working instrument; then it settles.

Text: at 5.5s of the frame the URL rises in center — "antipoda-fm.vercel.app" — IBM Plex Mono, bone #F2EEE3, 40px, tracking 0.12em, with a thin signal-orange underline rule that draws left→right over 400ms. Above it, small mono label "live radio · the far side of you". Both hold to the end; footage keeps breathing behind (vignette darkens edges to 0.55 ink for legibility).

handoff_in: session-1080.mp4, full-bleed, scale 1, opacity 1, from media 20s

## Video direction

- Silent film: `music: none`, no narration, no SFX. Type and the product's own motion carry it.
- One continuous piece of real product footage plays across all five frames; frame boundaries are clean cuts at fixed media offsets — the element never moves (full-bleed, scale 1, opacity 1), so handoffs need no choreography beyond matching media_start to the previous frame's exit time.
- Hook inside 2s: frame 1's headline lands by 1.4s over a planet already wearing its guide arcs.
- Type voice matches the product: Fraunces italic for sentences (hushed, awed), IBM Plex Mono uppercase letterspaced for data/chrome; signal orange = attention, phosphor = live/earned, bone = body.
- No invented UI, no mockups — every pixel of product shown is the real build.

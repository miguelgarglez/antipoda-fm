# Frame packet: 02-body

## Project inputs

- Project: /Users/miguelgarglez/Developer/antipoda-fm/video/launch
- Design tokens: /Users/miguelgarglez/Developer/antipoda-fm/video/launch/frame.md
- RULES_DIR: /Users/miguelgarglez/.agents/skills/hyperframes-animation/rules

## Assigned storyboard block

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

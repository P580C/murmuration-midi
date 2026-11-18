# Murmuration MIDI — project context

A generative MIDI controller: a starling-murmuration simulation in the browser whose flock behaviour becomes CC streams for a DAW or VCV Rack. The original brief is [murmuration-midi-spec.md](murmuration-midi-spec.md) (milestones, open decisions, risks). Keep this file updated as work lands.

## Commands

```sh
npm run dev              # Vite dev server, opens http://localhost:5190 (5173 is used by another local project)
npm run build            # tsc --noEmit + vite build
npm test                 # headless MIDI engine / slot mapping tests (tools/midi-test.ts)
npm run metrics:flight   # flock behaviour metrics: corners, wall-hugging, circling index, coverage
npm run metrics:bounds   # birds outside / near the edge under stress configs (slow, ~1-2 min)
npm run metrics:streams  # descriptor values over 24 s + ms/step for 1200 and 4000 birds
```

Debug URL params: `?warmup=<s>&strikeAt=<s>` pre-runs the sim (for screenshots), `?tab=midi` opens a tab.
Visual checks: build, `vite preview`, then headless Chrome `--screenshot` with `?warmup=`. rAF barely advances in headless, so warmup is what makes screenshots meaningful.

## Architecture

```
src/sim/       pure simulation, no DOM (can move to a worker later)
  params.ts      user params + defaults + limits (max 4000 birds, 20 neighbours)
  grid.ts        uniform spatial grid via counting sort
  flock.ts       3D boids in a shallow slab: k-nearest (topological) neighbours, panic + turning-wave propagation, containment, banking turns
  predator.ts    threat agent: spawns off-screen, homes on one bird with limited turn rate, leaves
  descriptors.ts 0-1 stream sources computed every step
  world.ts       owns flock + predator + nav target; triggers turning waves; fixed 60 Hz step; auto strike
src/midi/      slots.ts (pure mapping), output.ts (Web MIDI out, CC + timestamped notes), engine.ts (throttle + learn),
               clock.ts (MIDI clock in + internal fallback), triggers.ts (panic → quantised notes)
src/render/    canvas 2D renderer (reads the world only); flattens the 3D slab with depth cues + additive blending
src/ui/        placeholder controls, meters, MIDI panel. To be replaced by the Figma build
src/ticker.ts  Web Worker interval: drives sim + MIDI so they keep running when the window is hidden
src/main.ts    wiring; sim/MIDI on the worker tick, drawing on requestAnimationFrame
tools/         headless test + metric scripts (bundled with esbuild via tools/run.mjs)
```

## Decisions made (beyond the spec)

- **Stack:** Vite + TypeScript, no framework. The sim is kept separate from the UI so the Figma designs can replace `src/ui/` freely.
- **Fixed 60 Hz sim step** with an accumulator. Panic spreads one neighbour-hop per step, so a fixed rate keeps wave speed independent of display refresh.
- **Double-buffered** velocities and panic, so update order doesn't matter.
- **Panic waves:** birds near the predator panic directly; others copy panic × 0.9 and the escape heading from their most-panicked neighbour. This gives the rippling escape waves. Panicked birds speed up, turn tighter and are drawn brighter.
- **Sim + MIDI run on a worker timer**, not requestAnimationFrame. Chrome stops rAF when the window is hidden or covered (e.g. by the DAW), which would freeze CC output.
- **MIDI:** 8 slots, default CC 20-27 on channel 1 (undefined CCs). Pipeline: smoothing → invert → curve (linear/exp) → min/max → round. A CC is sent only when its integer value changes. Learn mutes the other slots and resends every 250 ms. Port, slots and active tab are kept in localStorage (guarded).
- **Extra stream "Panic"** (mean panic) added beyond the spec's list.
- **Swirl** is signed (0.5 = none). **Turbulence** is local heading disagreement, deliberately different from global Alignment.
- **Centre X/Y** are normalised to the sky ellipse's bounding box, not the window, so they still span 0-1.
- **3D slab, drawn flattened:** birds have x, y and z. Depth = 50% of the smaller screen dimension. The renderer draws near birds longer, thicker and brighter, foreshortens birds flying toward or away from the viewer, and uses additive blending so edge-on parts of the flock read as dense bright bands. This is what makes it look like a murmuration rather than a 2D school. kNN uses the x/y grid with 3D distances (the ring stopping rule still holds).
- **Turning waves:** direction changes start with ~2% of birds on a random edge of the flock taking up a new heading. Neighbours copy it (× 0.96 per hop, one hop per step, decay 1/s), so the turn sweeps through the flock and it folds and morphs. This uses the same `Signal` propagation as panic.
- **When turns happen (world.ts `updateNav`):** every 3-8 s, when the flock reaches its target, or when its predicted centroid passes 70% of the sky ellipse (1.5 s cooldown). Boundary turns pick a target that reverses the flock's rotation about the centre 75% of the time. Without that, every inward turn keeps the same rotation and the flock orbits; boundary-following was the root cause of the "fish in a tank" look.
- **Containment layers:** (1) weak pull (0.2) toward the nav target; (2) a sky ellipsoid (36% × 34% of the view, 40% of the slab depth) with a strong pull back once a bird's predicted position leaves it; (3) a thin last-resort edge zone (7%, and the slab's front/back) plus a hard clamp 6 px from the window edge. Birds never flee outward near an edge, and noise fades in the edge zone.
- **Banking turns:** sideways acceleration is capped at v²/r_min, with r_min = 0.25 s × cruise speed, halved when panicking.
- **Clock (milestone 5):** listens on any input or a chosen one (or internal only). 24 ppqn; Start → next pulse is tick 0 (downbeat); Continue/Stop honoured; Song Position Pointer jumps. BPM is smoothed over about a beat. If no pulse arrives for 600 ms it falls back to the internal clock at the manual BPM and keeps counting from the same position. Ticks carry timestamps (performance.now() base). 4/4 is assumed. The internal clock is polled from the 120 Hz worker tick, so it has up to ~8 ms jitter; external ticks are handled on arrival.
- **Threat timing:** `threat.mode` is manual / timer / bars. "On the bar" strikes on the downbeat every N bars of the clock, and only while the clock is running.
- **Panic triggers:** the flock counts birds whose panic crosses `panicThreshold` upward (`takePanicOnsets()`); a bird can trigger again after it calms down. One strike can produce 1000+ onsets, so by default onsets are quantised (1/16): all onsets within a grid step become one note, with velocity scaling with the count ("burst", log scale, 1 bird ≈ 30%, 60+ = 100% of Vel). With quantise off they are rate-limited (max N/s). Note on/off are scheduled with Web MIDI timestamps; the gate is clamped below the grid step so repeats don't cut each other. Triggers are muted while a CC slot is learning. Defaults: ch 1, note 36, gate 20 ms. Settings persist with the MIDI state.
- **Descriptors in 3D:** Speed, Alignment, Turbulence and Threat distance use 3D motion. Centre, Spread and Swirl use on-screen x/y so they match what you see.

## Status

Done: spec milestones 1-5 (single flock sim, threat, stream meters, MIDI out with learn, MIDI clock in + bar-synced strikes), plus containment/3D work and panic triggers (an extra output the user asked for). `npm test` runs 36 checks.

Measured (`npm run metrics:flight` / `metrics:bounds`, default settings, auto strike every 10 s):

| Metric | Original 2D | 2D + shared target ("blob") | Now (3D + turning waves) |
|---|---|---|---|
| Birds outside window | ~2% (10% fast + noisy) | 0% | 0% |
| Centroid in a corner | 5.4% | 0% | 0% |
| Circling index (1 = always same way) | 0.94 | 0.70 | 0.67 |
| Aspect-ratio sd (shape morphing) | n/a | 0.41 | 0.56 |
| Mean alignment | n/a | 0.93 | 0.87 |

Performance: 1.5 ms/step for 1200 birds, 6.3 ms/step for 4000 (Node). Fine at 60 Hz, though 4000 uses about 40% of a core.

## Open issues / next up

- **Flock look:** reworked to 3D + turning waves after the user reported "fish in a tank" (edge-hugging, circling, corners). Screenshots now show ribbons, folds and density bands. Wait for user feedback before tuning further. Possible next levers: density (more birds by default, smaller separation), wave initiation rate, slab depth.
- 4000 birds costs 6.3 ms/step. If that's a problem, move the sim to a worker or use WebGL rendering.
- Clock has not been tested against a real DAW or VCV Rack yet, only with simulated messages. VCV Rack's Core CV-MIDI may provide clock output (to verify).
- Milestone 7's "MIDI note launches a strike" must not listen to the port the app sends panic triggers on, or the triggers would loop back.
- Spec ideas not done yet: speed scaling with BPM, randomness waves lasting N bars, flock-driven tempo.
- Milestone 6: 2-4 flocks + interaction slider (slots already carry a `flock` field, always 0 for now).
- Milestone 7: presets (JSON), 14-bit/NRPN/OSC (open decision), MIDI input to trigger the threat.
- The Figma link is still missing; the UI is placeholder.

## Working notes

- The user uses Chrome on macOS, with VCV Rack and DAWs via the IAC Driver.
- Verify sim changes headlessly with the tools/ metrics before and after, then screenshot. Visual impressions and metrics have disagreed before (edge-band % was low while the flock visibly wall-followed), so check both.

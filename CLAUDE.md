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
  flock.ts       boids: k-nearest (topological) neighbours, panic propagation, containment, banking turns
  predator.ts    threat agent: spawns off-screen, homes on one bird with limited turn rate, leaves
  descriptors.ts 0-1 stream sources computed every step
  world.ts       owns flock + predator + nav target; fixed 60 Hz step; auto strike
src/midi/      slots.ts (pure mapping), output.ts (Web MIDI), engine.ts (throttle + learn)
src/render/    canvas 2D renderer (reads the world only)
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
- **Containment (current):** (1) every bird is pulled toward a shared nav target in the central sky that the World moves every 3-8 s, chosen 50-140° to a random side of the flock's heading; (2) a sky ellipse (36% × 34% radii) with a strong pull back once a bird's predicted position leaves it; (3) a thin last-resort edge zone (7%) plus a hard clamp 6 px from the edge. Birds never flee outward near an edge, and noise fades in the edge zone.
- **Banking turns:** sideways acceleration is capped at v²/r_min, with r_min = 0.25 s × cruise speed, halved when panicking.

## Status

Done: spec milestones 1-4 (single flock sim, threat, stream meters, MIDI out with learn), plus containment work.

Measured (`npm run metrics:flight`, default settings, auto strike every 10 s):

| Metric | Before containment rework | Now |
|---|---|---|
| Birds outside window | ~2% (10% when fast + noisy) | 0% |
| Centroid in a corner | 5.4% | 0% |
| Circling index (1 = always turning the same way) | 0.94 | 0.68 |

## Open issues / next up

- **Flock look is the top issue.** The user reported it looked like "fish in a tank": hugging edges, circling, heading into corners. Containment and circling are fixed, but the flock is now a tight, very aligned blob (alignment ≈ 0.98, turbulence ≈ 0), not murmuration-like. Candidate fixes:
  - Pseudo-3D: simulate a z axis in a thin slab and project, so the flock appears to fold and change density. The spec allows 3D later.
  - Turning waves started by edge birds (reuse the panic-propagation mechanism with a heading but no speed-up), instead of every bird steering to the same nav point.
  - Lower NAV_WEIGHT now that the sky ellipse handles containment, and looser cohesion/separation.
  - Track it with `metrics:flight`, and add a metric for shape/density variation.
- Milestone 5: MIDI clock in (24 ppqn, Start/Stop/Continue), BPM fallback, clock-synced strikes. VCV Rack's Core CV-MIDI may provide clock (to verify).
- Milestone 6: 2-4 flocks + interaction slider (slots already carry a `flock` field, always 0 for now).
- Milestone 7: presets (JSON), 14-bit/NRPN/OSC (open decision), MIDI input to trigger the threat.
- The Figma link is still missing; the UI is placeholder.

## Working notes

- The user uses Chrome on macOS, with VCV Rack and DAWs via the IAC Driver.
- Verify sim changes headlessly with the tools/ metrics before and after, then screenshot. Visual impressions and metrics have disagreed before (edge-band % was low while the flock visibly wall-followed), so check both.

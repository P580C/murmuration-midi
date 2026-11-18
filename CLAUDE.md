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
src/midi/      slots.ts (pure mapping), output.ts (Web MIDI), engine.ts (throttle + learn)
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
- **Descriptors in 3D:** Speed, Alignment, Turbulence and Threat distance use 3D motion. Centre, Spread and Swirl use on-screen x/y so they match what you see.

## Status

Done: spec milestones 1-4 (single flock sim, threat, stream meters, MIDI out with learn), plus containment work.

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
- Milestone 5: MIDI clock in (24 ppqn, Start/Stop/Continue), BPM fallback, clock-synced strikes. VCV Rack's Core CV-MIDI may provide clock (to verify).
- Milestone 6: 2-4 flocks + interaction slider (slots already carry a `flock` field, always 0 for now).
- Milestone 7: presets (JSON), 14-bit/NRPN/OSC (open decision), MIDI input to trigger the threat.
- The Figma link is still missing; the UI is placeholder.

## Working notes

- The user uses Chrome on macOS, with VCV Rack and DAWs via the IAC Driver.
- Verify sim changes headlessly with the tools/ metrics before and after, then screenshot. Visual impressions and metrics have disagreed before (edge-band % was low while the flock visibly wall-followed), so check both.

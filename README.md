# Murmuration MIDI

A generative MIDI controller driven by a starling-murmuration simulation. See [murmuration-midi-spec.md](murmuration-midi-spec.md) for the full brief.

## Status: v0.3 (spec milestones 1–5)

- **Single flock:** boids where each bird reacts to its *k* nearest neighbours (topological, default 7), using a spatial grid. Measured at about 0.8 ms/step for 1,200 birds and 3 ms for 4,000 (Node, M-series).
- **Threat:** a predator that homes on one bird, then leaves. Birds near it panic, and the panic (with an escape heading) is relayed bird-to-bird, so escapes ripple through the flock as waves. Panicked birds are drawn brighter. You can trigger it with the Strike button, with Space, by clicking a bird, or on an auto timer.
- **Stream sources:** live meters and 10 s sparklines for Centre X/Y, Spread, Speed, Alignment, Swirl, Turbulence and Threat distance, plus Panic (an extra source not in the spec).
- **MIDI out:** port picker, 8 slots (source, channel, CC, min/max, smoothing, linear/exp curve, invert, enable), CC sent only when the 0–127 value changes, and per-slot MIDI learn (only that slot sends; it resends every 250 ms so the DAW always sees it; Esc stops). The defaults are CCs 20–27 on channel 1. Mappings and the chosen port are saved in this browser.
- **Clock in:** follows MIDI clock (24 ppqn, Start/Stop/Continue/Song Position) from a DAW or VCV Rack, with an internal BPM fallback. The threat can strike on the downbeat every N bars.
- **Panic triggers:** a MIDI note each time birds cross into panic, quantised to the clock (default 1/16). Velocity rises with how many birds panicked in that step. With quantise off, notes are rate-limited instead.
- **Keeps running behind the DAW:** the sim and MIDI are driven by a worker timer, not `requestAnimationFrame`, so output continues when the browser window is hidden or covered.

## MIDI setup

1. **macOS:** open Audio MIDI Setup → Window → Show MIDI Studio → double-click **IAC Driver** → tick *Device is online*. **Windows:** install [loopMIDI](https://www.tobias-erichsen.de/software/loopmidi.html) and add a port.
2. In the app, open the **MIDI** tab, allow MIDI access when Chrome asks, and pick that port.
3. In your DAW, enable the same port as a MIDI input (for control/remote messages).
4. For clock: set your DAW to send MIDI clock to the same IAC port (Ableton: Preferences → Link/Tempo/MIDI → Output "Sync"). The MIDI tab shows "External clock" with the BPM and bar.
5. For panic triggers: press **Send test note** to map it, then use a drum rack pad (DAW) or **MIDI-Gate** (VCV Rack).
6. To map a parameter: arm MIDI learn in the DAW, press **Learn** on a slot, then press Esc (or Learn again) once the DAW has picked it up.

## Run

```sh
npm install
npm run dev        # opens http://localhost:5190
npm run build      # typecheck + production build
npm test           # headless MIDI engine tests
npm run metrics:flight   # flock behaviour metrics (see CLAUDE.md)
```

Debug: `?warmup=20&strikeAt=17` pre-runs the sim for 20 s (striking at 17 s) before the first frame. `?tab=midi` opens a tab.

## Layout

```
src/
  sim/        simulation only, with no DOM: safe to move into a worker later
    params.ts       user parameters + defaults
    grid.ts         spatial hash (counting sort)
    flock.ts        boids + k-nearest + panic propagation
    predator.ts     threat agent
    descriptors.ts  normalised 0–1 stream sources
    world.ts        ties it together, fixed 60 Hz step, auto strike
  midi/       slot mapping (pure), Web MIDI output, engine (throttle + learn)
  render/     canvas renderer (reads the world, never writes)
  ui/         placeholder controls + meters, to be replaced by the Figma build
  ticker.ts   worker-driven tick that survives background throttling
  storage.ts  guarded localStorage helpers
  main.ts     wiring + loops
```

## Notes on the descriptors

- **Swirl** is signed: 0.5 means no milling, higher means clockwise, lower means anticlockwise.
- **Turbulence** is *local* heading disagreement (each bird vs. its neighbours). It differs from Alignment, which is global: a milling flock has low Alignment but low Turbulence.
- **Speed** sits around 0.5 at cruise and rises toward 1 when the flock panics.
- **Threat distance** reads 1 when there is no predator.

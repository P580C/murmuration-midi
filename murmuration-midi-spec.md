# Murmuration MIDI - Project Spec

An experimental generative MIDI controller that simulates starling murmurations and turns flock behaviour into control data for a DAW. Think of it as an organic bank of LFOs driven by emergent flocking, not a hands-on controller.

Status: exploration done, nothing built yet. Use this doc as the brief for Claude Code.

---

## Decisions so far

- **The DAW is the clock master.** The app never generates MIDI clock. It listens to incoming clock for tempo and bar position, and falls back to a user-set BPM when there's no clock.
- **Output is mainly CCs.** CC timing isn't critical, so jitter doesn't matter. Any note or trigger events get quantised to the incoming clock.
- **Starling-style neighbours.** Each bird reacts to its ~7 nearest neighbours (topological), not to everything inside a radius. This is what produces the rippling waves.
- **A threat/predator is a core feature.** Without one, the flock settles into a calm, aligned blob. The threat keeps it alive.
- **Multiple flocks.** A fixed number of 2-4 flocks, each with its own parameters and colour, which can interact with each other.
- **Up to 8 output streams.** These are 8 assignable data streams (typically CCs), not 8 MIDI channels.

- **Platform: web.** UI look and feel is a priority, and the UI will be custom-designed in Figma, so it needs to be implementable with real HTML/CSS. Use Web MIDI in Chrome/Edge (Safari has no native support). Since the DAW owns the clock, browser timing is fine.
  - Rendering: a canvas (2D, or WebGL if bird counts get high) for the flock, with an HTML/CSS UI on top built from the Figma designs.
  - Optional later: wrap it in Electron/Tauri as a desktop app (no browser permission prompt, nothing tied to a browser).

## Open decisions

- **Output resolution:** 7-bit CC only, or also 14-bit CC / NRPN / OSC to avoid stepping on slow sweeps.
- **Flock-driven tempo:** an optional CC mapped to DAW tempo over a narrow range (e.g. 110-130). It's questionable musically, so test it before committing.

---

## Simulation

### Per-flock parameters (user controls)
- Bird count
- Speed
- Randomness (noise term)
- Rule weights: separation, alignment, cohesion (advanced/hidden)
- Neighbour count (default 7)

### Global controls
- **Inter-flock interaction:** a single slider, ignore -> avoid -> attract/merge
- **Threat:** a predator agent that birds flee. It can be triggered manually, run on a timer, or strike in sync with the clock (e.g. on the bar). It should also accept MIDI input, so a note can launch an attack and the flock can be "played".
- **Bounds / home point:** a soft force that keeps flocks on screen

### Implementation notes
- Boids (Reynolds): separation, alignment, cohesion, plus noise and threat avoidance.
- Spatial grid / hash for neighbour lookup. A few thousand birds should run on the CPU at 60 fps.
- 2D first. 3D is optional later; it looks better, but it adds rendering and UI cost.
- Bird identity stays fixed per flock even if flocks overlap or merge.

---

## Stream sources (what can be mapped)

Aggregate descriptors per flock, computed each frame and normalised to 0-1:

| Source | Description |
|---|---|
| Centre X / Y | Flock centroid position |
| Spread | Average distance from the centroid (density / breathing) |
| Speed | Mean velocity magnitude |
| Alignment | Polarisation order parameter (0 = chaotic, 1 = all heading the same way) |
| Swirl | Angular momentum around the centroid (milling) |
| Turbulence | Variance of velocities / rate of change of alignment |
| Threat distance | Distance from the flock centre to the predator |

Cross-flock sources:
- Distance between two flocks
- Overlap / merge amount

Event sources (optional, quantised to clock):
- Threat strike
- A flock crossing a user-drawn line or zone
- Alignment crossing a threshold

---

## Output mapping

- Up to **8 output slots**
- Each slot has: source, flock, MIDI channel, CC number, min/max range, smoothing amount, curve (linear/exp), and invert
- Throttle sends so a CC only goes out when its value changes
- Optional 14-bit CC / NRPN / OSC per slot (see open decisions)
- MIDI learn button per slot so it's easy to map in the DAW (sends just that stream while active)

## Timing model

- Input: MIDI clock from the DAW (24 ppqn) plus Start/Stop/Continue. Derive a smoothed BPM and bar position from it.
- Fallback: a manual BPM field when there's no clock.
- The flock can use tempo for: threat strikes on bar boundaries, randomness that comes in waves lasting N bars, and speed scaling with BPM.
- Suggested musical targets that ride on top of a steady tempo: swing, note density, rate multiplier (half to double time).

## Routing setup (document for users)

- macOS: IAC Driver (Audio MIDI Setup) for virtual ports
- Windows: loopMIDI
- The app can't create its own virtual port (web), so the user picks the output port from a list.

---

## UI

The UI is custom-designed in Figma (link to be added). Build the UI components to match the designs exactly, keeping the simulation and the UI as separate modules so the designs can change without touching the sim.

- Main canvas: flocks rendered in distinct colours, threat visible
- Per-flock panel: count, speed, randomness, neighbours
- Global panel: interaction, threat controls, BPM/clock status
- Mapping panel: 8 slots with a live value meter per slot
- Save/load presets (JSON)

---

## Suggested milestones

1. **Single flock sim:** boids with 7-nearest neighbours, spatial grid, sliders for count/speed/randomness.
2. **Threat:** predator agent, manual trigger, visible reaction.
3. **Stream sources:** compute the descriptors and show them as live meters/graphs (no MIDI yet). Judge which ones are actually interesting.
4. **MIDI out:** port selection, 8 mapping slots, CC output, MIDI learn.
5. **Clock in:** read DAW clock, BPM fallback, clock-synced threat.
6. **Multiple flocks + interaction slider.**
7. **Presets, polish, 14-bit/OSC, MIDI input to trigger the threat.**

## Risks to test early

- Does the flock settle into boring states? Tune the threat and noise until it doesn't.
- Do the streams feel distinct, or do they all move together? (Spread and alignment may correlate.)
- Does 7-bit CC step audibly on slow parameters?
- Is flock-driven tempo musical or just seasick?

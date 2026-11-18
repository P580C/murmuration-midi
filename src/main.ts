import './style.css';
import { TICKS_PER_BAR } from './midi/clock';
import { MidiEngine } from './midi/engine';
import { SLOT_COUNT, sanitizeSlot } from './midi/slots';
import { sanitizeTrigger } from './midi/triggers';
import { Renderer } from './render/renderer';
import { LIMITS, type ThreatMode } from './sim/params';
import { SIM_DT, World } from './sim/world';
import { loadJSON, saveJSON } from './storage';
import { startTicker } from './ticker';
import { button, el, section, select, slider } from './ui/controls';
import { MeterPanel } from './ui/meters';
import { MidiPanel } from './ui/midiPanel';

const canvas = document.querySelector<HTMLCanvasElement>('#flock')!;
const stage = document.querySelector<HTMLElement>('#stage')!;
const panel = document.querySelector<HTMLElement>('#panel')!;

const view = { trails: 0.55, paused: false };
const BG = '11, 13, 16';

const world = new World(stage.clientWidth, stage.clientHeight);
const renderer = new Renderer(canvas);
const meters = new MeterPanel();

function resize(): void {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  world.resize(w, h);
  renderer.resize(w, h);
}
new ResizeObserver(resize).observe(stage);
resize();

// ---------- MIDI (state restored from this browser) ----------

const MIDI_KEY = 'murmuration.midi.v1';
const midi = new MidiEngine();
{
  const saved = loadJSON(MIDI_KEY) as
    | { portId?: unknown; sending?: unknown; slots?: unknown; trigger?: unknown; clockInput?: unknown; bpm?: unknown }
    | undefined;
  if (saved) {
    midi.triggers.cfg = sanitizeTrigger(saved.trigger);
    if (typeof saved.clockInput === 'string') midi.clock.inputId = saved.clockInput;
    const bpm = Number(saved.bpm);
    if (Number.isFinite(bpm) && bpm >= 20 && bpm <= 300) midi.clock.manualBpm = bpm;
    if (typeof saved.portId === 'string') midi.output.selectedId = saved.portId;
    if (typeof saved.sending === 'boolean') midi.sending = saved.sending;
    if (Array.isArray(saved.slots)) {
      midi.slots = Array.from({ length: SLOT_COUNT }, (_, i) => sanitizeSlot(saved.slots && (saved.slots as unknown[])[i], i));
    }
  }
}
const saveMidi = () =>
  saveJSON(MIDI_KEY, {
    portId: midi.output.selectedId,
    sending: midi.sending,
    slots: midi.slots,
    trigger: midi.triggers.cfg,
    clockInput: midi.clock.inputId,
    bpm: midi.clock.manualBpm,
  });
void midi.init();
const midiPanel = new MidiPanel(midi, saveMidi);

// ---------- Flock tab ----------

const fp = world.flock.params;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const fixed = (d: number) => (v: number) => v.toFixed(d);

const advanced = el('details', 'advanced');
advanced.append(
  el('summary', undefined, 'Rule weights'),
  slider({ label: 'Separation', min: 0, max: 4, step: 0.05, value: fp.separation, format: fixed(2), onInput: (v) => (fp.separation = v) }),
  slider({ label: 'Alignment', min: 0, max: 3, step: 0.05, value: fp.alignment, format: fixed(2), onInput: (v) => (fp.alignment = v) }),
  slider({ label: 'Cohesion', min: 0, max: 3, step: 0.05, value: fp.cohesion, format: fixed(2), onInput: (v) => (fp.cohesion = v) }),
);

const flockSection = section(
  'Flock',
  slider({ label: 'Birds', min: 50, max: LIMITS.maxBirds, step: 50, value: fp.count, onInput: (v) => world.setBirdCount(v) }),
  slider({ label: 'Speed', min: 40, max: 400, step: 5, value: fp.speed, onInput: (v) => (fp.speed = v) }),
  slider({ label: 'Randomness', min: 0, max: 1, step: 0.01, value: fp.randomness, format: pct, onInput: (v) => (fp.randomness = v) }),
  slider({ label: 'Neighbours', min: 1, max: LIMITS.maxNeighbours, step: 1, value: fp.neighbours, onInput: (v) => (fp.neighbours = v) }),
  advanced,
);

const strikeBtn = button('Strike', () => world.strike(), 'btn btn-threat');
const strikeRow = el('div', 'row');
const countdown = el('span', 'muted');
strikeRow.append(strikeBtn, countdown);

const intervalSlider = slider({
  label: 'Every',
  min: 3,
  max: 30,
  step: 1,
  value: world.threat.interval,
  format: (v) => `${v}s`,
  onInput: (v) => {
    world.threat.interval = v;
    world.strikeCountdown = Math.min(world.strikeCountdown, v);
  },
});
const barsSlider = slider({
  label: 'Every',
  min: 1,
  max: 16,
  step: 1,
  value: world.threat.bars,
  format: (v) => `${v} bar${v === 1 ? '' : 's'}`,
  onInput: (v) => (world.threat.bars = v),
});
const timingRow = el('div', 'slot-row');
const timingSelect = select<ThreatMode>(
  [
    { value: 'timer', label: 'Timer' },
    { value: 'bars', label: 'On the bar (clock)' },
    { value: 'manual', label: 'Manual only' },
  ],
  world.threat.mode,
  (v) => setThreatMode(v),
);
timingSelect.setAttribute('aria-label', 'Strike timing');
timingRow.append(el('span', 'control-label', 'Timing'), timingSelect);
function setThreatMode(m: ThreatMode): void {
  world.threat.mode = m;
  world.strikeCountdown = world.threat.interval;
  intervalSlider.hidden = m !== 'timer';
  barsSlider.hidden = m !== 'bars';
}
setThreatMode(world.threat.mode);

const threatSection = section('Threat', strikeRow, timingRow, intervalSlider, barsSlider);

// Clock-synced strikes land on the downbeat.
midi.clock.onTick((t) => {
  const every = TICKS_PER_BAR * world.threat.bars;
  if (!view.paused && world.threat.mode === 'bars' && t.tick % every === 0) world.strike();
});

const pauseBtn = button('Pause', () => setPaused(!view.paused));
const viewRow = el('div', 'row');
viewRow.append(pauseBtn, button('Reset flock', () => world.flock.seed(world.width, world.height)));
const viewSection = section(
  'View',
  slider({ label: 'Trails', min: 0, max: 0.85, step: 0.01, value: view.trails, format: pct, onInput: (v) => (view.trails = v) }),
  viewRow,
);

const flockTab = el('div', 'tab-panel');
flockTab.append(flockSection, threatSection, viewSection, section('Streams', meters.element));

// ---------- Panel shell + tabs ----------

const status = el('div', 'status');
const header = el('header', 'panel-header');
header.append(el('h1', 'title', 'Murmuration'), status);

const TAB_KEY = 'murmuration.tab';
const tabs = [
  { id: 'flock', label: 'Flock', panel: flockTab },
  { id: 'midi', label: 'MIDI', panel: midiPanel.element },
];
const tabBar = el('div', 'tabs');
tabBar.setAttribute('role', 'tablist');
const tabButtons = tabs.map((t) => {
  const b = button(t.label, () => selectTab(t.id), 'tab');
  b.setAttribute('role', 'tab');
  t.panel.setAttribute('role', 'tabpanel');
  return b;
});
tabBar.append(...tabButtons);
let activeTab = 'flock';
function selectTab(id: string): void {
  activeTab = tabs.some((t) => t.id === id) ? id : 'flock';
  tabs.forEach((t, i) => {
    const on = t.id === activeTab;
    t.panel.hidden = !on;
    tabButtons[i].setAttribute('aria-selected', String(on));
  });
  saveJSON(TAB_KEY, activeTab);
}
selectTab(new URLSearchParams(location.search).get('tab') ?? String(loadJSON(TAB_KEY) ?? 'flock'));

const hints = el('p', 'hints');
hints.innerHTML = '<kbd>Space</kbd> strike · <kbd>P</kbd> pause · <kbd>Esc</kbd> stop learn · click canvas to strike a bird';

panel.append(header, tabBar, flockTab, midiPanel.element, hints);

function strikeStatus(): string {
  if (world.predator.active) return 'Attacking…';
  if (world.threat.mode === 'timer') return `next in ${Math.ceil(world.strikeCountdown)}s`;
  if (world.threat.mode === 'bars') {
    const every = TICKS_PER_BAR * world.threat.bars;
    const left = every - (((midi.clock.tick % every) + every) % every);
    const beats = Math.ceil(left / (TICKS_PER_BAR / 4));
    return midi.clock.running ? `next in ${beats} beat${beats === 1 ? '' : 's'}` : 'clock stopped';
  }
  return '';
}

function setPaused(p: boolean): void {
  view.paused = p;
  pauseBtn.textContent = p ? 'Resume' : 'Pause';
  stage.classList.toggle('is-paused', p);
}

// ---------- Input ----------

window.addEventListener('keydown', (e) => {
  const t = e.target;
  const typing = t instanceof HTMLInputElement && t.type !== 'range' && t.type !== 'checkbox';
  if (typing || t instanceof HTMLSelectElement) return;
  if (e.code === 'Space') {
    e.preventDefault();
    world.strike();
  } else if (e.code === 'KeyP') {
    setPaused(!view.paused);
  } else if (e.code === 'Escape') {
    midi.stopLearn();
  }
});

canvas.addEventListener('pointerdown', (e) => {
  const r = canvas.getBoundingClientRect();
  world.strikeAt(e.clientX - r.left, e.clientY - r.top);
});

// ---------- Debug: ?warmup=<s>&strikeAt=<s> pre-runs the sim (handy for screenshots) ----------

{
  const q = new URLSearchParams(location.search);
  const warmup = Number(q.get('warmup') ?? 0);
  const strikeAt = q.has('strikeAt') ? Number(q.get('strikeAt')) : -1;
  if (warmup > 0) {
    world.threat.mode = 'manual';
    for (let t = 0; t < warmup; t += SIM_DT) {
      if (strikeAt >= 0 && t <= strikeAt && t + SIM_DT > strikeAt) world.strike();
      world.step(SIM_DT);
      if (warmup - t < 2) renderer.draw(world, { trails: view.trails, background: BG });
    }
  }
}

// ---------- Simulation + MIDI: driven by the worker ticker so they keep running in the background ----------

const MAX_STEPS = 6;
let lastTick = performance.now();
let acc = 0;
let simMs = 0;

function tick(): void {
  const now = performance.now();
  const elapsed = Math.min(0.25, (now - lastTick) / 1000);
  lastTick = now;
  midi.clock.poll(now);
  if (view.paused) return;

  acc += elapsed;
  const t0 = performance.now();
  let steps = 0;
  while (acc >= SIM_DT && steps < MAX_STEPS) {
    world.step(SIM_DT);
    acc -= SIM_DT;
    steps++;
  }
  if (steps === MAX_STEPS) acc = 0; // drop time rather than spiral
  if (steps > 0) {
    simMs = simMs * 0.9 + ((performance.now() - t0) / steps) * 0.1;
    world.flock.panicThreshold = midi.triggers.cfg.threshold;
    midi.update(world.descriptors, steps * SIM_DT, now);
    midi.panicOnsets(world.flock.takePanicOnsets(), steps * SIM_DT, now);
  }
}
startTicker(1000 / 120, tick);

// ---------- Display: requestAnimationFrame (pauses when hidden, which is fine) ----------

let frames = 0;
let fpsTime = performance.now();
let meterTick = 0;

function frame(now: number): void {
  renderer.draw(world, { trails: view.trails, background: BG });

  // Panels at ~30 Hz.
  if (++meterTick % 2 === 0) {
    if (activeTab === 'flock') {
      if (!view.paused) meters.update(world.descriptors);
      countdown.textContent = strikeStatus();
      strikeBtn.disabled = world.predator.active;
    } else {
      midiPanel.render(now);
    }
  }

  frames++;
  if (now - fpsTime >= 500) {
    const fps = (frames * 1000) / (now - fpsTime);
    status.textContent = `${Math.round(fps)} fps · ${world.flock.n} birds · sim ${simMs.toFixed(1)} ms`;
    frames = 0;
    fpsTime = now;
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

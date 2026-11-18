import { MidiEngine } from '../src/midi/engine';
import { processSlot, SlotState, defaultSlot } from '../src/midi/slots';
import { World, SIM_DT } from '../src/sim/world';

let ok = true; const check = (name: string, cond: boolean, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${extra}`); ok &&= cond; };

// Pure mapping
const c = { ...defaultSlot(0), smoothing: 0 };
const st = new SlotState();
check('linear 0', processSlot(c, st, 0, SIM_DT) === 0);
check('linear 1', processSlot(c, st, 1, SIM_DT) === 127);
check('linear 0.5', processSlot(c, st, 0.5, SIM_DT) === 64);
check('invert', processSlot({ ...c, invert: true }, st, 0.25, SIM_DT) === 95);
check('range 40-80 @0.5', processSlot({ ...c, min: 40, max: 80 }, st, 0.5, SIM_DT) === 60);
check('flipped range', processSlot({ ...c, min: 100, max: 20 }, st, 1, SIM_DT) === 20);
check('exp low end', processSlot({ ...c, curve: 'exp' }, st, 0.5, SIM_DT) < 20);
check('clamps input', processSlot(c, st, 1.7, SIM_DT) === 127);
const sm = { ...c, smoothing: 0.5 }; const s2 = new SlotState();
processSlot(sm, s2, 0, SIM_DT); const v = processSlot(sm, s2, 1, SIM_DT);
check('smoothing lags', v > 0 && v < 20, `(${v})`);

// Engine with fake port
const e = new MidiEngine();
const sent: number[][] = [];
Object.defineProperty(e.output, 'connected', { get: () => true });
e.output.sendCC = (ch, cc, val) => { sent.push([ch, cc, val]); return true; };
const w = new World(1080, 900);
w.threat.mode = 'manual';
let t = 0;
const run = (sec: number) => { for (let i = 0; i < sec * 60; i++) { w.step(); t += 1000 / 60; e.update(w.descriptors, SIM_DT, t); } };
run(1);
const first = sent.length;
check('first tick sends all 8', new Set(sent.slice(0, 8).map((m) => m[1])).size === 8);
check('change-only throttle', first < 8 * 60, `(${first} msgs in 60 ticks, max 480)`);
check('valid bytes', sent.every(([ch, cc, val]) => ch >= 1 && ch <= 16 && cc >= 0 && cc <= 127 && val >= 0 && val <= 127 && Number.isInteger(val)));

sent.length = 0; e.updateSlot(2, { enabled: false }); run(1);
check('disabled slot silent', !sent.some((m) => m[1] === 22));

sent.length = 0; e.toggleLearn(5); run(2);
check('learn: only slot 6 sends', sent.length > 0 && sent.every((m) => m[1] === 25), `(${sent.length} msgs)`);
check('learn: resends ≥ every 250ms', sent.length >= 7);

sent.length = 0; e.stopLearn(); run(0.05);
check('after learn: resync all enabled', new Set(sent.map((m) => m[1])).size === 7);

sent.length = 0; e.sending = false; run(1);
check('master off silent', sent.length === 0);

// ---------- Clock ----------
import('../src/midi/clock').then(async ({ Clock, TICKS_PER_BAR }) => {
  const { TriggerEngine } = await import('../src/midi/triggers');

  const c = new Clock();
  const ticks: number[] = [];
  c.onTick((t) => ticks.push(t.tick));
  // Internal at 120 BPM: 48 ticks per second.
  c.poll(1000); c.poll(2000);
  check('internal ~48 ticks/s at 120', Math.abs(ticks.length - 49) <= 1, `(${ticks.length})`);

  // External clock at 125 BPM: 20 ms per tick.
  ticks.length = 0;
  c.handleMessage([0xfa], 3000); // Start
  let t = 3000;
  for (let i = 0; i < 96 * 2; i++) { t += 20; c.handleMessage([0xf8], t); c.poll(t); }
  check('external takes over', c.source === 'external');
  check('external BPM ≈ 125', Math.abs(c.bpm - 125) < 0.5, `(${c.bpm.toFixed(2)})`);
  check('start → first tick is 0 (downbeat)', ticks[0] === 0);
  check('position: last tick of bar 2 is beat 4', c.position().bar === 2 && c.position().beat === 4, JSON.stringify(c.position()));

  ticks.length = 0;
  c.handleMessage([0xfc], t); // Stop
  for (let i = 0; i < 24; i++) { t += 20; c.handleMessage([0xf8], t); }
  check('stop halts ticks', ticks.length === 0);
  c.handleMessage([0xf2, 8, 0], t); // SPP: 16th #8 = bar 1 beat 3
  c.handleMessage([0xfb], t); // Continue
  t += 20; c.handleMessage([0xf8], t);
  check('song position + continue', ticks[0] === 48, `(${ticks[0]})`);

  c.poll(t + 1000);
  check('falls back to internal when clock stops', c.source === 'internal');

  // ---------- Triggers ----------
  const notes: { vel: number; at?: number; gate: number }[] = [];
  const tr = new TriggerEngine((_ch, _n, vel, gate, at) => { notes.push({ vel, at, gate }); return true; });
  tr.addOnsets(5, 1 / 60, 0, true);
  tr.addOnsets(40, 1 / 60, 0, true);
  check('quantised: nothing until grid', notes.length === 0);
  tr.onTick({ tick: 3, time: 10 }, 120, true);
  check('quantised: not on off-grid tick', notes.length === 0);
  tr.onTick({ tick: 6, time: 20 }, 120, true);
  check('quantised: one note for 45 onsets', notes.length === 1 && notes[0].at === 20);
  check('burst velocity scales', notes[0].vel > 100, `(${notes[0].vel})`);
  tr.addOnsets(1, 1 / 60, 0, true); tr.onTick({ tick: 12, time: 30 }, 120, true);
  check('single onset quieter', notes[1].vel < 60, `(${notes[1].vel})`);
  tr.onTick({ tick: 18, time: 40 }, 120, true);
  check('no note when nothing pending', notes.length === 2);
  tr.cfg = { ...tr.cfg, gateMs: 500 }; tr.addOnsets(3, 1 / 60, 0, true); tr.onTick({ tick: 24, time: 50 }, 120, true);
  check('gate clamped below grid step', notes[2].gate < 125, `(${notes[2].gate.toFixed(0)} ms)`);
  tr.cfg = { ...tr.cfg, quantise: 'off', maxRate: 10, gateMs: 20 };
  notes.length = 0;
  for (let i = 0; i < 60; i++) tr.addOnsets(3, 1 / 60, i * (1000 / 60), true);
  check('unquantised rate limit ≈ 10/s', notes.length >= 9 && notes.length <= 11, `(${notes.length})`);
  notes.length = 0; tr.addOnsets(3, 1 / 60, 999999, false);
  check('muted when cannot send', notes.length === 0);

  // ---------- Panic onsets from a strike ----------
  const w2 = new World(1080, 900); w2.threat.mode = 'manual';
  for (let i = 0; i < 120; i++) w2.step();
  w2.flock.takePanicOnsets();
  check('no onsets without a threat', w2.flock.takePanicOnsets() === 0);
  w2.strike(); let total = 0;
  for (let i = 0; i < 60 * 5; i++) { w2.step(); total += w2.flock.takePanicOnsets(); }
  check('a strike produces panic onsets', total > 20, `(${total} birds of ${w2.flock.n})`);
  void TICKS_PER_BAR;
  process.exit(ok ? 0 : 1);
});


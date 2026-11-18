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
process.exit(ok ? 0 : 1);

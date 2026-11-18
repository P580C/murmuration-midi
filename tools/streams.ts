import { World } from '../src/sim/world';
for (const count of [1200, 4000]) {
  const w = new World(1280, 800, { count });
  w.threat.auto = false;
  let t0 = performance.now(), steps = 0;
  for (let s = 0; s < 60 * 24; s++) {
    if (s === 60 * 12) w.strike();
    w.step(); steps++;
    if (count === 1200 && s % 120 === 119) {
      const d = w.descriptors;
      console.log(`t=${((s+1)/60).toFixed(0).padStart(2)}s ` + Object.entries(d).map(([k,v]) => `${k}=${v.toFixed(2)}`).join(' ') + ` pred=${w.predator.state}`);
    }
  }
  const nan = Array.from(w.flock.x.subarray(0, w.flock.n)).some(Number.isNaN);
  console.log(`count=${count}: ${((performance.now()-t0)/steps).toFixed(2)} ms/step, NaN=${nan}`);
}

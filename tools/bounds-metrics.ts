import { World } from '../src/sim/world';
const cases = [
  { name: 'default 1080x900', w: 1080, h: 900, p: {} },
  { name: 'fast+noisy', w: 1080, h: 900, p: { speed: 400, randomness: 1 } },
  { name: 'wide short 1400x380', w: 1400, h: 380, p: {} },
  { name: '4000 birds', w: 1080, h: 900, p: { count: 4000 } },
];
for (const c of cases) {
  let outside = 0, nearEdge = 0, total = 0; let worst = 0; let hitsTot = 0; let cxMin = 1, cxMax = 0;
  for (let run = 0; run < 3; run++) {
    const w = new World(c.w, c.h, c.p);
    w.threat.interval = 4;
    for (let s = 0; s < 60 * 40; s++) { if (s === 0) w.flock.edgeHits = 0;
      w.step();
      const f = w.flock; const pad = Math.min(c.w, c.h) * 0.05;
      for (let i = 0; i < f.n; i++) {
        const x = f.x[i], y = f.y[i];
        const d = Math.min(x, y, c.w - x, c.h - y);
        if (d < 0) { outside++; worst = Math.max(worst, -d); }
        if (d < pad) nearEdge++;
      }
      total += f.n;
      cxMin = Math.min(cxMin, w.descriptors.centreX); cxMax = Math.max(cxMax, w.descriptors.centreX); if (s === 60*40-1) hitsTot += w.flock.edgeHits;
    }
  }
  console.log(`${c.name.padEnd(22)} outside=${(100*outside/total).toFixed(3)}%  within5%=${(100*nearEdge/total).toFixed(2)}%  worst=${worst.toFixed(0)}px  centreX ${cxMin.toFixed(2)}–${cxMax.toFixed(2)} hardHits/s=${(hitsTot/(3*40)).toFixed(1)}`);
}

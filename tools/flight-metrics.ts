import { World } from '../src/sim/world';
// Behaviour metrics for "birds in flight vs fish in a tank".
const W = 1080, H = 900, SEC = 60, RUNS = 3;
let edgeBirds = 0, birdSamples = 0, corner = 0, central = 0, samples = 0, edgeDist = 0;
let circSum = 0, circN = 0, turnAbs = 0, turnN = 0;
const covered = new Set<string>();
for (let r = 0; r < RUNS; r++) {
  const w = new World(W, H);
  let prevH = NaN; let winSigned = 0, winAbs = 0, winT = 0;
  for (let s = 0; s < SEC * 60; s++) {
    w.step();
    if (s < 120) continue;
    const f = w.flock; const m = Math.min(W, H);
    let cx = 0, cy = 0, hx = 0, hy = 0;
    for (let i = 0; i < f.n; i++) {
      const x = f.x[i], y = f.y[i];
      if (Math.min(x, y, W - x, H - y) < 0.1 * m) edgeBirds++;
      cx += x; cy += y; hx += f.vx[i]; hy += f.vy[i];
    }
    birdSamples += f.n; cx /= f.n; cy /= f.n; samples++;
    const nx = cx / W, ny = cy / H;
    if ((nx < 0.25 || nx > 0.75) && (ny < 0.25 || ny > 0.75)) corner++;
    if (nx > 0.25 && nx < 0.75 && ny > 0.25 && ny < 0.75) central++;
    edgeDist += Math.min(cx, cy, W - cx, H - cy) / m;
    covered.add(`${Math.floor(nx * 6)},${Math.floor(ny * 6)}`);
    const h = Math.atan2(hy, hx);
    if (!Number.isNaN(prevH)) {
      let d = h - prevH; d = Math.atan2(Math.sin(d), Math.cos(d));
      winSigned += d; winAbs += Math.abs(d); turnAbs += Math.abs(d); turnN++;
      if (++winT >= 8 * 60) { if (winAbs > 0) { circSum += Math.abs(winSigned) / winAbs; circN++; } winSigned = winAbs = 0; winT = 0; }
    }
    prevH = h;
  }
}
console.log(`birds in edge band (10%)   ${(100 * edgeBirds / birdSamples).toFixed(1)}%   (lower = less wall-hugging)`);
console.log(`centroid in a corner       ${(100 * corner / samples).toFixed(1)}%`);
console.log(`centroid in central half   ${(100 * central / samples).toFixed(1)}%`);
console.log(`centroid dist to edge      ${(edgeDist / samples).toFixed(3)} × minDim`);
console.log(`circling index (8 s)       ${(circSum / circN).toFixed(2)}   (1 = always turning the same way)`);
console.log(`flock turn rate            ${(turnAbs / turnN * 60).toFixed(2)} rad/s`);
console.log(`screen cells visited       ${covered.size}/36`);

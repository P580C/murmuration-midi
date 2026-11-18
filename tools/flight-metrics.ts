import { World } from '../src/sim/world';
// Behaviour metrics for "birds in flight vs fish in a tank".
const W = 1080, H = 900, SEC = 60, RUNS = 3;
let edgeBirds = 0, birdSamples = 0, corner = 0, central = 0, samples = 0, edgeDist = 0;
let circSum = 0, circN = 0, turnAbs = 0, turnN = 0;
const spreadS: number[] = [], aspectS: number[] = [], alignS: number[] = [], turbS: number[] = [];
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
    // Shape: eigenvalues of the projected (xy) covariance -> aspect ratio.
    let sxx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < f.n; i++) { const dx = f.x[i] - cx, dy = f.y[i] - cy; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
    sxx /= f.n; syy /= f.n; sxy /= f.n;
    const tr = sxx + syy, det = sxx * syy - sxy * sxy, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const l1 = tr / 2 + disc, l2 = Math.max(1e-6, tr / 2 - disc);
    if (s % 6 === 0) { aspectS.push(Math.sqrt(l1 / l2)); spreadS.push(w.descriptors.spread); alignS.push(w.descriptors.alignment); turbS.push(w.descriptors.turbulence); }
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

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
console.log(`aspect ratio mean / sd     ${mean(aspectS).toFixed(2)} / ${sd(aspectS).toFixed(2)}   (shape variety: higher sd = more morphing)`);
console.log(`spread mean / sd           ${mean(spreadS).toFixed(2)} / ${sd(spreadS).toFixed(2)}`);
console.log(`alignment mean / sd        ${mean(alignS).toFixed(2)} / ${sd(alignS).toFixed(2)}`);
console.log(`turbulence mean / sd       ${mean(turbS).toFixed(2)} / ${sd(turbS).toFixed(2)}`);

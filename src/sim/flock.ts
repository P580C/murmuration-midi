import { SpatialGrid } from './grid';
import { LIMITS, type FlockParams } from './params';
import type { Predator } from './predator';

/** Grid cell size in world units. Small cells keep dense flocks cheap. */
const CELL = 16;
/** Birds ignore anything further than this, even if it is among their k nearest. */
const MAX_RANGE = 140;
/** Neighbours closer than this push apart. */
const SEP_RADIUS = 14;
/** Birds further than this fraction of the screen from the flock centroid get pulled back in. */
const REGROUP_FRACTION = 0.25;

/**
 * The flock flies in a shallow 3D slab and is drawn flattened (x/y on screen, z = depth).
 * Turning edge-on or face-on changes the apparent density, which is a large part of the
 * murmuration look.
 */
export const DEPTH_FRACTION = 0.5;

/**
 * Containment, softest first:
 *  1. Navigation: a weak pull toward a shared target that the World moves every few
 *     seconds. Direction changes mostly come from turning waves (below), not this pull.
 *  2. Sky: an ellipsoid over the centre of the view. Birds predicted to leave it bank
 *     back toward the target. It has no corners to get trapped in.
 *  3. Edge: a thin last-resort zone at the window edge, plus a hard clamp.
 */
const NAV_WEIGHT = 0.2;
/** Sky ellipsoid radii as fractions of view width / height / slab depth. */
export const SKY_RX = 0.36;
export const SKY_RY = 0.34;
const SKY_RZ = 0.4;
const SKY_LOOKAHEAD = 0.8;
const SKY_WEIGHT = 2.2;
/** Width of the last-resort edge zone, as a fraction of the smaller screen dimension. */
const EDGE_MARGIN = 0.07;
const EDGE_LOOKAHEAD = 0.5;
const EDGE_WEIGHT = 6;
/** Hard limit: no bird gets closer than this to the edge of the view (px). */
const EDGE_PAD = 6;

/**
 * Flight dynamics: birds bank through turns rather than pivoting on the spot.
 * Minimum turn radius = cruise speed × this many seconds (halved when panicking).
 */
const TURN_RADIUS_TIME = 0.25;

/** Panic: decay rate (1/s) and fraction passed on per neighbour hop (one hop per step). */
const PANIC_DECAY = 1.4;
const PANIC_TRANSFER = 0.9;

/**
 * Turning waves: a few birds on one edge take up a new heading, and neighbours copy it
 * hop by hop. At one hop per step the wave crosses the flock at a few times flight speed,
 * as in real starlings.
 */
const TURN_DECAY = 1.0;
const TURN_TRANSFER = 0.96;
const TURN_WEIGHT = 1.8;

/** Shared steering target, owned by the World. */
export interface Nav {
  x: number;
  y: number;
  z: number;
}

/** Slab depth in world units for a given view. z runs from -depth/2 (far) to +depth/2 (near). */
export function slabDepth(width: number, height: number): number {
  return Math.min(width, height) * DEPTH_FRACTION;
}

// Scratch output for steer() to avoid allocating in the hot loop.
const out = { x: 0, y: 0, z: 0 };

/** Reynolds steering in 3D: velocity change needed to fly along d at `speed`, capped at `limit`. */
function steer(
  dx: number,
  dy: number,
  dz: number,
  vx: number,
  vy: number,
  vz: number,
  speed: number,
  limit: number,
): void {
  const m = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (m < 1e-9) {
    out.x = out.y = out.z = 0;
    return;
  }
  let sx = (dx / m) * speed - vx;
  let sy = (dy / m) * speed - vy;
  let sz = (dz / m) * speed - vz;
  const s = Math.sqrt(sx * sx + sy * sy + sz * sz);
  if (s > limit) {
    const k = limit / s;
    sx *= k;
    sy *= k;
    sz *= k;
  }
  out.x = sx;
  out.y = sy;
  out.z = sz;
}

/**
 * A value plus a heading that spreads bird-to-bird (used for panic and for turning
 * waves). Double-buffered so propagation doesn't depend on update order.
 */
class Signal {
  v = new Float32Array(LIMITS.maxBirds);
  x = new Float32Array(LIMITS.maxBirds);
  y = new Float32Array(LIMITS.maxBirds);
  z = new Float32Array(LIMITS.maxBirds);
  vN = new Float32Array(LIMITS.maxBirds);
  xN = new Float32Array(LIMITS.maxBirds);
  yN = new Float32Array(LIMITS.maxBirds);
  zN = new Float32Array(LIMITS.maxBirds);

  write(i: number, v: number, x: number, y: number, z: number): void {
    this.vN[i] = v;
    this.xN[i] = x;
    this.yN[i] = y;
    this.zN[i] = z;
  }

  swap(): void {
    [this.v, this.vN] = [this.vN, this.v];
    [this.x, this.xN] = [this.xN, this.x];
    [this.y, this.yN] = [this.yN, this.y];
    [this.z, this.zN] = [this.zN, this.z];
  }
}

/**
 * One flock, stored as a structure of typed arrays.
 * Each bird reacts to its k nearest neighbours (topological), not to a fixed radius.
 */
export class Flock {
  n = 0;
  readonly params: FlockParams;
  readonly color: string;

  readonly x = new Float32Array(LIMITS.maxBirds);
  readonly y = new Float32Array(LIMITS.maxBirds);
  readonly z = new Float32Array(LIMITS.maxBirds);
  vx = new Float32Array(LIMITS.maxBirds);
  vy = new Float32Array(LIMITS.maxBirds);
  vz = new Float32Array(LIMITS.maxBirds);
  private vxNext = new Float32Array(LIMITS.maxBirds);
  private vyNext = new Float32Array(LIMITS.maxBirds);
  private vzNext = new Float32Array(LIMITS.maxBirds);
  private readonly wander = new Float32Array(LIMITS.maxBirds);
  private readonly wanderZ = new Float32Array(LIMITS.maxBirds);

  /** Panic level per bird (0-1) and the escape heading it carries. */
  private readonly panicSig = new Signal();
  /** Turning-wave strength per bird and the new heading it carries. */
  private readonly turnSig = new Signal();

  get panic(): Float32Array {
    return this.panicSig.v;
  }

  /** Panic level a bird must cross to count as a panic onset (for triggers). */
  panicThreshold = 0.5;
  /** Birds that crossed panicThreshold upward since the last takePanicOnsets(). */
  private onsets = 0;

  /** Return and reset the number of panic onsets since the last call. */
  takePanicOnsets(): number {
    const n = this.onsets;
    this.onsets = 0;
    return n;
  }

  /** Slab depth used in the last step (for the renderer). */
  depth = 1;
  /** Running count of hard-limit corrections (diagnostic: should stay near zero). */
  edgeHits = 0;
  /** Mean local misalignment from the last step (0 = every bird matches its neighbours). */
  localDisorder = 0;

  private readonly grid = new SpatialGrid(CELL);
  private readonly nbIdx = new Int32Array(LIMITS.maxNeighbours);
  private readonly nbD2 = new Float32Array(LIMITS.maxNeighbours);
  private dots = new Float32Array(0);

  constructor(params: FlockParams, color: string, width: number, height: number) {
    this.params = params;
    this.color = color;
    this.seed(width, height);
  }

  /** Scatter birds in a ball around the centre, roughly heading the same way. */
  seed(width: number, height: number): void {
    const n = Math.min(LIMITS.maxBirds, Math.max(0, Math.round(this.params.count)));
    const r = Math.cbrt(n) * 14;
    const heading = Math.random() * Math.PI * 2;
    this.depth = slabDepth(width, height);
    for (let i = 0; i < n; i++) {
      // Uniform point in a sphere.
      let px: number, py: number, pz: number;
      do {
        px = Math.random() * 2 - 1;
        py = Math.random() * 2 - 1;
        pz = Math.random() * 2 - 1;
      } while (px * px + py * py + pz * pz > 1);
      this.x[i] = width / 2 + px * r;
      this.y[i] = height / 2 + py * r;
      this.z[i] = pz * Math.min(r, this.depth * 0.3);
      const h = heading + (Math.random() - 0.5) * 1.2;
      this.vx[i] = Math.cos(h) * this.params.speed;
      this.vy[i] = Math.sin(h) * this.params.speed;
      this.vz[i] = (Math.random() - 0.5) * 0.2 * this.params.speed;
      this.wander[i] = Math.random() * Math.PI * 2;
      this.wanderZ[i] = 0;
      this.panicSig.v[i] = 0;
      this.turnSig.v[i] = 0;
    }
    this.n = n;
  }

  /** Grow or shrink the flock. New birds are cloned from existing ones with jitter. */
  setCount(count: number, width: number, height: number): void {
    const target = Math.min(LIMITS.maxBirds, Math.max(0, Math.round(count)));
    if (this.n === 0) {
      this.params.count = target;
      this.seed(width, height);
      return;
    }
    for (let i = this.n; i < target; i++) {
      const src = Math.floor(Math.random() * this.n);
      this.x[i] = this.x[src] + (Math.random() - 0.5) * 12;
      this.y[i] = this.y[src] + (Math.random() - 0.5) * 12;
      this.z[i] = this.z[src] + (Math.random() - 0.5) * 12;
      this.vx[i] = this.vx[src];
      this.vy[i] = this.vy[src];
      this.vz[i] = this.vz[src];
      this.wander[i] = Math.random() * Math.PI * 2;
      this.wanderZ[i] = 0;
      this.panicSig.v[i] = 0;
      this.turnSig.v[i] = 0;
    }
    this.n = target;
  }

  /**
   * Start a turning wave: the birds furthest along `side` (the leading edge on that side,
   * `fraction` of the flock) take up heading (hx, hy, hz). Neighbours pass it on.
   */
  initiateTurn(hx: number, hy: number, hz: number, sideX: number, sideY: number, sideZ: number, fraction = 0.02): void {
    const n = this.n;
    if (n === 0) return;
    const hm = Math.hypot(hx, hy, hz) || 1;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let i = 0; i < n; i++) {
      cx += this.x[i];
      cy += this.y[i];
      cz += this.z[i];
    }
    cx /= n;
    cy /= n;
    cz /= n;
    if (this.dots.length < n) this.dots = new Float32Array(LIMITS.maxBirds);
    const dots = this.dots;
    for (let i = 0; i < n; i++) {
      dots[i] = (this.x[i] - cx) * sideX + (this.y[i] - cy) * sideY + (this.z[i] - cz) * sideZ;
    }
    const sorted = dots.slice(0, n).sort();
    const threshold = sorted[Math.max(0, Math.floor(n * (1 - fraction)) - 1)];
    const t = this.turnSig;
    for (let i = 0; i < n; i++) {
      if (dots[i] >= threshold) {
        t.v[i] = 1;
        t.x[i] = hx / hm;
        t.y[i] = hy / hm;
        t.z[i] = hz / hm;
      }
    }
  }

  step(dt: number, width: number, height: number, pred: Predator, nav: Nav): void {
    const n = this.n;
    if (n === 0) return;

    const { x, y, z, vx, vy, vz, vxNext, vyNext, vzNext, wander, wanderZ, nbIdx, nbD2 } = this;
    const P = this.panicSig;
    const T = this.turnSig;
    const p = this.params;
    const k = Math.max(1, Math.min(LIMITS.maxNeighbours, Math.round(p.neighbours)));
    const speed = p.speed;
    const maxF = speed * 2.2;
    const noiseF = maxF * p.randomness;
    const sepR2 = SEP_RADIUS * SEP_RADIUS;
    const maxRange2 = MAX_RANGE * MAX_RANGE;
    const panicDecay = Math.exp(-dt * PANIC_DECAY);
    const turnDecay = Math.exp(-dt * TURN_DECAY);

    const depth = slabDepth(width, height);
    this.depth = depth;
    const halfD = depth / 2;
    const margin = Math.min(width, height) * EDGE_MARGIN;
    const skyCx = width / 2;
    const skyCy = height / 2;
    const skyRx = width * SKY_RX;
    const skyRy = height * SKY_RY;
    const skyRz = halfD * SKY_RZ * 2;

    // Flock centroid (previous frame), for the straggler regroup force.
    let fcx = 0;
    let fcy = 0;
    let fcz = 0;
    for (let i = 0; i < n; i++) {
      fcx += x[i];
      fcy += y[i];
      fcz += z[i];
    }
    fcx /= n;
    fcy /= n;
    fcz /= n;
    const regroupR = Math.min(width, height) * REGROUP_FRACTION;

    const predActive = pred.active;
    const px = pred.x;
    const py = pred.y;
    const pz = pred.z;
    const fleeR = pred.fleeRadius;

    // The grid indexes x/y only. Distances are 3D, and since a 3D distance is never
    // shorter than its x/y part, the ring-search stopping rule below still holds.
    const grid = this.grid;
    grid.build(x, y, n, width, height);
    const { cols, rows, cellStart, cellCount, items } = grid;
    const maxRings = Math.ceil(MAX_RANGE / CELL);

    let disorderSum = 0;
    let disorderN = 0;
    let onsets = 0;
    const onsetThr = this.panicThreshold;

    for (let i = 0; i < n; i++) {
      const xi = x[i];
      const yi = y[i];
      const zi = z[i];
      const vxi = vx[i];
      const vyi = vy[i];
      const vzi = vz[i];

      // ---- k nearest neighbours: search rings of cells outward until the k-th
      // nearest is closer than anything an unsearched ring could hold.
      let cnt = 0;
      const cx0 = grid.cellX(xi);
      const cy0 = grid.cellY(yi);
      for (let r = 0; r <= maxRings; r++) {
        const yMin = cy0 - r;
        const yMax = cy0 + r;
        const xMin = cx0 - r;
        const xMax = cx0 + r;
        for (let cy = yMin; cy <= yMax; cy++) {
          if (cy < 0 || cy >= rows) continue;
          const edgeRow = cy === yMin || cy === yMax;
          const stride = edgeRow ? 1 : xMax - xMin; // interior rows: only the two side cells
          for (let cx = xMin; cx <= xMax; cx += stride) {
            if (cx < 0 || cx >= cols) continue;
            const c = cy * cols + cx;
            const end = cellStart[c] + cellCount[c];
            for (let q = cellStart[c]; q < end; q++) {
              const j = items[q];
              if (j === i) continue;
              const dx = x[j] - xi;
              const dy = y[j] - yi;
              const dz = z[j] - zi;
              const d2 = dx * dx + dy * dy + dz * dz;
              if (d2 > maxRange2) continue;
              if (cnt === k && d2 >= nbD2[k - 1]) continue;
              let pos = cnt < k ? cnt++ : k - 1;
              while (pos > 0 && nbD2[pos - 1] > d2) {
                nbD2[pos] = nbD2[pos - 1];
                nbIdx[pos] = nbIdx[pos - 1];
                pos--;
              }
              nbD2[pos] = d2;
              nbIdx[pos] = j;
            }
          }
        }
        const covered = r * CELL;
        if (cnt === k && nbD2[k - 1] <= covered * covered) break;
      }

      // ---- Gather neighbour stats.
      let avx = 0;
      let avy = 0;
      let avz = 0;
      let cxs = 0;
      let cys = 0;
      let czs = 0;
      let sx = 0;
      let sy = 0;
      let sz = 0;
      let hotPanic = 0;
      let hotP = -1;
      let hotTurn = 0;
      let hotT = -1;
      for (let m = 0; m < cnt; m++) {
        const j = nbIdx[m];
        avx += vx[j];
        avy += vy[j];
        avz += vz[j];
        cxs += x[j];
        cys += y[j];
        czs += z[j];
        const d2 = nbD2[m];
        if (d2 < sepR2 && d2 > 1e-6) {
          sx += (xi - x[j]) / d2;
          sy += (yi - y[j]) / d2;
          sz += (zi - z[j]) / d2;
        }
        if (P.v[j] > hotPanic) {
          hotPanic = P.v[j];
          hotP = j;
        }
        if (T.v[j] > hotTurn) {
          hotTurn = T.v[j];
          hotT = j;
        }
      }

      // ---- Panic: direct from the predator, or relayed from the most panicked neighbour.
      let pn = P.v[i] * panicDecay;
      let ex = P.x[i];
      let ey = P.y[i];
      let ez = P.z[i];
      if (hotP >= 0 && hotPanic * PANIC_TRANSFER > pn) {
        pn = hotPanic * PANIC_TRANSFER;
        ex = P.x[hotP];
        ey = P.y[hotP];
        ez = P.z[hotP];
      }
      if (predActive) {
        const dx = xi - px;
        const dy = yi - py;
        const dz = zi - pz;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < fleeR) {
          const direct = Math.min(1, (fleeR - d) / (fleeR * 0.6));
          if (direct >= pn && d > 1e-6) {
            pn = direct;
            ex = dx / d;
            ey = dy / d;
            ez = dz / d;
          }
        }
      }
      if (pn >= onsetThr && P.v[i] < onsetThr) onsets++;
      P.write(i, pn, ex, ey, ez);

      // ---- Turning wave: relayed from the neighbour most into the turn.
      let tn = T.v[i] * turnDecay;
      let thx = T.x[i];
      let thy = T.y[i];
      let thz = T.z[i];
      if (hotT >= 0 && hotTurn * TURN_TRANSFER > tn) {
        tn = hotTurn * TURN_TRANSFER;
        thx = T.x[hotT];
        thy = T.y[hotT];
        thz = T.z[hotT];
      }
      T.write(i, tn, thx, thy, thz);

      const cruise = speed * (1 + 0.8 * pn);
      let ax = 0;
      let ay = 0;
      let az = 0;

      // ---- Boids rules.
      if (cnt > 0) {
        steer(avx, avy, avz, vxi, vyi, vzi, cruise, maxF);
        ax += out.x * p.alignment;
        ay += out.y * p.alignment;
        az += out.z * p.alignment;
        steer(cxs / cnt - xi, cys / cnt - yi, czs / cnt - zi, vxi, vyi, vzi, cruise, maxF);
        ax += out.x * p.cohesion;
        ay += out.y * p.cohesion;
        az += out.z * p.cohesion;
        if (sx !== 0 || sy !== 0 || sz !== 0) {
          steer(sx, sy, sz, vxi, vyi, vzi, cruise, maxF);
          ax += out.x * p.separation;
          ay += out.y * p.separation;
          az += out.z * p.separation;
        }

        const am = Math.sqrt(avx * avx + avy * avy + avz * avz);
        const vm = Math.sqrt(vxi * vxi + vyi * vyi + vzi * vzi);
        if (am > 1e-6 && vm > 1e-6) {
          disorderSum += 1 - (vxi * avx + vyi * avy + vzi * avz) / (am * vm);
          disorderN++;
        }
      }

      // ---- Last-resort edge zone (x/y window edges and the slab's front/back).
      const qx = xi + vxi * EDGE_LOOKAHEAD;
      const qy = yi + vyi * EDGE_LOOKAHEAD;
      const qz = zi + vzi * EDGE_LOOKAHEAD;
      let wx = 0;
      let wy = 0;
      let wz = 0;
      if (qx < margin) wx = (margin - qx) / margin;
      else if (qx > width - margin) wx = -(qx - (width - margin)) / margin;
      if (qy < margin) wy = (margin - qy) / margin;
      else if (qy > height - margin) wy = -(qy - (height - margin)) / margin;
      const zMargin = halfD * 0.3;
      if (qz < -halfD + zMargin) wz = (-halfD + zMargin - qz) / zMargin;
      else if (qz > halfD - zMargin) wz = -(qz - (halfD - zMargin)) / zMargin;
      const wallDepth = Math.sqrt(wx * wx + wy * wy + wz * wz);
      if (wallDepth > 0) {
        steer(wx, wy, wz, vxi, vyi, vzi, cruise, maxF * 4);
        const w = Math.min(3, wallDepth) * EDGE_WEIGHT;
        ax += out.x * w;
        ay += out.y * w;
        az += out.z * w;
      }

      // ---- Turning wave.
      if (tn > 0.02) {
        steer(thx, thy, thz, vxi, vyi, vzi, cruise, maxF * 2);
        ax += out.x * tn * TURN_WEIGHT;
        ay += out.y * tn * TURN_WEIGHT;
        az += out.z * tn * TURN_WEIGHT;
      }

      // ---- Escape manoeuvre. Near an edge the outward part is dropped.
      if (pn > 0.02) {
        let fx = ex;
        let fy = ey;
        let fz = ez;
        if ((wx > 0 && fx < 0) || (wx < 0 && fx > 0)) fx = 0;
        if ((wy > 0 && fy < 0) || (wy < 0 && fy > 0)) fy = 0;
        if ((wz > 0 && fz < 0) || (wz < 0 && fz > 0)) fz = 0;
        if (fx !== 0 || fy !== 0 || fz !== 0) {
          steer(fx, fy, fz, vxi, vyi, vzi, cruise, maxF * 2);
          ax += out.x * pn * 2.5;
          ay += out.y * pn * 2.5;
          az += out.z * pn * 2.5;
        }
      }

      // ---- Noise: a slowly wandering heading per bird, faded out near edges.
      if (noiseF > 0) {
        const w = wander[i] + (Math.random() - 0.5) * 0.7;
        wander[i] = w;
        let wzv = wanderZ[i] + (Math.random() - 0.5) * 0.3;
        wzv = wzv > 1 ? 1 : wzv < -1 ? -1 : wzv;
        wanderZ[i] = wzv;
        const fade = Math.max(0, 1 - wallDepth) * noiseF;
        ax += Math.cos(w) * fade;
        ay += Math.sin(w) * fade;
        az += wzv * fade;
      }

      // ---- Regroup: only birds well outside the main body feel it.
      {
        const dx = fcx - xi;
        const dy = fcy - yi;
        const dz = fcz - zi;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > regroupR) {
          const w = Math.min(1, (d - regroupR) / regroupR) * 0.6;
          steer(dx, dy, dz, vxi, vyi, vzi, cruise, maxF);
          ax += out.x * w;
          ay += out.y * w;
          az += out.z * w;
        }
      }

      // ---- Navigation + sky: weak pull toward the shared target, much stronger once the
      // bird's predicted position leaves the sky ellipsoid.
      {
        const ux = (xi + vxi * SKY_LOOKAHEAD - skyCx) / skyRx;
        const uy = (yi + vyi * SKY_LOOKAHEAD - skyCy) / skyRy;
        const uz = (zi + vzi * SKY_LOOKAHEAD) / skyRz;
        const beyond = Math.sqrt(ux * ux + uy * uy + uz * uz) - 1;
        const w = NAV_WEIGHT + (beyond > 0 ? SKY_WEIGHT * Math.min(1.5, beyond / 0.3) : 0);
        steer(nav.x - xi, nav.y - yi, nav.z - zi, vxi, vyi, vzi, cruise, maxF * 2);
        ax += out.x * w;
        ay += out.y * w;
        az += out.z * w;
      }

      // ---- Flight dynamics: cap the sideways acceleration at v²/r_min (banked turns)
      // and limit along-track acceleration.
      {
        const s0 = Math.sqrt(vxi * vxi + vyi * vyi + vzi * vzi) || 1e-6;
        const ux = vxi / s0;
        const uy = vyi / s0;
        const uz = vzi / s0;
        let at = ax * ux + ay * uy + az * uz;
        let anx = ax - at * ux;
        let any = ay - at * uy;
        let anz = az - at * uz;
        const an = Math.sqrt(anx * anx + any * any + anz * anz);
        const rMin = Math.max(4, TURN_RADIUS_TIME * cruise * (1 - 0.5 * pn));
        const anMax = (s0 * s0) / rMin;
        if (an > anMax) {
          const kk = anMax / an;
          anx *= kk;
          any *= kk;
          anz *= kk;
        }
        const atMax = speed * 3;
        at = at > atMax ? atMax : at < -atMax ? -atMax : at;
        ax = at * ux + anx;
        ay = at * uy + any;
        az = at * uz + anz;
      }

      // ---- Integrate velocity, then relax speed toward cruise (starlings hold speed).
      let nvx = vxi + ax * dt;
      let nvy = vyi + ay * dt;
      let nvz = vzi + az * dt;
      const s = Math.sqrt(nvx * nvx + nvy * nvy + nvz * nvz) || 1e-6;
      const ns = Math.max(speed * 0.4, s + (cruise - s) * Math.min(1, dt * 10));
      nvx = (nvx / s) * ns;
      nvy = (nvy / s) * ns;
      nvz = (nvz / s) * ns;
      vxNext[i] = nvx;
      vyNext[i] = nvy;
      vzNext[i] = nvz;
    }

    // ---- Integrate positions only after every bird has read the same previous frame.
    // The hard limit is a safety net (e.g. right after the window shrinks).
    const loX = EDGE_PAD;
    const loY = EDGE_PAD;
    const hiX = Math.max(loX, width - EDGE_PAD);
    const hiY = Math.max(loY, height - EDGE_PAD);
    let hits = 0;
    for (let i = 0; i < n; i++) {
      let nx = x[i] + vxNext[i] * dt;
      let ny = y[i] + vyNext[i] * dt;
      let nz = z[i] + vzNext[i] * dt;
      if (nx < loX) {
        nx = loX;
        vxNext[i] = Math.abs(vxNext[i]);
        hits++;
      } else if (nx > hiX) {
        nx = hiX;
        vxNext[i] = -Math.abs(vxNext[i]);
        hits++;
      }
      if (ny < loY) {
        ny = loY;
        vyNext[i] = Math.abs(vyNext[i]);
        hits++;
      } else if (ny > hiY) {
        ny = hiY;
        vyNext[i] = -Math.abs(vyNext[i]);
        hits++;
      }
      if (nz < -halfD) {
        nz = -halfD;
        vzNext[i] = Math.abs(vzNext[i]);
      } else if (nz > halfD) {
        nz = halfD;
        vzNext[i] = -Math.abs(vzNext[i]);
      }
      x[i] = nx;
      y[i] = ny;
      z[i] = nz;
    }
    this.edgeHits += hits;

    // ---- Swap buffers.
    [this.vx, this.vxNext] = [vxNext, vx];
    [this.vy, this.vyNext] = [vyNext, vy];
    [this.vz, this.vzNext] = [vzNext, vz];
    P.swap();
    T.swap();

    this.localDisorder = disorderN > 0 ? disorderSum / disorderN : 0;
    this.onsets += onsets;
  }
}

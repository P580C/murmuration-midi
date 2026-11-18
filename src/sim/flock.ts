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
const REGROUP_FRACTION = 0.22;
/**
 * Containment, softest first:
 *  1. Navigation: every bird is weakly drawn to a shared target in the central sky that
 *     the World moves every few seconds. This gives flock-level swoops and changes of
 *     direction (left and right) instead of a constant orbit.
 *  2. Sky: an ellipse over the centre of the view. Birds predicted to leave it bank back
 *     toward the target. An ellipse has no corners to get trapped in.
 *  3. Edge: a thin last-resort zone at the window edge, plus a hard clamp.
 */
const NAV_WEIGHT = 1.2;
/** Sky ellipse radii as fractions of the view width / height. */
export const SKY_RX = 0.36;
export const SKY_RY = 0.34;
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

/** Shared steering target, owned by the World. */
export interface Nav {
  x: number;
  y: number;
}

/** Panic decays with this rate (1/s). */
const PANIC_DECAY = 1.4;
/** Fraction of a neighbour's panic passed on per hop (one hop per sim step). */
const PANIC_TRANSFER = 0.9;

// Scratch output for steer() to avoid allocating in the hot loop.
const out = { x: 0, y: 0 };

/** Reynolds steering: velocity change needed to fly along (dx,dy) at `speed`, capped at `limit`. */
function steer(dx: number, dy: number, vx: number, vy: number, speed: number, limit: number): void {
  const m = Math.hypot(dx, dy);
  if (m < 1e-9) {
    out.x = 0;
    out.y = 0;
    return;
  }
  let sx = (dx / m) * speed - vx;
  let sy = (dy / m) * speed - vy;
  const s = Math.hypot(sx, sy);
  if (s > limit) {
    sx *= limit / s;
    sy *= limit / s;
  }
  out.x = sx;
  out.y = sy;
}

/**
 * One flock, stored as a structure of typed arrays.
 *
 * Each bird reacts to its k nearest neighbours (topological), not to a fixed radius.
 * On top of the boids rules each bird carries a "panic" level and an escape heading.
 * Birds near the predator panic directly; others pick up panic from their most
 * panicked neighbour, one hop per step. That makes the escape ripple through the flock.
 */
export class Flock {
  n = 0;
  readonly params: FlockParams;
  readonly color: string;

  readonly x = new Float32Array(LIMITS.maxBirds);
  readonly y = new Float32Array(LIMITS.maxBirds);
  vx = new Float32Array(LIMITS.maxBirds);
  vy = new Float32Array(LIMITS.maxBirds);
  private vxNext = new Float32Array(LIMITS.maxBirds);
  private vyNext = new Float32Array(LIMITS.maxBirds);
  readonly wander = new Float32Array(LIMITS.maxBirds);

  // Velocity and panic state are double-buffered so propagation doesn't depend on update order.
  panic = new Float32Array(LIMITS.maxBirds);
  escX = new Float32Array(LIMITS.maxBirds);
  escY = new Float32Array(LIMITS.maxBirds);
  private panicNext = new Float32Array(LIMITS.maxBirds);
  private escXNext = new Float32Array(LIMITS.maxBirds);
  private escYNext = new Float32Array(LIMITS.maxBirds);

  /** Running count of hard-limit corrections (diagnostic: should stay near zero). */
  edgeHits = 0;
  /** Mean local misalignment from the last step (0 = every bird matches its neighbours). */
  localDisorder = 0;

  private readonly grid = new SpatialGrid(CELL);
  private readonly nbIdx = new Int32Array(LIMITS.maxNeighbours);
  private readonly nbD2 = new Float32Array(LIMITS.maxNeighbours);

  constructor(params: FlockParams, color: string, width: number, height: number) {
    this.params = params;
    this.color = color;
    this.seed(width, height);
  }

  /** Scatter birds around the centre, roughly heading the same way. */
  seed(width: number, height: number): void {
    const n = Math.min(LIMITS.maxBirds, Math.max(0, Math.round(this.params.count)));
    const r = Math.sqrt(n) * 6;
    const heading = Math.random() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * r;
      this.x[i] = width / 2 + Math.cos(a) * d;
      this.y[i] = height / 2 + Math.sin(a) * d;
      const h = heading + (Math.random() - 0.5) * 1.2;
      this.vx[i] = Math.cos(h) * this.params.speed;
      this.vy[i] = Math.sin(h) * this.params.speed;
      this.wander[i] = Math.random() * Math.PI * 2;
      this.panic[i] = 0;
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
      this.vx[i] = this.vx[src];
      this.vy[i] = this.vy[src];
      this.wander[i] = Math.random() * Math.PI * 2;
      this.panic[i] = 0;
    }
    this.n = target;
  }

  step(dt: number, width: number, height: number, pred: Predator, nav: Nav): void {
    const n = this.n;
    if (n === 0) return;

    const { x, y, vx, vy, vxNext, vyNext, wander } = this;
    const { panic, escX, escY, panicNext, escXNext, escYNext, nbIdx, nbD2 } = this;
    const p = this.params;
    const k = Math.max(1, Math.min(LIMITS.maxNeighbours, Math.round(p.neighbours)));
    const speed = p.speed;
    const maxF = speed * 2.2;
    const noiseF = maxF * p.randomness;
    const sepR2 = SEP_RADIUS * SEP_RADIUS;
    const maxRange2 = MAX_RANGE * MAX_RANGE;
    const margin = Math.min(width, height) * EDGE_MARGIN;
    const look = EDGE_LOOKAHEAD;
    const skyCx = width / 2;
    const skyCy = height / 2;
    const skyRx = width * SKY_RX;
    const skyRy = height * SKY_RY;
    const decay = Math.exp(-dt * PANIC_DECAY);

    // Flock centroid (previous frame), for the straggler regroup force.
    let fcx = 0;
    let fcy = 0;
    for (let i = 0; i < n; i++) {
      fcx += x[i];
      fcy += y[i];
    }
    fcx /= n;
    fcy /= n;
    const regroupR = Math.min(width, height) * REGROUP_FRACTION;

    const predActive = pred.active;
    const px = pred.x;
    const py = pred.y;
    const fleeR = pred.fleeRadius;

    const grid = this.grid;
    grid.build(x, y, n, width, height);
    const { cols, rows, cellStart, cellCount, items } = grid;
    const maxRings = Math.ceil(MAX_RANGE / CELL);

    let disorderSum = 0;
    let disorderN = 0;

    for (let i = 0; i < n; i++) {
      const xi = x[i];
      const yi = y[i];
      const vxi = vx[i];
      const vyi = vy[i];

      // k-nearest neighbours: search rings of cells outward until the k-th
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
              const d2 = dx * dx + dy * dy;
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

      // Gather neighbour stats.
      let avx = 0;
      let avy = 0;
      let cxs = 0;
      let cys = 0;
      let sx = 0;
      let sy = 0;
      let hotPanic = 0;
      let hot = -1;
      for (let m = 0; m < cnt; m++) {
        const j = nbIdx[m];
        avx += vx[j];
        avy += vy[j];
        cxs += x[j];
        cys += y[j];
        const d2 = nbD2[m];
        if (d2 < sepR2 && d2 > 1e-6) {
          // Inverse-distance push away from close neighbours.
          sx += (xi - x[j]) / d2;
          sy += (yi - y[j]) / d2;
        }
        if (panic[j] > hotPanic) {
          hotPanic = panic[j];
          hot = j;
        }
      }

      let ax = 0;
      let ay = 0;

      // Panic: direct from the predator, or relayed from the most panicked neighbour.
      let pn = panic[i] * decay;
      let ex = escX[i];
      let ey = escY[i];
      if (hot >= 0 && hotPanic * PANIC_TRANSFER > pn) {
        pn = hotPanic * PANIC_TRANSFER;
        ex = escX[hot];
        ey = escY[hot];
      }
      if (predActive) {
        const dx = xi - px;
        const dy = yi - py;
        const d = Math.hypot(dx, dy);
        if (d < fleeR) {
          const direct = Math.min(1, (fleeR - d) / (fleeR * 0.6));
          if (direct >= pn && d > 1e-6) {
            pn = direct;
            ex = dx / d;
            ey = dy / d;
          }
        }
      }
      panicNext[i] = pn;
      escXNext[i] = ex;
      escYNext[i] = ey;

      const cruise = speed * (1 + 0.8 * pn);

      if (cnt > 0) {
        // Alignment
        steer(avx, avy, vxi, vyi, cruise, maxF);
        ax += out.x * p.alignment;
        ay += out.y * p.alignment;
        // Cohesion
        steer(cxs / cnt - xi, cys / cnt - yi, vxi, vyi, cruise, maxF);
        ax += out.x * p.cohesion;
        ay += out.y * p.cohesion;
        // Separation
        if (sx !== 0 || sy !== 0) {
          steer(sx, sy, vxi, vyi, cruise, maxF);
          ax += out.x * p.separation;
          ay += out.y * p.separation;
        }

        // Local disorder: how far this bird's heading is from its neighbours' mean.
        const am = Math.hypot(avx, avy);
        const vm = Math.hypot(vxi, vyi);
        if (am > 1e-6 && vm > 1e-6) {
          disorderSum += 1 - (vxi * avx + vyi * avy) / (am * vm);
          disorderN++;
        }
      }

      // Edge avoidance: look ahead along the flight path and turn inward before the
      // edge, harder the deeper the predicted point sits in the edge zone.
      const qx = xi + vxi * look;
      const qy = yi + vyi * look;
      let wx = 0;
      let wy = 0;
      if (qx < margin) wx = (margin - qx) / margin;
      else if (qx > width - margin) wx = -(qx - (width - margin)) / margin;
      if (qy < margin) wy = (margin - qy) / margin;
      else if (qy > height - margin) wy = -(qy - (height - margin)) / margin;
      if (wx !== 0 || wy !== 0) {
        const depth = Math.min(3, Math.hypot(wx, wy));
        steer(wx, wy, vxi, vyi, cruise, maxF * 4);
        ax += out.x * depth * EDGE_WEIGHT;
        ay += out.y * depth * EDGE_WEIGHT;
      }

      // Escape manoeuvre. Near an edge the outward part is dropped: birds never flee into a wall.
      if (pn > 0.02) {
        let fx = ex;
        let fy = ey;
        if ((wx > 0 && fx < 0) || (wx < 0 && fx > 0)) fx = 0;
        if ((wy > 0 && fy < 0) || (wy < 0 && fy > 0)) fy = 0;
        if (fx !== 0 || fy !== 0) {
          steer(fx, fy, vxi, vyi, cruise, maxF * 2);
          ax += out.x * pn * 2.5;
          ay += out.y * pn * 2.5;
        }
      }

      // Noise: a slowly wandering heading per bird, faded out in the edge zone so
      // randomness can never carry a bird into the edge.
      if (noiseF > 0) {
        const w = wander[i] + (Math.random() - 0.5) * 0.7;
        wander[i] = w;
        const fade = Math.max(0, 1 - Math.hypot(wx, wy));
        ax += Math.cos(w) * noiseF * fade;
        ay += Math.sin(w) * noiseF * fade;
      }

      // Regroup: only birds well outside the main body feel it, so splits heal slowly.
      {
        const dx = fcx - xi;
        const dy = fcy - yi;
        const d = Math.hypot(dx, dy);
        if (d > regroupR) {
          const w = Math.min(1, (d - regroupR) / regroupR) * 0.6;
          steer(dx, dy, vxi, vyi, cruise, maxF);
          ax += out.x * w;
          ay += out.y * w;
        }
      }

      // Navigation + sky: always a weak pull toward the shared target, much stronger once
      // the bird's predicted position leaves the sky ellipse.
      {
        const sx = (xi + vxi * SKY_LOOKAHEAD - skyCx) / skyRx;
        const sy = (yi + vyi * SKY_LOOKAHEAD - skyCy) / skyRy;
        const out1 = Math.hypot(sx, sy) - 1;
        const w = NAV_WEIGHT + (out1 > 0 ? SKY_WEIGHT * Math.min(1.5, out1 / 0.3) : 0);
        steer(nav.x - xi, nav.y - yi, vxi, vyi, cruise, maxF * 2);
        ax += out.x * w;
        ay += out.y * w;
      }

      // Flight dynamics: split the acceleration into along-track and sideways parts and
      // cap the sideways part at v²/r_min, so birds bank through turns.
      {
        const s0 = Math.hypot(vxi, vyi) || 1e-6;
        const ux = vxi / s0;
        const uy = vyi / s0;
        let at = ax * ux + ay * uy;
        let anx = ax - at * ux;
        let any = ay - at * uy;
        const an = Math.hypot(anx, any);
        const rMin = Math.max(4, TURN_RADIUS_TIME * cruise * (1 - 0.5 * pn));
        const anMax = (s0 * s0) / rMin;
        if (an > anMax) {
          anx *= anMax / an;
          any *= anMax / an;
        }
        const atMax = speed * 3;
        at = at > atMax ? atMax : at < -atMax ? -atMax : at;
        ax = at * ux + anx;
        ay = at * uy + any;
      }

      // Integrate velocity, then relax speed toward cruise (starlings hold speed).
      let nvx = vxi + ax * dt;
      let nvy = vyi + ay * dt;
      const s = Math.hypot(nvx, nvy) || 1e-6;
      const ns = Math.max(speed * 0.4, s + (cruise - s) * Math.min(1, dt * 10));
      nvx = (nvx / s) * ns;
      nvy = (nvy / s) * ns;
      vxNext[i] = nvx;
      vyNext[i] = nvy;
    }

    // Integrate positions only after every bird has read the same previous frame.
    // The hard limit is a safety net (e.g. right after the window shrinks); the edge
    // avoidance above should keep birds well clear of it.
    const loX = EDGE_PAD;
    const loY = EDGE_PAD;
    const hiX = Math.max(loX, width - EDGE_PAD);
    const hiY = Math.max(loY, height - EDGE_PAD);
    let hits = 0;
    for (let i = 0; i < n; i++) {
      let nx = x[i] + vxNext[i] * dt;
      let ny = y[i] + vyNext[i] * dt;
      if (nx < loX) { nx = loX; vxNext[i] = Math.abs(vxNext[i]); hits++; }
      else if (nx > hiX) { nx = hiX; vxNext[i] = -Math.abs(vxNext[i]); hits++; }
      if (ny < loY) { ny = loY; vyNext[i] = Math.abs(vyNext[i]); hits++; }
      else if (ny > hiY) { ny = hiY; vyNext[i] = -Math.abs(vyNext[i]); hits++; }
      x[i] = nx;
      y[i] = ny;
    }
    this.edgeHits += hits;

    // Swap buffers.
    this.vx = vxNext;
    this.vxNext = vx;
    this.vy = vyNext;
    this.vyNext = vy;
    this.panic = panicNext;
    this.panicNext = panic;
    this.escX = escXNext;
    this.escXNext = escX;
    this.escY = escYNext;
    this.escYNext = escY;

    this.localDisorder = disorderN > 0 ? disorderSum / disorderN : 0;
  }
}

import { computeDescriptors, emptyDescriptors, type Descriptors } from './descriptors';
import { Flock, SKY_RX, SKY_RY, slabDepth, type Nav } from './flock';
import { DEFAULT_FLOCK, DEFAULT_THREAT, type FlockParams, type ThreatParams } from './params';
import { Predator } from './predator';

/** Fixed simulation step. Panic spreads one hop per step, so a fixed rate keeps wave speed stable. */
export const SIM_DT = 1 / 60;

/**
 * Owns the whole simulation. Has no DOM or rendering dependencies, so the UI can be
 * swapped for the Figma build (or the sim moved to a worker) without touching it.
 */
export class World {
  width: number;
  height: number;
  readonly flock: Flock;
  readonly predator = new Predator();
  readonly threat: ThreatParams;
  readonly descriptors: Descriptors = emptyDescriptors();
  /** Simulated seconds since start. */
  time = 0;
  /** Seconds until the next auto strike. */
  strikeCountdown: number;
  /** Shared steering target in the central sky. Moves every few seconds. */
  readonly nav: Nav = { x: 0, y: 0, z: 0 };
  private navTimer = 0;
  private navCooldown = 0;

  constructor(width: number, height: number, flockParams?: Partial<FlockParams>) {
    this.width = width;
    this.height = height;
    this.threat = { ...DEFAULT_THREAT };
    this.flock = new Flock({ ...DEFAULT_FLOCK, ...flockParams }, '#f2b55e', width, height);
    this.strikeCountdown = this.threat.interval;
    this.nav.x = width / 2;
    this.nav.y = height / 2;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  setBirdCount(count: number): void {
    this.flock.params.count = count;
    this.flock.setCount(count, this.width, this.height);
  }

  /** Launch the predator at a bird (random if not given). Ignored while a strike is in progress. */
  strike(targetIdx?: number): boolean {
    if (this.predator.active) return false;
    this.predator.strike(this.flock, this.width, this.height, targetIdx);
    this.strikeCountdown = this.threat.interval;
    return true;
  }

  /** Strike at the bird nearest a world-space point. */
  strikeAt(px: number, py: number): boolean {
    const { x, y, n } = this.flock;
    let best = -1;
    let bestD2 = Infinity;
    for (let i = 0; i < n; i++) {
      const d2 = (x[i] - px) ** 2 + (y[i] - py) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = i;
      }
    }
    return best >= 0 && this.strike(best);
  }

  /**
   * Pick a new target every 3-8 s, or when the flock gets close to it. The new target
   * sits off to one side of the flock's heading (left or right at random) and at a new
   * depth. The turn toward it starts as a wave from one edge of the flock and spreads
   * bird to bird, so the flock folds and morphs rather than turning as a rigid block.
   */
  private updateNav(dt: number): void {
    const f = this.flock;
    if (f.n === 0) return;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    let hx = 0;
    let hy = 0;
    for (let i = 0; i < f.n; i++) {
      cx += f.x[i];
      cy += f.y[i];
      cz += f.z[i];
      hx += f.vx[i];
      hy += f.vy[i];
    }
    cx /= f.n;
    cy /= f.n;
    cz /= f.n;

    this.navTimer -= dt;
    this.navCooldown -= dt;
    const near = Math.hypot(this.nav.x - cx, this.nav.y - cy) < Math.min(this.width, this.height) * 0.12;
    // Turn before the flock reaches the sky boundary, so the boundary rarely has to
    // steer (boundary-following is what makes a flock orbit).
    const look = 1.2 / f.n;
    const fx = cx + hx * look - this.width / 2;
    const fy = cy + hy * look - this.height / 2;
    const heading_out = Math.hypot(fx / (this.width * SKY_RX), fy / (this.height * SKY_RY)) > 0.7;
    const due = this.navTimer <= 0 || near || (heading_out && this.navCooldown <= 0);
    if (!due) return;
    this.navTimer = 3 + Math.random() * 5;
    this.navCooldown = 1.5;

    const heading = Math.atan2(hy, hx);
    const side = Math.random() < 0.5 ? -1 : 1;
    // Near the boundary, usually pick a target that reverses the flock's rotation about
    // the centre (a U-turn back across the sky). Otherwise every inward turn would keep
    // the same rotation and the flock would orbit.
    const offX = cx - this.width / 2;
    const offY = cy - this.height / 2;
    const spin = Math.sign(offX * hy - offY * hx);
    const reverse = heading_out && Math.random() < 0.75;
    const rx = this.width * 0.3;
    const ry = this.height * 0.28;
    let bx = this.width / 2;
    let by = this.height / 2;
    for (let tries = 0; tries < 24; tries++) {
      // Uniform point in the central ellipse.
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random());
      const tx = this.width / 2 + Math.cos(a) * r * rx;
      const ty = this.height / 2 + Math.sin(a) * r * ry;
      bx = tx;
      by = ty;
      if (reverse) {
        // Straight path to the target must have the opposite angular momentum.
        const l = offX * (ty - this.height / 2) - offY * (tx - this.width / 2);
        if (Math.sign(l) === -spin && Math.abs(l) > rx * ry * 0.15) break;
        continue;
      }
      // Want a turn of 50-140° to the chosen side.
      let turn = Math.atan2(ty - cy, tx - cx) - heading;
      turn = Math.atan2(Math.sin(turn), Math.cos(turn)) * side;
      if (turn > 0.9 && turn < 2.4) break;
    }
    const depth = slabDepth(this.width, this.height);
    const bz = (Math.random() - 0.5) * depth * 0.6;
    this.nav.x = bx;
    this.nav.y = by;
    this.nav.z = bz;

    // Start the turn as a wave from a random edge of the flock.
    const sa = Math.random() * Math.PI * 2;
    const sz = (Math.random() - 0.5) * 0.6;
    f.initiateTurn(bx - cx, by - cy, bz - cz, Math.cos(sa), Math.sin(sa), sz);
  }

  step(dt: number = SIM_DT): void {
    this.time += dt;

    if (this.threat.auto && !this.predator.active) {
      this.strikeCountdown -= dt;
      if (this.strikeCountdown <= 0) this.strike();
    }

    this.updateNav(dt);
    this.predator.step(dt, this.flock, this.width, this.height);
    this.flock.step(dt, this.width, this.height, this.predator, this.nav);
    computeDescriptors(this.flock, this.predator, this.width, this.height, this.descriptors);
  }
}

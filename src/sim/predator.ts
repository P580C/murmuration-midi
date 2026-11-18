import { slabDepth, type Flock } from './flock';

export type PredatorState = 'idle' | 'attack' | 'leave';

const TRAIL_LEN = 40;

/**
 * A single predator. When idle it is off-screen and has no effect.
 * A strike spawns it outside the view, it homes on one target bird with a limited
 * turn rate (so the flock can out-turn it), then it flies off and goes idle again.
 */
export class Predator {
  state: PredatorState = 'idle';
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vy = 0;
  vz = 0;
  /** Seconds spent in the current state. */
  t = 0;
  target = -1;
  /** Radius inside which birds react directly. */
  readonly fleeRadius = 150;

  readonly trailX = new Float32Array(TRAIL_LEN);
  readonly trailY = new Float32Array(TRAIL_LEN);
  trailHead = 0;
  trailSize = 0;

  get active(): boolean {
    return this.state !== 'idle';
  }

  strike(flock: Flock, width: number, height: number, targetIdx?: number): void {
    if (flock.n === 0) return;
    this.target =
      targetIdx !== undefined && targetIdx >= 0 && targetIdx < flock.n
        ? targetIdx
        : Math.floor(Math.random() * flock.n);

    const angle = Math.random() * Math.PI * 2;
    const r = Math.hypot(width, height) / 2 + 60;
    this.x = width / 2 + Math.cos(angle) * r;
    this.y = height / 2 + Math.sin(angle) * r;
    this.z = (Math.random() - 0.5) * slabDepth(width, height) * 0.5;

    const s = this.cruiseSpeed(flock);
    const dx = flock.x[this.target] - this.x;
    const dy = flock.y[this.target] - this.y;
    const dz = flock.z[this.target] - this.z;
    const d = Math.hypot(dx, dy, dz) || 1;
    this.vx = (dx / d) * s;
    this.vy = (dy / d) * s;
    this.vz = (dz / d) * s;

    this.state = 'attack';
    this.t = 0;
    this.trailSize = 0;
  }

  step(dt: number, flock: Flock, width: number, height: number): void {
    if (this.state === 'idle') return;
    this.t += dt;
    const speed = this.cruiseSpeed(flock);

    if (this.state === 'attack') {
      if (this.target >= flock.n) this.target = Math.floor(Math.random() * flock.n);
      const dx = flock.x[this.target] - this.x;
      const dy = flock.y[this.target] - this.y;
      const dz = flock.z[this.target] - this.z;
      const d = Math.hypot(dx, dy, dz);

      if (d < 10 || this.t > 5) {
        this.state = 'leave';
        this.t = 0;
      } else {
        // Steer toward the target with a limited force (= limited turn rate).
        const maxForce = speed * 2.4;
        let sx = (dx / d) * speed - this.vx;
        let sy = (dy / d) * speed - this.vy;
        let sz = (dz / d) * speed - this.vz;
        const sm = Math.hypot(sx, sy, sz);
        if (sm > maxForce) {
          sx *= maxForce / sm;
          sy *= maxForce / sm;
          sz *= maxForce / sm;
        }
        this.vx += sx * dt;
        this.vy += sy * dt;
        this.vz += sz * dt;
      }
    }

    // Hold cruise speed (slight acceleration while leaving).
    const target = this.state === 'leave' ? speed * 1.2 : speed;
    const s = Math.hypot(this.vx, this.vy, this.vz) || 1;
    const ns = s + (target - s) * Math.min(1, dt * 4);
    this.vx = (this.vx / s) * ns;
    this.vy = (this.vy / s) * ns;
    this.vz = (this.vz / s) * ns;

    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.z += this.vz * dt;
    this.pushTrail();

    if (this.state === 'leave') {
      const m = 120;
      const out = this.x < -m || this.y < -m || this.x > width + m || this.y > height + m;
      if (out || this.t > 6) {
        this.state = 'idle';
        this.t = 0;
        this.target = -1;
      }
    }
  }

  private cruiseSpeed(flock: Flock): number {
    return Math.max(220, flock.params.speed * 2.5);
  }

  private pushTrail(): void {
    this.trailX[this.trailHead] = this.x;
    this.trailY[this.trailHead] = this.y;
    this.trailHead = (this.trailHead + 1) % TRAIL_LEN;
    this.trailSize = Math.min(TRAIL_LEN, this.trailSize + 1);
  }

  /** Trail point by age (0 = newest). */
  trailAt(age: number, out: { x: number; y: number }): void {
    const idx = (this.trailHead - 1 - age + TRAIL_LEN * 2) % TRAIL_LEN;
    out.x = this.trailX[idx];
    out.y = this.trailY[idx];
  }
}

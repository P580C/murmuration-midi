import type { World } from '../sim/world';

const PANIC_BUCKETS = 4;
const DEPTH_BUCKETS = 4;

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.replace('#', ''), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export interface RenderOptions {
  /** 0 = no trails, towards 1 = long trails. */
  trails: number;
  background: string; // "r, g, b"
}

/** Canvas 2D renderer. Reads the world, never writes to it. */
export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private width = 0;
  private height = 0;
  private bucketColors: string[] = [];
  private bucketOf = new Uint8Array(0);
  private colorFor = '';
  private readonly tmp = { x: 0, y: 0 };

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D not available');
    this.ctx = ctx;
  }

  resize(width: number, height: number): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = width;
    this.height = height;
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
  }

  /**
   * Colour per (depth, panic) bucket. Calm birds use the flock colour, panicked birds
   * blend toward white. Far birds are dimmer.
   */
  private ensureColors(hex: string): void {
    if (this.colorFor === hex) return;
    const [r, g, b] = hexToRgb(hex);
    this.bucketColors = [];
    for (let d = 0; d < DEPTH_BUCKETS; d++) {
      const near = d / (DEPTH_BUCKETS - 1);
      for (let k = 0; k < PANIC_BUCKETS; k++) {
        const t = k / (PANIC_BUCKETS - 1);
        const mix = (c: number) => Math.round(c + (255 - c) * t);
        const alpha = 0.32 + 0.5 * near + 0.18 * t;
        this.bucketColors.push(`rgba(${mix(r)}, ${mix(g)}, ${mix(b)}, ${alpha.toFixed(3)})`);
      }
    }
    this.colorFor = hex;
  }

  draw(world: World, opts: RenderOptions): void {
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgba(${opts.background}, ${1 - opts.trails})`;
    ctx.fillRect(0, 0, this.width, this.height);

    this.drawFlock(world);
    this.drawPredator(world);
  }

  /**
   * The flock is a 3D slab drawn flattened. Near birds are longer, thicker and brighter.
   * A bird flying toward or away from the viewer looks foreshortened. Strokes add up
   * ('lighter'), so where the flock is seen edge-on it reads as a dense, bright band.
   */
  private drawFlock(world: World): void {
    const { ctx } = this;
    const flock = world.flock;
    const { n, x, y, z, vx, vy, vz, panic } = flock;
    const halfD = flock.depth / 2 || 1;
    this.ensureColors(flock.color);

    if (this.bucketOf.length < n) this.bucketOf = new Uint8Array(n);
    const bucketOf = this.bucketOf;
    for (let i = 0; i < n; i++) {
      let pb = Math.round(panic[i] * (PANIC_BUCKETS - 1));
      pb = pb < 0 ? 0 : pb >= PANIC_BUCKETS ? PANIC_BUCKETS - 1 : pb;
      let db = Math.floor(((z[i] / halfD + 1) / 2) * DEPTH_BUCKETS);
      db = db < 0 ? 0 : db >= DEPTH_BUCKETS ? DEPTH_BUCKETS - 1 : db;
      bucketOf[i] = db * PANIC_BUCKETS + pb;
    }

    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    const total = DEPTH_BUCKETS * PANIC_BUCKETS;
    for (let b = 0; b < total; b++) {
      const near = Math.floor(b / PANIC_BUCKETS) / (DEPTH_BUCKETS - 1);
      const len = 2.6 + 2.2 * near;
      ctx.lineWidth = 1.0 + 1.1 * near;
      ctx.beginPath();
      let any = false;
      for (let i = 0; i < n; i++) {
        if (bucketOf[i] !== b) continue;
        const s = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i] + vz[i] * vz[i]) || 1;
        // Projected direction keeps its 3D length, so head-on birds look short.
        const ux = (vx[i] / s) * len;
        const uy = (vy[i] / s) * len;
        const ox = Math.abs(ux) + Math.abs(uy) < 0.6 ? 0.6 : 0; // keep a visible dot
        ctx.moveTo(x[i] - ux - ox, y[i] - uy);
        ctx.lineTo(x[i] + ux + ox, y[i] + uy);
        any = true;
      }
      if (any) {
        ctx.strokeStyle = this.bucketColors[b];
        ctx.stroke();
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  private drawPredator(world: World): void {
    const pred = world.predator;
    if (!pred.active) return;
    const { ctx, tmp } = this;

    // Trail
    if (pred.trailSize > 1) {
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      for (let a = 1; a < pred.trailSize; a++) {
        pred.trailAt(a - 1, tmp);
        const x0 = tmp.x;
        const y0 = tmp.y;
        pred.trailAt(a, tmp);
        ctx.strokeStyle = `rgba(255, 84, 104, ${0.5 * (1 - a / pred.trailSize)})`;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(tmp.x, tmp.y);
        ctx.stroke();
      }
    }

    // Flee radius
    ctx.strokeStyle = 'rgba(255, 84, 104, 0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(pred.x, pred.y, pred.fleeRadius, 0, Math.PI * 2);
    ctx.stroke();

    // Body: a swept-wing chevron pointing along velocity
    const s = Math.hypot(pred.vx, pred.vy) || 1;
    const ux = pred.vx / s;
    const uy = pred.vy / s;
    const size = 11;
    ctx.fillStyle = '#ff5468';
    ctx.beginPath();
    ctx.moveTo(pred.x + ux * size, pred.y + uy * size);
    ctx.lineTo(pred.x - ux * size * 0.7 - uy * size * 0.8, pred.y - uy * size * 0.7 + ux * size * 0.8);
    ctx.lineTo(pred.x - ux * size * 0.25, pred.y - uy * size * 0.25);
    ctx.lineTo(pred.x - ux * size * 0.7 + uy * size * 0.8, pred.y - uy * size * 0.7 - ux * size * 0.8);
    ctx.closePath();
    ctx.fill();
  }
}

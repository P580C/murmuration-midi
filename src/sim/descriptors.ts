import { SKY_RX, SKY_RY, type Flock } from './flock';
import type { Predator } from './predator';

/** Aggregate flock descriptors, all normalised to 0-1. These become the mappable stream sources. */
export interface Descriptors {
  centreX: number;
  centreY: number;
  spread: number;
  speed: number;
  alignment: number;
  swirl: number;
  turbulence: number;
  threatDistance: number;
  panic: number;
}

export type DescriptorKey = keyof Descriptors;

export const DESCRIPTOR_META: { key: DescriptorKey; label: string; hint: string }[] = [
  { key: 'centreX', label: 'Centre X', hint: 'Centroid, left → right' },
  { key: 'centreY', label: 'Centre Y', hint: 'Centroid, bottom → top' },
  { key: 'spread', label: 'Spread', hint: 'Mean distance from centroid' },
  { key: 'speed', label: 'Speed', hint: 'Mean speed (≈0.5 at cruise, ↑ when panicking)' },
  { key: 'alignment', label: 'Alignment', hint: 'Polarisation: 1 = all same heading' },
  { key: 'swirl', label: 'Swirl', hint: 'Milling: 0.5 none, ↑ clockwise, ↓ anticlockwise' },
  { key: 'turbulence', label: 'Turbulence', hint: 'Local heading disagreement' },
  { key: 'threatDistance', label: 'Threat dist.', hint: 'Predator to centroid (1 = none)' },
  { key: 'panic', label: 'Panic', hint: 'Mean panic level (extra, not in spec)' },
];

export function emptyDescriptors(): Descriptors {
  return {
    centreX: 0.5,
    centreY: 0.5,
    spread: 0,
    speed: 0,
    alignment: 0,
    swirl: 0.5,
    turbulence: 0,
    threatDistance: 1,
    panic: 0,
  };
}

/** Fraction of the sky ellipse the centroid typically reaches (tuned from headless runs). */
const CENTRE_SPAN = 1;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function computeDescriptors(
  flock: Flock,
  pred: Predator,
  width: number,
  height: number,
  out: Descriptors,
): Descriptors {
  const n = flock.n;
  if (n === 0) return Object.assign(out, emptyDescriptors());

  const { x, y, z, vx, vy, vz, panic } = flock;

  // Speed, alignment and threat distance use the full 3D motion. Position, spread and
  // swirl use the projected (on-screen) x/y, so they match what you see.
  let cx = 0;
  let cy = 0;
  let cz = 0;
  let sumSpeed = 0;
  let hx = 0;
  let hy = 0;
  let hz = 0;
  let panicSum = 0;
  for (let i = 0; i < n; i++) {
    cx += x[i];
    cy += y[i];
    cz += z[i];
    const s = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i] + vz[i] * vz[i]);
    sumSpeed += s;
    if (s > 1e-6) {
      hx += vx[i] / s;
      hy += vy[i] / s;
      hz += vz[i] / s;
    }
    panicSum += panic[i];
  }
  cx /= n;
  cy /= n;
  cz /= n;

  let spreadSum = 0;
  let swirlSum = 0;
  for (let i = 0; i < n; i++) {
    const rx = x[i] - cx;
    const ry = y[i] - cy;
    const r = Math.hypot(rx, ry);
    spreadSum += r;
    const s = Math.hypot(vx[i], vy[i]);
    if (r > 1e-6 && s > 1e-6) {
      // Screen y points down, so a positive cross product is clockwise on screen.
      swirlSum += (rx * vy[i] - ry * vx[i]) / (r * s);
    }
  }

  const minDim = Math.min(width, height);
  // Centre is measured within the sky area the flock actually uses, so it still spans 0-1.
  const rx = width * SKY_RX * CENTRE_SPAN;
  const ry = height * SKY_RY * CENTRE_SPAN;
  out.centreX = clamp01((cx - (width / 2 - rx)) / (2 * rx));
  out.centreY = clamp01(1 - (cy - (height / 2 - ry)) / (2 * ry));
  out.spread = clamp01(spreadSum / n / (minDim * 0.35));
  out.speed = clamp01(sumSpeed / n / (flock.params.speed * 1.8));
  out.alignment = clamp01(Math.sqrt(hx * hx + hy * hy + hz * hz) / n);
  out.swirl = clamp01((swirlSum / n + 1) / 2);
  out.turbulence = clamp01(flock.localDisorder * 4);
  out.threatDistance = pred.active
    ? clamp01(Math.hypot(pred.x - cx, pred.y - cy, pred.z - cz) / (Math.hypot(width, height) * 0.5))
    : 1;
  out.panic = clamp01(panicSum / n);
  return out;
}

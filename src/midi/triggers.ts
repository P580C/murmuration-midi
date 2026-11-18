import { PPQN, type ClockTick } from './clock';

/**
 * Panic triggers: a MIDI note each time birds cross into panic.
 *
 * A single strike can panic hundreds of birds within a second, so onsets are either
 * quantised to the clock (all onsets within one grid step become one note, the
 * velocity rising with how many there were) or, with quantise off, rate-limited.
 */

export type Quantise = 'off' | '1/32' | '1/16' | '1/8' | '1/4';
export type VelocityMode = 'burst' | 'fixed';

export const QUANTISE_OPTIONS: { value: Quantise; label: string }[] = [
  { value: '1/32', label: '1/32' },
  { value: '1/16', label: '1/16' },
  { value: '1/8', label: '1/8' },
  { value: '1/4', label: '1/4' },
  { value: 'off', label: 'Off (rate-limited)' },
];

const QUANT_TICKS: Record<Exclude<Quantise, 'off'>, number> = {
  '1/32': PPQN / 8,
  '1/16': PPQN / 4,
  '1/8': PPQN / 2,
  '1/4': PPQN,
};

export interface TriggerConfig {
  enabled: boolean;
  /** MIDI channel 1-16. */
  channel: number;
  /** Note number 0-127. */
  note: number;
  velocityMode: VelocityMode;
  /** Fixed velocity, and the ceiling for burst mode (1-127). */
  velocity: number;
  /** Note length in ms. */
  gateMs: number;
  /** Panic level (0-1) a bird must cross to count as an onset. */
  threshold: number;
  quantise: Quantise;
  /** Max notes per second when quantise is off. */
  maxRate: number;
}

export function defaultTrigger(): TriggerConfig {
  return {
    enabled: true,
    channel: 1,
    note: 36,
    velocityMode: 'burst',
    velocity: 127,
    gateMs: 20,
    threshold: 0.5,
    quantise: '1/16',
    maxRate: 16,
  };
}

const num = (v: unknown, lo: number, hi: number, fallback: number, round = true) => {
  let n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (round) n = Math.round(n);
  return Math.min(hi, Math.max(lo, n));
};

export function sanitizeTrigger(raw: unknown): TriggerConfig {
  const d = defaultTrigger();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Partial<Record<keyof TriggerConfig, unknown>>;
  const q = QUANTISE_OPTIONS.some((o) => o.value === r.quantise) ? (r.quantise as Quantise) : d.quantise;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    channel: num(r.channel, 1, 16, d.channel),
    note: num(r.note, 0, 127, d.note),
    velocityMode: r.velocityMode === 'fixed' ? 'fixed' : 'burst',
    velocity: num(r.velocity, 1, 127, d.velocity),
    gateMs: num(r.gateMs, 2, 2000, d.gateMs),
    threshold: num(r.threshold, 0.05, 1, d.threshold, false),
    quantise: q,
    maxRate: num(r.maxRate, 1, 60, d.maxRate),
  };
}

export type NoteSender = (channel: number, note: number, velocity: number, gateMs: number, at?: number) => boolean;

export class TriggerEngine {
  cfg: TriggerConfig = defaultTrigger();
  /** Onsets waiting for the next grid step. */
  pending = 0;
  sentCount = 0;
  lastSentAt = 0;
  lastVelocity = 0;
  /** Smoothed onsets per second (for display). */
  onsetRate = 0;
  private nextFree = 0;

  constructor(private readonly send: NoteSender) {}

  /** Birds that crossed into panic since the last call. `dt` in seconds. */
  addOnsets(count: number, dt: number, now: number, canSend: boolean): void {
    if (dt > 0) this.onsetRate += (count / dt - this.onsetRate) * Math.min(1, dt * 2);
    if (!this.cfg.enabled || count <= 0) return;
    if (this.cfg.quantise !== 'off') {
      this.pending += count;
      return;
    }
    if (!canSend || now < this.nextFree) return;
    this.fire(count, now, this.cfg.gateMs);
    this.nextFree = now + Math.max(1000 / this.cfg.maxRate, this.cfg.gateMs + 2);
  }

  /** Clock tick: release pending onsets on grid boundaries. */
  onTick(t: ClockTick, bpm: number, canSend: boolean): void {
    const q = this.cfg.quantise;
    if (q === 'off') return;
    const step = QUANT_TICKS[q];
    if (t.tick % step !== 0) return;
    if (this.pending > 0 && this.cfg.enabled && canSend) {
      // Keep the note shorter than the grid step so repeats don't cut each other off.
      const stepMs = (60000 / Math.max(20, bpm) / PPQN) * step;
      this.fire(this.pending, t.time, Math.min(this.cfg.gateMs, Math.max(2, stepMs - 3)));
    }
    this.pending = 0;
  }

  /** Send one note now (for mapping in a DAW / VCV). */
  test(now: number): void {
    this.fire(1, now, Math.max(this.cfg.gateMs, 50), this.cfg.velocity);
  }

  velocityFor(count: number): number {
    const c = this.cfg;
    if (c.velocityMode === 'fixed') return c.velocity;
    // 1 bird ≈ 30% of the ceiling, ~60 birds or more = full.
    const t = Math.min(1, 0.3 + 0.7 * (Math.log2(1 + count) / 6));
    return Math.max(1, Math.round(c.velocity * t));
  }

  private fire(count: number, at: number, gateMs: number, velocity = this.velocityFor(count)): void {
    if (this.send(this.cfg.channel, this.cfg.note, velocity, gateMs, at)) {
      this.sentCount++;
      this.lastSentAt = at;
      this.lastVelocity = velocity;
    }
  }
}

import { DESCRIPTOR_META, type DescriptorKey } from '../sim/descriptors';

export type Curve = 'linear' | 'exp';

/** One output slot: which stream it reads and how it maps to a CC. */
export interface SlotConfig {
  enabled: boolean;
  source: DescriptorKey;
  /** Flock index. Only one flock exists until milestone 6. */
  flock: number;
  /** MIDI channel, 1-16. */
  channel: number;
  /** CC number, 0-127. */
  cc: number;
  /** Output range, 0-127. min > max is allowed and flips the range. */
  min: number;
  max: number;
  /** 0 = raw, 1 = heavy smoothing (~3 s time constant). */
  smoothing: number;
  curve: Curve;
  invert: boolean;
}

export const SLOT_COUNT = 8;

/** Defaults: one slot per descriptor on CCs 20-27 (undefined in the MIDI spec, so free to use). */
const DEFAULT_SOURCES: DescriptorKey[] = [
  'centreX',
  'centreY',
  'spread',
  'speed',
  'alignment',
  'swirl',
  'turbulence',
  'panic',
];

export function defaultSlot(i: number): SlotConfig {
  return {
    enabled: true,
    source: DEFAULT_SOURCES[i] ?? 'centreX',
    flock: 0,
    channel: 1,
    cc: 20 + i,
    min: 0,
    max: 127,
    smoothing: 0.15,
    curve: 'linear',
    invert: false,
  };
}

export function defaultSlots(): SlotConfig[] {
  return Array.from({ length: SLOT_COUNT }, (_, i) => defaultSlot(i));
}

const VALID_SOURCES = new Set<string>(DESCRIPTOR_META.map((m) => m.key));
const int = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

/** Repair a slot loaded from storage so bad or old data can't break the engine. */
export function sanitizeSlot(raw: unknown, i: number): SlotConfig {
  const d = defaultSlot(i);
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Partial<Record<keyof SlotConfig, unknown>>;
  const smoothing = Number(r.smoothing);
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    source: typeof r.source === 'string' && VALID_SOURCES.has(r.source) ? (r.source as DescriptorKey) : d.source,
    flock: 0,
    channel: int(r.channel, 1, 16, d.channel),
    cc: int(r.cc, 0, 127, d.cc),
    min: int(r.min, 0, 127, d.min),
    max: int(r.max, 0, 127, d.max),
    smoothing: Number.isFinite(smoothing) ? Math.min(1, Math.max(0, smoothing)) : d.smoothing,
    curve: r.curve === 'exp' ? 'exp' : 'linear',
    invert: typeof r.invert === 'boolean' ? r.invert : d.invert,
  };
}

/** Per-slot runtime state. */
export class SlotState {
  smoothed = NaN;
  /** Latest output value, 0-127. */
  value = 0;
  /** Last value actually sent, -1 = never (forces a send). */
  lastSent = -1;
  lastSentAt = 0;
}

const EXP_K = 4;
const EXP_NORM = Math.exp(EXP_K) - 1;

/**
 * Stream value (0-1) → smoothing → invert → curve → range → integer 0-127.
 * Smoothing comes first so it acts on the stream itself, independent of the mapping.
 */
export function processSlot(cfg: SlotConfig, state: SlotState, input: number, dt: number): number {
  let x = input < 0 ? 0 : input > 1 ? 1 : input;

  if (Number.isNaN(state.smoothed) || cfg.smoothing <= 0) {
    state.smoothed = x;
  } else {
    const tau = cfg.smoothing * cfg.smoothing * 3; // seconds
    state.smoothed += (x - state.smoothed) * (1 - Math.exp(-dt / tau));
  }
  x = state.smoothed;

  if (cfg.invert) x = 1 - x;
  if (cfg.curve === 'exp') x = (Math.exp(EXP_K * x) - 1) / EXP_NORM;

  const v = Math.round(cfg.min + (cfg.max - cfg.min) * x);
  state.value = v < 0 ? 0 : v > 127 ? 127 : v;
  return state.value;
}

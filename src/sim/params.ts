/** User-facing parameters. The UI writes these; the sim reads them every step. */

export interface FlockParams {
  /** Number of birds. */
  count: number;
  /** Cruise speed in world units (CSS px) per second. */
  speed: number;
  /** 0-1 strength of the per-bird wander/noise term. */
  randomness: number;
  /** Topological neighbour count (starlings: ~7). */
  neighbours: number;
  /** Rule weights (advanced). */
  separation: number;
  alignment: number;
  cohesion: number;
}

export type ThreatMode = 'manual' | 'timer' | 'bars';

export interface ThreatParams {
  /** manual: only on demand. timer: every `interval` seconds. bars: every `bars` bars of the clock. */
  mode: ThreatMode;
  /** Seconds between timer strikes. */
  interval: number;
  /** Bars between clock-synced strikes. */
  bars: number;
}

export const DEFAULT_FLOCK: FlockParams = {
  count: 1200,
  speed: 160,
  randomness: 0.2,
  neighbours: 7,
  separation: 1.6,
  alignment: 1.0,
  cohesion: 0.7,
};

export const DEFAULT_THREAT: ThreatParams = {
  mode: 'timer',
  interval: 10,
  bars: 4,
};

export const LIMITS = {
  maxBirds: 4000,
  maxNeighbours: 20,
};

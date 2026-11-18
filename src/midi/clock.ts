/**
 * MIDI clock input (24 ppqn) with an internal fallback.
 *
 * The DAW is the clock master: the app only listens. While external clock pulses are
 * arriving they drive the tick count and tempo. Start (FA) resets to the downbeat,
 * Continue (FB) resumes, Stop (FC) halts, and Song Position (F2) jumps. If no pulse
 * arrives for a while, the internal clock takes over at the manual BPM and carries on
 * counting from the same position.
 *
 * Ticks are emitted to listeners with the time they happened (performance.now() base),
 * so outgoing events can be timestamped precisely.
 */

export const PPQN = 24;
/** 4/4 is assumed for bar counting. */
export const TICKS_PER_BAR = PPQN * 4;

/** Treat external clock as lost after this long without a pulse. */
const EXTERNAL_TIMEOUT_MS = 600;

export type ClockSource = 'external' | 'internal';

export interface ClockTick {
  /** Tick index since the last Start (24 per quarter note). 0 = first downbeat. */
  tick: number;
  /** When the tick happened (performance.now() time base). */
  time: number;
}

/** '' = listen on every input, 'none' = ignore external clock, otherwise an input id. */
export type ClockInput = string;

export class Clock {
  inputId: ClockInput = '';
  manualBpm = 120;

  source: ClockSource = 'internal';
  /** Current tempo: smoothed external BPM, or the manual BPM. */
  bpm = 120;
  running = true;
  /** Last emitted tick. */
  tick = -1;

  private access: MIDIAccess | null = null;
  private tickListeners = new Set<(t: ClockTick) => void>();
  private changeListeners = new Set<() => void>();

  // External state
  private extLast = -Infinity;
  private extIntervalMs = 0;
  private sawTransport = false;

  // Internal state
  private intNext = 0;

  onTick(fn: (t: ClockTick) => void): () => void {
    this.tickListeners.add(fn);
    return () => this.tickListeners.delete(fn);
  }

  /** Input list or selection changed. */
  onChange(fn: () => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  attach(access: MIDIAccess): void {
    this.access = access;
    access.addEventListener('statechange', () => {
      this.bindInputs();
      this.emitChange();
    });
    this.bindInputs();
    this.emitChange();
  }

  inputs(): { id: string; name: string }[] {
    if (!this.access) return [];
    return [...this.access.inputs.values()].map((p) => ({ id: p.id, name: p.name ?? p.id }));
  }

  selectInput(id: ClockInput): void {
    this.inputId = id;
    this.bindInputs();
    if (id === 'none') this.fallBackToInternal(performance.now());
    this.emitChange();
  }

  /** Feed one MIDI message. Public so tests can drive the clock without hardware. */
  handleMessage(data: Uint8Array | number[], time: number): void {
    if (this.inputId === 'none' || data.length === 0) return;
    const status = data[0];
    switch (status) {
      case 0xf8: {
        // Timing clock
        if (this.source !== 'external') {
          this.source = 'external';
          this.extLast = -Infinity;
          this.extIntervalMs = 0;
          if (!this.sawTransport) this.running = true;
          this.emitChange();
        }
        const dt = time - this.extLast;
        if (dt > 0 && dt < 250) {
          // Smooth over roughly one beat.
          this.extIntervalMs = this.extIntervalMs === 0 ? dt : this.extIntervalMs + (dt - this.extIntervalMs) * 0.06;
          this.bpm = 60000 / (this.extIntervalMs * PPQN);
        }
        this.extLast = time;
        if (this.running) this.emit(time);
        break;
      }
      case 0xfa: // Start: next pulse is the downbeat
        this.sawTransport = true;
        this.running = true;
        this.tick = -1;
        this.emitChange();
        break;
      case 0xfb: // Continue
        this.sawTransport = true;
        this.running = true;
        this.emitChange();
        break;
      case 0xfc: // Stop
        this.sawTransport = true;
        this.running = false;
        this.emitChange();
        break;
      case 0xf2: {
        // Song position pointer, in 16th notes (6 ticks each)
        if (data.length >= 3) {
          const sixteenths = (data[1] & 0x7f) | ((data[2] & 0x7f) << 7);
          this.tick = sixteenths * 6 - 1;
        }
        break;
      }
    }
  }

  /** Call regularly (every sim tick). Drives the internal clock and detects lost external clock. */
  poll(now: number): void {
    if (this.source === 'external') {
      if (now - this.extLast > EXTERNAL_TIMEOUT_MS) this.fallBackToInternal(now);
      return;
    }
    this.bpm = this.manualBpm;
    const tickMs = 60000 / (Math.max(20, this.manualBpm) * PPQN);
    if (this.intNext === 0 || now - this.intNext > 1000) this.intNext = now; // first run or long stall
    while (this.intNext <= now) {
      this.emit(this.intNext);
      this.intNext += tickMs;
    }
  }

  /** Bar (1-based), beat (1-based) and ticks into the beat for the current position. */
  position(): { bar: number; beat: number } {
    const t = Math.max(0, this.tick);
    return { bar: Math.floor(t / TICKS_PER_BAR) + 1, beat: Math.floor((t % TICKS_PER_BAR) / PPQN) + 1 };
  }

  private fallBackToInternal(now: number): void {
    const was = this.source;
    this.source = 'internal';
    this.running = true;
    this.sawTransport = false;
    this.intNext = now;
    if (was !== 'internal') this.emitChange();
  }

  private emit(time: number): void {
    this.tick++;
    const t: ClockTick = { tick: this.tick, time };
    for (const fn of this.tickListeners) fn(t);
  }

  private bindInputs(): void {
    if (!this.access) return;
    for (const input of this.access.inputs.values()) {
      const listen = this.inputId !== 'none' && (this.inputId === '' || this.inputId === input.id);
      input.onmidimessage = listen ? (e: MIDIMessageEvent) => e.data && this.handleMessage(e.data, e.timeStamp) : null;
    }
  }

  private emitChange(): void {
    for (const fn of this.changeListeners) fn();
  }
}

import type { Descriptors } from '../sim/descriptors';
import { Clock, type ClockTick } from './clock';
import { MidiOutput } from './output';
import { TriggerEngine } from './triggers';
import { SLOT_COUNT, SlotState, defaultSlots, processSlot, type SlotConfig } from './slots';

/** While learning, resend the current value at this interval even if it hasn't changed. */
const LEARN_RESEND_MS = 250;

/**
 * Turns descriptor values into CC messages.
 * Every slot is processed every tick (so the UI meters stay live), but a CC is only
 * sent when its integer value changes. During MIDI learn only the learning slot sends.
 */
export class MidiEngine {
  readonly output = new MidiOutput();
  slots: SlotConfig[] = defaultSlots();
  readonly state: SlotState[] = Array.from({ length: SLOT_COUNT }, () => new SlotState());
  /** Master switch for all sending. */
  sending = true;
  /** Slot index in learn mode, or -1. */
  learning = -1;
  /** Messages sent since start (for the status line). */
  sentCount = 0;
  readonly clock = new Clock();
  readonly triggers = new TriggerEngine((ch, note, vel, gate, at) => this.output.sendNote(ch, note, vel, gate, at));

  constructor() {
    this.clock.onTick((t: ClockTick) => this.triggers.onTick(t, this.clock.bpm, this.canSendTriggers));
  }

  /** Request MIDI access, then hook the clock up to the inputs. */
  async init(): Promise<void> {
    await this.output.init();
    const access = this.output.midiAccess;
    if (access) this.clock.attach(access);
  }

  /** Triggers are muted while a CC slot is learning, so the DAW learns the right message. */
  get canSendTriggers(): boolean {
    return this.sending && this.output.connected && this.learning < 0;
  }

  /** Feed the birds that crossed into panic since the last call. */
  panicOnsets(count: number, dt: number, nowMs: number): void {
    this.triggers.addOnsets(count, dt, nowMs, this.canSendTriggers);
  }

  update(d: Descriptors, dt: number, nowMs: number): void {
    const canSend = this.sending && this.output.connected;
    for (let i = 0; i < SLOT_COUNT; i++) {
      const cfg = this.slots[i];
      const st = this.state[i];
      const value = processSlot(cfg, st, d[cfg.source], dt);
      if (!canSend) continue;

      const isLearning = this.learning === i;
      if (this.learning >= 0 && !isLearning) continue;
      if (!cfg.enabled && !isLearning) continue;

      const due = value !== st.lastSent || (isLearning && nowMs - st.lastSentAt >= LEARN_RESEND_MS);
      if (!due) continue;
      if (this.output.sendCC(cfg.channel, cfg.cc, value)) {
        st.lastSent = value;
        st.lastSentAt = nowMs;
        this.sentCount++;
      }
    }
  }

  /** Start learning on a slot, or stop if it's already learning. */
  toggleLearn(i: number): void {
    this.learning = this.learning === i ? -1 : i;
    this.resync();
  }

  stopLearn(): void {
    if (this.learning === -1) return;
    this.learning = -1;
    this.resync();
  }

  /** Apply a config change to one slot and force it to resend. */
  updateSlot(i: number, patch: Partial<SlotConfig>): void {
    const prev = this.slots[i];
    this.slots[i] = { ...prev, ...patch };
    if (patch.smoothing !== undefined && patch.smoothing <= 0) this.state[i].smoothed = NaN;
    this.state[i].lastSent = -1;
  }

  /** Force every slot to send its current value on the next tick. */
  resync(): void {
    for (const st of this.state) st.lastSent = -1;
  }
}

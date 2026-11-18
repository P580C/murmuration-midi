/**
 * Thin wrapper over Web MIDI output. The app never creates ports (the browser can't);
 * the user picks an existing one, e.g. the IAC Driver on macOS or loopMIDI on Windows.
 */

export type MidiStatus =
  | { kind: 'unsupported' }
  | { kind: 'pending' }
  | { kind: 'denied'; message: string }
  | { kind: 'ready' };

export interface PortInfo {
  id: string;
  name: string;
}

export class MidiOutput {
  status: MidiStatus = { kind: 'pending' };
  private access: MIDIAccess | null = null;
  private port: MIDIOutput | null = null;
  /** The chosen port id. Kept even while the port is unplugged so it reconnects. */
  selectedId = '';
  private listeners = new Set<() => void>();

  async init(): Promise<void> {
    if (typeof navigator === 'undefined' || !('requestMIDIAccess' in navigator)) {
      this.status = { kind: 'unsupported' };
      this.emit();
      return;
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      this.status = { kind: 'ready' };
      this.access.addEventListener('statechange', () => {
        this.resolvePort();
        this.emit();
      });
      this.resolvePort();
    } catch (err) {
      this.status = { kind: 'denied', message: err instanceof Error ? err.message : String(err) };
    }
    this.emit();
  }

  /** Called whenever the port list, selection or status changes. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  ports(): PortInfo[] {
    if (!this.access) return [];
    return [...this.access.outputs.values()].map((p) => ({ id: p.id, name: p.name ?? p.id }));
  }

  select(id: string): void {
    this.selectedId = id;
    this.resolvePort();
    this.emit();
  }

  /** The MIDIAccess object once granted (shared with the clock input). */
  get midiAccess(): MIDIAccess | null {
    return this.access;
  }

  /** True when a selected port is present and connected. */
  get connected(): boolean {
    return this.port !== null && this.port.state === 'connected';
  }

  /** Name of the selected port, or '' if none. */
  get selectedName(): string {
    return this.port?.name ?? '';
  }

  sendCC(channel: number, cc: number, value: number): boolean {
    const port = this.port;
    if (!port || port.state !== 'connected') return false;
    try {
      port.send([0xb0 | ((channel - 1) & 0x0f), cc & 0x7f, value & 0x7f]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Note on now (or at `at`, a performance.now() time) and note off `gateMs` later.
   * Both are scheduled with Web MIDI timestamps, so no timers are needed.
   */
  sendNote(channel: number, note: number, velocity: number, gateMs: number, at?: number): boolean {
    const port = this.port;
    if (!port || port.state !== 'connected') return false;
    const ch = (channel - 1) & 0x0f;
    const start = Math.max(performance.now(), at ?? 0);
    try {
      port.send([0x90 | ch, note & 0x7f, Math.max(1, velocity & 0x7f)], start);
      port.send([0x80 | ch, note & 0x7f, 0], start + gateMs);
      return true;
    } catch {
      return false;
    }
  }

  private resolvePort(): void {
    const p = this.selectedId && this.access ? this.access.outputs.get(this.selectedId) : undefined;
    this.port = p ?? null;
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

import type { MidiEngine } from '../midi/engine';
import { SLOT_COUNT, type Curve, type SlotConfig } from '../midi/slots';
import { QUANTISE_OPTIONS, type Quantise, type TriggerConfig, type VelocityMode } from '../midi/triggers';
import { DESCRIPTOR_META, type DescriptorKey } from '../sim/descriptors';
import { button, el, numberField, section, select, setOptions, slider, toggle } from './controls';

const ACTIVITY_MS = 120;

interface SlotView {
  root: HTMLElement;
  fill: HTMLElement;
  value: HTMLElement;
  dot: HTMLElement;
  learn: HTMLButtonElement;
  summary: HTMLElement;
}

/** Port picker + 8 mapping slots. Reads/writes the engine; `onChange` persists. */
export class MidiPanel {
  readonly element: HTMLElement;
  private readonly views: SlotView[] = [];
  private readonly portSelect: HTMLSelectElement;
  private readonly statusLine: HTMLElement;
  private readonly help: HTMLElement;
  private readonly clockSelect: HTMLSelectElement;
  private readonly clockStatus: HTMLElement;
  private readonly trigStatus: HTMLElement;
  private readonly trigDot: HTMLElement;

  constructor(
    private readonly engine: MidiEngine,
    private readonly onChange: () => void,
  ) {
    this.element = el('div', 'midi-panel');

    // ----- Output -----
    this.portSelect = select([], '', (id) => {
      engine.output.select(id);
      engine.resync();
      this.onChange();
    });
    this.portSelect.setAttribute('aria-label', 'MIDI output port');
    this.statusLine = el('div', 'midi-status');
    this.help = el('p', 'help');
    this.help.innerHTML =
      'No ports? On macOS enable the <b>IAC Driver</b> in Audio MIDI Setup → MIDI Studio. On Windows install <b>loopMIDI</b>. Then pick it here and as an input in your DAW.';

    const sendToggle = toggle('Send MIDI', engine.sending, (v) => {
      engine.sending = v;
      engine.resync();
      this.onChange();
    });

    // ----- Clock -----
    const clock = engine.clock;
    this.clockSelect = select([], clock.inputId, (id) => {
      clock.selectInput(id);
      this.onChange();
    });
    this.clockSelect.setAttribute('aria-label', 'Clock input');
    this.clockStatus = el('div', 'midi-status clock-status');
    const bpmRow = el('div', 'slot-grid');
    bpmRow.append(
      numberField('Internal BPM', 20, 300, clock.manualBpm, (v) => {
        clock.manualBpm = v;
        this.onChange();
      }),
    );
    const clockHelp = el('p', 'help');
    clockHelp.textContent =
      'Follows MIDI clock from your DAW or VCV Rack (send clock to the IAC port). With no clock, the internal BPM is used.';

    // ----- Panic triggers -----
    this.trigDot = el('span', 'slot-dot');
    this.trigStatus = el('span', 'muted');
    const trigHead = el('div', 'row');
    trigHead.append(this.trigDot, this.trigStatus);

    this.element.append(
      section('Output', this.portSelect, this.statusLine, sendToggle, this.help),
      section('Clock', this.clockSelect, this.clockStatus, bpmRow, clockHelp),
      section('Panic triggers', ...this.buildTriggers(trigHead)),
      section('Slots', this.buildSlots()),
    );

    engine.output.onChange(() => this.refreshPorts());
    clock.onChange(() => this.refreshClockInputs());
    this.refreshPorts();
    this.refreshClockInputs();
  }

  private buildTriggers(statusRow: HTMLElement): HTMLElement[] {
    const t = this.engine.triggers;
    const patch = (p: Partial<TriggerConfig>) => {
      t.cfg = { ...t.cfg, ...p };
      rateSlider.hidden = t.cfg.quantise !== 'off';
      this.onChange();
    };

    const enable = toggle('Send a note when birds panic', t.cfg.enabled, (v) => patch({ enabled: v }));

    const grid = el('div', 'slot-grid');
    grid.append(
      numberField('Ch', 1, 16, t.cfg.channel, (v) => patch({ channel: v })),
      numberField('Note', 0, 127, t.cfg.note, (v) => patch({ note: v })),
      numberField('Vel', 1, 127, t.cfg.velocity, (v) => patch({ velocity: v })),
      numberField('Gate ms', 2, 2000, t.cfg.gateMs, (v) => patch({ gateMs: v })),
    );

    const quantRow = el('div', 'slot-row');
    const quant = select<Quantise>(QUANTISE_OPTIONS, t.cfg.quantise, (v) => patch({ quantise: v }));
    quant.setAttribute('aria-label', 'Trigger quantise');
    quantRow.append(el('span', 'field-label', 'Quantise'), quant);

    const velRow = el('div', 'slot-row');
    const vel = select<VelocityMode>(
      [
        { value: 'burst', label: 'Burst size (up to Vel)' },
        { value: 'fixed', label: 'Fixed' },
      ],
      t.cfg.velocityMode,
      (v) => patch({ velocityMode: v }),
    );
    vel.setAttribute('aria-label', 'Trigger velocity mode');
    velRow.append(el('span', 'field-label', 'Velocity'), vel);

    const rateSlider = slider({
      label: 'Max rate',
      min: 1,
      max: 60,
      step: 1,
      value: t.cfg.maxRate,
      format: (v) => `${v}/s`,
      onInput: (v) => patch({ maxRate: v }),
    });
    rateSlider.hidden = t.cfg.quantise !== 'off';

    const threshold = slider({
      label: 'Panic threshold',
      min: 0.05,
      max: 1,
      step: 0.05,
      value: t.cfg.threshold,
      format: (v) => v.toFixed(2),
      onInput: (v) => patch({ threshold: v }),
    });

    const testBtn = button('Send test note', () => t.test(performance.now()), 'btn btn-small');
    testBtn.title = 'Send one note so your DAW or VCV can learn it';
    const testRow = el('div', 'row');
    testRow.append(testBtn);

    const help = el('p', 'help');
    help.textContent =
      'One note per grid step while birds are crossing into panic, louder the more birds panicked. In VCV Rack use MIDI-Gate or MIDI-CV.';

    return [enable, statusRow, grid, velRow, quantRow, rateSlider, threshold, testRow, help];
  }

  private refreshClockInputs(): void {
    const c = this.engine.clock;
    const opts = [
      { value: '', label: 'Any input' },
      ...c.inputs().map((p) => ({ value: p.id, label: p.name })),
      { value: 'none', label: 'Internal clock only' },
    ];
    if (c.inputId && c.inputId !== 'none' && !opts.some((o) => o.value === c.inputId)) {
      opts.push({ value: c.inputId, label: 'Disconnected input' });
    }
    setOptions(this.clockSelect, opts, c.inputId);
    this.clockSelect.disabled = this.engine.output.status.kind !== 'ready';
  }

  private buildSlots(): HTMLElement {
    const list = el('div', 'slots');
    for (let i = 0; i < SLOT_COUNT; i++) list.append(this.buildSlot(i));
    return list;
  }

  private buildSlot(i: number): HTMLElement {
    const engine = this.engine;
    const cfg = () => engine.slots[i];
    const patch = (p: Partial<SlotConfig>) => {
      engine.updateSlot(i, p);
      root.classList.toggle('is-off', !cfg().enabled);
      summary.textContent = summaryText(cfg());
      this.onChange();
    };

    const root = el('div', 'slot');
    root.classList.toggle('is-off', !cfg().enabled);

    // Header row
    const head = el('div', 'slot-head');
    const enable = el('input', 'slot-enable');
    enable.type = 'checkbox';
    enable.checked = cfg().enabled;
    enable.title = 'Enable slot';
    enable.setAttribute('aria-label', `Enable slot ${i + 1}`);
    enable.addEventListener('change', () => patch({ enabled: enable.checked }));

    const num = el('span', 'slot-num', String(i + 1));
    const source = select(
      DESCRIPTOR_META.map((m) => ({ value: m.key, label: m.label })),
      cfg().source,
      (v: DescriptorKey) => patch({ source: v }),
      'select slot-source',
    );
    source.setAttribute('aria-label', `Slot ${i + 1} source`);

    const dot = el('span', 'slot-dot');
    dot.title = 'Sending';
    const value = el('span', 'slot-value', '0');
    const learn = button('Learn', () => {
      engine.toggleLearn(i);
      this.onChange();
    }, 'btn btn-small slot-learn');
    learn.title = 'Send only this slot so your DAW can learn it (Esc to stop)';

    head.append(enable, num, source, dot, value, learn);

    // Meter
    const bar = el('div', 'slot-bar');
    const fill = el('div', 'slot-fill');
    bar.append(fill);

    // Settings
    const details = el('details', 'slot-details');
    const summary = el('summary', 'slot-summary', summaryText(cfg()));
    const grid = el('div', 'slot-grid');
    grid.append(
      numberField('Ch', 1, 16, cfg().channel, (v) => patch({ channel: v })),
      numberField('CC', 0, 127, cfg().cc, (v) => patch({ cc: v })),
      numberField('Min', 0, 127, cfg().min, (v) => patch({ min: v })),
      numberField('Max', 0, 127, cfg().max, (v) => patch({ max: v })),
    );
    const curveRow = el('div', 'slot-row');
    const curve = select<Curve>(
      [
        { value: 'linear', label: 'Linear' },
        { value: 'exp', label: 'Exponential' },
      ],
      cfg().curve,
      (v) => patch({ curve: v }),
    );
    curve.setAttribute('aria-label', `Slot ${i + 1} curve`);
    curveRow.append(el('span', 'field-label', 'Curve'), curve);

    details.append(
      summary,
      grid,
      slider({
        label: 'Smoothing',
        min: 0,
        max: 1,
        step: 0.01,
        value: cfg().smoothing,
        format: (v) => (v <= 0 ? 'off' : `${(v * v * 3).toFixed(2)}s`),
        onInput: (v) => patch({ smoothing: v }),
      }),
      curveRow,
      toggle('Invert', cfg().invert, (v) => patch({ invert: v })),
    );

    root.append(head, bar, details);
    this.views.push({ root, fill, value, dot, learn, summary });
    return root;
  }

  private refreshPorts(): void {
    const out = this.engine.output;
    const ports = out.ports();
    const opts = [{ value: '', label: 'No output' }, ...ports.map((p) => ({ value: p.id, label: p.name }))];
    // Keep a remembered-but-unplugged port visible so the selection isn't lost.
    if (out.selectedId && !ports.some((p) => p.id === out.selectedId)) {
      opts.push({ value: out.selectedId, label: 'Disconnected port' });
    }
    setOptions(this.portSelect, opts, out.selectedId);
    this.portSelect.disabled = out.status.kind !== 'ready';
    this.help.hidden = out.status.kind === 'ready' && ports.length > 0;
  }

  /** Call at display rate. */
  render(nowMs: number): void {
    const e = this.engine;
    const out = e.output;

    let status: string;
    let tone: 'ok' | 'warn' | 'idle' = 'idle';
    switch (out.status.kind) {
      case 'unsupported':
        status = 'Web MIDI isn’t available in this browser. Use Chrome or Edge.';
        tone = 'warn';
        break;
      case 'pending':
        status = 'Waiting for MIDI permission…';
        break;
      case 'denied':
        status = 'MIDI access was blocked. Allow it from the site settings (lock icon) and reload.';
        tone = 'warn';
        break;
      default:
        if (!out.selectedId) status = 'Choose an output port.';
        else if (!out.connected) {
          status = 'Port disconnected. It will reconnect when it’s back.';
          tone = 'warn';
        } else if (!e.sending) status = `Paused · ${out.selectedName}`;
        else if (e.learning >= 0) {
          status = `Learning slot ${e.learning + 1}: only it is sending`;
          tone = 'ok';
        } else {
          status = `Sending to ${out.selectedName} · ${e.sentCount.toLocaleString()} msgs`;
          tone = 'ok';
        }
    }
    this.statusLine.textContent = status;
    this.statusLine.dataset.tone = tone;

    // Clock
    const c = e.clock;
    const pos = c.position();
    const where = `bar ${pos.bar}.${pos.beat}`;
    if (c.source === 'external') {
      this.clockStatus.textContent = c.running
        ? `External clock · ${c.bpm.toFixed(1)} BPM · ${where}`
        : `External clock · stopped · ${c.bpm.toFixed(1)} BPM`;
      this.clockStatus.dataset.tone = 'ok';
    } else {
      this.clockStatus.textContent = `Internal · ${c.bpm.toFixed(0)} BPM · ${where}`;
      this.clockStatus.dataset.tone = 'idle';
    }

    // Triggers
    const t = e.triggers;
    this.trigDot.classList.toggle('is-on', t.lastSentAt > 0 && nowMs - t.lastSentAt < ACTIVITY_MS && nowMs >= t.lastSentAt);
    this.trigStatus.textContent = t.cfg.enabled
      ? `${Math.round(t.onsetRate)} panics/s · ${t.sentCount.toLocaleString()} notes sent${t.sentCount ? ` · last vel ${t.lastVelocity}` : ''}`
      : 'Off';

    for (let i = 0; i < this.views.length; i++) {
      const v = this.views[i];
      const st = e.state[i];
      v.fill.style.transform = `scaleX(${st.value / 127})`;
      v.value.textContent = String(st.value);
      v.dot.classList.toggle('is-on', st.lastSentAt > 0 && nowMs - st.lastSentAt < ACTIVITY_MS);
      const learning = e.learning === i;
      v.learn.classList.toggle('is-learning', learning);
      v.learn.textContent = learning ? 'Learning' : 'Learn';
      v.learn.setAttribute('aria-pressed', String(learning));
      v.root.classList.toggle('is-muted', e.learning >= 0 && !learning);
    }
  }
}

function summaryText(c: SlotConfig): string {
  const range = c.min === 0 && c.max === 127 ? '' : ` · ${c.min}–${c.max}`;
  const extras = [c.curve === 'exp' ? 'exp' : '', c.invert ? 'inv' : ''].filter(Boolean).join(' ');
  return `Ch ${c.channel} · CC ${c.cc}${range}${extras ? ` · ${extras}` : ''}`;
}

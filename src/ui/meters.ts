import { DESCRIPTOR_META, type DescriptorKey, type Descriptors } from '../sim/descriptors';
import { el } from './controls';

const HISTORY = 300; // samples (~10 s at 30 Hz)

interface Row {
  key: DescriptorKey;
  value: HTMLElement;
  bar: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  history: Float32Array;
}

/** Live meter + scrolling sparkline for each stream source. */
export class MeterPanel {
  readonly element: HTMLElement;
  private rows: Row[] = [];
  private head = 0;
  private filled = 0;

  constructor() {
    this.element = el('div', 'meters');
    for (const meta of DESCRIPTOR_META) {
      const row = el('div', 'meter');
      row.title = meta.hint;
      const head = el('div', 'meter-head');
      const value = el('span', 'meter-value', '0.00');
      head.append(el('span', 'meter-label', meta.label), value);
      const barWrap = el('div', 'meter-bar');
      const bar = el('div', 'meter-fill');
      barWrap.append(bar);
      const canvas = el('canvas', 'meter-spark');
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D not available');
      row.append(head, barWrap, canvas);
      this.element.append(row);
      this.rows.push({ key: meta.key, value, bar, canvas, ctx, history: new Float32Array(HISTORY) });
    }
  }

  /** Push one sample per row and redraw. */
  update(d: Descriptors): void {
    const accent = getComputedStyle(this.element).getPropertyValue('--accent').trim() || '#f2b55e';
    const grid = getComputedStyle(this.element).getPropertyValue('--line').trim() || '#333';
    for (const r of this.rows) {
      const v = d[r.key];
      r.history[this.head] = v;
      r.value.textContent = v.toFixed(2);
      r.bar.style.transform = `scaleX(${v})`;
      this.drawSpark(r, accent, grid);
    }
    this.head = (this.head + 1) % HISTORY;
    this.filled = Math.min(HISTORY, this.filled + 1);
  }

  private drawSpark(r: Row, stroke: string, grid: string): void {
    const { canvas, ctx } = r;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2 + 0.5);
    ctx.lineTo(w, h / 2 + 0.5);
    ctx.stroke();

    if (this.filled < 2) return;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.25;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const n = this.filled;
    for (let k = 0; k < n; k++) {
      // Oldest on the left, newest on the right edge.
      const idx = (this.head - n + 1 + k + HISTORY) % HISTORY;
      const px = w - ((n - 1 - k) / (HISTORY - 1)) * w;
      const py = 1 + (1 - r.history[idx]) * (h - 2);
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
}

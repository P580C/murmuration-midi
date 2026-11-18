/**
 * Placeholder control primitives. These will be replaced by components built from
 * the Figma designs; the rest of the app only depends on the callbacks.
 */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

export interface SliderOptions {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format?: (v: number) => string;
  onInput: (v: number) => void;
}

export function slider(o: SliderOptions): HTMLElement {
  const fmt = o.format ?? ((v: number) => String(v));
  const row = el('label', 'control');
  const head = el('div', 'control-head');
  const name = el('span', 'control-label', o.label);
  const val = el('span', 'control-value', fmt(o.value));
  head.append(name, val);

  const input = el('input');
  input.type = 'range';
  input.min = String(o.min);
  input.max = String(o.max);
  input.step = String(o.step);
  input.value = String(o.value);
  const paint = () => {
    const t = (Number(input.value) - o.min) / (o.max - o.min);
    input.style.setProperty('--fill', `${t * 100}%`);
  };
  paint();
  input.addEventListener('input', () => {
    const v = Number(input.value);
    val.textContent = fmt(v);
    paint();
    o.onInput(v);
  });

  row.append(head, input);
  return row;
}

export function toggle(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const row = el('label', 'toggle');
  const input = el('input');
  input.type = 'checkbox';
  input.checked = value;
  input.addEventListener('change', () => onChange(input.checked));
  const track = el('span', 'toggle-track');
  row.append(el('span', 'control-label', label), input, track);
  return row;
}

export function button(label: string, onClick: () => void, className = 'btn'): HTMLButtonElement {
  const b = el('button', className, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

export function section(title: string, ...children: HTMLElement[]): HTMLElement {
  const s = el('section', 'panel-section');
  s.append(el('h2', 'section-title', title), ...children);
  return s;
}

export function select<T extends string>(
  options: { value: T; label: string }[],
  value: T,
  onChange: (v: T) => void,
  className = 'select',
): HTMLSelectElement {
  const s = el('select', className);
  setOptions(s, options, value);
  s.addEventListener('change', () => onChange(s.value as T));
  return s;
}

export function setOptions(s: HTMLSelectElement, options: { value: string; label: string }[], value: string): void {
  s.replaceChildren(
    ...options.map((o) => {
      const opt = el('option', undefined, o.label);
      opt.value = o.value;
      return opt;
    }),
  );
  s.value = value;
}

/** Labelled integer field. Commits on change (blur/enter), clamped to range. */
export function numberField(
  label: string,
  min: number,
  max: number,
  value: number,
  onChange: (v: number) => void,
): HTMLElement {
  const wrap = el('label', 'field');
  const input = el('input', 'field-input');
  input.type = 'number';
  input.min = String(min);
  input.max = String(max);
  input.step = '1';
  input.value = String(value);
  input.addEventListener('change', () => {
    let v = Math.round(Number(input.value));
    if (!Number.isFinite(v)) v = value;
    v = Math.min(max, Math.max(min, v));
    input.value = String(v);
    value = v;
    onChange(v);
  });
  wrap.append(el('span', 'field-label', label), input);
  return wrap;
}

/**
 * Per-browser conveniences (selected port, slot mappings, active tab). Storage can be
 * unavailable or cleared at any time, so every access is guarded and the app works without it.
 */

export function loadJSON(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

export function saveJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: ignore */
  }
}

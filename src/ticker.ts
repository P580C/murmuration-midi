/**
 * A steady ~60 Hz tick that keeps running when the tab is hidden or the window is
 * covered by the DAW. requestAnimationFrame stops in those cases and main-thread timers
 * are throttled, but timers inside a dedicated worker are not, so a tiny worker sends the beat.
 */
export function startTicker(intervalMs: number, onTick: () => void): () => void {
  const src = `let id = setInterval(() => postMessage(0), ${intervalMs});
onmessage = () => clearInterval(id);`;
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  const worker = new Worker(url);
  worker.onmessage = onTick;
  return () => {
    worker.postMessage('stop');
    worker.terminate();
    URL.revokeObjectURL(url);
  };
}

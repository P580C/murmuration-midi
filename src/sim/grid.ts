/**
 * Uniform spatial grid built with a counting sort each step.
 * Birds outside the world rectangle are clamped into the edge cells, which keeps
 * lookups valid while the soft bounds force pulls them back.
 */
export class SpatialGrid {
  readonly cellSize: number;
  cols = 0;
  rows = 0;
  /** Index into `items` where each cell's birds start. */
  cellStart = new Int32Array(0);
  /** Number of birds in each cell. */
  cellCount = new Int32Array(0);
  /** Bird indices sorted by cell. */
  items = new Int32Array(0);
  private birdCell = new Int32Array(0);

  constructor(cellSize: number) {
    this.cellSize = cellSize;
  }

  cellX(x: number): number {
    const c = Math.floor(x / this.cellSize);
    return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
  }

  cellY(y: number): number {
    const c = Math.floor(y / this.cellSize);
    return c < 0 ? 0 : c >= this.rows ? this.rows - 1 : c;
  }

  build(xs: Float32Array, ys: Float32Array, n: number, width: number, height: number): void {
    const cols = Math.max(1, Math.ceil(width / this.cellSize));
    const rows = Math.max(1, Math.ceil(height / this.cellSize));
    const nCells = cols * rows;
    this.cols = cols;
    this.rows = rows;

    if (this.cellCount.length < nCells) {
      this.cellCount = new Int32Array(nCells);
      this.cellStart = new Int32Array(nCells);
    } else {
      this.cellCount.fill(0, 0, nCells);
    }
    if (this.items.length < n) {
      this.items = new Int32Array(n);
      this.birdCell = new Int32Array(n);
    }

    const { cellCount, cellStart, items, birdCell } = this;

    for (let i = 0; i < n; i++) {
      const c = this.cellY(ys[i]) * cols + this.cellX(xs[i]);
      birdCell[i] = c;
      cellCount[c]++;
    }

    let acc = 0;
    for (let c = 0; c < nCells; c++) {
      cellStart[c] = acc;
      acc += cellCount[c];
      cellCount[c] = 0;
    }

    // Second pass restores cellCount while placing items.
    for (let i = 0; i < n; i++) {
      const c = birdCell[i];
      items[cellStart[c] + cellCount[c]++] = i;
    }
  }
}

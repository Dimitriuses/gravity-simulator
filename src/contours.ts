import { Vector2D } from './Vector2D';
import { ViewBounds } from './VectorField';

/**
 * Equipotential contours, by marching squares. Roadmap M5.
 *
 * An arrow grid shows which way the field points and roughly how hard. What it
 * does not show is structure: the saddle between two bodies, the closed curve
 * that separates what orbits one from what orbits both, the Lagrange points.
 * Those are all features of the *potential*, a scalar, and the natural way to
 * draw a scalar is its level sets.
 *
 * Nothing here knows about gravity. It takes a function that returns a number
 * at a point and returns line segments, which is what makes it testable against
 * fields whose contours are known in closed form.
 */

/** One contour level: the value it traces, and the segments that trace it. */
export interface ContourLine {
  level: number;
  segments: { from: Vector2D; to: Vector2D }[];
}

/**
 * Cap on grid cells per frame.
 *
 * Each cell corner is one evaluation of the scalar field, and for gravity that
 * is a tree query. 6,400 keeps a contour pass in the same budget as the arrow
 * grid it replaces.
 */
export const MAX_CONTOUR_CELLS = 6400;

/**
 * Linear interpolation to where `level` crosses between two corners.
 *
 * The whole reason marching squares looks smooth rather than blocky: the
 * crossing is placed by value, not at the midpoint of the edge.
 */
function crossing(
  ax: number,
  ay: number,
  av: number,
  bx: number,
  by: number,
  bv: number,
  level: number
): Vector2D {
  const span = bv - av;
  // Two corners of equal value have no crossing to place; the midpoint is the
  // only defensible answer and the case is degenerate anyway.
  const t = span === 0 ? 0.5 : (level - av) / span;
  return new Vector2D(ax + (bx - ax) * t, ay + (by - ay) * t);
}

/**
 * Contour levels spaced geometrically between the values present.
 *
 * Gravitational potential runs from a small negative number far away to a very
 * large one near a body — three or four orders of magnitude across one view —
 * so evenly spaced levels would put every line in a ring around the heaviest
 * body and none anywhere else. Geometric spacing gives each order of magnitude
 * the same number of lines, which is what makes the far structure visible at
 * all.
 */
export function contourLevels(min: number, max: number, count: number): number[] {
  // Potential is negative, so the "smallest" value is the deepest well.
  const deepest = Math.abs(Math.min(min, max));
  const shallowest = Math.abs(Math.max(min, max));

  if (!Number.isFinite(deepest) || !Number.isFinite(shallowest)) return [];
  if (shallowest <= 0 || deepest <= shallowest) return [];

  const ratio = deepest / shallowest;
  const levels: number[] = [];

  for (let i = 0; i < count; i++) {
    // Skip the endpoints: a contour exactly at the extreme value traces the
    // single point it came from.
    const t = (i + 1) / (count + 1);
    levels.push(-shallowest * Math.pow(ratio, t));
  }

  return levels;
}

/**
 * A scalar field sampled on a regular grid over the view.
 *
 * Shared by the contour tracer and the heightmap, which want exactly the same
 * thing and should not each grow their own copy of the sampling arithmetic.
 */
export interface ScalarGrid {
  values: Float64Array;
  columns: number;
  rows: number;
  min: number;
  max: number;
}

/**
 * Sample `scalarAt` on a grid over `view`, squaring off the cells and staying
 * inside `MAX_CONTOUR_CELLS`.
 *
 * One evaluation per grid *corner*, reused by the four cells that share it;
 * sampling per cell instead would cost four times as much.
 */
export function sampleScalarGrid(
  scalarAt: (x: number, y: number) => number,
  view: ViewBounds,
  resolution: number
): ScalarGrid | null {
  const width = view.maxX - view.minX;
  const height = view.maxY - view.minY;
  if (!(width > 0) || !(height > 0)) return null;

  const cell = Math.max(width, height) / resolution;
  let columns = Math.max(1, Math.ceil(width / cell));
  let rows = Math.max(1, Math.ceil(height / cell));

  if (columns * rows > MAX_CONTOUR_CELLS) {
    const shrink = Math.sqrt((columns * rows) / MAX_CONTOUR_CELLS);
    columns = Math.max(1, Math.floor(columns / shrink));
    rows = Math.max(1, Math.floor(rows / shrink));
  }

  const stepX = width / columns;
  const stepY = height / rows;
  const values = new Float64Array((columns + 1) * (rows + 1));

  let min = Infinity;
  let max = -Infinity;

  for (let row = 0; row <= rows; row++) {
    for (let column = 0; column <= columns; column++) {
      const value = scalarAt(view.minX + column * stepX, view.minY + row * stepY);
      values[row * (columns + 1) + column] = value;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;

  return { values, columns, rows, min, max };
}

/**
 * Trace the level sets of `scalarAt` across `view`.
 *
 * `resolution` is the target number of cells across the wider axis; the grid is
 * squared off from the view's aspect and clamped to `MAX_CONTOUR_CELLS`.
 */
export function traceContours(
  scalarAt: (x: number, y: number) => number,
  view: ViewBounds,
  levelCount: number = 12,
  resolution: number = 90,
  refineNear: ReadonlyArray<{ x: number; y: number }> = [],
  /**
   * The levels to trace, when the caller has already decided them.
   *
   * Given, they are traced whether or not this frame's field reaches them —
   * which is the point of pinning a scale: the same curve is drawn from one
   * frame to the next, and a level the scene has moved away from is simply
   * absent rather than replaced by a different one.
   */
  fixedLevels?: number[]
): ContourLine[] {
  const lattice = Lattice.over(view, resolution, scalarAt);
  if (!lattice) return [];

  // Pass one: every other lattice point.
  lattice.sampleCoarse();

  const levels = fixedLevels ?? contourLevels(lattice.min, lattice.max, levelCount);
  if (levels.length === 0) return [];

  const ascending = levels
    .map((level, index) => ({ level, index }))
    .sort((a, b) => a.level - b.level);
  const segments: ContourLine['segments'][] = levels.map(() => []);

  const forced = lattice.cellsAround(refineNear);

  // Pass two: the coarse cells that have something to draw, at full
  // resolution. A coarse cell whose four corners sit between the same pair of
  // levels crosses none of them and is left alone — and so is its share of the
  // sampling, which is the point.
  for (let row = 0; row < lattice.coarseRows; row++) {
    for (let column = 0; column < lattice.coarseColumns; column++) {
      if (!forced.has(row * lattice.coarseColumns + column)) {
        if (!lattice.worthRefining(column, row, ascending)) continue;
      }

      lattice.refine(column, row);
      for (let sub = 0; sub < 4; sub++) {
        lattice.marchFine(2 * column + (sub & 1), 2 * row + (sub >> 1), ascending, segments);
      }
    }
  }

  const lines: ContourLine[] = [];
  levels.forEach((level, index) => {
    if (segments[index].length > 0) lines.push({ level, segments: segments[index] });
  });

  return lines;
}

/**
 * The sampling lattice a contour pass is traced on, sampled where it is asked
 * for rather than everywhere.
 *
 * Points are held at the *fine* spacing and addressed by integer index, so a
 * point on the boundary between two cells is the same point to both of them
 * however either of them came to want it. That is what keeps the lines
 * continuous across a refinement boundary: neighbouring cells interpolate their
 * shared edge from the same two numbers, so the crossing they each place on it
 * lands in the same spot.
 */
class Lattice {
  readonly values: Float64Array;
  private readonly filled: Uint8Array;

  min = Infinity;
  max = -Infinity;

  private constructor(
    private readonly scalarAt: (x: number, y: number) => number,
    private readonly view: ViewBounds,
    readonly columns: number,
    readonly rows: number,
    readonly stepX: number,
    readonly stepY: number
  ) {
    this.values = new Float64Array((columns + 1) * (rows + 1));
    this.filled = new Uint8Array((columns + 1) * (rows + 1));
  }

  /** Fine cells across, and down: even, so the coarse pass is exactly half. */
  static over(
    view: ViewBounds,
    resolution: number,
    scalarAt: (x: number, y: number) => number
  ): Lattice | null {
    const width = view.maxX - view.minX;
    const height = view.maxY - view.minY;
    if (!(width > 0) || !(height > 0)) return null;

    const cell = Math.max(width, height) / resolution;
    let columns = Math.max(1, Math.ceil(width / cell));
    let rows = Math.max(1, Math.ceil(height / cell));

    if (columns * rows > MAX_CONTOUR_CELLS) {
      const shrink = Math.sqrt((columns * rows) / MAX_CONTOUR_CELLS);
      columns = Math.max(1, Math.floor(columns / shrink));
      rows = Math.max(1, Math.floor(rows / shrink));
    }

    columns += columns % 2;
    rows += rows % 2;

    return new Lattice(scalarAt, view, columns, rows, width / columns, height / rows);
  }

  get coarseColumns(): number {
    return this.columns / 2;
  }

  get coarseRows(): number {
    return this.rows / 2;
  }

  /** The value at fine lattice point (i, j), evaluating it if it is new. */
  at(i: number, j: number): number {
    const index = j * (this.columns + 1) + i;
    if (this.filled[index] === 0) {
      const value = this.scalarAt(this.view.minX + i * this.stepX, this.view.minY + j * this.stepY);
      this.values[index] = value;
      this.filled[index] = 1;
      if (value < this.min) this.min = value;
      if (value > this.max) this.max = value;
    }
    return this.values[index];
  }

  /** Every other point: the first pass, and where the levels come from. */
  sampleCoarse(): void {
    for (let j = 0; j <= this.rows; j += 2) {
      for (let i = 0; i <= this.columns; i += 2) this.at(i, j);
    }
  }

  /**
   * The coarse cells holding the points a caller says are worth a closer look.
   *
   * Refinement that only follows the readings is blind to anything smaller
   * than its first cell — the same trap the gradient arrow mode fell into,
   * where a small body sitting in a cell dominated by a large one produced no
   * arrows at all. A caller that knows where the structure is names those
   * places, and their cells are refined whether or not the coarse pass found
   * them interesting.
   *
   * Cells, not samples: forcing a patch of *points* around every body cost more
   * at three hundred bodies than the thinning saved, since the patches overlap
   * and most of them land on ground the coarse pass was going to refine anyway.
   */
  cellsAround(points: ReadonlyArray<{ x: number; y: number }>): Set<number> {
    const cells = new Set<number>();

    for (const point of points) {
      const column = Math.floor((point.x - this.view.minX) / (this.stepX * 2));
      const row = Math.floor((point.y - this.view.minY) / (this.stepY * 2));

      if (column < 0 || row < 0 || column >= this.coarseColumns || row >= this.coarseRows) {
        continue;
      }
      cells.add(row * this.coarseColumns + column);
    }

    return cells;
  }

  /** Does any level pass through this coarse cell, as its corners see it? */
  worthRefining(
    column: number,
    row: number,
    levels: ReadonlyArray<{ level: number }>
  ): boolean {
    const i = column * 2;
    const j = row * 2;

    const a = this.at(i, j);
    const b = this.at(i + 2, j);
    const c = this.at(i + 2, j + 2);
    const d = this.at(i, j + 2);

    const lowest = Math.min(a, b, c, d);
    const highest = Math.max(a, b, c, d);

    const first = lowerBound(levels, lowest);
    return first < levels.length && levels[first].level < highest;
  }

  /** Sample the five interior points a coarse cell needs to become four. */
  refine(column: number, row: number): void {
    const i = column * 2;
    const j = row * 2;

    this.at(i + 1, j);
    this.at(i, j + 1);
    this.at(i + 1, j + 1);
    this.at(i + 2, j + 1);
    this.at(i + 1, j + 2);
  }

  /** March one fine cell against every level that crosses it. */
  marchFine(
    i: number,
    j: number,
    levels: ReadonlyArray<{ level: number; index: number }>,
    segments: ContourLine['segments'][]
  ): void {
    const topLeft = this.at(i, j);
    const topRight = this.at(i + 1, j);
    const bottomRight = this.at(i + 1, j + 1);
    const bottomLeft = this.at(i, j + 1);

    const lowest = Math.min(topLeft, topRight, bottomRight, bottomLeft);
    const highest = Math.max(topLeft, topRight, bottomRight, bottomLeft);

    let first = lowerBound(levels, lowest);
    if (first >= levels.length || levels[first].level >= highest) return;

    const x0 = this.view.minX + i * this.stepX;
    const y0 = this.view.minY + j * this.stepY;

    for (; first < levels.length && levels[first].level < highest; first++) {
      marchCell(
        segments[levels[first].index],
        levels[first].level,
        x0,
        y0,
        x0 + this.stepX,
        y0 + this.stepY,
        topLeft,
        topRight,
        bottomRight,
        bottomLeft
      );
    }
  }
}

/** Index of the first level at or above `value`. */
function lowerBound(levels: ReadonlyArray<{ level: number }>, value: number): number {
  let low = 0;
  let high = levels.length;

  while (low < high) {
    const middle = (low + high) >> 1;
    if (levels[middle].level < value) low = middle + 1;
    else high = middle;
  }

  return low;
}

/** One cell against one level: the sixteen marching-squares cases. */
function marchCell(
  out: ContourLine['segments'],
  level: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  topLeft: number,
  topRight: number,
  bottomRight: number,
  bottomLeft: number
): void {
  // The four corners above or below the level, as a 4-bit case.
  const code =
    (topLeft > level ? 8 : 0) |
    (topRight > level ? 4 : 0) |
    (bottomRight > level ? 2 : 0) |
    (bottomLeft > level ? 1 : 0);

  if (code === 0 || code === 15) return;

  const top = () => crossing(x0, y0, topLeft, x1, y0, topRight, level);
  const right = () => crossing(x1, y0, topRight, x1, y1, bottomRight, level);
  const bottom = () => crossing(x0, y1, bottomLeft, x1, y1, bottomRight, level);
  const left = () => crossing(x0, y0, topLeft, x0, y1, bottomLeft, level);

  switch (code) {
    case 1:
    case 14:
      out.push({ from: left(), to: bottom() });
      break;
    case 2:
    case 13:
      out.push({ from: bottom(), to: right() });
      break;
    case 3:
    case 12:
      out.push({ from: left(), to: right() });
      break;
    case 4:
    case 11:
      out.push({ from: top(), to: right() });
      break;
    case 6:
    case 9:
      out.push({ from: top(), to: bottom() });
      break;
    case 7:
    case 8:
      out.push({ from: left(), to: top() });
      break;
    // The two ambiguous cases, where opposite corners are on one side of the
    // level and the other two on the other. Resolved by the cell's average: it
    // decides which pair of corners is actually connected, and gets the saddle
    // between two bodies right — which is exactly where this matters.
    case 5:
    case 10: {
      const middle = (topLeft + topRight + bottomRight + bottomLeft) / 4;
      const joined = code === 5 ? middle > level : middle <= level;

      if (joined) {
        out.push({ from: left(), to: top() });
        out.push({ from: bottom(), to: right() });
      } else {
        out.push({ from: left(), to: bottom() });
        out.push({ from: top(), to: right() });
      }
      break;
    }
  }
}

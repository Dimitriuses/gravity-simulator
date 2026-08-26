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
  resolution: number = 90
): ContourLine[] {
  const grid = sampleScalarGrid(scalarAt, view, resolution);
  if (!grid) return [];

  const { values, columns, rows, min, max } = grid;
  const stepX = (view.maxX - view.minX) / columns;
  const stepY = (view.maxY - view.minY) / rows;

  const lines: ContourLine[] = [];

  for (const level of contourLevels(min, max, levelCount)) {
    const segments: ContourLine['segments'] = [];

    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const x0 = view.minX + column * stepX;
        const y0 = view.minY + row * stepY;
        const x1 = x0 + stepX;
        const y1 = y0 + stepY;

        const topLeft = values[row * (columns + 1) + column];
        const topRight = values[row * (columns + 1) + column + 1];
        const bottomRight = values[(row + 1) * (columns + 1) + column + 1];
        const bottomLeft = values[(row + 1) * (columns + 1) + column];

        // The four corners above or below the level, as a 4-bit case.
        const code =
          (topLeft > level ? 8 : 0) |
          (topRight > level ? 4 : 0) |
          (bottomRight > level ? 2 : 0) |
          (bottomLeft > level ? 1 : 0);

        if (code === 0 || code === 15) continue;

        const top = () => crossing(x0, y0, topLeft, x1, y0, topRight, level);
        const right = () => crossing(x1, y0, topRight, x1, y1, bottomRight, level);
        const bottom = () => crossing(x0, y1, bottomLeft, x1, y1, bottomRight, level);
        const left = () => crossing(x0, y0, topLeft, x0, y1, bottomLeft, level);

        switch (code) {
          case 1:
          case 14:
            segments.push({ from: left(), to: bottom() });
            break;
          case 2:
          case 13:
            segments.push({ from: bottom(), to: right() });
            break;
          case 3:
          case 12:
            segments.push({ from: left(), to: right() });
            break;
          case 4:
          case 11:
            segments.push({ from: top(), to: right() });
            break;
          case 6:
          case 9:
            segments.push({ from: top(), to: bottom() });
            break;
          case 7:
          case 8:
            segments.push({ from: left(), to: top() });
            break;
          // The two ambiguous cases, where opposite corners are on one side of
          // the level and the other two on the other. Resolved by the cell's
          // average: it decides which pair of corners is actually connected,
          // and gets the saddle between two bodies right — which is exactly
          // where this matters.
          case 5:
          case 10: {
            const middle = (topLeft + topRight + bottomRight + bottomLeft) / 4;
            const joined = code === 5 ? middle > level : middle <= level;

            if (joined) {
              segments.push({ from: left(), to: top() });
              segments.push({ from: bottom(), to: right() });
            } else {
              segments.push({ from: left(), to: bottom() });
              segments.push({ from: top(), to: right() });
            }
            break;
          }
        }
      }
    }

    if (segments.length > 0) lines.push({ level, segments });
  }

  return lines;
}

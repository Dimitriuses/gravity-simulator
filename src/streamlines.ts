import { Vector2D } from './Vector2D';
import { OccupancyGrid, ViewBounds } from './VectorField';

/**
 * Streamlines: curves that follow the field instead of sampling it. Roadmap M5.
 *
 * An arrow grid is a set of disconnected opinions about direction. A streamline
 * is the path a body released from rest would be pushed along, drawn as one
 * continuous curve, which makes the shape of the flow — where it converges,
 * where it splits — legible at a glance.
 *
 * The hard part is not the tracing but the spacing: seeded naively, lines
 * bunch where the field is strong and leave the rest of the view empty. This
 * uses the standard remedy (Jobard and Lefer, 1997): trace a line until it
 * comes too close to a line already drawn, then stop. `OccupancyGrid` already
 * answers "is there something within this distance" for the arrow sampler, so
 * it does that job here too.
 */

/** A traced curve, as the points along it. */
export type Streamline = Vector2D[];

/**
 * Total integration steps allowed per frame, across every line.
 *
 * Each step is one field evaluation, which for gravity is a tree query — the
 * same currency the arrow grid spends. This keeps a streamline pass in the same
 * budget as the grid it replaces rather than quietly costing several times more.
 */
export const MAX_STREAMLINE_STEPS = 6000;

/** Points closer together than this along a line are not worth keeping. */
const MIN_SEGMENT_FRACTION = 0.25;

/**
 * Cosine of the sharpest turn a line may take before it is ended.
 *
 * 0 is a right angle. A smooth flow turns by a few degrees per step; anything
 * approaching a right angle means the step has jumped across a body or a
 * saddle, where the field reverses and no step size would follow it.
 */
const REVERSAL_COSINE = 0;

export interface StreamlineOptions {
  /** Distance between neighbouring lines, in world units. */
  spacing: number;
  /** How far each integration step advances. */
  stepLength: number;
  /** Longest a single line may run, in steps, in each direction. */
  maxStepsPerLine: number;
  /** Ceiling on the total work done. */
  maxTotalSteps: number;
}

export function defaultStreamlineOptions(view: ViewBounds): StreamlineOptions {
  // Spacing set from the view so the picture holds its density as the camera
  // zooms, rather than thinning out or turning into a solid mat.
  const span = Math.max(view.maxX - view.minX, view.maxY - view.minY);

  return {
    spacing: span / 26,
    stepLength: span / 160,
    maxStepsPerLine: 220,
    maxTotalSteps: MAX_STREAMLINE_STEPS,
  };
}

const inside = (point: Vector2D, view: ViewBounds, margin: number) =>
  point.x >= view.minX - margin &&
  point.x <= view.maxX + margin &&
  point.y >= view.minY - margin &&
  point.y <= view.maxY + margin;

/**
 * Trace evenly spaced streamlines of `fieldAt` across `view`.
 *
 * `fieldAt` returns the field vector at a point; only its direction is used.
 * Seeds are laid on a lattice anchored to **world** coordinates, for the same
 * reason the arrow sampler's is: anchoring to the viewport makes every line
 * crawl across the screen as the camera moves.
 */
export function traceStreamlines(
  fieldAt: (x: number, y: number) => Vector2D,
  view: ViewBounds,
  options: StreamlineOptions
): Streamline[] {
  const { spacing, stepLength, maxStepsPerLine, maxTotalSteps } = options;
  if (!(spacing > 0) || !(stepLength > 0)) return [];

  // Cell size at least the largest half-width queried, which is what keeps an
  // OccupancyGrid lookup honest — see its own documentation.
  const occupancy = new OccupancyGrid(spacing);
  const lines: Streamline[] = [];
  let stepsSpent = 0;

  const tooClose = (point: Vector2D) => occupancy.has(point.x, point.y, spacing / 2);

  /**
   * Follow the field from `seed` in one direction until the line leaves the
   * view, stalls in a dead spot, runs out of allowance, or reaches a curve
   * already drawn.
   */
  const follow = (seed: Vector2D, sign: number): Vector2D[] => {
    const points: Vector2D[] = [];
    let point = seed;
    let previousDirection: Vector2D | null = null;

    for (let step = 0; step < maxStepsPerLine && stepsSpent < maxTotalSteps; step++) {
      // Midpoint method: sample the field, take a half step, sample again, and
      // move on the second reading. Straight Euler visibly cuts corners on the
      // tight curves near a body, which is where the picture is interesting.
      const first = fieldAt(point.x, point.y);
      stepsSpent++;
      if (first.magnitude() === 0) break;

      const halfway = point.add(first.normalize().mult((sign * stepLength) / 2));
      const second = fieldAt(halfway.x, halfway.y);
      stepsSpent++;
      if (second.magnitude() === 0) break;

      const direction = second.normalize();

      // A gravitational field turns through 180 degrees at a body and at a
      // saddle, and a fixed step cannot follow that: the line ends up
      // oscillating back and forth across the singularity, drawn as a visible
      // zigzag. Ending the line where the direction reverses is the standard
      // remedy, and it is the honest picture — the flow really does terminate
      // there.
      if (previousDirection && direction.dot(previousDirection) < REVERSAL_COSINE) break;
      previousDirection = direction;

      const next = point.add(direction.mult(sign * stepLength));
      if (!inside(next, view, spacing)) break;
      if (tooClose(next)) break;

      points.push(next);
      point = next;
    }

    return points;
  };

  // Seeds on a world-anchored lattice, ordered so the ones nearest the middle
  // of the view are tried first: those are the lines the viewer is looking at,
  // and they should get the room rather than whatever happened to be seeded
  // from the corner.
  const seedSpacing = spacing;
  const firstX = Math.floor(view.minX / seedSpacing) * seedSpacing;
  const firstY = Math.floor(view.minY / seedSpacing) * seedSpacing;
  const centreX = (view.minX + view.maxX) / 2;
  const centreY = (view.minY + view.maxY) / 2;

  const seeds: Vector2D[] = [];
  for (let x = firstX; x <= view.maxX; x += seedSpacing) {
    for (let y = firstY; y <= view.maxY; y += seedSpacing) {
      seeds.push(new Vector2D(x, y));
    }
  }
  seeds.sort(
    (a, b) => Math.hypot(a.x - centreX, a.y - centreY) - Math.hypot(b.x - centreX, b.y - centreY)
  );

  for (const seed of seeds) {
    if (stepsSpent >= maxTotalSteps) break;
    if (tooClose(seed)) continue;

    const backward = follow(seed, -1).reverse();
    const forward = follow(seed, 1);
    const line = [...backward, seed, ...forward];

    // A line of two or three points is a smudge, not a curve.
    if (line.length < 4) continue;

    // Claim the space, so later lines keep their distance.
    for (const point of line) occupancy.add(point);
    lines.push(line);
  }

  return lines.map(thin);
}

/** Drop points that sit almost on top of their predecessor. */
function thin(line: Streamline): Streamline {
  if (line.length < 3) return line;

  const minimum = line[0].sub(line[1]).magnitude() * MIN_SEGMENT_FRACTION;
  const kept: Vector2D[] = [line[0]];

  for (let i = 1; i < line.length - 1; i++) {
    if (line[i].sub(kept[kept.length - 1]).magnitude() >= minimum) kept.push(line[i]);
  }

  kept.push(line[line.length - 1]);
  return kept;
}

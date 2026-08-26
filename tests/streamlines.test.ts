import { describe, it, expect } from 'vitest';
import {
  MAX_STREAMLINE_STEPS,
  defaultStreamlineOptions,
  traceStreamlines,
} from '../src/streamlines';
import { Vector2D } from '../src/Vector2D';
import type { ViewBounds } from '../src/VectorField';

/**
 * Like the contour tracer, this knows nothing about gravity: it follows a
 * vector field, so it can be checked against fields whose flow is known — a
 * uniform field flows in straight lines, a circular one in circles, a radial
 * one along spokes.
 */

const VIEW: ViewBounds = { minX: -200, minY: -200, maxX: 200, maxY: 200 };
const OPTIONS = defaultStreamlineOptions(VIEW);

describe('following a field whose flow is known', () => {
  it('draws straight lines through a uniform field', () => {
    const lines = traceStreamlines(() => new Vector2D(1, 0), VIEW, OPTIONS);

    expect(lines.length).toBeGreaterThan(3);

    for (const line of lines) {
      // Every point on a horizontal flow keeps its y.
      for (const point of line) expect(point.y).toBeCloseTo(line[0].y, 6);
      // ...and runs left to right.
      expect(line[line.length - 1].x).toBeGreaterThan(line[0].x);
    }
  });

  it('draws circles through a rotating field', () => {
    // A field perpendicular to the radius: every streamline is a circle about
    // the origin, so every point on one keeps its distance from the centre.
    const lines = traceStreamlines((x, y) => new Vector2D(-y, x), VIEW, OPTIONS);

    expect(lines.length).toBeGreaterThan(3);

    for (const line of lines) {
      const radius = Math.hypot(line[0].x, line[0].y);
      if (radius < OPTIONS.stepLength * 4) continue; // the centre is degenerate

      for (const point of line) {
        // The midpoint method still cuts a little on a curve; a couple of
        // percent over a whole circle is the honest tolerance.
        expect(Math.abs(Math.hypot(point.x, point.y) - radius) / radius).toBeLessThan(0.05);
      }
    }
  });

  it('follows the field rather than the other way down it', () => {
    // A radial field pointing outward: lines should run away from the centre.
    const lines = traceStreamlines(
      (x, y) => new Vector2D(x, y),
      VIEW,
      defaultStreamlineOptions(VIEW)
    );

    for (const line of lines) {
      const start = Math.hypot(line[0].x, line[0].y);
      const end = Math.hypot(line[line.length - 1].x, line[line.length - 1].y);
      expect(end).toBeGreaterThan(start);
    }
  });
});

describe('spacing', () => {
  it('keeps lines apart instead of bunching them', () => {
    // The whole reason for the occupancy test: seeded naively, a field like
    // this bunches every line into the same channel.
    const lines = traceStreamlines((_x, y) => new Vector2D(1, y / 200), VIEW, OPTIONS);
    expect(lines.length).toBeGreaterThan(2);

    // No point of one line should sit inside another line's half-spacing.
    // Endpoints are exempt: a line stops *because* it reached its neighbour.
    let violations = 0;
    for (let a = 0; a < lines.length; a++) {
      for (let b = a + 1; b < lines.length; b++) {
        for (const point of lines[a].slice(1, -1)) {
          for (const other of lines[b].slice(1, -1)) {
            if (point.sub(other).magnitude() < OPTIONS.spacing * 0.4) violations++;
          }
        }
      }
    }

    expect(violations).toBe(0);
  });

  it('covers the view rather than one corner of it', () => {
    const lines = traceStreamlines(() => new Vector2D(1, 0), VIEW, OPTIONS);
    const ys = lines.map((line) => line[0].y);

    expect(Math.min(...ys)).toBeLessThan(-100);
    expect(Math.max(...ys)).toBeGreaterThan(100);
  });
});

describe('cost', () => {
  it('spends no more than its budget, however large the view', () => {
    let evaluations = 0;
    const counted = (x: number, y: number) => {
      evaluations++;
      return new Vector2D(-y, x);
    };

    const wide: ViewBounds = { minX: -20000, minY: -20000, maxX: 20000, maxY: 20000 };
    traceStreamlines(counted, wide, {
      ...defaultStreamlineOptions(wide),
      maxTotalSteps: 1500,
    });

    // The budget is checked between steps, and one step is two evaluations.
    expect(evaluations).toBeLessThanOrEqual(1500 + 2);
  });

  it('has a default budget in the same range as the arrow grid', () => {
    expect(MAX_STREAMLINE_STEPS).toBeLessThanOrEqual(12000);
  });
});

describe('giving up gracefully', () => {
  it('produces nothing in a field with no direction anywhere', () => {
    expect(traceStreamlines(() => new Vector2D(0, 0), VIEW, OPTIONS)).toEqual([]);
  });

  it('refuses nonsense options rather than looping forever', () => {
    expect(traceStreamlines(() => new Vector2D(1, 0), VIEW, { ...OPTIONS, spacing: 0 })).toEqual(
      []
    );
    expect(
      traceStreamlines(() => new Vector2D(1, 0), VIEW, { ...OPTIONS, stepLength: 0 })
    ).toEqual([]);
  });

  it('anchors its seeds to the world, not to the viewport', () => {
    // The same invariant the arrow sampler has: anchoring to the view makes
    // every line crawl across the screen as the camera pans.
    const field = () => new Vector2D(1, 0);
    const shifted: ViewBounds = {
      minX: VIEW.minX + OPTIONS.spacing,
      maxX: VIEW.maxX + OPTIONS.spacing,
      minY: VIEW.minY,
      maxY: VIEW.maxY,
    };

    const before = traceStreamlines(field, VIEW, OPTIONS).map((line) => line[0].y);
    const after = traceStreamlines(field, shifted, OPTIONS).map((line) => line[0].y);

    // Panning by exactly one spacing should leave the lattice where it was.
    for (const y of after) {
      expect(before.some((original) => Math.abs(original - y) < 1e-6)).toBe(true);
    }
  });
});

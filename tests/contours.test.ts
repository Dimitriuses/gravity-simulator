import { describe, it, expect } from 'vitest';
import { MAX_CONTOUR_CELLS, contourLevels, traceContours } from '../src/contours';
import { gravitationalPotential } from '../src/forces';
import { Particle } from '../src/Particle';
import { treeOf } from '../src/quadtree';
import { Vector2D } from '../src/Vector2D';
import { SIMULATION_G } from '../src/PhysicsEngine';
import type { ViewBounds } from '../src/VectorField';

/**
 * Marching squares knows nothing about gravity, so it can be checked against
 * fields whose level sets are known exactly: a cone's contours are circles of a
 * radius you can write down, and a plane's are straight lines. Anything that
 * gets those wrong would be guesswork on a gravitational potential, where
 * nobody can see the right answer by eye.
 */

const VIEW: ViewBounds = { minX: -100, minY: -100, maxX: 100, maxY: 100 };

describe('levels', () => {
  it('spaces levels geometrically, so every decade gets lines', () => {
    // Evenly spaced levels on a potential spanning three orders of magnitude
    // put every line in a ring around the deepest well and none anywhere else.
    const levels = contourLevels(-1000, -1, 3);

    expect(levels).toHaveLength(3);
    for (const level of levels) {
      expect(level).toBeLessThan(0);
      expect(level).toBeGreaterThan(-1000);
    }

    const ratios = levels.slice(1).map((level, i) => level / levels[i]);
    for (const ratio of ratios) expect(ratio).toBeCloseTo(ratios[0], 9);
  });

  it('gives up rather than inventing levels for a flat or invalid range', () => {
    expect(contourLevels(-5, -5, 8)).toEqual([]);
    expect(contourLevels(0, 0, 8)).toEqual([]);
    expect(contourLevels(-Infinity, -1, 8)).toEqual([]);
  });
});

describe('tracing a field whose contours are known', () => {
  it('draws circles for a cone', () => {
    // f = -(200 - r) is a cone: the level set at -(200 - R) is the circle of
    // radius R about the origin, exactly.
    const cone = (x: number, y: number) => -(200 - Math.hypot(x, y));
    const lines = traceContours(cone, VIEW, 6, 120);

    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) {
      const radius = 200 + line.level;

      for (const segment of line.segments) {
        for (const point of [segment.from, segment.to]) {
          // Within half a cell of the true circle, which is all linear
          // interpolation along a straight edge can promise.
          expect(Math.abs(Math.hypot(point.x, point.y) - radius)).toBeLessThan(2);
        }
      }
    }
  });

  it('draws straight lines for a plane, and puts them where the level is', () => {
    // f = x, so the level set at x = c is the vertical line x = c.
    const plane = (x: number) => x;
    const lines = traceContours(plane, VIEW, 5, 60);

    for (const line of lines) {
      for (const segment of line.segments) {
        expect(segment.from.x).toBeCloseTo(line.level, 6);
        expect(segment.to.x).toBeCloseTo(line.level, 6);
      }
    }
  });

  it('closes the curve it traces', () => {
    // A circle drawn as segments should have every endpoint shared with
    // exactly one other segment: no gaps, no dangling ends.
    const cone = (x: number, y: number) => -(200 - Math.hypot(x, y));
    const [line] = traceContours(cone, VIEW, 1, 40);

    const key = (v: { x: number; y: number }) => `${v.x.toFixed(6)},${v.y.toFixed(6)}`;
    const counts = new Map<string, number>();
    for (const segment of line.segments) {
      for (const point of [segment.from, segment.to]) {
        counts.set(key(point), (counts.get(key(point)) ?? 0) + 1);
      }
    }

    for (const [point, count] of counts) {
      expect(count, `endpoint ${point} is shared ${count} times`).toBe(2);
    }
  });

  it('resolves the saddle between two wells rather than guessing', () => {
    // The ambiguous marching-squares cases are exactly the saddle, which is
    // where the interesting structure of a two-body potential lives. Two equal
    // wells: at a level just above the saddle the contour is one curve around
    // both; well below it, two separate curves.
    const wells = (x: number, y: number) =>
      -100 / Math.max(Math.hypot(x - 40, y), 5) - 100 / Math.max(Math.hypot(x + 40, y), 5);

    const lines = traceContours(wells, VIEW, 14, 140);
    expect(lines.length).toBeGreaterThan(4);

    // Every segment sits on its level, whichever side of the saddle it is.
    for (const line of lines) {
      for (const segment of line.segments) {
        const middleX = (segment.from.x + segment.to.x) / 2;
        const middleY = (segment.from.y + segment.to.y) / 2;
        const value = wells(middleX, middleY);

        expect(Math.abs(value - line.level) / Math.abs(line.level)).toBeLessThan(0.25);
      }
    }
  });

  it('produces nothing for a field with no variation', () => {
    expect(traceContours(() => -5, VIEW, 8, 40)).toEqual([]);
  });

  it('refuses a degenerate view instead of dividing by zero', () => {
    expect(traceContours(() => 1, { minX: 0, minY: 0, maxX: 0, maxY: 0 }, 8, 40)).toEqual([]);
  });
});

describe('cost', () => {
  it('stays inside its cell budget however wide the view', () => {
    let evaluations = 0;
    const counted = (x: number, y: number) => {
      evaluations++;
      return -(1000 - Math.hypot(x, y));
    };

    // A view a hundred times wider than the default, asking for a fine grid.
    traceContours(counted, { minX: -50000, minY: -30000, maxX: 50000, maxY: 30000 }, 10, 400);

    // One evaluation per grid corner, which is cells plus a fencepost on each
    // axis — comfortably inside twice the cap.
    expect(evaluations).toBeLessThan(MAX_CONTOUR_CELLS * 2);
  });
});

describe('on a real gravitational potential', () => {
  it('agrees whether the potential comes from the tree or the direct sum', () => {
    const particles = [
      new Particle(-120, 0, 4000),
      new Particle(120, 0, 1000),
      new Particle(0, 200, 500),
    ];
    const tree = treeOf(particles);
    const view: ViewBounds = { minX: -400, minY: -300, maxX: 400, maxY: 300 };

    const direct = traceContours(
      (x, y) => gravitationalPotential(new Vector2D(x, y), particles, SIMULATION_G),
      view,
      8,
      60
    );
    const viaTree = traceContours((x, y) => tree.potentialAt(x, y, SIMULATION_G, 0), view, 8, 60);

    expect(viaTree).toHaveLength(direct.length);
    for (let i = 0; i < direct.length; i++) {
      expect(viaTree[i].level).toBeCloseTo(direct[i].level, 9);
      expect(viaTree[i].segments.length).toBe(direct[i].segments.length);
    }
  });
});

describe('levels the caller has already chosen', () => {
  /**
   * What a locked scale means for a mode that draws level sets: the same values
   * are traced every frame, so two frames show the same curves moving rather
   * than different curves. Roadmap M17.
   */
  const bounds = { minX: -100, minY: -100, maxX: 100, maxY: 100 };
  const well = (x: number, y: number) => -400 / Math.max(Math.hypot(x, y), 5);

  it('traces exactly the levels it is given', () => {
    const asked = [-40, -20, -10];
    const lines = traceContours(well, bounds, 12, 60, [], asked);

    expect(lines.map((line) => line.level)).toEqual(asked);
  });

  it('leaves out a level the field has moved away from, rather than replacing it', () => {
    // -400 is deeper than this field goes outside the softening radius, so it
    // traces nothing — and nothing is the honest answer. A frame-chosen level
    // would have quietly substituted a different value.
    const lines = traceContours(well, bounds, 12, 60, [], [-400, -20]);

    expect(lines.map((line) => line.level)).toEqual([-20]);
  });

  it('chooses its own when it is not given any, as before', () => {
    const lines = traceContours(well, bounds, 5, 60);

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(5);
  });
});

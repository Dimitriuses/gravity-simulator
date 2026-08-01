import { describe, it, expect } from 'vitest';
import { OccupancyGrid } from '../src/VectorField';
import { Vector2D } from '../src/Vector2D';

/**
 * The linear scan the spatial hash replaced: for every accepted sample, is it
 * within `half` on both axes? Kept here as the reference implementation the
 * optimisation is measured against.
 */
class NaiveOccupancy {
  private points: Vector2D[] = [];

  has(x: number, y: number, half: number): boolean {
    return this.points.some((p) => Math.abs(p.x - x) < half && Math.abs(p.y - y) < half);
  }

  add(point: Vector2D): void {
    this.points.push(point);
  }
}

/** Deterministic PRNG so a failure is reproducible from the seed alone. */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('OccupancyGrid', () => {
  it('finds a point within the half-width on both axes', () => {
    const grid = new OccupancyGrid(18);
    grid.add(new Vector2D(100, 100));

    expect(grid.has(104, 104, 5)).toBe(true);
    // Exactly at the half-width is outside: the predicate is a strict <.
    expect(grid.has(105, 100, 5)).toBe(false);
    // Inside on x but outside on y — both axes must be within.
    expect(grid.has(101, 120, 5)).toBe(false);
  });

  it('is empty until something is added, and clears', () => {
    const grid = new OccupancyGrid(18);
    expect(grid.has(0, 0, 10)).toBe(false);

    grid.add(new Vector2D(0, 0));
    expect(grid.has(0, 0, 10)).toBe(true);

    grid.clear();
    expect(grid.has(0, 0, 10)).toBe(false);
  });

  it('finds points across cell boundaries', () => {
    // A query box straddling several cells must still see the point; getting
    // this wrong is the classic spatial-hash bug and it fails silently, as
    // extra duplicate samples rather than an exception.
    const cellSize = 18;
    const grid = new OccupancyGrid(cellSize);
    grid.add(new Vector2D(cellSize - 0.5, cellSize - 0.5));

    expect(grid.has(cellSize + 0.5, cellSize + 0.5, 3)).toBe(true);
  });

  it('handles negative coordinates', () => {
    // World space is centred on the origin, so half the samples are negative.
    const grid = new OccupancyGrid(18);
    grid.add(new Vector2D(-100, -100));
    expect(grid.has(-98, -102, 5)).toBe(true);
    expect(grid.has(-80, -100, 5)).toBe(false);
  });

  /**
   * The claim the optimisation rests on: the spatial hash answers exactly the
   * question the linear scan answered, so the field it produces is identical.
   */
  it('agrees with the naive linear scan on every query', () => {
    const random = mulberry32(20260801);
    const cellSize = 18; // baseGridSize 30 x 0.6, as VectorField sizes it
    const halfWidths = [4.5, 7.5, 12, 18]; // the four zone spacings, halved

    const grid = new OccupancyGrid(cellSize);
    const naive = new NaiveOccupancy();

    let agreements = 0;
    let accepted = 0;

    for (let i = 0; i < 4000; i++) {
      const x = (random() - 0.5) * 1200;
      const y = (random() - 0.5) * 800;
      const half = halfWidths[Math.floor(random() * halfWidths.length)];

      const fromGrid = grid.has(x, y, half);
      const fromNaive = naive.has(x, y, half);
      expect(fromGrid).toBe(fromNaive);
      agreements++;

      // Mirror VectorField: only accepted samples enter the index.
      if (!fromGrid) {
        grid.add(new Vector2D(x, y));
        naive.add(new Vector2D(x, y));
        accepted++;
      }
    }

    expect(agreements).toBe(4000);
    // Sanity: the run has to actually populate the structure, or the test
    // would pass by comparing two empty sets.
    expect(accepted).toBeGreaterThan(200);
  });

  it('agrees with the naive scan on a clustered distribution', () => {
    // Uniform random points rarely collide; the real workload is dense rings
    // around a handful of particles, where near-duplicates are the norm.
    const random = mulberry32(7);
    const grid = new OccupancyGrid(18);
    const naive = new NaiveOccupancy();

    const centres = [
      [0, 0],
      [40, 25],
      [-30, 10],
    ];

    for (let i = 0; i < 3000; i++) {
      const [cx, cy] = centres[i % centres.length];
      const x = cx + (random() - 0.5) * 60;
      const y = cy + (random() - 0.5) * 60;
      const half = 9;

      const fromGrid = grid.has(x, y, half);
      expect(fromGrid).toBe(naive.has(x, y, half));

      if (!fromGrid) {
        grid.add(new Vector2D(x, y));
        naive.add(new Vector2D(x, y));
      }
    }
  });
});

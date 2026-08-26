import { Vector2D } from './Vector2D';
import { Particle } from './Particle';
import { DEFAULT_THETA, QuadTree } from './quadtree';

/**
 * Represents a single vector sample point in the field
 */
export interface VectorSample {
  position: Vector2D;
  force: Vector2D;
}

/**
 * The rectangle of world space currently on screen, supplied by the camera.
 * The field is only ever built for this region — sampling outside it is work
 * whose result nobody can see.
 */
export interface ViewBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Forces below this are not worth an arrow. */
const MIN_FORCE = 0.001;

/**
 * Upper bound on samples per frame. Reached only by zooming far out in uniform
 * mode, where the visible world area grows as 1/zoom²; at the minimum zoom of
 * 0.1 an unbounded grid would ask for ~113,000 arrows and lock the tab. Uniform
 * mode responds by coarsening its spacing (the field stays uniform, just less
 * dense); adaptive mode stops adding samples.
 */
export const MAX_SAMPLES = 12000;

/**
 * Answers "is there already an accepted sample within `half` on both axes?" in
 * roughly constant time.
 *
 * This replaces a linear scan over every accepted sample, which made adaptive
 * mode quadratic in the sample count — the dominant cost of a frame. The
 * predicate is unchanged, so the field it produces is identical; the grid only
 * narrows which samples have to be tested. tests/OccupancyGrid.test.ts pins
 * that equivalence against the naive scan.
 */
export class OccupancyGrid {
  private cells = new Map<string, Vector2D[]>();

  /**
   * @param cellSize should be at least the largest `half` that will be queried,
   *   which keeps every lookup to a 2x2 or 3x3 block of cells.
   */
  constructor(private cellSize: number) {}

  clear(): void {
    this.cells.clear();
  }

  has(x: number, y: number, half: number): boolean {
    const minCX = Math.floor((x - half) / this.cellSize);
    const maxCX = Math.floor((x + half) / this.cellSize);
    const minCY = Math.floor((y - half) / this.cellSize);
    const maxCY = Math.floor((y + half) / this.cellSize);

    for (let cx = minCX; cx <= maxCX; cx++) {
      for (let cy = minCY; cy <= maxCY; cy++) {
        const bucket = this.cells.get(`${cx},${cy}`);
        if (!bucket) continue;
        for (const p of bucket) {
          if (Math.abs(p.x - x) < half && Math.abs(p.y - y) < half) return true;
        }
      }
    }
    return false;
  }

  add(point: Vector2D): void {
    const key = `${Math.floor(point.x / this.cellSize)},${Math.floor(point.y / this.cellSize)}`;
    const bucket = this.cells.get(key);
    if (bucket) bucket.push(point);
    else this.cells.set(key, [point]);
  }
}

/**
 * Gravitational field sampled on a grid, in one of two modes.
 *
 * `uniform` walks a regular lattice across the visible region. `adaptive`
 * instead walks four concentric rings around each particle, spacing samples
 * more finely close in — which is where the field actually has structure —
 * and deduplicates where rings from different particles overlap.
 */
export class VectorField {
  samples: VectorSample[] = [];
  maxInfluenceRadius: number = 300; // Range over which vectors are drawn (user-adjustable)
  baseGridSize: number = 30; // Nominal sample spacing
  gridMode: 'uniform' | 'adaptive' = 'adaptive';

  /**
   * Index over the accepted samples, used by adaptive mode's duplicate test.
   * Rebuilt every frame alongside `samples`.
   */
  private occupancy = new OccupancyGrid(1);

  /**
   * Barnes-Hut tree to sample through, or null to sum over every particle.
   *
   * Sampling is O(n) per sample point over several thousand points, so this is
   * the other half of what the tree is for — the field is usually the more
   * expensive of the two.
   */
  private tree: QuadTree | null = null;
  private theta: number = DEFAULT_THETA;

  constructor(baseGridSize: number = 30) {
    this.baseGridSize = baseGridSize;
  }

  /**
   * Rebuild the field for the current particles and camera view.
   *
   * `tree`, when given, is used to evaluate the field instead of summing over
   * particles. The sample *positions* still come from the particles themselves:
   * adaptive mode walks rings around each body, which is a question about where
   * to look rather than what is there.
   */
  update(
    particles: Particle[],
    G: number = 1,
    view: ViewBounds,
    tree: QuadTree | null = null,
    theta: number = DEFAULT_THETA
  ): void {
    this.samples = [];
    this.occupancy.clear();
    this.tree = tree;
    this.theta = theta;

    if (particles.length === 0) return;

    if (this.gridMode === 'uniform') {
      this.generateUniformGrid(particles, G, view);
    } else {
      this.generateAdaptiveGrid(particles, G, view);
    }
  }

  /**
   * Regular lattice across the whole visible region.
   *
   * The lattice is anchored to world coordinates rather than to the viewport,
   * so arrows stay put while the camera pans instead of crawling across the
   * screen.
   */
  private generateUniformGrid(particles: Particle[], G: number, view: ViewBounds): void {
    const width = view.maxX - view.minX;
    const height = view.maxY - view.minY;

    // Coarsen rather than truncate when the visible area is too large to
    // sample at the nominal spacing (see MAX_SAMPLES).
    let gridSize = this.baseGridSize;
    const wanted = (width / gridSize) * (height / gridSize);
    if (wanted > MAX_SAMPLES) {
      gridSize *= Math.sqrt(wanted / MAX_SAMPLES);
    }

    const startX = Math.floor(view.minX / gridSize) * gridSize;
    const startY = Math.floor(view.minY / gridSize) * gridSize;

    for (let x = startX; x <= view.maxX; x += gridSize) {
      for (let y = startY; y <= view.maxY; y += gridSize) {
        const samplePoint = new Vector2D(x, y);
        const force = this.calculateForceAt(samplePoint, particles, G);

        if (force.magnitude() > MIN_FORCE) {
          this.samples.push({ position: samplePoint, force });
        }
      }
    }
  }

  /**
   * Four density zones per particle: dense near the body, sparse at the edge of
   * its influence.
   */
  private generateAdaptiveGrid(particles: Particle[], G: number, view: ViewBounds): void {
    const maxRadius = this.maxInfluenceRadius;

    // Zone spacings as fractions of the base grid: 30%, 50%, 80%, 120%.
    const zones = [
      { maxDist: maxRadius * 0.2, gridSize: this.baseGridSize * 0.3 },
      { maxDist: maxRadius * 0.4, gridSize: this.baseGridSize * 0.5 },
      { maxDist: maxRadius * 0.7, gridSize: this.baseGridSize * 0.8 },
      { maxDist: maxRadius, gridSize: this.baseGridSize * 1.2 },
    ];

    // The duplicate test asks "is an existing sample within gridSize/2 on both
    // axes?". Sizing the hash cells to the largest such half-width any zone can
    // ask for — the outermost zone's 1.2 x base, halved — keeps every query to
    // a 2x2 or 3x3 block of cells.
    this.occupancy = new OccupancyGrid(Math.max(this.baseGridSize * 0.6, 1e-6));

    for (const particle of particles) {
      let innerRadius = 0;
      for (const zone of zones) {
        this.generateSamplesInRing(
          particle,
          innerRadius,
          zone.maxDist,
          zone.gridSize,
          particles,
          G,
          view
        );
        innerRadius = zone.maxDist;
      }
    }
  }

  /**
   * Sample one annulus around a particle, clipped to the visible region.
   */
  private generateSamplesInRing(
    particle: Particle,
    innerRadius: number,
    outerRadius: number,
    gridSize: number,
    allParticles: Particle[],
    G: number,
    view: ViewBounds
  ): void {
    const centerX = particle.position.x;
    const centerY = particle.position.y;

    // Clip the ring's bounding box to what is on screen.
    const minX = Math.max(view.minX, centerX - outerRadius);
    const maxX = Math.min(view.maxX, centerX + outerRadius);
    const minY = Math.max(view.minY, centerY - outerRadius);
    const maxY = Math.min(view.maxY, centerY + outerRadius);

    // Snap to a world-anchored lattice per zone spacing. Two consequences, both
    // wanted: samples do not crawl as the particle moves, and rings from
    // different particles land on the same points instead of near-misses, so
    // the duplicate test actually catches the overlap it is there to catch.
    const startX = Math.ceil(minX / gridSize) * gridSize;
    const startY = Math.ceil(minY / gridSize) * gridSize;

    const halfSpacing = gridSize * 0.5;

    for (let x = startX; x <= maxX; x += gridSize) {
      for (let y = startY; y <= maxY; y += gridSize) {
        if (this.samples.length >= MAX_SAMPLES) return;

        const dx = x - centerX;
        const dy = y - centerY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < innerRadius || dist > outerRadius) continue;
        if (this.occupancy.has(x, y, halfSpacing)) continue;

        const samplePoint = new Vector2D(x, y);
        const force = this.calculateForceAt(samplePoint, allParticles, G);

        if (force.magnitude() > MIN_FORCE) {
          this.samples.push({ position: samplePoint, force });
          this.occupancy.add(samplePoint);
        }
      }
    }
  }

  /**
   * Total gravitational field at a point: the sum over every particle within
   * range, of G·m/r². Field strength per unit mass, so the test particle's own
   * mass does not appear.
   */
  private calculateForceAt(point: Vector2D, particles: Particle[], G: number): Vector2D {
    if (this.tree) {
      // Same softening and the same range cutoff, reached through the tree
      // rather than by visiting every particle.
      return this.tree.accelerationAt(point.x, point.y, G, this.theta, this.maxInfluenceRadius);
    }

    let totalForce = new Vector2D(0, 0);

    for (const particle of particles) {
      const direction = particle.position.sub(point);
      const distanceSquared = direction.magnitudeSquared();

      // Skip if beyond the user-defined max range
      if (distanceSquared > this.maxInfluenceRadius * this.maxInfluenceRadius) continue;

      // Softened at the particle's own radius, as in Particle.attractionTo
      const softened = Math.max(distanceSquared, particle.radius * particle.radius);

      const forceMagnitude = (G * particle.mass) / softened;
      totalForce = totalForce.add(direction.normalize().mult(forceMagnitude));
    }

    return totalForce;
  }

  /**
   * Get all samples (for rendering)
   */
  getSamples(): VectorSample[] {
    return this.samples;
  }
}

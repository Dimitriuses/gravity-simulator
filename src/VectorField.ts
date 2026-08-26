import { Vector2D } from './Vector2D';
import { Particle } from './Particle';
import { DEFAULT_THETA, QuadTree } from './quadtree';
import { ContourLine, ScalarGrid, sampleScalarGrid, traceContours } from './contours';
import { Streamline, defaultStreamlineOptions, traceStreamlines } from './streamlines';
import { gravitationalPotential } from './forces';

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

/** Is this body within `range` of the square cell? */
function nearCell(
  particle: Particle,
  cell: { x: number; y: number; size: number },
  range: number
): boolean {
  const dx = Math.max(cell.x - particle.position.x, particle.position.x - (cell.x + cell.size), 0);
  const dy = Math.max(cell.y - particle.position.y, particle.position.y - (cell.y + cell.size), 0);
  return dx * dx + dy * dy <= range * range;
}

/** Forces below this are not worth an arrow. */
const MIN_FORCE = 0.001;

/**
 * How much a cell has to disagree with its parent before it is worth splitting.
 *
 * A quarter is a picture that follows the structure closely without spending
 * the whole budget on the first body it meets; lower and the count runs to the
 * cap near any mass, higher and the field goes blocky where it curves.
 */
const GRADIENT_SPLIT_THRESHOLD = 0.25;

/** Spacing close to a body, as a fraction of the base grid. */
const GRADIENT_FINE_FRACTION = 0.5;

/** How close to a body counts as close, as a fraction of the influence range. */
const GRADIENT_CLOSE_FRACTION = 0.15;

/**
 * Cells across the wider axis for the heightmap.
 *
 * Coarser than the contour grid: the image is stretched over the view and the
 * canvas interpolates between cells, so the extra samples a finer grid would
 * cost buy very little. A contour has no such luxury — its accuracy *is* its
 * grid.
 */
const HEIGHTMAP_RESOLUTION = 64;

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
 * How the field is drawn.
 *
 * The first three are arrow grids differing only in where they put the arrows;
 * the last two draw something else entirely and are described in
 * `contours.ts` and `streamlines.ts`.
 */
export type FieldMode =
  | 'adaptive'
  | 'uniform'
  | 'gradient'
  | 'contours'
  | 'heightmap'
  | 'streamlines';

/** Labels for the UI, in the order they should appear. */
export const FIELD_MODE_LABELS: ReadonlyArray<{ id: FieldMode; label: string }> = [
  { id: 'gradient', label: 'Arrows (where it changes)' },
  { id: 'adaptive', label: 'Arrows (dense near bodies)' },
  { id: 'uniform', label: 'Arrows (regular grid)' },
  { id: 'contours', label: 'Equipotential contours' },
  { id: 'heightmap', label: 'Potential heightmap' },
  { id: 'streamlines', label: 'Streamlines' },
];

/**
 * Gravitational field, drawn one of five ways.
 *
 * `uniform` walks a regular lattice across the visible region. `adaptive` walks
 * four concentric rings around each particle, spacing samples more finely close
 * in and deduplicating where rings overlap. `gradient` asks the field itself
 * where it needs looking at, by subdividing a cell only when its value differs
 * from its parent's — which is both a better picture and a much cheaper one,
 * because the sample count follows the structure rather than the body count.
 *
 * `contours` and `streamlines` are not sampling modes at all; they hand the
 * work to modules that know nothing about gravity and take a field function.
 */
export class VectorField {
  samples: VectorSample[] = [];
  contours: ContourLine[] = [];
  streamlines: Streamline[] = [];
  heightmap: ScalarGrid | null = null;

  /**
   * The view the current geometry was built for.
   *
   * The heightmap is an image stretched across exactly this rectangle, so the
   * renderer needs the same bounds the sampler used — taking the camera's
   * current bounds instead would stretch last frame's image over this frame's
   * view while panning.
   */
  lastView: ViewBounds | null = null;
  maxInfluenceRadius: number = 300; // Range over which vectors are drawn (user-adjustable)
  baseGridSize: number = 30; // Nominal sample spacing
  fieldMode: FieldMode = 'gradient';

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
    this.contours = [];
    this.streamlines = [];
    this.heightmap = null;
    this.lastView = view;
    this.occupancy.clear();
    this.tree = tree;
    this.theta = theta;

    if (particles.length === 0) return;

    switch (this.fieldMode) {
      case 'uniform':
        this.generateUniformGrid(particles, G, view);
        break;
      case 'adaptive':
        this.generateAdaptiveGrid(particles, G, view);
        break;
      case 'gradient':
        this.generateGradientGrid(particles, G, view);
        break;
      case 'contours':
        this.contours = traceContours(
          (x, y) => this.potentialAt(new Vector2D(x, y), particles, G),
          view
        );
        break;
      case 'heightmap':
        // The same grid the contours are traced from, handed over unreduced:
        // one draws its level sets, the other shades every cell. Sampled a
        // little more coarsely, because a heightmap is stretched over the view
        // and reads perfectly well interpolated, while a contour's accuracy is
        // set by the grid it is traced on.
        this.heightmap = sampleScalarGrid(
          (x, y) => this.potentialAt(new Vector2D(x, y), particles, G),
          view,
          HEIGHTMAP_RESOLUTION
        );
        break;
      case 'streamlines':
        this.streamlines = traceStreamlines(
          (x, y) => this.calculateForceAt(new Vector2D(x, y), particles, G),
          view,
          defaultStreamlineOptions(view)
        );
        break;
    }
  }

  /**
   * Sample where the field changes, not where the bodies are.
   *
   * Start with a coarse lattice and subdivide a cell only when its own reading
   * differs enough from its parent's — which is a direct measure of how much
   * the field is doing there. Smooth regions keep one arrow; the steep ground
   * near a body, or the saddle between two, gets as many as the budget allows.
   *
   * The point of it is that **the sample count follows the field's structure
   * rather than the number of bodies**. The zone-based mode asks for four rings
   * around every particle, so three hundred bodies ask for thousands of samples
   * and get truncated at the cap; this asks the same question of a two-body
   * scene and a three-hundred-body one, and answers it with a similar number of
   * arrows.
   */
  private generateGradientGrid(particles: Particle[], G: number, view: ViewBounds): void {
    // Anchored to the world, like every other lattice here, so arrows stay put
    // while the camera pans.
    const coarse = this.baseGridSize * 4;
    const finest = this.baseGridSize;
    // Matching the zone-based mode's innermost spacing, so the picture close to
    // a body is as dense as it has always been.
    const fine = this.baseGridSize * GRADIENT_FINE_FRACTION;
    const startX = Math.floor(view.minX / coarse) * coarse;
    const startY = Math.floor(view.minY / coarse) * coarse;

    interface Cell {
      x: number;
      y: number;
      size: number;
      parentMagnitude: number;
      /** Bodies inside this cell, carried down as it splits. */
      occupants: Particle[];
    }

    const queue: Cell[] = [];
    for (let x = startX; x <= view.maxX; x += coarse) {
      for (let y = startY; y <= view.maxY; y += coarse) {
        queue.push({ x, y, size: coarse, parentMagnitude: -1, occupants: [] });
      }
    }

    // Which bodies are near each coarse cell, so a cell knows whether it is in
    // interesting territory without searching. Handing the list down as cells
    // split keeps this to one pass over the bodies rather than one per cell.
    //
    // "Near" is the same distance the zone-based mode calls its innermost zone,
    // so the two agree about where the field deserves the closest look.
    const closeRange = this.maxInfluenceRadius * GRADIENT_CLOSE_FRACTION;
    for (const cell of queue) {
      cell.occupants = particles.filter((particle) => nearCell(particle, cell, closeRange));
    }

    while (queue.length > 0 && this.samples.length < MAX_SAMPLES) {
      const cell = queue.pop() as Cell;

      const centre = new Vector2D(cell.x + cell.size / 2, cell.y + cell.size / 2);
      const force = this.calculateForceAt(centre, particles, G);
      const magnitude = force.magnitude();

      if (magnitude <= MIN_FORCE && cell.occupants.length === 0) continue;

      // How much this cell disagrees with the one it came from. The first
      // level has nothing to compare against and always splits, which is what
      // gets the lattice down to a useful resolution before it starts judging.
      const change =
        cell.parentMagnitude < 0
          ? Infinity
          : Math.abs(magnitude - cell.parentMagnitude) / Math.max(magnitude, cell.parentMagnitude);

      const roomToSplit = this.samples.length + queue.length + 4 <= MAX_SAMPLES;

      // A cell near a body splits until it reaches the *fine* limit, whatever
      // the readings say, and cells elsewhere split only while they disagree
      // with their parent.
      //
      // Refinement driven by disagreement alone is blind to structure smaller
      // than the cell it starts from: a 120-unit cell near a mass-5 body sees a
      // field dominated by whatever heavy thing is nearby, finds nothing to
      // disagree with, and never looks closer. Measured on the Lagrange scene,
      // both trojans got no arrows at all.
      const nearBody = cell.occupants.length > 0;
      const limit = nearBody ? fine : finest;

      if (cell.size > limit && (nearBody || change > GRADIENT_SPLIT_THRESHOLD) && roomToSplit) {
        const half = cell.size / 2;

        for (const [dx, dy] of [
          [0, 0],
          [half, 0],
          [0, half],
          [half, half],
        ]) {
          const childX = cell.x + dx;
          const childY = cell.y + dy;

          queue.push({
            x: childX,
            y: childY,
            size: half,
            parentMagnitude: magnitude,
            occupants: cell.occupants.filter((particle) =>
              nearCell(particle, { x: childX, y: childY, size: half }, closeRange)
            ),
          });
        }
        continue;
      }

      if (magnitude > MIN_FORCE) this.samples.push({ position: centre, force });
    }
  }

  /** Potential at a point, through the tree when there is one. */
  private potentialAt(point: Vector2D, particles: Particle[], G: number): number {
    return this.tree
      ? this.tree.potentialAt(point.x, point.y, G, this.theta)
      : gravitationalPotential(point, particles, G);
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

  /** Equipotential lines, when the mode draws them. */
  getContours(): ContourLine[] {
    return this.contours;
  }

  /** Traced streamlines, when the mode draws them. */
  getStreamlines(): Streamline[] {
    return this.streamlines;
  }

  /** The sampled potential, when the mode shades it. */
  getHeightmap(): ScalarGrid | null {
    return this.heightmap;
  }
}

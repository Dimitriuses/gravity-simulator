import { describe, it, expect } from 'vitest';
import { VectorField, MAX_SAMPLES, type ViewBounds } from '../src/VectorField';
import { Particle } from '../src/Particle';
import { SIMULATION_G } from '../src/PhysicsEngine';

const VIEW: ViewBounds = { minX: -640, minY: -400, maxX: 640, maxY: 400 };

function view(minX: number, minY: number, maxX: number, maxY: number): ViewBounds {
  return { minX, minY, maxX, maxY };
}

describe('VectorField', () => {
  it('produces nothing without particles', () => {
    const field = new VectorField(30);
    field.update([], 1, VIEW);
    expect(field.getSamples()).toHaveLength(0);
  });

  it('clears the previous frame rather than appending to it', () => {
    const field = new VectorField(30);
    const particles = [new Particle(0, 0, 500)];

    field.update(particles, 1, VIEW);
    const first = field.getSamples().length;

    field.update(particles, 1, VIEW);
    expect(field.getSamples().length).toBe(first);
  });

  describe.each(['adaptive', 'uniform', 'gradient'] as const)('%s mode', (mode) => {
    it('samples only inside the visible region', () => {
      const field = new VectorField(30);
      field.fieldMode = mode;
      field.update([new Particle(0, 0, 500)], 1, VIEW);

      const samples = field.getSamples();
      expect(samples.length).toBeGreaterThan(0);
      for (const s of samples) {
        expect(s.position.x).toBeGreaterThanOrEqual(VIEW.minX);
        expect(s.position.x).toBeLessThanOrEqual(VIEW.maxX);
        expect(s.position.y).toBeGreaterThanOrEqual(VIEW.minY);
        expect(s.position.y).toBeLessThanOrEqual(VIEW.maxY);
      }
    });

    /**
     * The camera-awareness regression. The field used to be built inside a
     * fixed box the size of the canvas centred on the world origin, so panning
     * away from the origin showed empty space however many particles were
     * there. It now follows whatever the camera is looking at.
     */
    it('follows the camera to a distant region', () => {
      const field = new VectorField(30);
      field.fieldMode = mode;
      const farAway = [new Particle(10_000, 10_000, 500)];

      field.update(farAway, 1, VIEW);
      expect(field.getSamples()).toHaveLength(0);

      field.update(farAway, 1, view(9_400, 9_600, 10_600, 10_400));
      expect(field.getSamples().length).toBeGreaterThan(0);
    });

    it('points its arrows towards the attracting mass', () => {
      const field = new VectorField(30);
      field.fieldMode = mode;
      field.update([new Particle(0, 0, 500)], 1, VIEW);

      for (const s of field.getSamples()) {
        // The field vector at any point must have a positive component along
        // the direction from that point to the mass at the origin.
        const towards = { x: -s.position.x, y: -s.position.y };
        const dot = s.force.x * towards.x + s.force.y * towards.y;
        expect(dot).toBeGreaterThan(0);
      }
    });

    it('never emits a non-finite force', () => {
      const field = new VectorField(30);
      field.fieldMode = mode;
      // A body sitting exactly on a lattice point is the divide-by-zero case.
      field.update([new Particle(0, 0, 500), new Particle(30, 60, 500)], 1, VIEW);

      for (const s of field.getSamples()) {
        expect(Number.isFinite(s.force.x)).toBe(true);
        expect(Number.isFinite(s.force.y)).toBe(true);
        expect(s.force.magnitude()).toBeGreaterThan(0);
      }
    });

    it('stays within the sample budget when zoomed far out', () => {
      const field = new VectorField(30);
      field.fieldMode = mode;
      field.maxInfluenceRadius = 500;

      // The minimum zoom of 0.1 over a 1280x800 canvas: a 12800x8000 world
      // rectangle. Unbounded, a 30px lattice would ask for ~113,000 arrows.
      const particles = Array.from({ length: 12 }, (_, i) => new Particle(i * 700 - 4000, 0, 800));
      field.update(particles, 1, view(-6400, -4000, 6400, 4000));

      expect(field.getSamples().length).toBeLessThanOrEqual(MAX_SAMPLES);
    });

    it('respects the influence radius', () => {
      const field = new VectorField(30);
      field.fieldMode = mode;
      field.maxInfluenceRadius = 150;
      field.update([new Particle(0, 0, 500)], 1, VIEW);

      for (const s of field.getSamples()) {
        expect(s.position.magnitude()).toBeLessThanOrEqual(150 + 1e-9);
      }
    });
  });

  describe('adaptive mode', () => {
    it('samples more densely near the mass than far from it', () => {
      const field = new VectorField(30);
      field.fieldMode = 'adaptive';
      field.maxInfluenceRadius = 300;
      field.update([new Particle(0, 0, 500)], 1, VIEW);

      const samples = field.getSamples();
      // Inner zone: r < 60 (20% of 300). Outer zone: 210 <= r <= 300.
      const inner = samples.filter((s) => s.position.magnitude() < 60);
      const outer = samples.filter(
        (s) => s.position.magnitude() >= 210 && s.position.magnitude() <= 300
      );

      const innerArea = Math.PI * 60 * 60;
      const outerArea = Math.PI * (300 * 300 - 210 * 210);

      expect(inner.length / innerArea).toBeGreaterThan(outer.length / outerArea);
    });

    it('does not stack duplicate samples where two particles overlap', () => {
      const field = new VectorField(30);
      field.fieldMode = 'adaptive';
      field.maxInfluenceRadius = 300;

      // 100px apart, so their inner zones overlap heavily.
      field.update([new Particle(-50, 0, 500), new Particle(50, 0, 500)], 1, VIEW);

      const seen = new Set(field.getSamples().map((s) => `${s.position.x},${s.position.y}`));
      expect(seen.size).toBe(field.getSamples().length);
    });

    /**
     * Samples are snapped to a world-anchored lattice rather than one anchored
     * to each particle, so they do not crawl across the screen as a body
     * drifts. A body moving by less than one lattice step must leave the
     * sample positions where they were.
     */
    it('anchors its lattice to the world, not to the particle', () => {
      const field = new VectorField(30);
      field.fieldMode = 'adaptive';

      field.update([new Particle(0, 0, 500)], 1, VIEW);
      const before = new Set(field.getSamples().map((s) => `${s.position.x},${s.position.y}`));

      field.update([new Particle(1, 0, 500)], 1, VIEW);
      const after = field.getSamples().map((s) => `${s.position.x},${s.position.y}`);

      // The ring edges shift slightly, so allow a small difference — but the
      // overwhelming majority of points must be unmoved.
      const kept = after.filter((k) => before.has(k)).length;
      expect(kept / after.length).toBeGreaterThan(0.9);
    });
  });

  describe('uniform mode', () => {
    it('lays samples on a regular lattice', () => {
      const field = new VectorField(30);
      field.fieldMode = 'uniform';
      field.maxInfluenceRadius = 500;
      field.update([new Particle(0, 0, 2000)], 1, VIEW);

      for (const s of field.getSamples()) {
        expect(s.position.x % 30).toBeCloseTo(0, 9);
        expect(s.position.y % 30).toBeCloseTo(0, 9);
      }
    });

    it('keeps the lattice fixed in world space while the camera pans', () => {
      const field = new VectorField(30);
      field.fieldMode = 'uniform';
      field.maxInfluenceRadius = 500;

      const particles = [new Particle(0, 0, 2000)];
      field.update(particles, 1, VIEW);
      const before = new Set(field.getSamples().map((s) => `${s.position.x},${s.position.y}`));

      // Pan by a non-multiple of the grid size. Arrows must not shift with it.
      field.update(particles, 1, view(VIEW.minX + 7, VIEW.minY + 7, VIEW.maxX + 7, VIEW.maxY + 7));
      const after = field.getSamples().map((s) => `${s.position.x},${s.position.y}`);

      const kept = after.filter((k) => before.has(k)).length;
      expect(kept / after.length).toBeGreaterThan(0.95);
    });
  });

  describe('superposition', () => {
    const twoEqualMasses = () => [new Particle(-150, 0, 500), new Particle(150, 0, 500)];

    it('cancels the pull of two equal masses along their perpendicular bisector', () => {
      const field = new VectorField(30);
      field.fieldMode = 'uniform';
      field.maxInfluenceRadius = 500;
      field.update(twoEqualMasses(), 1, VIEW);

      // On the bisector the horizontal components cancel and only the pull
      // back towards the axis survives.
      const onBisector = field.getSamples().find((s) => s.position.x === 0 && s.position.y === -60);
      expect(onBisector).toBeDefined();
      expect(onBisector!.force.x).toBeCloseTo(0, 9);
      expect(onBisector!.force.y).toBeGreaterThan(0);
    });

    it('emits no arrow at a null point, where the field cancels exactly', () => {
      const field = new VectorField(30);
      field.fieldMode = 'uniform';
      field.maxInfluenceRadius = 500;
      field.update(twoEqualMasses(), 1, VIEW);

      // Dead centre between two equal masses the net field is exactly zero.
      // Drawing a zero-length arrow there would be noise, so it is skipped —
      // the blank spot is the physics, not a gap in the sampling.
      const centre = field.getSamples().filter((s) => s.position.x === 0 && s.position.y === 0);
      expect(centre).toHaveLength(0);

      // Its neighbours either side are present and point in opposite directions.
      const left = field.getSamples().find((s) => s.position.x === -30 && s.position.y === 0);
      const right = field.getSamples().find((s) => s.position.x === 30 && s.position.y === 0);
      expect(left).toBeDefined();
      expect(right).toBeDefined();
      expect(Math.sign(left!.force.x)).toBe(-Math.sign(right!.force.x));
    });
  });
});

describe('gradient mode', () => {
  /**
   * The mode's whole claim: put samples where the field has structure rather
   * than where the bodies happen to be, and so spend fewer of them.
   */
  const view: ViewBounds = { minX: -600, minY: -400, maxX: 600, maxY: 400 };

  function fieldWith(mode: 'gradient' | 'adaptive', particles: Particle[]): VectorField {
    const field = new VectorField(30);
    field.fieldMode = mode;
    field.maxInfluenceRadius = 150;
    field.update(particles, SIMULATION_G, view);
    return field;
  }

  it('reaches every body, including one too small to bend the field around it', () => {
    // The failure this exists for. Refinement driven only by how much a cell
    // disagrees with its parent never looks closer at a mass-5 body sitting in
    // a mass-5000 body's field: the coarse cell sees nothing worth splitting
    // for. Measured before the fix, both small bodies got zero arrows.
    const particles = [
      new Particle(-300, 0, 5000),
      new Particle(300, 0, 5),
      new Particle(0, 250, 5),
    ];

    const samples = fieldWith('gradient', particles).getSamples();

    for (const particle of particles) {
      const near = samples.filter(
        (sample) => sample.position.sub(particle.position).magnitude() < 60
      );
      expect(near.length, `body of mass ${particle.mass}`).toBeGreaterThan(10);
    }
  });

  it('spends fewer samples than the zone-based mode for the same scene', () => {
    const particles = [
      new Particle(-300, 0, 5000),
      new Particle(300, 0, 100),
      new Particle(0, 250, 5),
    ];

    const gradient = fieldWith('gradient', particles).getSamples().length;
    const adaptive = fieldWith('adaptive', particles).getSamples().length;

    expect(gradient).toBeLessThan(adaptive);
  });

  it('puts more samples where the field bends than where it is flat', () => {
    const particles = [new Particle(0, 0, 5000)];
    const samples = fieldWith('gradient', particles).getSamples();

    const close = samples.filter((s) => s.position.magnitude() < 60).length;
    const far = samples.filter(
      (s) => s.position.magnitude() > 90 && s.position.magnitude() < 150
    ).length;

    // The near ring is a quarter the area of the far one and should still hold
    // its own on count, which only happens if spacing follows the structure.
    expect(close).toBeGreaterThan(far / 2);
  });

  it('anchors its lattice to the world, not to the viewport', () => {
    // The invariant every sampler here shares: anchoring to the view makes
    // every arrow crawl across the screen as the camera pans.
    const particles = [new Particle(0, 0, 5000)];

    const still = fieldWith('gradient', particles).getSamples();
    const field = new VectorField(30);
    field.fieldMode = 'gradient';
    field.maxInfluenceRadius = 150;
    field.update(particles, SIMULATION_G, {
      minX: view.minX + 120,
      maxX: view.maxX + 120,
      minY: view.minY,
      maxY: view.maxY,
    });

    // Panned by exactly one coarse cell, every sample still in view should sit
    // where it sat before.
    const before = new Set(still.map((s) => `${s.position.x.toFixed(4)},${s.position.y.toFixed(4)}`));
    const shared = field
      .getSamples()
      .filter((s) => before.has(`${s.position.x.toFixed(4)},${s.position.y.toFixed(4)}`));

    expect(shared.length).toBeGreaterThan(field.getSamples().length * 0.5);
  });

  it('stays within the sample budget when a scene is crowded', () => {
    const particles = Array.from(
      { length: 200 },
      (_, i) => new Particle((i % 20) * 60 - 600, Math.floor(i / 20) * 80 - 400, 200)
    );

    expect(fieldWith('gradient', particles).getSamples().length).toBeLessThanOrEqual(MAX_SAMPLES);
  });
});

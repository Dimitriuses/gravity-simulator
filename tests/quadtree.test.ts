import { describe, it, expect } from 'vitest';
import { DEFAULT_THETA, QuadTree, treeAt, treeOf } from '../src/quadtree';
import { accelerationsAt } from '../src/forces';
import { Particle } from '../src/Particle';
import { Vector2D } from '../src/Vector2D';
import { SIMULATION_G } from '../src/PhysicsEngine';

/**
 * The tree is an approximation, so it is tested two ways: at theta = 0 it must
 * reproduce the direct sum *exactly*, which proves the traversal, the centres
 * of mass and the softening are all right; at the theta actually used it must
 * stay within a stated error, which is the thing being traded for speed.
 *
 * An approximation with no measured error bound is just a bug that has not been
 * noticed yet.
 */

function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/**
 * Deterministic scattered cloud, so a failure is reproducible.
 *
 * The default spread is wide enough that bodies do not overlap. A denser one is
 * not a fair test of the approximation: with most bodies inside another's
 * contact distance the softened force law dominates, and such a configuration
 * cannot persist anyway, because contact merges it.
 */
function cloud(count: number, spread = 6000, seed = 12345): Particle[] {
  const random = seeded(seed);

  return Array.from({ length: count }, () => {
    const mass = 50 + random() * 2000;
    return new Particle((random() - 0.5) * spread, (random() - 0.5) * spread, mass);
  });
}

/**
 * A heavy centre with a disc around it — the distribution the tree exists for,
 * and the one where each body's acceleration is dominated by a single term
 * rather than being a residual of cancelling ones.
 */
function galaxy(count: number, seed = 4242): Particle[] {
  const random = seeded(seed);
  const bodies = [new Particle(0, 0, 200000)];

  for (let i = 1; i < count; i++) {
    const radius = 200 + random() * 2500;
    const angle = random() * Math.PI * 2;
    bodies.push(
      new Particle(Math.cos(angle) * radius, Math.sin(angle) * radius, 20 + random() * 60)
    );
  }

  return bodies;
}

/**
 * Force error, two ways.
 *
 * `median` is each body's error against its own acceleration, which is the
 * usual measure. `maxVsMean` is the largest error in the system measured
 * against the *mean* acceleration, which is the one to trust in the tail: a
 * body whose pulls nearly cancel has a near-zero denominator, so its own
 * relative error can read enormous while the absolute error is ordinary.
 */
function errorStats(particles: Particle[], theta: number) {
  const tree = treeOf(particles);
  const exact = exactAccelerations(particles);
  const mean = exact.reduce((sum, a) => sum + a.magnitude(), 0) / exact.length;

  const own: number[] = [];
  let maxVsMean = 0;

  for (let i = 0; i < particles.length; i++) {
    const error = tree.accelerationOn(i, SIMULATION_G, theta).sub(exact[i]).magnitude();
    own.push(exact[i].magnitude() === 0 ? 0 : error / exact[i].magnitude());
    maxVsMean = Math.max(maxVsMean, error / mean);
  }

  own.sort((a, b) => a - b);
  return { median: own[own.length >> 1], maxVsMean };
}

/** The direct O(n²) sum every tree result is measured against. */
function exactAccelerations(particles: Particle[]): Vector2D[] {
  return accelerationsAt(
    particles,
    particles.map((p) => p.position),
    SIMULATION_G
  );
}

describe('structure', () => {
  it('summarises the whole system at the root', () => {
    const particles = cloud(50);
    const tree = treeOf(particles);
    const totalMass = particles.reduce((sum, p) => sum + p.mass, 0);

    // The root's single-mass approximation is what a very distant observer
    // sees, so it has to be the system's mass at the system's barycentre.
    const far = tree.accelerationAt(1e7, 0, SIMULATION_G, DEFAULT_THETA);
    const barycentreX =
      particles.reduce((sum, p) => sum + p.position.x * p.mass, 0) / totalMass;
    const expected = (SIMULATION_G * totalMass) / (1e7 - barycentreX) ** 2;

    expect(far.magnitude()).toBeCloseTo(expected, 12);
  });

  it('copes with an empty tree and with one body', () => {
    expect(QuadTree.build([]).accelerationAt(0, 0, SIMULATION_G).magnitude()).toBe(0);

    const single = treeOf([new Particle(0, 0, 100)]);
    expect(single.accelerationOn(0, SIMULATION_G).magnitude()).toBe(0);
    expect(single.accelerationAt(100, 0, SIMULATION_G).magnitude()).toBeGreaterThan(0);
  });

  it('terminates on bodies at identical coordinates', () => {
    // Subdivision separates bodies by quadrant, which never separates two at
    // the same point; without a depth limit this recurses until the stack goes.
    const particles = [
      new Particle(10, 10, 100),
      new Particle(10, 10, 100),
      new Particle(10, 10, 100),
    ];
    const tree = treeOf(particles);

    expect(Number.isFinite(tree.accelerationOn(0, SIMULATION_G).magnitude())).toBe(true);
    expect(Number.isFinite(tree.accelerationAt(50, 50, SIMULATION_G).magnitude())).toBe(true);
  });
});

describe('accuracy against the direct sum', () => {
  it('is exact at theta = 0, where no cell is ever opened', () => {
    const particles = cloud(120);
    const tree = treeOf(particles);
    const exact = exactAccelerations(particles);

    for (let i = 0; i < particles.length; i++) {
      const approximate = tree.accelerationOn(i, SIMULATION_G, 0);
      expect(approximate.x).toBeCloseTo(exact[i].x, 12);
      expect(approximate.y).toBeCloseTo(exact[i].y, 12);
    }
  });

  it('holds a tenth of a percent on the distribution it exists for', () => {
    // Measured on a 400-body galaxy at theta = 0.5: median 0.082%, worst
    // 0.132% of the mean acceleration.
    const stats = errorStats(galaxy(400), DEFAULT_THETA);

    expect(stats.median).toBeLessThan(0.002);
    expect(stats.maxVsMean).toBeLessThan(0.01);
  });

  it('stays under a percent on a sparse cloud, where forces largely cancel', () => {
    // The harder case: no dominant attractor, so each body's net acceleration
    // is a small residual and the same absolute error reads much larger.
    // Measured at theta = 0.5: median 0.73%, worst 5.5% of the mean.
    const stats = errorStats(cloud(400), DEFAULT_THETA);

    expect(stats.median).toBeLessThan(0.02);
    expect(stats.maxVsMean).toBeLessThan(0.1);
  });

  it('scales to two thousand bodies without the error running away', () => {
    // Measured on a 2,000-body galaxy at theta = 0.5: median 0.347%, worst
    // 2.9% of the mean.
    const stats = errorStats(galaxy(2000), DEFAULT_THETA);

    expect(stats.median).toBeLessThan(0.01);
    expect(stats.maxVsMean).toBeLessThan(0.05);
  });

  it('trades accuracy for speed monotonically as theta opens up', () => {
    const particles = galaxy(300);

    expect(errorStats(particles, 0).median).toBeLessThan(errorStats(particles, 0.5).median);
    expect(errorStats(particles, 0.5).median).toBeLessThan(errorStats(particles, 1).median);
  });

  it('never lets a body pull on itself', () => {
    // The self term is the one that would be infinite, so its absence is
    // conspicuous: a single pair must feel exactly its partner and nothing else.
    const particles = [new Particle(0, 0, 100), new Particle(300, 0, 400)];
    const tree = treeOf(particles);

    const acceleration = tree.accelerationOn(0, SIMULATION_G, 0);
    expect(acceleration.x).toBeCloseTo((SIMULATION_G * 400) / 300 ** 2, 12);
    expect(acceleration.y).toBeCloseTo(0, 12);
  });

  it('softens at contact, exactly as the direct force law does', () => {
    const a = new Particle(0, 0, 1000);
    const b = new Particle(1, 0, 1000);
    const tree = treeOf([a, b]);
    const exact = exactAccelerations([a, b]);

    expect(tree.accelerationOn(0, SIMULATION_G, 0).x).toBeCloseTo(exact[0].x, 12);
    expect(Number.isFinite(tree.accelerationOn(0, SIMULATION_G, 0).x)).toBe(true);
  });
});

describe('field queries', () => {
  it('matches the direct sum at a point no body occupies', () => {
    const particles = cloud(80);
    const tree = treeOf(particles);

    // The field softens on the source body's radius alone, since a sample
    // point has no size of its own.
    const point = new Vector2D(123, -45);
    let expected = new Vector2D(0, 0);
    for (const particle of particles) {
      const offset = particle.position.sub(point);
      const softened = Math.max(offset.magnitudeSquared(), particle.radius ** 2);
      expected = expected.add(
        offset.normalize().mult((SIMULATION_G * particle.mass) / softened)
      );
    }

    const actual = tree.accelerationAt(point.x, point.y, SIMULATION_G, 0);
    expect(actual.x).toBeCloseTo(expected.x, 10);
    expect(actual.y).toBeCloseTo(expected.y, 10);
  });

  it('honours the range cutoff the field sampler has always applied', () => {
    const near = new Particle(0, 0, 500);
    const far = new Particle(5000, 0, 500);
    const tree = treeOf([near, far]);

    const cutOff = tree.accelerationAt(100, 0, SIMULATION_G, 0, 1000);
    const everything = tree.accelerationAt(100, 0, SIMULATION_G, 0);

    // Within 1000 units only the near body counts, and it pulls back towards
    // the origin; including the far one drags the total the other way.
    expect(cutOff.x).toBeLessThan(0);
    expect(everything.x).toBeGreaterThan(cutOff.x);
  });
});

describe('contact queries', () => {
  it('answers exactly what a linear scan answers', () => {
    // Clustered, because uniformly scattered bodies rarely touch and would let
    // a broken query pass. Same reasoning as tests/OccupancyGrid.test.ts.
    const particles = [
      ...cloud(150, 120, 7),
      ...cloud(150, 4000, 99),
      new Particle(0, 0, 8000),
    ];
    const tree = treeOf(particles);

    for (let i = 0; i < particles.length; i++) {
      const body = particles[i];

      const naive: number[] = [];
      for (let j = 0; j < particles.length; j++) {
        const reach = body.radius + particles[j].radius;
        if (particles[j].position.sub(body.position).magnitudeSquared() < reach * reach) {
          naive.push(j);
        }
      }

      const found: number[] = [];
      tree.withinContact(body.position.x, body.position.y, body.radius, found);

      expect(found.sort((a, b) => a - b)).toEqual(naive.sort((a, b) => a - b));
    }
  });
});

describe('trial configurations', () => {
  it('builds over positions the bodies are not actually at', () => {
    // RK4 evaluates the field at three trial configurations per step, so the
    // tree has to be constructible from borrowed coordinates.
    const particles = [new Particle(0, 0, 100), new Particle(300, 0, 400)];
    const moved = [new Vector2D(0, 0), new Vector2D(600, 0)];

    const tree = treeAt(particles, moved);

    expect(tree.accelerationOn(0, SIMULATION_G, 0).x).toBeCloseTo(
      (SIMULATION_G * 400) / 600 ** 2,
      12
    );
  });
});

import { describe, it, expect } from 'vitest';
import { BARNES_HUT_THRESHOLD, PhysicsEngine, SIMULATION_G } from '../src/PhysicsEngine';
import { Particle } from '../src/Particle';
import type { ViewBounds } from '../src/VectorField';

const VIEW: ViewBounds = { minX: -640, minY: -400, maxX: 640, maxY: 400 };

function twoBodyEngine(): PhysicsEngine {
  const engine = new PhysicsEngine(30);
  engine.addParticle(new Particle(-200, 0, 100, 0, 0.5));
  engine.addParticle(new Particle(200, 0, 100, 0, -0.5));
  return engine;
}

describe('PhysicsEngine', () => {
  it('adds, removes and clears particles', () => {
    const engine = new PhysicsEngine(30);
    const a = new Particle(0, 0, 100);
    const b = new Particle(50, 0, 100);

    engine.addParticle(a);
    engine.addParticle(b);
    expect(engine.particles).toHaveLength(2);

    engine.removeParticle(a);
    expect(engine.particles).toEqual([b]);

    // Removing something absent is a no-op, not a splice at index -1.
    engine.removeParticle(a);
    expect(engine.particles).toEqual([b]);

    engine.clearParticles();
    expect(engine.particles).toHaveLength(0);
  });

  /**
   * The regression this suite exists for.
   *
   * `netForce` is what the renderer draws as each particle's orange force
   * arrow, and it reads it straight after the engine steps. The original code
   * cleared it at the *end* of Particle.update(), so by the time the renderer
   * looked it was always exactly zero and the arrow — advertised in the README
   * and in the on-screen legend — never drew a single pixel.
   */
  it('leaves netForce readable after a step, for the renderer', () => {
    const engine = twoBodyEngine();

    for (let frame = 0; frame < 5; frame++) {
      engine.step();

      for (const particle of engine.particles) {
        expect(particle.netForce.magnitude()).toBeGreaterThan(0);
      }
    }
  });

  it('does not accumulate force across steps', () => {
    const engine = twoBodyEngine();

    engine.computeForces();
    const first = engine.particles[0].netForce.magnitude();

    engine.computeForces();
    const second = engine.particles[0].netForce.magnitude();

    // Same configuration, so the same force — not twice it.
    expect(second).toBeCloseTo(first, 12);
  });

  it('applies equal and opposite forces (Newton’s 3rd law)', () => {
    const engine = new PhysicsEngine(30);
    engine.addParticle(new Particle(-100, 0, 100));
    engine.addParticle(new Particle(100, 0, 400));
    engine.computeForces();

    const [a, b] = engine.particles;
    expect(a.netForce.x).toBeCloseTo(-b.netForce.x, 12);
    expect(a.netForce.y).toBeCloseTo(-b.netForce.y, 12);
  });

  it('conserves total momentum under integration', () => {
    const engine = twoBodyEngine();
    const momentum = () =>
      engine.particles.reduce(
        (sum, p) => ({ x: sum.x + p.velocity.x * p.mass, y: sum.y + p.velocity.y * p.mass }),
        { x: 0, y: 0 }
      );

    const before = momentum();
    for (let i = 0; i < 500; i++) engine.step();
    const after = momentum();

    // Internal forces cancel pairwise, so total momentum is invariant even
    // though Euler integration does not conserve energy.
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it('keeps a symmetric two-body pair symmetric', () => {
    const engine = twoBodyEngine();
    for (let i = 0; i < 200; i++) engine.step();

    const [a, b] = engine.particles;
    // Mirrored initial conditions about the origin stay mirrored.
    expect(a.position.x).toBeCloseTo(-b.position.x, 9);
    expect(a.position.y).toBeCloseTo(-b.position.y, 9);
  });

  it('stays finite through a close encounter', () => {
    const engine = new PhysicsEngine(30);
    // Collisions off, so this is the softening floor being tested rather than
    // the merge that would otherwise resolve the encounter — see
    // tests/collisions.test.ts.
    engine.collisionMode = 'none';
    // Aimed straight at each other: they pass through the softening floor.
    engine.addParticle(new Particle(-60, 0, 500, 2, 0));
    engine.addParticle(new Particle(60, 0, 500, -2, 0));

    for (let i = 0; i < 400; i++) engine.step();

    for (const p of engine.particles) {
      expect(Number.isFinite(p.position.x)).toBe(true);
      expect(Number.isFinite(p.position.y)).toBe(true);
      expect(Number.isFinite(p.velocity.magnitude())).toBe(true);
    }
  });

  it('is inert with no particles', () => {
    const engine = new PhysicsEngine(30);
    expect(() => engine.update(VIEW)).not.toThrow();
    expect(engine.vectorField.getSamples()).toHaveLength(0);
  });

  it('finds a particle under a point, within a threshold', () => {
    const engine = new PhysicsEngine(30);
    const p = new Particle(100, 100, 100);
    engine.addParticle(p);

    expect(engine.getParticleAt(105, 105)).toBe(p);
    expect(engine.getParticleAt(500, 500)).toBeNull();
  });

  it('computeForces alone does not move anything', () => {
    // This is what a paused simulation calls, so arrows stay correct when a
    // body is added or deleted while frozen.
    const engine = twoBodyEngine();
    const before = engine.particles.map((p) => ({ x: p.position.x, y: p.position.y }));

    engine.computeForces();

    engine.particles.forEach((p, i) => {
      expect(p.position.x).toBe(before[i].x);
      expect(p.position.y).toBe(before[i].y);
    });
    expect(engine.particles[0].netForce.magnitude()).toBeGreaterThan(0);
  });
});

/**
 * Barnes-Hut changes the answer, on purpose. These check the size of that
 * change, and that switching to it is something the engine does deliberately
 * rather than accidentally.
 */
describe('choosing between the exact sum and the tree', () => {
  /** A disc of bodies, large enough to trip the automatic threshold. */
  function disc(count: number): Particle[] {
    let state = 987654321;
    const random = () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };

    const core = 200000;
    const bodies = [new Particle(0, 0, core)];

    for (let i = 1; i < count; i++) {
      const radius = 300 + Math.sqrt(random()) * 1700;
      const angle = random() * Math.PI * 2;
      const speed = Math.sqrt((SIMULATION_G * core) / radius);
      bodies.push(
        new Particle(
          Math.cos(angle) * radius,
          Math.sin(angle) * radius,
          20 + random() * 40,
          -Math.sin(angle) * speed,
          Math.cos(angle) * speed
        )
      );
    }

    return bodies;
  }

  function engineOf(count: number, forceMode: 'exact' | 'barnes-hut' | 'auto') {
    const engine = new PhysicsEngine(30);
    engine.forceMode = forceMode;
    engine.collisionMode = 'none';
    for (const body of disc(count)) engine.addParticle(body);
    return engine;
  }

  it('switches on automatically past the threshold, and not before', () => {
    expect(engineOf(BARNES_HUT_THRESHOLD - 1, 'auto').usingBarnesHut()).toBe(false);
    expect(engineOf(BARNES_HUT_THRESHOLD, 'auto').usingBarnesHut()).toBe(true);

    // And the setting overrides the count in both directions.
    expect(engineOf(4, 'barnes-hut').usingBarnesHut()).toBe(true);
    expect(engineOf(500, 'exact').usingBarnesHut()).toBe(false);
  });

  it('follows the same trajectories as the exact sum', () => {
    // Not identical - it is an approximation - but a scene run both ways should
    // still be recognisably the same scene after a hundred steps.
    const exact = engineOf(140, 'exact');
    const tree = engineOf(140, 'barnes-hut');

    for (let i = 0; i < 60; i++) {
      exact.step();
      tree.step();
    }

    const scale = 2000; // the disc's outer radius
    let worst = 0;
    for (let i = 0; i < exact.particles.length; i++) {
      const drift = tree.particles[i].position.sub(exact.particles[i].position).magnitude();
      worst = Math.max(worst, drift / scale);
    }

    expect(worst).toBeLessThan(0.02);
    // Sized to stay well inside the default timeout: the *exact* side is what
    // costs, and 200 bodies for 200 steps took six seconds on its own.
  }, 30000);

  it('gives up exact momentum conservation, and not much of it', () => {
    // The trade the method makes: A may see B individually while B sees A only
    // as part of a cell, so the pair's forces are not equal and opposite. The
    // exact solver has no such drift, which is why it stays the default for
    // scenes small enough to afford it.
    const measure = (engine: PhysicsEngine) => {
      const momentum = () =>
        engine.particles.reduce(
          (sum, p) => ({ x: sum.x + p.velocity.x * p.mass, y: sum.y + p.velocity.y * p.mass }),
          { x: 0, y: 0 }
        );
      const scale = engine.particles.reduce(
        (sum, p) => sum + p.mass * p.velocity.magnitude(),
        0
      );

      const before = momentum();
      for (let i = 0; i < 120; i++) engine.step();
      const after = momentum();

      return Math.hypot(after.x - before.x, after.y - before.y) / scale;
    };

    // Measured on a 140-body disc over 120 steps: 1.3e-16 exact, 7.8e-4 tree.
    expect(measure(engineOf(140, 'exact'))).toBeLessThan(1e-12);
    expect(measure(engineOf(140, 'barnes-hut'))).toBeLessThan(0.01);
  }, 30000);

  it('samples the same field through the tree as without it', () => {
    const view: ViewBounds = { minX: -400, minY: -400, maxX: 400, maxY: 400 };
    const exact = engineOf(200, 'exact');
    const tree = engineOf(200, 'barnes-hut');

    exact.computeForces();
    tree.computeForces();
    exact.updateField(view);
    tree.updateField(view);

    const exactSamples = exact.vectorField.getSamples();
    const treeSamples = tree.vectorField.getSamples();

    // Sample *positions* are generated from the particles, which are identical
    // here, so both runs walk the same lattice. The lists can still differ by a
    // sample or two: the sampler drops anything below a visibility threshold,
    // and a sample sitting right at it can fall either side under two force
    // sums that disagree in the fourth decimal place.
    expect(treeSamples.length).toBeGreaterThan(exactSamples.length * 0.99);
    expect(treeSamples.length).toBeLessThan(exactSamples.length * 1.01);

    const byPosition = new Map(
      exactSamples.map((sample) => [`${sample.position.x},${sample.position.y}`, sample.force])
    );

    let compared = 0;
    let worst = 0;
    for (const sample of treeSamples) {
      const reference = byPosition.get(`${sample.position.x},${sample.position.y}`);
      if (!reference || reference.magnitude() === 0) continue;

      compared++;
      worst = Math.max(worst, sample.force.sub(reference).magnitude() / reference.magnitude());
    }

    expect(compared).toBeGreaterThan(exactSamples.length * 0.95);
    expect(worst).toBeLessThan(0.05);
  });
});

describe('diagnostics', () => {
  /**
   * The overlay's numbers, and the only reason they are worth having: a scheme
   * in trouble says so here long before the picture looks wrong. They are
   * checked against closed forms rather than against themselves.
   */
  it('reports the energy of a two-body system as the textbook does', () => {
    const engine = new PhysicsEngine(30);
    const separation = 400;
    const a = new Particle(0, 0, 1000);
    const b = new Particle(separation, 0, 500, 0, 1.2);
    engine.addParticle(a);
    engine.addParticle(b);

    const { kinetic, potential, energy } = engine.diagnostics();

    expect(kinetic).toBeCloseTo(0.5 * 500 * 1.2 ** 2, 12);
    expect(potential).toBeCloseTo(-(SIMULATION_G * 1000 * 500) / separation, 12);
    expect(energy).toBeCloseTo(kinetic + potential, 12);
  });

  it('softens the potential exactly where the force law softens', () => {
    // Two bodies inside each other would otherwise report an energy heading
    // for minus infinity, and the overlay would show a drift of thousands of
    // percent for a contact that conserved everything it was supposed to.
    const engine = new PhysicsEngine(30);
    const a = new Particle(0, 0, 1000);
    const b = new Particle(0, 0, 1000);
    engine.addParticle(a);
    engine.addParticle(b);

    const { potential } = engine.diagnostics();

    expect(Number.isFinite(potential)).toBe(true);
    expect(potential).toBeCloseTo(-(SIMULATION_G * 1000 * 1000) / (a.radius + b.radius), 12);
  });

  it('sums momentum as a vector, and angular momentum about the origin', () => {
    const engine = new PhysicsEngine(30);
    engine.addParticle(new Particle(0, 100, 200, 3, 0));
    engine.addParticle(new Particle(0, -100, 200, -3, 0));

    const { momentum, angularMomentum } = engine.diagnostics();

    // Equal and opposite: no net momentum, but plenty of spin about the origin.
    expect(momentum.x).toBeCloseTo(0, 12);
    expect(momentum.y).toBeCloseTo(0, 12);
    expect(angularMomentum).toBeCloseTo(2 * 200 * (0 * 0 - 100 * 3), 12);
  });

  it('holds energy and angular momentum through a long orbit', () => {
    // The property the overlay exists to show, on a case where the answer is
    // known: a closed orbit gives nothing up.
    const engine = new PhysicsEngine(30);
    engine.collisionMode = 'none';
    const primary = new Particle(0, 0, 5000);
    const radius = 300;
    const speed = Math.sqrt((SIMULATION_G * 5000) / radius);
    engine.addParticle(primary);
    engine.addParticle(new Particle(radius, 0, 1, 0, speed));

    const before = engine.diagnostics();
    for (let i = 0; i < 4000; i++) engine.step();
    const after = engine.diagnostics();

    expect(Math.abs((after.energy - before.energy) / before.energy)).toBeLessThan(1e-3);
    expect(
      Math.abs((after.angularMomentum - before.angularMomentum) / before.angularMomentum)
    ).toBeLessThan(1e-6);
  });
});

describe('diagnostics on a balanced scene', () => {
  it('reports how much momentum is present, not just the net', () => {
    // Every preset is built momentum-balanced, so the net is zero and a drift
    // measured against it is a division by nothing. The scale is what the
    // overlay divides by instead: how much there is to lose.
    const engine = new PhysicsEngine(30);
    engine.addParticle(new Particle(0, 100, 200, 4, 0));
    engine.addParticle(new Particle(0, -100, 200, -4, 0));

    const { momentum, momentumScale, angularMomentum, angularScale } = engine.diagnostics();

    expect(momentum.magnitude()).toBeCloseTo(0, 12);
    expect(momentumScale).toBeCloseTo(2 * 200 * 4, 12);

    // The two bodies orbit the same way, so this pair's angular momentum does
    // not cancel — but the scale is still the sum of magnitudes.
    expect(angularScale).toBeGreaterThanOrEqual(Math.abs(angularMomentum));
  });

  it('counts angular scale even when the total cancels exactly', () => {
    const engine = new PhysicsEngine(30);
    engine.addParticle(new Particle(0, 100, 200, 4, 0));
    engine.addParticle(new Particle(0, -100, 200, 4, 0));

    const { angularMomentum, angularScale } = engine.diagnostics();

    expect(angularMomentum).toBeCloseTo(0, 12);
    expect(angularScale).toBeCloseTo(2 * 200 * 100 * 4, 12);
  });
});

describe('barycentre', () => {
  it('is the mass-weighted middle, not the middle', () => {
    const engine = new PhysicsEngine(30);
    engine.addParticle(new Particle(0, 0, 300));
    engine.addParticle(new Particle(400, 0, 100));

    const centre = engine.barycentre();

    expect(centre.x).toBeCloseTo(100, 12);
    expect(centre.y).toBeCloseTo(0, 12);
  });

  it('answers for an empty scene rather than dividing by zero', () => {
    const centre = new PhysicsEngine(30).barycentre();

    expect(centre.x).toBe(0);
    expect(centre.y).toBe(0);
  });

  it('stays put while the bodies orbit around it', () => {
    // Which is what makes it worth measuring a body's distance from: the
    // origin is wherever the scene happened to be built, the barycentre is a
    // fact about the system. Internal forces cannot move it, so any drift here
    // is the integrator's.
    const engine = new PhysicsEngine(30);
    engine.collisionMode = 'none';
    const separation = 400;
    const speed = Math.sqrt((SIMULATION_G * 200) / (2 * separation));
    engine.addParticle(new Particle(-separation / 2, 0, 200, 0, speed));
    engine.addParticle(new Particle(separation / 2, 0, 200, 0, -speed));

    const before = engine.barycentre();
    for (let i = 0; i < 3000; i++) engine.step();
    const after = engine.barycentre();

    expect(after.sub(before).magnitude()).toBeLessThan(1e-9);
  });
});

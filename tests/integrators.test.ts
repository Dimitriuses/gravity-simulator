import { describe, it, expect } from 'vitest';
import {
  ForceField,
  INTEGRATORS,
  IntegratorName,
  MAX_SUB_STEPS,
  pairTimescale,
  recommendedSubSteps,
  subStepsForTimescale,
  rungeKutta4,
  symplecticEuler,
  velocityVerlet,
} from '../src/integrators';
import { PhysicsEngine, SIMULATION_G } from '../src/PhysicsEngine';
import { Particle } from '../src/Particle';
import { Vector2D } from '../src/Vector2D';
import { treeOf } from '../src/quadtree';

/**
 * Two things need proving about an integrator, and they are different things:
 * that it computes the update it says it computes (checked against the closed
 * form for a constant field, where all three are exact or nearly so), and that
 * it converges at the order it claims (checked by halving the step and watching
 * the error fall by 2, 4 and 16). A scheme can look plausible and be first
 * order by accident.
 */

const NAMES: IntegratorName[] = ['euler', 'verlet', 'rk4'];

/** A uniform acceleration field — the case every scheme should handle exactly. */
function constantField(particles: Particle[], acceleration: Vector2D): ForceField {
  return {
    refresh() {
      for (const particle of particles) {
        particle.acceleration = acceleration;
        particle.netForce = acceleration.mult(particle.mass);
      }
    },
    accelerationsAt(positions) {
      return positions.map(() => acceleration);
    },
  };
}

/** Counts what an integrator asks of the world, to price a step. */
function countingField(engine: PhysicsEngine) {
  const counts = { refresh: 0, trial: 0 };
  const field: ForceField = {
    refresh() {
      counts.refresh++;
      engine.refresh();
    },
    accelerationsAt(positions) {
      counts.trial++;
      return engine.accelerationsAt(positions);
    },
  };
  return { counts, field };
}

/** A satellite on a circular orbit of radius `r` about a heavy primary. */
function orbit(radius: number, primaryMass = 5000): Particle[] {
  const speed = Math.sqrt((SIMULATION_G * primaryMass) / radius);
  return [new Particle(0, 0, primaryMass, 0, 0), new Particle(radius, 0, 1, 0, speed)];
}

/** Run one scheme over `duration` at step `dt`, straight through with no sub-stepping. */
function run(name: IntegratorName, particles: Particle[], duration: number, dt: number) {
  const engine = new PhysicsEngine(30);
  for (const particle of particles) engine.addParticle(particle);
  engine.integrator = name;
  engine.adaptiveStepping = false;

  const steps = Math.round(duration / dt);
  for (let i = 0; i < steps; i++) engine.integrate(dt);

  return engine;
}

describe('the update each scheme computes', () => {
  it('advances a constant field exactly the way the closed form does', () => {
    // x(t) = x₀ + v₀t + ½at², v(t) = v₀ + at. With a = 1, v₀ = 1, dt = 1:
    // position 1.5 and velocity 2. Symplectic Euler is the odd one out — it
    // uses the *new* velocity for the whole step, landing at 2 instead of 1.5.
    // That is the first-order error, in one number.
    const expected: Record<IntegratorName, { x: number; v: number }> = {
      euler: { x: 2, v: 2 },
      verlet: { x: 1.5, v: 2 },
      rk4: { x: 1.5, v: 2 },
    };

    for (const name of NAMES) {
      const particle = new Particle(0, 0, 10, 1, 0);
      const field = constantField([particle], new Vector2D(1, 0));
      field.refresh();

      INTEGRATORS[name]([particle], 1, field);

      expect(particle.position.x, name).toBeCloseTo(expected[name].x, 12);
      expect(particle.velocity.x, name).toBeCloseTo(expected[name].v, 12);
    }
  });

  it('leaves accelerations current for the next step and for the renderer', () => {
    // The contract the schemes rely on each other for: velocity Verlet opens by
    // using the acceleration the previous step left behind, and the renderer
    // draws netForce straight after a step.
    for (const name of NAMES) {
      const engine = new PhysicsEngine(30);
      engine.integrator = name;
      for (const particle of orbit(200)) engine.addParticle(particle);

      engine.step();

      for (const particle of engine.particles) {
        expect(particle.netForce.magnitude(), name).toBeGreaterThan(0);

        // netForce is the force where the particle *is*, not where it was.
        const expected = engine.accelerationsAt(engine.particles.map((p) => p.position));
        const index = engine.particles.indexOf(particle);
        expect(particle.acceleration.x, name).toBeCloseTo(expected[index].x, 12);
        expect(particle.acceleration.y, name).toBeCloseTo(expected[index].y, 12);
      }
    }
  });
});

describe('order of accuracy', () => {
  /**
   * Halving the step should divide the error by 2^order. Measured against a
   * reference orbit integrated with RK4 at dt = 1/64, which is three orders
   * finer than anything under test.
   */
  const DURATION = 400;

  function positionError(name: IntegratorName, dt: number): number {
    const reference = run('rk4', orbit(200), DURATION, 1 / 64).particles[1].position;
    const actual = run(name, orbit(200), DURATION, dt).particles[1].position;
    return actual.sub(reference).magnitude();
  }

  it.each([
    ['euler' as const, 2, 1.6, 2.6],
    ['verlet' as const, 4, 3.4, 4.6],
    ['rk4' as const, 16, 12, 20],
  ])('%s converges at ratio ~%i when the step is halved', (name, _nominal, low, high) => {
    const coarse = positionError(name, 1);
    const fine = positionError(name, 0.5);

    expect(coarse / fine).toBeGreaterThan(low);
    expect(coarse / fine).toBeLessThan(high);
  });

  it('ranks the schemes by accuracy at the same step size', () => {
    const euler = positionError('euler', 1);
    const verlet = positionError('verlet', 1);
    const rk4 = positionError('rk4', 1);

    expect(verlet).toBeLessThan(euler);
    expect(rk4).toBeLessThan(verlet);
  });
});

describe('what a step costs', () => {
  it('charges velocity Verlet one force evaluation, the same as Euler', () => {
    // The claim that makes Verlet free: the acceleration it computes to finish
    // its velocity update is the one the next step opens with.
    // RK4's first stage reuses the same cached acceleration, so it costs four
    // evaluations rather than the five a naive implementation would need.
    for (const [name, expected] of [
      ['euler', 1],
      ['verlet', 1],
      ['rk4', 4],
    ] as const) {
      const engine = new PhysicsEngine(30);
      for (const particle of orbit(200)) engine.addParticle(particle);
      engine.computeForces();

      const { counts, field } = countingField(engine);
      INTEGRATORS[name](engine.particles, 1, field);

      expect(counts.refresh + counts.trial, name).toBe(expected);
    }
  });
});

describe('conservation', () => {
  it('conserves total momentum under every scheme', () => {
    for (const name of NAMES) {
      const engine = new PhysicsEngine(30);
      engine.integrator = name;
      engine.addParticle(new Particle(-200, 0, 100, 0, 0.25));
      engine.addParticle(new Particle(200, 0, 100, 0, -0.25));

      const momentum = () =>
        engine.particles.reduce(
          (sum, p) => ({ x: sum.x + p.velocity.x * p.mass, y: sum.y + p.velocity.y * p.mass }),
          { x: 0, y: 0 }
        );

      const before = momentum();
      for (let i = 0; i < 500; i++) engine.step();
      const after = momentum();

      // Every stage of every scheme applies forces in equal and opposite
      // pairs, so this holds even for RK4, which conserves nothing else.
      expect(after.x, name).toBeCloseTo(before.x, 9);
      expect(after.y, name).toBeCloseTo(before.y, 9);
    }
  });

  it('bounds the symplectic schemes and lets RK4 drift', () => {
    // The reason a fourth-order scheme is not automatically the better one, and
    // the reason RK4 is offered for comparison rather than as the default.
    // r = 50 is 44 steps per orbit, coarse enough to see this inside a few
    // hundred orbits. Measured energy excursion: Euler 2.0096% by 100 orbits
    // and still 2.0096% by 1,000; Verlet 0.0097% and still 0.0097%; RK4
    // 0.0997% growing to 1.0444%.
    const excursion = (name: IntegratorName, orbits: number) => {
      const period = 2 * Math.PI * Math.sqrt(50 ** 3 / (SIMULATION_G * 5001));
      const engine = new PhysicsEngine(30);
      engine.integrator = name;
      engine.adaptiveStepping = false;
      for (const particle of orbit(50)) engine.addParticle(particle);

      const energy = () => {
        const [primary, satellite] = engine.particles;
        const r = satellite.position.sub(primary.position).magnitude();
        const v = satellite.velocity.sub(primary.velocity).magnitude();
        return (v * v) / 2 - (SIMULATION_G * 5001) / r;
      };

      const start = energy();
      let widest = 0;
      for (let i = 0; i < Math.round(period * orbits); i++) {
        engine.step();
        widest = Math.max(widest, Math.abs((energy() - start) / start));
      }
      return widest;
    };

    // Symplectic: by 100 orbits the error is already as wide as it ever gets.
    for (const name of ['euler', 'verlet'] as const) {
      expect(excursion(name, 500) / excursion(name, 100), name).toBeCloseTo(1, 2);
    }

    // Not symplectic: it keeps accumulating.
    expect(excursion('rk4', 500) / excursion('rk4', 100)).toBeGreaterThan(3);
  });

  it('keeps the symplectic schemes bounded in energy over a long run', () => {
    // 1,000 orbits at r = 200. The symplectic schemes trade energy back and
    // forth within a bound; RK4 is fourth-order but not symplectic, which is
    // exactly why it is offered for comparison rather than as the default.
    const orbits = 1000;
    const period = 2 * Math.PI * Math.sqrt(200 ** 3 / (SIMULATION_G * 5000));

    for (const name of ['euler', 'verlet'] as const) {
      const engine = run(name, orbit(200), period * orbits, 1);
      const satellite = engine.particles[1];
      const radius = satellite.position.sub(engine.particles[0].position).magnitude();

      expect(radius, name).toBeGreaterThan(190);
      expect(radius, name).toBeLessThan(210);
    }
  });
});

describe('adaptive sub-stepping', () => {
  it('asks for a single step on a wide orbit', () => {
    // The common case has to stay free, or adaptive stepping is a tax on every
    // scene to rescue the few that need it.
    expect(recommendedSubSteps(orbit(400), SIMULATION_G, 1)).toBe(1);
    expect(recommendedSubSteps(orbit(200), SIMULATION_G, 1)).toBe(1);
  });

  it('subdivides in step with how tight the orbit is', () => {
    // Lighter primary, so these radii stay outside its contact distance: a
    // mass-1000 body is 20 units across, a mass-5000 one 34.2.
    const tight = recommendedSubSteps(orbit(50, 1000), SIMULATION_G, 1);
    const tighter = recommendedSubSteps(orbit(25, 1000), SIMULATION_G, 1);

    expect(tighter).toBeGreaterThan(tight);
  });

  it('clamps separation at contact, so overlapping bodies do not demand infinite steps', () => {
    // Inside the primary's own radius the force law softens — the force stops
    // growing — so the timescale has to stop shrinking too, or two overlapping
    // bodies would ask for an unbounded number of sub-steps. Both pairs here
    // are at rest, isolating the dynamical term from the crossing one.
    const contact = new Particle(0, 0, 5000).radius + new Particle(0, 0, 1).radius;
    const inside = [new Particle(0, 0, 5000, 0, 0), new Particle(contact / 2, 0, 1, 0, 0)];
    const deeperInside = [new Particle(0, 0, 5000, 0, 0), new Particle(0.01, 0, 1, 0, 0)];

    expect(recommendedSubSteps(deeperInside, SIMULATION_G, 1)).toBe(
      recommendedSubSteps(inside, SIMULATION_G, 1)
    );
  });

  it('subdivides for a fast flyby the dynamical time alone would miss', () => {
    // Far enough apart that the dynamical time is long, but crossing that
    // separation in a couple of frames.
    const slow = [new Particle(0, 0, 5000, 0, 0), new Particle(300, 0, 1, 0, 0)];
    const fast = [new Particle(0, 0, 5000, 0, 0), new Particle(300, 0, 1, -150, 0)];

    expect(recommendedSubSteps(slow, SIMULATION_G, 1)).toBe(1);
    expect(recommendedSubSteps(fast, SIMULATION_G, 1)).toBeGreaterThan(1);
  });

  it('never exceeds its cap, however pathological the pair', () => {
    const overlapping = [new Particle(0, 0, 100000, 0, 0), new Particle(0, 0, 100000, 500, 0)];
    const count = recommendedSubSteps(overlapping, SIMULATION_G, 1);

    expect(count).toBeLessThanOrEqual(MAX_SUB_STEPS);
    expect(Number.isFinite(count)).toBe(true);
  });

  it('gets the same answer from the tree as from the pairwise scan', () => {
    // The tree version is a branch-and-bound search for the same minimum, not
    // an approximation of it, so it has to agree exactly — on scattered
    // clouds, on a scene with one very close pair, and on one with a fast
    // flyby, since the rule takes the smaller of two different timescales.
    let state = 20240826;
    const random = () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };

    const scenes: Particle[][] = [
      Array.from({ length: 200 }, () =>
        new Particle(
          (random() - 0.5) * 4000,
          (random() - 0.5) * 4000,
          20 + random() * 900,
          (random() - 0.5) * 8,
          (random() - 0.5) * 8
        )
      ),
      [...orbit(50), new Particle(4000, 4000, 100, 0, 0)],
      [new Particle(0, 0, 5000, 0, 0), new Particle(-400, 0, 50, 160, 0)],
      [new Particle(0, 0, 100), new Particle(0, 0, 100)],
    ];

    for (const [index, particles] of scenes.entries()) {
      const scan = recommendedSubSteps(particles, SIMULATION_G, 1);
      const searched = recommendedSubSteps(
        particles,
        SIMULATION_G,
        1,
        MAX_SUB_STEPS,
        treeOf(particles)
      );

      expect(searched, `scene ${index}`).toBe(scan);
    }
  });

  it('needs no sub-steps when nothing is interacting', () => {
    expect(recommendedSubSteps([], SIMULATION_G, 1)).toBe(1);
    expect(recommendedSubSteps([new Particle(0, 0, 100)], SIMULATION_G, 1)).toBe(1);
  });

  /**
   * The measurement this milestone exists for.
   *
   * r = 50 about a mass-5000 primary is 44 steps per orbit at `dt = 1` — the
   * tightest orbit in KNOWNISSUES.md's table that is still a real orbit. Its
   * two tighter rows, r = 25 and r = 12, sit *inside* the primary's own
   * 34.2-unit radius, where the force law softens; what they measured was
   * mostly softening rather than step size.
   */
  it('tightens the tightest orbit the fixed step handles badly', () => {
    const measure = (adaptive: boolean) => {
      const engine = new PhysicsEngine(30);
      engine.adaptiveStepping = adaptive;
      for (const particle of orbit(50)) engine.addParticle(particle);

      let min = Infinity;
      let max = 0;
      for (let i = 0; i < 4000; i++) {
        engine.step();
        const r = engine.particles[1].position.sub(engine.particles[0].position).magnitude();
        min = Math.min(min, r);
        max = Math.max(max, r);
      }
      return { spread: max - min, subSteps: engine.lastSubSteps };
    };

    const fixed = measure(false);
    const adaptive = measure(true);

    expect(adaptive.subSteps).toBeGreaterThan(1);
    expect(fixed.subSteps).toBe(1);
    // Measured: 1.00% of the radius fixed, 0.11% adaptive.
    expect(adaptive.spread).toBeLessThan(fixed.spread / 5);
    expect(adaptive.spread / 50).toBeLessThan(0.005);
  });

  it('records one trail point per frame however many sub-steps it took', () => {
    // A trail that recorded sub-steps would drain in a fraction of a second on
    // a tight orbit, and change length as the sub-step count moved.
    const engine = new PhysicsEngine(30);
    for (const particle of orbit(50)) engine.addParticle(particle);

    for (let i = 0; i < 20; i++) engine.step();

    expect(engine.lastSubSteps).toBeGreaterThan(1);
    expect(engine.particles[1].trail).toHaveLength(20);
  });

  it('reports the sub-step count it used, for the UI', () => {
    const engine = new PhysicsEngine(30);
    for (const particle of orbit(50)) engine.addParticle(particle);

    engine.step();
    expect(engine.lastSubSteps).toBeGreaterThan(1);

    engine.adaptiveStepping = false;
    engine.step();
    expect(engine.lastSubSteps).toBe(1);
  });
});

describe('integrator selection', () => {
  it('exports one implementation per name', () => {
    expect(INTEGRATORS.euler).toBe(symplecticEuler);
    expect(INTEGRATORS.verlet).toBe(velocityVerlet);
    expect(INTEGRATORS.rk4).toBe(rungeKutta4);
  });

  it('defaults to velocity Verlet with adaptive stepping on', () => {
    const engine = new PhysicsEngine(30);
    expect(engine.integrator).toBe('verlet');
    expect(engine.adaptiveStepping).toBe(true);
  });
});

describe('the step rule, taken apart', () => {
  /**
   * `pairTimescale` and `subStepsForTimescale` are exported so that the
   * benchmark can ask "what would *this* body have needed on its own?" with the
   * same arithmetic the engine uses. That is only true while these hold.
   */
  it('is the minimum of the pair timescales, over every pair', () => {
    // A small deterministic generator, so the scene is the same scene each run.
    let state = 31415;
    const random = () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };

    const particles = Array.from({ length: 40 }, () =>
      new Particle(
        (random() - 0.5) * 2000,
        (random() - 0.5) * 2000,
        20 + random() * 900,
        (random() - 0.5) * 6,
        (random() - 0.5) * 6
      )
    );

    let shortest = Infinity;
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        shortest = Math.min(shortest, pairTimescale(particles[i], particles[j], SIMULATION_G));
      }
    }

    expect(subStepsForTimescale(shortest, 1)).toBe(
      recommendedSubSteps(particles, SIMULATION_G, 1)
    );
  });

  it('asks for more sub-steps as the timescale shortens, and stops at the cap', () => {
    expect(subStepsForTimescale(Infinity, 1)).toBe(1);
    expect(subStepsForTimescale(100, 1)).toBe(1);
    expect(subStepsForTimescale(1, 1)).toBe(16);
    expect(subStepsForTimescale(0.1, 1)).toBe(64);
    expect(subStepsForTimescale(0, 1)).toBe(64);
  });

  it('clamps a pair at contact, so touching bodies do not ask for infinity', () => {
    const a = new Particle(0, 0, 1000);
    const b = new Particle(0, 0, 1000);
    const touching = new Particle(a.radius + b.radius, 0, 1000);

    expect(Number.isFinite(pairTimescale(a, b, SIMULATION_G))).toBe(true);
    expect(pairTimescale(a, b, SIMULATION_G)).toBeCloseTo(
      pairTimescale(a, touching, SIMULATION_G),
      12
    );
  });
});

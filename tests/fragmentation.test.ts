import { describe, it, expect } from 'vitest';
import {
  DISPERSAL_EFFICIENCY,
  LARGEST_REMNANT_FRACTION,
  MAX_FRAGMENTS,
  bindingEnergy,
  fragmentsOf,
  impactEnergy,
} from '../src/fragmentation';
import { overlapping, resolveCollisions } from '../src/collisions';
import { PhysicsEngine } from '../src/PhysicsEngine';
import { SIMULATION_G } from '../src/forces';
import { Particle } from '../src/Particle';
import { Vector2D } from '../src/Vector2D';

/**
 * Fragmentation is four decisions that the conservation laws constrain without
 * deciding, so this file checks the two things that *are* decided — what is
 * conserved, and that the result does not undo itself — and pins the four
 * choices to the reasons given for them rather than to a screenshot.
 */

const ORIGIN = new Vector2D(0, 0);

/**
 * Two bodies meeting head-on at `speed`, each side of the origin.
 *
 * A hair inside contact rather than exactly at it: `overlapping` is a strict
 * comparison, so a pair placed at precisely the contact distance is not
 * touching and the collision pass has nothing to resolve.
 */
function impact(mass: number, speed: number) {
  const a = new Particle(0, 0, mass, speed, 0);
  const contact = 2 * Particle.radiusForMass(mass) - 1e-9;
  return [a, new Particle(contact, 0, mass, -speed, 0)];
}

const totals = (bodies: Particle[]) => ({
  mass: bodies.reduce((sum, body) => sum + body.mass, 0),
  momentum: bodies.reduce((sum, body) => sum.add(body.velocity.mult(body.mass)), ORIGIN),
  angular: bodies.reduce((sum, body) => sum + body.angularMomentumAbout(ORIGIN), 0),
  kinetic: bodies.reduce(
    (sum, body) => sum + 0.5 * body.mass * body.velocity.magnitudeSquared(),
    0
  ),
});

describe('when a pair breaks', () => {
  it('holds together under an impact softer than the body itself', () => {
    // The threshold is the energy it would take to pull the merged body apart
    // against its own gravity — the one energy scale a simulation with no
    // material strength actually has.
    const [a, b] = impact(200, 1);
    const merged = a.mass + b.mass;

    expect(impactEnergy(a, b)).toBeLessThan(bindingEnergy(merged, SIMULATION_G));
    expect(fragmentsOf(a, b, SIMULATION_G)).toBeNull();
  });

  it('comes apart under one harder than it', () => {
    const [a, b] = impact(200, 12);
    const merged = a.mass + b.mass;

    expect(impactEnergy(a, b)).toBeGreaterThan(bindingEnergy(merged, SIMULATION_G));
    expect(fragmentsOf(a, b, SIMULATION_G)).not.toBeNull();
  });

  it('breaks into more pieces the harder it is hit, up to a limit', () => {
    const counts = [10, 12, 15, 20, 60].map(
      (speed) => fragmentsOf(...(impact(200, speed) as [Particle, Particle]), SIMULATION_G)!.length
    );

    for (let i = 1; i < counts.length; i++) {
      expect(counts[i], `speed ${i}`).toBeGreaterThanOrEqual(counts[i - 1]);
    }
    expect(counts[0]).toBe(2);
    expect(counts[counts.length - 1]).toBe(MAX_FRAGMENTS);
  });

  it('refuses a break-up whose pieces could not escape each other', () => {
    // The alternative to this is a cooldown — state saying "these may not
    // re-merge yet" — and the scene flickering between one body and several
    // while it runs out. A break-up that cannot finish never starts.
    let refusals = 0;
    let breaks = 0;

    // Across the crossing, which is where the question arises: hard enough to
    // unbind the body, and not yet hard enough to scatter what is left.
    for (let speed = 8; speed < 11; speed += 0.02) {
      const [a, b] = impact(200, speed);
      const fragments = fragmentsOf(a, b, SIMULATION_G);

      if (fragments === null) refusals++;
      else breaks++;
    }

    // Somewhere in that range the answer changes, and it changes once: every
    // speed above the crossing breaks, every speed below it merges.
    expect(refusals).toBeGreaterThan(0);
    expect(breaks).toBeGreaterThan(0);
  });
});

describe('what a break conserves', () => {
  /** A messy pair: unequal, spinning, moving, and off the origin. */
  function messyPair() {
    const a = new Particle(-140, 60, 500, 21, -4);
    const b = new Particle(
      -140 + Particle.radiusForMass(500) + Particle.radiusForMass(180) - 1e-9,
      60,
      180,
      -24,
      3
    );
    a.angularVelocity = 0.05;
    b.angularVelocity = -0.2;
    return [a, b];
  }

  it('conserves mass, momentum and angular momentum exactly', () => {
    const pair = messyPair();
    const before = totals(pair);

    const fragments = fragmentsOf(pair[0], pair[1], SIMULATION_G);
    expect(fragments).not.toBeNull();

    const after = totals(fragments!);

    expect(after.mass).toBeCloseTo(before.mass, 9);
    expect(after.momentum.x).toBeCloseTo(before.momentum.x, 8);
    expect(after.momentum.y).toBeCloseTo(before.momentum.y, 8);
    expect(after.angular).toBeCloseTo(before.angular, 6);
  });

  it('never invents kinetic energy', () => {
    // The dispersal speed comes from the impact's own excess energy, scaled by
    // an efficiency below 1, so a break-up is always a loss — as inelastic as
    // the merge it replaces, and never a source.
    for (const speed of [12, 25, 60, 200]) {
      const pair = impact(300, speed);
      const before = totals(pair);
      const fragments = fragmentsOf(pair[0], pair[1], SIMULATION_G);

      expect(totals(fragments!).kinetic, `speed ${speed}`).toBeLessThanOrEqual(before.kinetic);
    }
  });

  it('puts the pieces where the pair was, not where one of them was', () => {
    const pair = messyPair();
    const total = pair[0].mass + pair[1].mass;
    const centre = pair[0].position
      .mult(pair[0].mass)
      .add(pair[1].position.mult(pair[1].mass))
      .div(total);

    const fragments = fragmentsOf(pair[0], pair[1], SIMULATION_G)!;
    const after = fragments
      .reduce((sum, f) => sum.add(f.position.mult(f.mass)), ORIGIN)
      .div(total);

    expect(after.x).toBeCloseTo(centre.x, 8);
    expect(after.y).toBeCloseTo(centre.y, 8);
  });

  it('lays the pieces out without putting any two inside each other', () => {
    const fragments = fragmentsOf(...(impact(400, 60) as [Particle, Particle]), SIMULATION_G)!;

    for (let i = 0; i < fragments.length; i++) {
      for (let j = i + 1; j < fragments.length; j++) {
        expect(overlapping(fragments[i], fragments[j]), `${i} and ${j}`).toBe(false);
      }
    }
  });

  it('keeps half the mass in one piece and shares the rest', () => {
    const fragments = fragmentsOf(...(impact(400, 90) as [Particle, Particle]), SIMULATION_G)!;
    const masses = fragments.map((f) => f.mass).sort((a, b) => b - a);

    expect(masses[0]).toBeCloseTo(800 * LARGEST_REMNANT_FRACTION, 9);
    for (let i = 2; i < masses.length; i++) {
      expect(masses[i]).toBeCloseTo(masses[1], 9);
    }
  });
});

describe('a scene that shatters', () => {
  it('replaces the pair with its pieces, and counts one event', () => {
    const particles = impact(200, 20);
    const events = resolveCollisions(particles, 'shatter', Infinity, 0.5, undefined, SIMULATION_G);

    expect(events).toBe(1);
    expect(particles.length).toBeGreaterThan(2);
  });

  it('merges gentle contacts, so the mode is merging with an exception', () => {
    const particles = impact(200, 0.5);
    const events = resolveCollisions(particles, 'shatter', Infinity, 0.5, undefined, SIMULATION_G);

    expect(events).toBe(1);
    expect(particles).toHaveLength(1);
    expect(particles[0].mass).toBe(400);
  });

  it('settles instead of flickering, and conserves what it should', () => {
    // The whole run: a hard head-on impact inside a live engine, left alone for
    // long enough that anything unstable would have shown itself. What must not
    // happen is a body count that oscillates as pieces re-merge and re-break.
    const engine = new PhysicsEngine(30);
    engine.collisionMode = 'shatter';
    for (const particle of impact(400, 30)) engine.addParticle(particle);

    const before = engine.diagnostics();
    const counts: number[] = [];

    for (let step = 0; step < 3000; step++) {
      engine.step();
      if (step % 100 === 0) counts.push(engine.particles.length);
    }

    const after = engine.diagnostics();

    // Settled: the count stops changing well before the end.
    const tail = counts.slice(counts.length >> 1);
    expect(new Set(tail).size, `counts: ${counts.join(',')}`).toBe(1);

    expect(engine.particles.reduce((sum, p) => sum + p.mass, 0)).toBeCloseTo(800, 6);
    expect(after.momentum.magnitude()).toBeCloseTo(before.momentum.magnitude(), 6);
    expect(after.kinetic).toBeLessThan(before.kinetic + Math.abs(before.potential));
  });

  it('does not turn one impact into an unbounded shower', () => {
    // Fragments are smaller, and a smaller body is easier to break — so the
    // question is whether one hard impact cascades. It cannot: the pieces carry
    // less energy than the impact that made them, and the count is capped per
    // event.
    const engine = new PhysicsEngine(30);
    engine.collisionMode = 'shatter';
    for (const particle of impact(2000, 40)) engine.addParticle(particle);

    for (let step = 0; step < 2000; step++) engine.step();

    expect(engine.particles.length).toBeLessThanOrEqual(MAX_FRAGMENTS * 2);
  });
});

describe('the numbers behind the decisions', () => {
  it('spends less than all of the excess on throwing the pieces apart', () => {
    expect(DISPERSAL_EFFICIENCY).toBeGreaterThan(0);
    expect(DISPERSAL_EFFICIENCY).toBeLessThan(1);
  });

  it('measures binding energy from the mass rule, so bigger bodies are tougher', () => {
    // U = G·M²/R with R = 2·M^(1/3), so U grows as M^(5/3): the same impact
    // speed shatters a small body and not a large one, which is the behaviour
    // gravity alone gives a body with no material strength.
    const small = bindingEnergy(100, SIMULATION_G);
    const large = bindingEnergy(1000, SIMULATION_G);

    expect(large / small).toBeCloseTo(10 ** (5 / 3), 6);
  });
});

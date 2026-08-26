import { describe, it, expect } from 'vitest';
import {
  CONTACT_SLOP,
  RESTITUTION,
  overlapping,
  resolveCollisions,
  resolveContact,
  sweptContactTime,
} from '../src/collisions';
import { PhysicsEngine } from '../src/PhysicsEngine';
import { Particle } from '../src/Particle';
import { Vector2D } from '../src/Vector2D';

/**
 * A collision is where conservation laws are easiest to break by accident, so
 * they are what these tests check: mass and momentum come out of a merge
 * exactly as they went in, and a bounce conserves momentum while deliberately
 * losing energy. Everything else — where the merged body sits, how big it is,
 * which one survives — follows from those.
 */

const momentum = (particles: Particle[]) =>
  particles.reduce(
    (sum, p) => new Vector2D(sum.x + p.velocity.x * p.mass, sum.y + p.velocity.y * p.mass),
    new Vector2D(0, 0)
  );

const totalMass = (particles: Particle[]) => particles.reduce((sum, p) => sum + p.mass, 0);

const kineticEnergy = (particles: Particle[]) =>
  particles.reduce((sum, p) => sum + 0.5 * p.mass * p.velocity.magnitudeSquared(), 0);

/** Two bodies overlapping by construction, with whatever velocities are given. */
function touchingPair(massA: number, massB: number, velocityA: Vector2D, velocityB: Vector2D) {
  const a = new Particle(0, 0, massA, velocityA.x, velocityA.y);
  const b = new Particle(a.radius, 0, massB, velocityB.x, velocityB.y);
  return [a, b];
}

/**
 * Two bodies exactly at contact distance — touching, not overlapping.
 *
 * The distinction matters to every test about the *bounce*: an overlapping pair
 * also gets the separating bias, which is a second impulse on top of the one
 * being measured. `touchingPair` above puts them half inside each other, which
 * is right for testing a merge and wrong for testing restitution.
 */
function justTouchingPair(
  massA: number,
  massB: number,
  velocityA: Vector2D,
  velocityB: Vector2D
) {
  const a = new Particle(0, 0, massA, velocityA.x, velocityA.y);
  const contact = a.radius + Particle.radiusForMass(massB);

  // A hair inside contact distance, not exactly on it: `overlapping` asks for a
  // strict inequality, so a pair placed exactly at contact is not in contact at
  // all and nothing would happen. A nanometre is far below the slop, so the
  // separating bias stays zero and the bounce is all that is measured.
  return [a, new Particle(contact - 1e-9, 0, massB, velocityB.x, velocityB.y)];
}

describe('contact detection', () => {
  it('starts exactly where the force law softens', () => {
    // The softening floor in forces.ts is the sum of the two radii. Contact is
    // defined at the same distance on purpose: past it the force stops growing
    // because the bodies are inside each other.
    const a = new Particle(0, 0, 1000);
    const contact = a.radius + new Particle(0, 0, 1000).radius;

    expect(overlapping(a, new Particle(contact - 0.01, 0, 1000))).toBe(true);
    expect(overlapping(a, new Particle(contact + 0.01, 0, 1000))).toBe(false);
  });
});

describe('merging', () => {
  it('conserves mass and momentum exactly', () => {
    const particles = touchingPair(300, 100, new Vector2D(2, -1), new Vector2D(-3, 4));
    const massBefore = totalMass(particles);
    const momentumBefore = momentum(particles);

    const events = resolveCollisions(particles, 'merge');

    expect(events).toBe(1);
    expect(particles).toHaveLength(1);
    expect(totalMass(particles)).toBeCloseTo(massBefore, 10);
    expect(momentum(particles).x).toBeCloseTo(momentumBefore.x, 10);
    expect(momentum(particles).y).toBeCloseTo(momentumBefore.y, 10);
  });

  it('loses kinetic energy, because a merge is perfectly inelastic', () => {
    const particles = touchingPair(100, 100, new Vector2D(5, 0), new Vector2D(-5, 0));
    const before = kineticEnergy(particles);

    resolveCollisions(particles, 'merge');

    // Equal and opposite: everything cancels and the merged body sits still.
    expect(kineticEnergy(particles)).toBeCloseTo(0, 10);
    expect(before).toBeGreaterThan(0);
  });

  it('places the merged body at the centre of mass', () => {
    const a = new Particle(0, 0, 300);
    const b = new Particle(a.radius, 0, 100);
    const particles = [a, b];
    const expected = (0 * 300 + a.radius * 100) / 400;

    resolveCollisions(particles, 'merge');

    expect(particles[0].position.x).toBeCloseTo(expected, 10);
    expect(particles[0].position.y).toBeCloseTo(0, 10);
  });

  it('sizes the merged body from its new mass, like every other body', () => {
    const particles = touchingPair(300, 100, new Vector2D(0, 0), new Vector2D(0, 0));

    resolveCollisions(particles, 'merge');

    expect(particles[0].mass).toBe(400);
    expect(particles[0].radius).toBeCloseTo(Particle.radiusForMass(400), 10);
    expect(particles[0].radius).toBeCloseTo(new Particle(0, 0, 400).radius, 10);
  });

  it('keeps the heavier body, so its trail carries through the collision', () => {
    const heavy = new Particle(0, 0, 500);
    const light = new Particle(heavy.radius, 0, 10);
    heavy.recordTrail();
    heavy.recordTrail();

    // Lighter one first in the list, to prove survival is decided by mass
    // rather than by position in the array.
    const particles = [light, heavy];
    resolveCollisions(particles, 'merge');

    expect(particles[0]).toBe(heavy);
    expect(particles[0].trail).toHaveLength(2);
  });

  it('collapses a chain of contacts into one body', () => {
    // Each pair touches; the merged body is bigger than either part, so it can
    // reach a third body that neither of them reached.
    const a = new Particle(0, 0, 200);
    const b = new Particle(a.radius, 0, 200);
    const c = new Particle(a.radius * 2, 0, 200);
    const particles = [a, b, c];
    const massBefore = totalMass(particles);

    const events = resolveCollisions(particles, 'merge');

    expect(particles).toHaveLength(1);
    expect(events).toBe(2);
    expect(particles[0].mass).toBeCloseTo(massBefore, 10);
  });

  it('survives two bodies at exactly the same point', () => {
    // Easy to produce by clicking one body on top of another; a zero-length
    // separation has no direction, and a NaN here would poison every later step.
    const particles = [new Particle(50, 50, 100), new Particle(50, 50, 100)];

    resolveCollisions(particles, 'merge');

    expect(particles).toHaveLength(1);
    expect(Number.isFinite(particles[0].position.x)).toBe(true);
    expect(Number.isFinite(particles[0].velocity.magnitude())).toBe(true);
  });

  it('leaves bodies that are not touching alone', () => {
    const a = new Particle(0, 0, 100);
    const particles = [a, new Particle(a.radius * 2 + 1, 0, 100)];

    expect(resolveCollisions(particles, 'merge')).toBe(0);
    expect(particles).toHaveLength(2);
  });
});

describe('bouncing', () => {
  it('conserves momentum but not kinetic energy', () => {
    const particles = justTouchingPair(200, 100, new Vector2D(4, 0), new Vector2D(-4, 0));
    const momentumBefore = momentum(particles);
    const energyBefore = kineticEnergy(particles);

    const events = resolveCollisions(particles, 'bounce');

    expect(events).toBe(1);
    expect(particles).toHaveLength(2);
    expect(momentum(particles).x).toBeCloseTo(momentumBefore.x, 10);
    expect(momentum(particles).y).toBeCloseTo(momentumBefore.y, 10);
    expect(kineticEnergy(particles)).toBeLessThan(energyBefore);
  });

  it('reverses the approach at the restitution coefficient', () => {
    const particles = justTouchingPair(100, 100, new Vector2D(4, 0), new Vector2D(-4, 0));
    const approachBefore = particles[1].velocity.sub(particles[0].velocity).magnitude();

    resolveCollisions(particles, 'bounce');

    const separation = particles[1].velocity.sub(particles[0].velocity).magnitude();
    expect(separation).toBeCloseTo(approachBefore * RESTITUTION, 10);
  });

  it('pushes the pair apart, to all but a sliver of contact', () => {
    // Without the separation the two stay inside each other, collide again next
    // step, and jitter indefinitely. The sliver that is left is the slop, and
    // it is what stops a *resting* contact correcting forever: gravity presses
    // the pair together by a hair each step, and a separation that insisted on
    // exact contact would answer every single one — each answer handing a
    // little more angular momentum to the pair's spin.
    const particles = touchingPair(200, 100, new Vector2D(4, 0), new Vector2D(-4, 0));
    const overlapBefore =
      particles[0].radius +
      particles[1].radius -
      particles[1].position.sub(particles[0].position).magnitude();

    resolveCollisions(particles, 'bounce');

    const overlapAfter =
      particles[0].radius +
      particles[1].radius -
      particles[1].position.sub(particles[0].position).magnitude();

    expect(overlapBefore).toBeGreaterThan(1);
    expect(overlapAfter).toBeCloseTo(CONTACT_SLOP, 10);
  });

  it('leaves a resting pair alone rather than arguing with gravity', () => {
    const engine = new PhysicsEngine(30);
    engine.collisionMode = 'bounce';
    const a = new Particle(0, 0, 200);
    engine.addParticle(a);
    engine.addParticle(new Particle(a.radius * 2, 0, 200));

    for (let i = 0; i < 400; i++) engine.step();

    const speed = engine.particles.map((p) => p.velocity.magnitude());
    expect(Math.max(...speed)).toBeLessThan(0.5);
    for (const particle of engine.particles) {
      expect(Number.isFinite(particle.position.x)).toBe(true);
    }
  });

  it('settles a pile dropped inside itself instead of firing it off screen', () => {
    // Five heavy bodies placed 43 units interpenetrated, which is what a
    // handful of clicks in the same spot produces. Separating them with the
    // textbook bias impulse instead of by moving them turned that standing
    // start into 5.8 million units of kinetic energy and a spread of 63,513
    // world units: the impulse is energy from nowhere, and gravity keeps the
    // contact alive to collect it on every sub-step.
    const engine = new PhysicsEngine(30);
    engine.collisionMode = 'bounce';
    for (const [x, y] of [
      [0, 0],
      [14, 6],
      [-6, 14],
      [8, -12],
      [-14, -4],
    ]) {
      engine.addParticle(new Particle(x, y, 3000));
    }

    for (let i = 0; i < 2000; i++) engine.step();

    const spread = Math.max(...engine.particles.map((p) => p.position.magnitude()));
    const energy = kineticEnergy(engine.particles);

    // They are heavy and touching, so they stay a huddle: nothing is thrown.
    expect(spread).toBeLessThan(200);
    expect(energy).toBeLessThan(20000);
    for (const particle of engine.particles) {
      expect(Number.isFinite(particle.position.x)).toBe(true);
    }
  });

  it('does not hit a pair that is touching and already separating', () => {
    // Nothing left to do: they are not overlapping, and they are on their way
    // out. Another impulse would add energy rather than remove it.
    const particles = justTouchingPair(100, 100, new Vector2D(-2, 0), new Vector2D(2, 0));
    const energyBefore = kineticEnergy(particles);

    const events = resolveCollisions(particles, 'bounce');

    expect(events).toBe(0);
    expect(kineticEnergy(particles)).toBeCloseTo(energyBefore, 10);
  });

  it('still separates a pair that is buried but drifting apart', () => {
    // Sinking slowly out of another body is still being inside it. The bounce
    // has nothing to say about a pair already moving apart; the overlap does.
    const particles = touchingPair(100, 100, new Vector2D(-0.01, 0), new Vector2D(0.01, 0));
    const before = particles[1].position.sub(particles[0].position).magnitude();

    const events = resolveCollisions(particles, 'bounce');

    expect(events).toBe(0);
    expect(particles[1].position.sub(particles[0].position).magnitude()).toBeGreaterThan(before);
  });

  it('settles rather than ringing, over repeated contacts', () => {
    const engine = new PhysicsEngine(30);
    engine.collisionMode = 'bounce';
    engine.addParticle(new Particle(-40, 0, 200, 1.5, 0));
    engine.addParticle(new Particle(40, 0, 200, -1.5, 0));

    const before = kineticEnergy(engine.particles);
    for (let i = 0; i < 400; i++) engine.step();

    expect(engine.particles).toHaveLength(2);
    expect(kineticEnergy(engine.particles)).toBeLessThan(before);
    for (const particle of engine.particles) {
      expect(Number.isFinite(particle.position.x)).toBe(true);
    }
  });
});

describe('passing through', () => {
  it('does nothing at all, which is what the simulation used to do', () => {
    const particles = touchingPair(100, 100, new Vector2D(5, 0), new Vector2D(-5, 0));

    expect(resolveCollisions(particles, 'none')).toBe(0);
    expect(particles).toHaveLength(2);
    expect(overlapping(particles[0], particles[1])).toBe(true);
  });
});

describe('collisions inside the engine', () => {
  it('merges bodies that are dropped on top of each other', () => {
    const engine = new PhysicsEngine(30);
    engine.addParticle(new Particle(0, 0, 500));
    engine.addParticle(new Particle(4, 0, 500));

    engine.step();

    expect(engine.particles).toHaveLength(1);
    expect(engine.particles[0].mass).toBe(1000);
    expect(engine.collisionCount).toBe(1);
  });

  it('leaves accelerations current after a step that merged', () => {
    // The integrator contract: on entry to a step every acceleration is the one
    // at the body's current position. A merge changes both the membership of
    // the list and the masses in it, so the engine has to restore that before
    // returning — and the renderer reads netForce immediately afterwards.
    const engine = new PhysicsEngine(30);
    engine.addParticle(new Particle(0, 0, 500));
    engine.addParticle(new Particle(4, 0, 500));
    engine.addParticle(new Particle(400, 0, 100, 0, 1));

    engine.step();

    expect(engine.particles).toHaveLength(2);
    const expected = engine.accelerationsAt(engine.particles.map((p) => p.position));
    engine.particles.forEach((particle, index) => {
      expect(particle.acceleration.x).toBeCloseTo(expected[index].x, 12);
      expect(particle.acceleration.y).toBeCloseTo(expected[index].y, 12);
      expect(particle.netForce.magnitude()).toBeGreaterThan(0);
    });
  });

  it('conserves total momentum across a merge in flight', () => {
    const engine = new PhysicsEngine(30);
    engine.addParticle(new Particle(-150, 0, 400, 1.2, 0.3));
    engine.addParticle(new Particle(150, 0, 400, -1.2, 0.3));
    engine.addParticle(new Particle(0, 600, 100, 0, -0.6));

    const before = momentum(engine.particles);
    const massBefore = totalMass(engine.particles);

    for (let i = 0; i < 400; i++) engine.step();

    expect(engine.particles.length).toBeLessThan(3);
    expect(totalMass(engine.particles)).toBeCloseTo(massBefore, 8);
    expect(momentum(engine.particles).x).toBeCloseTo(before.x, 6);
    expect(momentum(engine.particles).y).toBeCloseTo(before.y, 6);
  });

  it('catches a fast head-on pass at any speed, sub-stepping or not', () => {
    // This used to be a demonstration of tunnelling. Contact was a test on
    // overlap, so a body crossing the whole contact window inside one step was
    // never seen to touch anything: at 160 units per frame against a 23-unit
    // target, a fixed step went straight through and only adaptive sub-stepping
    // caught it.
    //
    // Contact is now swept along the path each body travelled (roadmap M6), so
    // the speed stops mattering.
    const passes = (speed: number, adaptive: boolean) => {
      const engine = new PhysicsEngine(30);
      engine.adaptiveStepping = adaptive;
      engine.addParticle(new Particle(0, 0, 500, 0, 0));
      engine.addParticle(new Particle(-400, 0, 50, speed, 0));

      for (let i = 0; i < 60; i++) engine.step();
      return engine.particles.length;
    };

    // 20,000 units a frame is a body crossing the whole visible region between
    // one frame and the next.
    for (const speed of [160, 1000, 20000]) {
      expect(passes(speed, false), `${speed} units per frame, fixed step`).toBe(1);
      expect(passes(speed, true), `${speed} units per frame, sub-stepped`).toBe(1);
    }
  });

  it('can be turned off, and then bodies pass through as before', () => {
    const engine = new PhysicsEngine(30);
    engine.collisionMode = 'none';
    engine.addParticle(new Particle(-60, 0, 500, 2, 0));
    engine.addParticle(new Particle(60, 0, 500, -2, 0));

    for (let i = 0; i < 400; i++) engine.step();

    expect(engine.particles).toHaveLength(2);
    expect(engine.collisionCount).toBe(0);
  });

  it('defaults to merging', () => {
    expect(new PhysicsEngine(30).collisionMode).toBe('merge');
  });

  it('can resolve contacts without advancing time', () => {
    // Exposed separately from step() so contacts can be settled without
    // integrating. The UI deliberately does not call it while paused - paused
    // means nothing moves - but a caller that wants to settle a configuration
    // it has just built should not have to run the clock to do it.
    const engine = new PhysicsEngine(30);
    engine.addParticle(new Particle(0, 0, 500));
    engine.addParticle(new Particle(4, 0, 500));

    expect(engine.resolveCollisions()).toBe(1);
    expect(engine.particles).toHaveLength(1);
  });
});

describe('when the contact happened', () => {
  const at = (x: number, y: number) => new Vector2D(x, y);

  it('solves for the moment two bodies meet', () => {
    // A pair closing head-on: contact distance is the sum of the radii, so the
    // time of impact is a number that can be worked out by hand.
    const a = new Particle(0, 0, 100);
    const b = new Particle(0, 0, 100);
    const contact = a.radius + b.radius;

    // b starts four contact-distances away and ends the step on top of a, so
    // the gap closes from 4c to 0 at a constant rate. It passes through c —
    // the moment they touch — three quarters of the way along.
    a.position = at(0, 0);
    b.position = at(0, 0);
    const time = sweptContactTime(a, at(0, 0), b, at(4 * contact, 0));

    expect(time).toBeCloseTo(0.75, 6);
  });

  it('says nothing happened when the pair never meet', () => {
    const a = new Particle(0, 0, 100);
    const b = new Particle(500, 500, 100);

    expect(sweptContactTime(a, at(0, 0), b, at(500, 500))).toBeNull();
  });

  it('says nothing happened when they are moving apart', () => {
    const a = new Particle(0, 0, 100);
    const b = new Particle(300, 0, 100);

    expect(sweptContactTime(a, at(0, 0), b, at(100, 0))).toBeNull();
  });

  it('reports zero when they were already touching', () => {
    const a = new Particle(0, 0, 100);
    const b = new Particle(a.radius, 0, 100);

    expect(sweptContactTime(a, at(0, 0), b, at(a.radius, 0))).toBe(0);
  });

  it('catches a pass that crosses the window entirely', () => {
    // The tunnelling case, as a single step: b starts far to the right, ends
    // far to the left, and passes through a on the way.
    const a = new Particle(0, 0, 100);
    const b = new Particle(-4000, 0, 100);

    const time = sweptContactTime(a, at(0, 0), b, at(4000, 0));
    expect(time).not.toBeNull();
    expect(time!).toBeGreaterThan(0);
    expect(time!).toBeLessThan(1);
  });
});

describe('spin', () => {
  /**
   * Two equal bodies exactly touching, with `b` moving at `a` along -x.
   *
   * `bearing` is where b sits relative to a: zero is head-on through both
   * centres, anything else puts the contact normal at an angle to the motion
   * and so gives the impact something to twist.
   *
   * Exactly touching matters: the positional correction only runs on an
   * overlap, and it is the one part of a contact that is a fix-up rather than
   * physics. Starting them in contact keeps these tests about the impulse.
   */
  function glancingPair(bearing: number) {
    const a = new Particle(0, 0, 200, 0, 0);
    const contact = a.radius + Particle.radiusForMass(200);
    return [
      a,
      new Particle(Math.cos(bearing) * contact, Math.sin(bearing) * contact, 200, -4, 0),
    ];
  }

  it('imparts none on a head-on hit through both centres', () => {
    const [a, b] = glancingPair(0);
    resolveContact(a, b, 0.5);

    expect(a.angularVelocity).toBeCloseTo(0, 12);
    expect(b.angularVelocity).toBeCloseTo(0, 12);
  });

  it('imparts spin on an off-centre hit', () => {
    // Friction at the contact point is what does it: without a tangential
    // impulse the two would scrape past without either starting to turn.
    const [a, b] = glancingPair(Math.PI / 6);
    resolveContact(a, b, 0.5);

    expect(Math.abs(a.angularVelocity)).toBeGreaterThan(0);
    expect(Math.abs(b.angularVelocity)).toBeGreaterThan(0);
  });

  it('conserves angular momentum through a bounce', () => {
    const [a, b] = glancingPair(Math.PI / 6);
    const origin = new Vector2D(0, 0);
    const before = a.angularMomentumAbout(origin) + b.angularMomentumAbout(origin);

    resolveContact(a, b, 0.5);

    const after = a.angularMomentumAbout(origin) + b.angularMomentumAbout(origin);
    expect(after).toBeCloseTo(before, 8);
  });

  it('conserves it through a contact that has to separate an overlap too', () => {
    // This is what the separation change bought. The pair starts half inside
    // each other, so the contact does two jobs at once: an impulse at the
    // shared contact point, which conserves the total by construction, and a
    // move to get them apart, which does not — the move's `Σ m (Δ × v)` is
    // handed to the pair's spin instead of being dropped. Before that, this
    // test could not be written: it had to start the pair exactly touching so
    // that the separation never ran.
    const a = new Particle(0, 0, 200, 1, 2);
    const b = new Particle(a.radius * 0.7, a.radius * 0.7, 300, -3, 1);
    a.angularVelocity = 0.4;
    b.angularVelocity = -0.1;

    const origin = new Vector2D(0, 0);
    const angularBefore = a.angularMomentumAbout(origin) + b.angularMomentumAbout(origin);
    const linearBefore = momentum([a, b]);

    expect(overlapping(a, b)).toBe(true);
    resolveContact(a, b, 0.5);

    expect(a.angularMomentumAbout(origin) + b.angularMomentumAbout(origin)).toBeCloseTo(
      angularBefore,
      8
    );
    expect(momentum([a, b]).x).toBeCloseTo(linearBefore.x, 8);
    expect(momentum([a, b]).y).toBeCloseTo(linearBefore.y, 8);
  });

  it('conserves it through a swept contact, where the rewind moves them too', () => {
    // The rewind puts a pair back where they first touched, which is a move
    // backwards along the step each body took — not along the velocity it is
    // carrying now, because gravity changed that during the step. So it costs
    // angular momentum exactly as the separation does, and pays it back the
    // same way. Compensating only the separation and leaving this alone was
    // measurably *worse* than compensating neither: -139% against -26% over
    // 1,500 steps of a jostling pile.
    const a = new Particle(0, 0, 200, 0, 0);
    const b = new Particle(3, 4, 300, -6, -8);
    a.angularVelocity = 0.2;
    const previous = [new Vector2D(0, 0), new Vector2D(30, 40)];

    const origin = new Vector2D(0, 0);
    const before = a.angularMomentumAbout(origin) + b.angularMomentumAbout(origin);

    resolveCollisions([a, b], 'bounce', Infinity, 0.5, previous);

    expect(a.angularMomentumAbout(origin) + b.angularMomentumAbout(origin)).toBeCloseTo(before, 6);
  });

  it('conserves linear momentum through a bounce, spin and all', () => {
    const [a, b] = glancingPair(Math.PI / 6);
    const before = momentum([a, b]);

    resolveContact(a, b, 0.5);

    const after = momentum([a, b]);
    expect(after.x).toBeCloseTo(before.x, 8);
    expect(after.y).toBeCloseTo(before.y, 8);
  });

  it('conserves angular momentum through a merge', () => {
    // Two bodies passing each other carry angular momentum about their common
    // centre even with no spin of their own; the merged body has to carry it
    // as spin, or a merge would quietly destroy it.
    const a = new Particle(-10, 0, 200, 0, 2);
    const b = new Particle(10, 0, 200, 0, -2);
    a.angularVelocity = 0.05;

    const centre = new Vector2D(0, 0);
    const before = a.angularMomentumAbout(centre) + b.angularMomentumAbout(centre);

    a.absorb(b);

    expect(a.angularMomentumAbout(centre)).toBeCloseTo(before, 8);
    expect(Math.abs(a.angularVelocity)).toBeGreaterThan(0);
  });

  it('turns a body it has set spinning', () => {
    const engine = new PhysicsEngine(30);
    const particle = new Particle(0, 0, 200);
    particle.angularVelocity = 0.1;
    engine.addParticle(particle);

    engine.step();
    expect(particle.angle).toBeCloseTo(0.1, 9);
  });

  it('leaves bodies alone that nothing has touched', () => {
    // Gravity applies no torque to a point mass, so an orbit must not
    // spontaneously start spinning.
    const engine = new PhysicsEngine(30);
    engine.addParticle(new Particle(0, 0, 5000));
    engine.addParticle(new Particle(200, 0, 10, 0, 3.54));

    for (let i = 0; i < 200; i++) engine.step();

    for (const particle of engine.particles) {
      expect(particle.angularVelocity).toBe(0);
      expect(particle.angle).toBe(0);
    }
  });
});

describe('restitution as a setting', () => {
  it('scales the bounce, from dead stop to nearly elastic', () => {
    const rebound = (restitution: number) => {
      const a = new Particle(0, 0, 200, 2, 0);
      const b = new Particle(a.radius * 2, 0, 200, -2, 0);
      resolveContact(a, b, restitution);
      return b.velocity.sub(a.velocity).magnitude();
    };

    expect(rebound(0)).toBeCloseTo(0, 9);
    expect(rebound(0.5)).toBeCloseTo(2, 9);
    expect(rebound(1)).toBeCloseTo(4, 9);
  });

  it('is what the engine passes down', () => {
    // Compared against each other rather than against a fixed number: gravity
    // is trading potential and kinetic energy the whole time these run, so what
    // is meaningful is that the bouncier setting keeps more of it.
    const energyAfterBouncing = (restitution: number) => {
      const engine = new PhysicsEngine(30);
      engine.collisionMode = 'bounce';
      engine.restitution = restitution;

      engine.addParticle(new Particle(-30, 0, 200, 3, 0));
      engine.addParticle(new Particle(30, 0, 200, -3, 0));

      for (let i = 0; i < 60; i++) engine.step();
      return kineticEnergy(engine.particles);
    };

    expect(energyAfterBouncing(1)).toBeGreaterThan(energyAfterBouncing(0.5));
    expect(energyAfterBouncing(0.5)).toBeGreaterThan(energyAfterBouncing(0));
  });
});

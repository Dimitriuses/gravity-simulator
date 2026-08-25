import { describe, it, expect } from 'vitest';
import { PhysicsEngine } from '../src/PhysicsEngine';
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

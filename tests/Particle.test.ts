import { describe, it, expect } from 'vitest';
import { Particle } from '../src/Particle';
import { Vector2D } from '../src/Vector2D';

describe('Particle', () => {
  it('derives radius from mass by cube root', () => {
    // Radius scales as m^(1/3), so an 8x heavier body is only 2x wider.
    const light = new Particle(0, 0, 125);
    const heavy = new Particle(0, 0, 1000);
    expect(heavy.radius / light.radius).toBeCloseTo(2, 12);
  });

  it('converts force to acceleration by F = ma', () => {
    const p = new Particle(0, 0, 100);
    p.applyForce(new Vector2D(50, 0));
    expect(p.acceleration.x).toBeCloseTo(0.5, 12);
  });

  it('accumulates every applied force into netForce', () => {
    const p = new Particle(0, 0, 100);
    p.applyForce(new Vector2D(3, 0));
    p.applyForce(new Vector2D(0, 4));
    expect(p.netForce.magnitude()).toBeCloseTo(5, 12);
  });

  describe('attractionTo', () => {
    it('follows the inverse-square law', () => {
      const a = new Particle(0, 0, 100);
      const near = new Particle(100, 0, 100);
      const far = new Particle(200, 0, 100);

      const fNear = a.attractionTo(near, 1).magnitude();
      const fFar = a.attractionTo(far, 1).magnitude();

      // Doubling the distance quarters the force.
      expect(fNear / fFar).toBeCloseTo(4, 6);
    });

    it('scales with the product of the masses', () => {
      const a = new Particle(0, 0, 100);
      const light = new Particle(500, 0, 100);
      const heavy = new Particle(500, 0, 300);

      const ratio =
        a.attractionTo(heavy, 1).magnitude() / a.attractionTo(light, 1).magnitude();
      expect(ratio).toBeCloseTo(
        3,
        6
      );
    });

    it('points from the body towards the attractor', () => {
      const a = new Particle(0, 0, 100);
      const b = new Particle(100, 0, 100);
      const force = a.attractionTo(b, 1);
      expect(force.x).toBeGreaterThan(0);
      expect(force.y).toBeCloseTo(0, 12);
    });

    // Without softening, an unsoftened 1/r² at r -> 0 returns Infinity and the
    // body is flung out of the simulation in a single Euler step.
    it('softens at contact instead of diverging', () => {
      const a = new Particle(0, 0, 100);
      const overlapping = new Particle(0.0001, 0, 100);
      const force = a.attractionTo(overlapping, 1).magnitude();

      expect(Number.isFinite(force)).toBe(true);

      // Capped at exactly the surface-contact value: G·m1·m2 / (r1 + r2)².
      const contact = a.radius + overlapping.radius;
      expect(force).toBeCloseTo((1 * 100 * 100) / (contact * contact), 6);
    });
  });

  describe('trail', () => {
    // Integration itself lives in integrators.ts; a particle only records where
    // it has been.
    it('records a trail and caps its length', () => {
      const p = new Particle(0, 0, 10, 1, 0);

      for (let i = 0; i < p.maxTrailLength + 25; i++) {
        p.position = p.position.add(new Vector2D(1, 0));
        p.recordTrail();
      }

      expect(p.trail.length).toBe(p.maxTrailLength);
      // The cap drops the oldest points, so the newest position is last.
      expect(p.trail[p.trail.length - 1].position.x).toBeCloseTo(p.position.x, 12);
    });

    it('stores copies, so later movement does not rewrite history', () => {
      const p = new Particle(0, 0, 10);
      p.recordTrail();
      p.position = p.position.add(new Vector2D(50, 0));

      expect(p.trail[0].position.x).toBe(0);
    });
  });

  describe('trail continuity through a merge', () => {
    it('marks the point a merge teleported the body to', () => {
      // A merge moves the survivor to the pair's centre of mass. That is a real
      // discontinuity, and a trail drawn straight across it claims a path the
      // body never took — the kink visible in the README screenshots.
      const heavy = new Particle(0, 0, 500);
      const light = new Particle(heavy.radius, 0, 500);

      heavy.recordTrail();
      expect(heavy.trail[0].jumped).toBe(false);

      heavy.absorb(light);
      heavy.recordTrail();

      expect(heavy.trail[1].jumped).toBe(true);
      expect(heavy.trail[1].position.x).toBeCloseTo(heavy.position.x, 12);
    });

    it('marks only the point the jump landed on', () => {
      const heavy = new Particle(0, 0, 500);
      heavy.absorb(new Particle(heavy.radius, 0, 500));

      heavy.recordTrail();
      heavy.position = heavy.position.add(new Vector2D(5, 0));
      heavy.recordTrail();

      expect(heavy.trail[0].jumped).toBe(true);
      expect(heavy.trail[1].jumped).toBe(false);
    });
  });

  describe('resetForces', () => {
    it('clears accumulated force and acceleration', () => {
      const p = new Particle(0, 0, 100);
      p.applyForce(new Vector2D(10, 10));
      p.resetForces();

      expect(p.netForce.magnitude()).toBe(0);
      expect(p.acceleration.magnitude()).toBe(0);
    });

    // The renderer reads netForce after the step completes. Clearing it anywhere
    // other than the top of computeForces() leaves the arrows with nothing to
    // draw — see PhysicsEngine.test.ts.
    it('is not performed by recording a trail', () => {
      const p = new Particle(0, 0, 100);
      p.applyForce(new Vector2D(10, 0));
      p.recordTrail();

      expect(p.netForce.magnitude()).toBeGreaterThan(0);
    });
  });
});

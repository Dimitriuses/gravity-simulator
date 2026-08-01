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

      expect(a.attractionTo(heavy, 1).magnitude() / a.attractionTo(light, 1).magnitude()).toBeCloseTo(
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

  describe('integration', () => {
    it('applies acceleration to velocity and velocity to position', () => {
      const p = new Particle(0, 0, 10, 1, 0);
      p.applyForce(new Vector2D(10, 0)); // a = 1
      p.update(1);

      expect(p.velocity.x).toBeCloseTo(2, 12); // 1 + 1
      expect(p.position.x).toBeCloseTo(2, 12); // 0 + 2
    });

    it('records a trail and caps its length', () => {
      const p = new Particle(0, 0, 10, 1, 0);
      for (let i = 0; i < p.maxTrailLength + 25; i++) p.update(1);

      expect(p.trail.length).toBe(p.maxTrailLength);
      // The cap drops the oldest points, so the newest position is last.
      expect(p.trail[p.trail.length - 1].x).toBeCloseTo(p.position.x, 12);
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

    // The renderer reads netForce after the step completes. If update() also
    // cleared it, there would never be anything to draw — see
    // PhysicsEngine.test.ts.
    it('is not performed by update()', () => {
      const p = new Particle(0, 0, 100);
      p.applyForce(new Vector2D(10, 0));
      p.update(1);

      expect(p.netForce.magnitude()).toBeGreaterThan(0);
    });
  });
});

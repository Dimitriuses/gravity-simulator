import { Vector2D } from './Vector2D';
import { Particle } from './Particle';

/**
 * The force law, in one place.
 *
 * `Particle.attractionTo` and the integrators both need it, and the
 * higher-order integrators need it at positions the particles are not actually
 * at — RK4 evaluates the field at three trial configurations per step. Two
 * copies of a softened inverse-square law is two things to keep in step, so
 * there is one.
 */

/**
 * The gravitational constant, in simulation units.
 *
 * Not a measurement: 0.5 is the number that made the mass slider feel right.
 * `src/units.ts` is what turns it into real seconds when a scene needs to be
 * compared with the sky.
 *
 * It lives beside the force law rather than in `PhysicsEngine` — where it used
 * to be, and is still re-exported from for the callers that know it by that
 * name — because the contact solver needs it too, and importing it from the
 * engine made the engine and the collision pass import each other.
 */
export const SIMULATION_G = 0.5;

/**
 * Softened gravitational force on a body at `from` due to a body at `to`.
 *
 * F = G·m₁·m₂/r², with r² clamped to `contactDistance²`. Below contact the two
 * bodies are touching and an unsoftened 1/r² would launch them to infinity in a
 * single step; clamping caps the force at its surface value instead.
 */
export function gravitationalForce(
  from: Vector2D,
  to: Vector2D,
  mass: number,
  otherMass: number,
  contactDistance: number,
  G: number
): Vector2D {
  const direction = to.sub(from);
  const distanceSquared = direction.magnitudeSquared();
  const softened = Math.max(distanceSquared, contactDistance * contactDistance);

  return direction.normalize().mult((G * mass * otherMass) / softened);
}

/**
 * Gravitational potential at a point: the sum over every body of −G·m/r.
 *
 * Potential rather than force, because a contour needs a scalar: equipotential
 * lines are the level sets of this, and they show orbital structure — Lagrange
 * points, the Hill sphere — that an arrow grid only hints at.
 *
 * Softened the same way the field is, at the source body's own radius, so the
 * value stays finite inside a body instead of diving to negative infinity and
 * taking every contour level with it.
 */
export function gravitationalPotential(
  point: Vector2D,
  particles: Particle[],
  G: number
): number {
  let potential = 0;

  for (const particle of particles) {
    const distance = Math.max(particle.position.sub(point).magnitude(), particle.radius);
    potential -= (G * particle.mass) / distance;
  }

  return potential;
}

/**
 * Accelerations every particle would feel if the bodies sat at `positions`
 * instead of where they actually are.
 *
 * Pure: nothing on the particles is touched. `positions[i]` belongs to
 * `particles[i]`; masses and radii still come from the particles themselves,
 * because a trial configuration moves bodies without changing what they are.
 */
export function accelerationsAt(
  particles: Particle[],
  positions: Vector2D[],
  G: number
): Vector2D[] {
  const accelerations: Vector2D[] = particles.map(() => new Vector2D(0, 0));

  for (let i = 0; i < particles.length; i++) {
    for (let j = i + 1; j < particles.length; j++) {
      const force = gravitationalForce(
        positions[i],
        positions[j],
        particles[i].mass,
        particles[j].mass,
        particles[i].radius + particles[j].radius,
        G
      );

      // Newton's third law: one evaluation, two equal and opposite results.
      accelerations[i] = accelerations[i].add(force.div(particles[i].mass));
      accelerations[j] = accelerations[j].sub(force.div(particles[j].mass));
    }
  }

  return accelerations;
}

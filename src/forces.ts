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

import { Particle } from './Particle';
import { Vector2D } from './Vector2D';

/**
 * What happens when two bodies touch. Roadmap M2.
 *
 * Until this existed bodies passed straight through one another. The force law
 * softens at contact distance — it stops growing once the bodies overlap, which
 * keeps the simulation finite — but finite is not physical: two bodies aimed at
 * each other would interpenetrate, swing through and fly apart.
 *
 * Contact is defined at exactly the distance the force law softens at, the sum
 * of the two radii. That is not a coincidence worth breaking: the softened
 * regime is precisely the regime where the bodies are touching, so past this
 * point the simulation has nothing meaningful left to say about them.
 */

export type CollisionMode = 'merge' | 'bounce' | 'none';

/** Labels for the UI, in the order they should appear. */
export const COLLISION_MODE_LABELS: ReadonlyArray<{ id: CollisionMode; label: string }> = [
  { id: 'merge', label: 'Merge on contact' },
  { id: 'bounce', label: 'Bounce (inelastic)' },
  { id: 'none', label: 'Pass through' },
];

/**
 * Bounce restitution: the fraction of approach speed that survives an impact.
 *
 * 1 would be a perfectly elastic bounce, 0 a pair that hits and stops dead
 * relative to each other. Half is firmly inelastic — collisions visibly bleed
 * energy out of a system, which is the honest behaviour for lumps of rock and
 * is what keeps a bouncing pair from ringing forever.
 */
export const RESTITUTION = 0.5;

/** Are these two bodies touching? */
export function overlapping(a: Particle, b: Particle): boolean {
  const contact = a.radius + b.radius;
  return b.position.sub(a.position).magnitudeSquared() < contact * contact;
}

/**
 * The direction from `a` to `b`, and how deeply they interpenetrate.
 *
 * Two bodies at exactly the same point have no separating direction, which
 * happens easily enough when a body is placed on top of another. Picking a
 * fixed axis keeps the result deterministic — the alternative is a NaN normal
 * that propagates into every later step.
 */
function contactGeometry(a: Particle, b: Particle): { normal: Vector2D; overlap: number } {
  const offset = b.position.sub(a.position);
  const distance = offset.magnitude();
  const contact = a.radius + b.radius;

  if (distance === 0) {
    return { normal: new Vector2D(1, 0), overlap: contact };
  }

  return { normal: offset.div(distance), overlap: contact - distance };
}

/**
 * Merge every touching pair, in place.
 *
 * The heavier body absorbs the lighter one and keeps its identity, so the trail
 * on screen carries through the collision instead of restarting. Repeats until
 * nothing overlaps, because a merged body is larger than either of its parts
 * and can therefore reach a third body that neither of them touched.
 */
function mergeAll(particles: Particle[]): number {
  let merges = 0;

  // Bounded by the particle count: every pass removes one body.
  for (let guard = particles.length; guard > 0; guard--) {
    let found = false;

    for (let i = 0; i < particles.length && !found; i++) {
      for (let j = i + 1; j < particles.length && !found; j++) {
        if (!overlapping(particles[i], particles[j])) continue;

        const heavier = particles[i].mass >= particles[j].mass ? i : j;
        const lighter = heavier === i ? j : i;

        particles[heavier].absorb(particles[lighter]);
        particles.splice(lighter, 1);
        merges++;
        found = true;
      }
    }

    if (!found) break;
  }

  return merges;
}

/**
 * Bounce every touching pair once.
 *
 * An impulse along the contact normal, scaled by the reduced mass so momentum
 * comes out exactly conserved, followed by the positional correction that
 * separates the pair. Without that correction the two stay overlapped, collide
 * again on the next step, and jitter against each other forever.
 */
function bounceAll(particles: Particle[]): number {
  let impacts = 0;

  for (let i = 0; i < particles.length; i++) {
    for (let j = i + 1; j < particles.length; j++) {
      const a = particles[i];
      const b = particles[j];
      if (!overlapping(a, b)) continue;

      const { normal, overlap } = contactGeometry(a, b);
      const approachSpeed = b.velocity.sub(a.velocity).dot(normal);

      // Already separating: they are overlapped but on their way out, and
      // hitting them again would pump energy in rather than take it out.
      if (approachSpeed < 0) {
        const impulse =
          (-(1 + RESTITUTION) * approachSpeed) / (1 / a.mass + 1 / b.mass);

        a.velocity = a.velocity.sub(normal.mult(impulse / a.mass));
        b.velocity = b.velocity.add(normal.mult(impulse / b.mass));
        impacts++;
      }

      // Push them apart along the normal until they just touch, the heavier
      // body moving least.
      const total = a.mass + b.mass;
      a.position = a.position.sub(normal.mult((overlap * b.mass) / total));
      b.position = b.position.add(normal.mult((overlap * a.mass) / total));
    }
  }

  return impacts;
}

/**
 * Apply `mode` to every touching pair, mutating `particles` in place.
 *
 * Returns the number of collision events resolved. Callers must treat a
 * non-zero result as invalidating any cached accelerations: merging changes
 * both the membership of the list and the masses in it, and bouncing changes
 * positions.
 */
export function resolveCollisions(particles: Particle[], mode: CollisionMode): number {
  if (mode === 'none' || particles.length < 2) return 0;
  return mode === 'merge' ? mergeAll(particles) : bounceAll(particles);
}

import { Particle } from './Particle';
import { Vector2D } from './Vector2D';
import { QuadTree, treeOf } from './quadtree';

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
 * Default bounce restitution: the fraction of approach speed that survives an
 * impact.
 *
 * 1 would be a perfectly elastic bounce, 0 a pair that hits and stops dead
 * relative to each other. Half is firmly inelastic — collisions visibly bleed
 * energy out of a system, which is the honest behaviour for lumps of rock and
 * is what keeps a bouncing pair from ringing forever. The UI can set it to
 * anything in between.
 */
export const RESTITUTION = 0.5;

/**
 * Coulomb friction at a contact, as a fraction of the normal impulse.
 *
 * This is what turns an off-centre hit into a spin: without a tangential
 * impulse a bounce is frictionless and central, and two bodies could scrape
 * past each other without either one starting to turn. A third is a rough
 * surface — rock rather than ice.
 */
export const CONTACT_FRICTION = 1 / 3;

/**
 * Overlap allowed to stand, in world units.
 *
 * Without it a resting contact never stops correcting: gravity presses the pair
 * together by a hair each step, the separation pushes back, and the two argue
 * forever — trading a sliver of angular momentum into spin every step for as
 * long as the scene runs. A twentieth of a unit is far below anything visible
 * at any zoom the camera allows.
 */
export const CONTACT_SLOP = 0.05;

/**
 * When, during a sub-step, did these two bodies first touch?
 *
 * Overlap tested only at the end of a step misses anything that crossed the
 * whole contact window inside it: measured, a body at 160 units per frame goes
 * straight through a 23-unit target and is never seen to touch. This asks the
 * other question — over the straight line each body travelled, was there a
 * moment when the gap closed?
 *
 * That is a quadratic in the fraction of the step elapsed: with `p` the gap at
 * the start and `v` how much it changed over the step, `|p + t·v|² = contact²`.
 * Returns the earliest `t` in [0, 1], or null.
 */
export function sweptContactTime(
  a: Particle,
  aFrom: Vector2D,
  b: Particle,
  bFrom: Vector2D
): number | null {
  const contact = a.radius + b.radius;

  const p = bFrom.sub(aFrom);
  const v = b.position.sub(bFrom).sub(a.position.sub(aFrom));

  // Already touching when the step began; nothing to solve for.
  if (p.magnitudeSquared() <= contact * contact) return 0;

  const va = v.magnitudeSquared();
  if (va === 0) return null;

  const half = p.dot(v);
  // Moving apart, or not closing at all.
  if (half >= 0) return null;

  const c = p.magnitudeSquared() - contact * contact;
  const discriminant = half * half - va * c;
  if (discriminant < 0) return null;

  const t = (-half - Math.sqrt(discriminant)) / va;
  return t >= 0 && t <= 1 ? t : null;
}

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
 * Every touching pair, as index pairs with `i < j`.
 *
 * The direct scan is O(n²), which is the same wall the force sum ran into; past
 * `treeThreshold` the quadtree answers the same question by asking each body
 * only about bodies near it. `tests/quadtree.test.ts` pins that query against a
 * linear scan, so the pairs found are the same pairs either way.
 */
function touchingPairs(
  particles: Particle[],
  treeThreshold: number,
  previous?: Vector2D[]
): [number, number][] {
  const pairs: [number, number][] = [];

  const touched = (i: number, j: number): boolean => {
    if (overlapping(particles[i], particles[j])) return true;
    // Swept: did they pass through each other inside the step?
    return previous
      ? sweptContactTime(particles[i], previous[i], particles[j], previous[j]) !== null
      : false;
  };

  if (particles.length >= treeThreshold) {
    const tree = sweptTree(particles, previous);
    const candidates: number[] = [];

    for (let i = 0; i < particles.length; i++) {
      candidates.length = 0;
      const body = particles[i];

      // Query from the same swept disc the tree was built from, or the pruning
      // would discard the very pairs the sweep is meant to catch.
      const centre = previous ? previous[i].add(body.position).div(2) : body.position;
      const reach = previous
        ? body.radius + body.position.sub(previous[i]).magnitude() / 2
        : body.radius;

      tree.withinContact(centre.x, centre.y, reach, candidates);

      for (const j of candidates) {
        // Each pair once, and never a body against itself.
        if (j > i && touched(i, j)) pairs.push([i, j]);
      }
    }

    return pairs;
  }

  for (let i = 0; i < particles.length; i++) {
    for (let j = i + 1; j < particles.length; j++) {
      if (touched(i, j)) pairs.push([i, j]);
    }
  }

  return pairs;
}

/**
 * A tree over the bodies' *swept* discs: each one centred on the middle of its
 * motion and widened by half of it.
 *
 * A tree of end-of-step positions cannot answer a question about the path taken
 * to get there — it would prune away a body that flew clean through another.
 */
function sweptTree(particles: Particle[], previous?: Vector2D[]) {
  if (!previous) return treeOf(particles);

  return QuadTree.build(
    particles.map((particle, index) => {
      const travel = particle.position.sub(previous[index]);
      const centre = previous[index].add(particle.position).div(2);

      return {
        x: centre.x,
        y: centre.y,
        mass: particle.mass,
        radius: particle.radius + travel.magnitude() / 2,
        vx: particle.velocity.x,
        vy: particle.velocity.y,
      };
    })
  );
}

/**
 * Merge every touching pair, in place.
 *
 * The heavier body absorbs the lighter one and keeps its identity, so the trail
 * on screen carries through the collision instead of restarting. Repeats until
 * nothing overlaps, because a merged body is larger than either of its parts
 * and can therefore reach a third body that neither of them touched.
 *
 * Within one pass, pairs are resolved greedily and a body already consumed is
 * skipped rather than merged twice; the pass then repeats on what is left. That
 * is what keeps a pile-up from costing a full re-detection per merge.
 */
function mergeAll(
  particles: Particle[],
  treeThreshold: number,
  previous?: Vector2D[]
): number {
  let merges = 0;

  // Bounded by the particle count: every pass removes at least one body.
  for (let guard = particles.length; guard > 0; guard--) {
    const pairs = touchingPairs(particles, treeThreshold, previous);
    if (pairs.length === 0) break;

    const consumed = new Set<number>();
    const removals: number[] = [];

    for (const [i, j] of pairs) {
      if (consumed.has(i) || consumed.has(j)) continue;

      // A pair caught mid-flight is wound back to where it actually met, so
      // the merged body appears at the point of contact rather than wherever
      // the step happened to end.
      if (previous) rewindToContact(particles[i], previous[i], particles[j], previous[j]);

      const heavier = particles[i].mass >= particles[j].mass ? i : j;
      const lighter = heavier === i ? j : i;

      particles[heavier].absorb(particles[lighter]);
      consumed.add(lighter);
      removals.push(lighter);
      merges++;
    }

    // Descending, so each splice leaves the lower indices untouched. The
    // previous-position list has to follow, or the two fall out of step.
    removals.sort((a, b) => b - a);
    for (const index of removals) {
      particles.splice(index, 1);
      previous?.splice(index, 1);
    }
  }

  return merges;
}

/**
 * Put a pair back where they first touched, if that was partway through the
 * step just taken.
 *
 * Resolving a contact at the end-of-step positions means resolving it where the
 * bodies have already interpenetrated, or passed each other entirely.
 */
function rewindToContact(a: Particle, aFrom: Vector2D, b: Particle, bFrom: Vector2D): void {
  const time = sweptContactTime(a, aFrom, b, bFrom);
  if (time === null || time === 0) return;

  // Backwards along the step each body actually took, which is *not* backwards
  // along the velocity it is carrying now — gravity changed that during the
  // step — so this move costs angular momentum like any other.
  movePair(
    a,
    aFrom.add(a.position.sub(aFrom).mult(time)).sub(a.position),
    b,
    bFrom.add(b.position.sub(bFrom).mult(time)).sub(b.position)
  );
}

/**
 * Move both bodies of a contact, and put the angular momentum the move would
 * have destroyed into their spin.
 *
 * Moving a body changes `Σ m (r × v)` the moment `r` changes, by
 * `Σ m (Δ × v)`; only a displacement parallel to the body's own velocity
 * escapes it. Neither of the two moves a contact makes is parallel to anything
 * in particular, and both are large enough to matter: measured on five heavy
 * bodies dropped interpenetrating and left to jostle for 1,500 steps, the
 * pile's total angular momentum fell by **26%** when the separation went
 * uncompensated, and swung to **-139%** when only the separation was fixed and
 * the rewind was left alone.
 *
 * So the debt is not written off. It goes where a merge already puts orbital
 * angular momentum — into spin, shared so that `I_a Δω + I_b Δω` is exactly the
 * orbital term the move cost, which for one common change in angular *velocity*
 * means `Δω = -ΔL / (I_a + I_b)`.
 *
 * The alternative, and the reason this comment is long: a separating *impulse*,
 * the textbook Baumgarte bias, needs no compensation at all, because then every
 * change a contact makes is an impulse at a shared point. It was tried first.
 * It is also energy from nowhere, applied afresh on every sub-step for as long
 * as the contact lasts — and gravity makes contacts last. The same five bodies
 * gained **5.8 million** units of kinetic energy and left the screen at a spread
 * of 63,513 world units, against 62 for this. A conserved quantity bought with
 * an unconserved one is not a bargain.
 */
function movePair(a: Particle, shiftA: Vector2D, b: Particle, shiftB: Vector2D): void {
  const orbitalLost =
    a.mass * (shiftA.x * a.velocity.y - shiftA.y * a.velocity.x) +
    b.mass * (shiftB.x * b.velocity.y - shiftB.y * b.velocity.x);

  a.position = a.position.add(shiftA);
  b.position = b.position.add(shiftB);

  const spinChange = -orbitalLost / (a.momentOfInertia + b.momentOfInertia);
  a.angularVelocity += spinChange;
  b.angularVelocity += spinChange;
}

/**
 * Bounce every touching pair once.
 *
 * An impulse along the contact normal, scaled by the reduced mass so momentum
 * comes out exactly conserved, followed by the positional correction that
 * separates the pair. Without that correction the two stay overlapped, collide
 * again on the next step, and jitter against each other forever.
 */
function bounceAll(
  particles: Particle[],
  treeThreshold: number,
  restitution: number,
  previous?: Vector2D[]
): number {
  let impacts = 0;

  for (const [i, j] of touchingPairs(particles, treeThreshold, previous)) {
    const a = particles[i];
    const b = particles[j];

    if (previous) rewindToContact(a, previous[i], b, previous[j]);

    // The pair list was gathered before any impulse was applied, so a pair may
    // have been separated by an earlier one in the same pass.
    if (!overlapping(a, b)) continue;

    if (resolveContact(a, b, restitution)) impacts++;
  }

  return impacts;
}

/**
 * One contact between two bodies: an impulse along the normal, a friction
 * impulse across it, and the positional correction that separates them.
 *
 * Both impulses act at the same contact point and are equal and opposite, so
 * linear *and* angular momentum come out exactly conserved — which is what the
 * tests check, because it is the property that a wrong sign or a wrong lever
 * arm breaks first.
 *
 * Separating an overlap is the one thing a contact does that is not an impulse.
 * `movePair()` below carries the argument for why it is done by moving the
 * bodies and paying the angular momentum back into their spin, rather than by
 * the separating impulse the textbooks give.
 */
export function resolveContact(a: Particle, b: Particle, restitution: number): boolean {
  const { normal, overlap } = contactGeometry(a, b);

  // Arms from each centre to *the same point*. Taking each arm as its own
  // body's radius along the normal puts the two impulses at two different
  // places whenever the pair overlaps, and equal and opposite impulses applied
  // at different points do not conserve angular momentum — measured, 1.6% of it
  // vanished per bounce. The shared point sits in the middle of the overlap.
  const contactPoint = a.position.add(normal.mult(a.radius - overlap / 2));
  const armA = contactPoint.sub(a.position);
  const armB = contactPoint.sub(b.position);

  const relative = b.velocityAt(armB).sub(a.velocityAt(armA));
  const approachSpeed = relative.dot(normal);

  let struck = false;

  // Already separating: they are overlapped but on their way out, and hitting
  // them again would pump energy in rather than take it out.
  if (approachSpeed < 0) {
    const normalImpulse =
      (-(1 + restitution) * approachSpeed) / effectiveMass(a, b, armA, armB, normal);

    a.applyImpulse(normal.mult(-normalImpulse), armA);
    b.applyImpulse(normal.mult(normalImpulse), armB);

    // Friction acts across the normal, against whatever sliding remains after
    // the normal impulse, and is capped by Coulomb's rule.
    const sliding = relative.sub(normal.mult(approachSpeed));
    const slidingSpeed = sliding.magnitude();

    if (slidingSpeed > 0) {
      const tangent = sliding.div(slidingSpeed);
      const wanted = slidingSpeed / effectiveMass(a, b, armA, armB, tangent);
      const frictionImpulse = Math.min(wanted, CONTACT_FRICTION * normalImpulse);

      a.applyImpulse(tangent.mult(frictionImpulse), armA);
      b.applyImpulse(tangent.mult(-frictionImpulse), armB);
    }

    struck = true;
  }

  separate(a, b, normal, overlap);
  return struck;
}

/**
 * Move an overlapping pair apart along the normal, far enough that they touch.
 *
 * The heavier body gives least ground, which leaves the pair's centre of mass
 * where it was. `movePair` above covers what the move costs and how it is paid.
 */
function separate(a: Particle, b: Particle, normal: Vector2D, overlap: number): void {
  // A sliver is left alone, which keeps a resting pair from trading a nudge
  // back and forth with gravity forever.
  const penetration = Math.max(overlap - CONTACT_SLOP, 0);
  if (penetration === 0) return;

  const total = a.mass + b.mass;
  movePair(
    a,
    normal.mult(-(penetration * b.mass) / total),
    b,
    normal.mult((penetration * a.mass) / total)
  );
}

/**
 * Effective mass of the pair along `direction`, counting the rotation each
 * impulse would cause.
 *
 * A hit near the rim spends part of itself spinning the body rather than
 * shoving it, so the pair resists it *less* than their masses alone suggest;
 * this is the term that says by how much.
 */
function effectiveMass(
  a: Particle,
  b: Particle,
  armA: Vector2D,
  armB: Vector2D,
  direction: Vector2D
): number {
  const leverA = armA.x * direction.y - armA.y * direction.x;
  const leverB = armB.x * direction.y - armB.y * direction.x;

  return (
    1 / a.mass +
    1 / b.mass +
    (leverA * leverA) / a.momentOfInertia +
    (leverB * leverB) / b.momentOfInertia
  );
}

/**
 * Apply `mode` to every touching pair, mutating `particles` in place.
 *
 * Returns the number of collision events resolved. Callers must treat a
 * non-zero result as invalidating any cached accelerations: merging changes
 * both the membership of the list and the masses in it, and bouncing changes
 * positions.
 */
export function resolveCollisions(
  particles: Particle[],
  mode: CollisionMode,
  treeThreshold: number = Infinity,
  restitution: number = RESTITUTION,
  previous?: Vector2D[]
): number {
  if (mode === 'none' || particles.length < 2) return 0;
  return mode === 'merge'
    ? mergeAll(particles, treeThreshold, previous)
    : bounceAll(particles, treeThreshold, restitution, previous);
}

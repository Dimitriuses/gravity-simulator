import { Particle } from './Particle';
import { Vector2D } from './Vector2D';

/**
 * Breaking a pair apart on a hard enough impact. Roadmap M16.
 *
 * Merging is the easy direction: two bodies become one, and mass, momentum and
 * angular momentum each have exactly one answer. Breaking one into several has
 * no such answer — the number of fragments, their sizes, their velocities and
 * their spins are all free, and the conservation laws constrain them without
 * deciding them. That is why this was deferred four times; what follows is the
 * four decisions, made, with the reasoning attached to each.
 *
 * Nothing here knows about the simulation's other machinery: it takes two
 * bodies and returns the bodies that replace them, or `null` to say the pair
 * should merge after all. That makes every one of those decisions testable
 * against a conservation law rather than against a screenshot.
 */

/**
 * How much harder than "just barely" an impact has to be, as a multiple of the
 * merged body's gravitational binding energy.
 *
 * **The first decision: when.** A break-up needs a threshold, and a threshold
 * needs an energy to compare against. Real rock has a material strength; this
 * simulation has no material — a body is a point mass with a radius derived
 * from it — so inventing one would be inventing physics. What it does have is
 * the energy it would take to pull the merged body apart against its own
 * gravity, `G·M²/R`, which is a number the model already implies rather than
 * one chosen to make collisions look right.
 *
 * So: shatter when the kinetic energy of the impact, measured in the pair's own
 * frame, exceeds that. Below it the pair merges exactly as it does today, which
 * is what makes this mode a superset of merging rather than a replacement for
 * it — gentle contacts accrete, hard ones disrupt, which is the distinction
 * planetary science draws too.
 */
export const SHATTER_ENERGY_RATIO = 1;

/**
 * How much of the energy left over after the break-up goes into throwing the
 * pieces apart.
 *
 * **The third decision: how fast.** The fragments have to carry the pair's
 * momentum and angular momentum exactly — that part is not a choice — but the
 * *spread* of their velocities is free, and it is what decides whether the
 * result reads as a collision or as confetti. Taking it from the impact's own
 * excess energy is what stops it being a number picked by eye: a harder hit
 * throws the pieces further because it had more to spend, and a marginal one
 * barely disperses them at all.
 *
 * Half rather than all of it, because a real disruption puts the rest into heat
 * and rotation, and because anything below 1 guarantees the property the tests
 * check: a contact can lose kinetic energy but never invent it.
 */
export const DISPERSAL_EFFICIENCY = 0.5;

/**
 * The share of the mass that stays in one piece.
 *
 * **The second decision: how many, and how big.** Two equal halves is the only
 * split that needs no parameter at all, and it looks like a body cut in two
 * rather than one that broke. What a disruption actually leaves is a largest
 * remnant and a tail of smaller pieces, so that is what this makes: half the
 * mass in one fragment and the rest shared equally among the others.
 *
 * This is the one number here that is a choice rather than a consequence, and
 * it is written as a constant rather than buried so that it can be argued with.
 */
export const LARGEST_REMNANT_FRACTION = 0.5;

/**
 * The most pieces one impact may produce.
 *
 * The count grows with how far the impact exceeds the threshold — more energy,
 * more pieces — and stops here. Not for looks: every fragment is a body, each
 * body is another pair for every other body, and an uncapped rule turns one
 * hard collision into an arbitrary amount of work.
 */
export const MAX_FRAGMENTS = 5;

/** How much wider than touching the debris ring is placed. */
const RING_SLACK = 1.1;

/**
 * The energy it would take to pull a body of this mass apart against its own
 * gravity: `G·M²/R`, with `R` the radius the mass rule gives it.
 *
 * The constant in front of that (3/5 for a uniform sphere) is left out
 * deliberately — it would be a made-up precision, since the bodies here are
 * discs in a plane obeying a cube-root radius rule, and it would only move the
 * threshold by a factor this milestone would then have to justify.
 */
export function bindingEnergy(mass: number, G: number): number {
  return (G * mass * mass) / Particle.radiusForMass(mass);
}

/** The kinetic energy of an impact, measured in the pair's own rest frame. */
export function impactEnergy(a: Particle, b: Particle): number {
  const reduced = (a.mass * b.mass) / (a.mass + b.mass);
  return 0.5 * reduced * b.velocity.sub(a.velocity).magnitudeSquared();
}

/**
 * The pieces a pair breaks into, or `null` if it should merge instead.
 *
 * `null` covers both of the ways a break-up can fail to be worth doing: an
 * impact too gentle to exceed the binding energy, and one that would produce
 * pieces too slow to escape each other.
 *
 * **The fourth decision: what stops it undoing itself.** Fragments that
 * separate slower than their own escape velocity fall straight back together
 * and merge, and a scene doing that flickers between one body and several,
 * several times a second. The obvious fix is a cooldown — state saying "these
 * pieces may not re-merge yet" — which every other part of the contact solver
 * manages to do without. This does without it too: if the dispersal speed the
 * energy pays for is below the escape speed of the cloud it would produce, the
 * pair merges instead. A break-up that cannot finish never starts.
 */
export function fragmentsOf(a: Particle, b: Particle, G: number): Particle[] | null {
  const total = a.mass + b.mass;
  const centre = a.position.mult(a.mass).add(b.position.mult(b.mass)).div(total);
  const velocity = a.velocity.mult(a.mass).add(b.velocity.mult(b.mass)).div(total);

  const impact = impactEnergy(a, b);
  const binding = bindingEnergy(total, G);
  if (impact < SHATTER_ENERGY_RATIO * binding) return null;

  const excess = impact - binding;

  // Energy the impact has left after paying to unbind the body, turned into a
  // speed by sharing it over the whole mass.
  const dispersal = Math.sqrt((2 * DISPERSAL_EFFICIENCY * excess) / total);

  // **The second decision: how many.** Two is the fewest a break-up can be, and
  // it is what a marginal one makes; the count rises with how much faster than
  // escape the pieces are travelling. Energy goes as the square of speed, so a
  // margin of √2 in speed is twice the energy and buys one more piece.
  //
  // The margin is measured against the *two-piece* layout, and it has to be:
  // more pieces sit on a wider ring, a wider ring is easier to escape from, and
  // asking "how many can get away?" therefore answers "all of them, always".
  // That was measured before it was noticed — every break-up made five.
  const smallest = layoutFor(total, 2, b.position.sub(a.position));
  const escape = Math.sqrt((2 * G * total) / smallest.ring);
  if (dispersal < escape) return null;

  const count = Math.min(
    MAX_FRAGMENTS,
    2 + Math.floor(2 * Math.log2(dispersal / escape))
  );
  const layout = layoutFor(total, count, b.position.sub(a.position));

  const { masses, radii, ring } = layout;

  const offsets = ringOffsets(radii, ring, b.position.sub(a.position));

  balanceOffsets(offsets, masses);

  // Angular momentum of the pair about the point the fragments are placed
  // around — their orbital motion about each other, and both of their spins.
  // The cloud is given it back as a rigid rotation, which is the same trick a
  // merge uses when it turns two orbiting bodies into one spinning one.
  const internal = a.angularMomentumAbout(centre) + b.angularMomentumAbout(centre);
  const inertia = masses.reduce(
    (sum, mass, i) => sum + mass * offsets[i].magnitudeSquared() + spinInertia(mass),
    0
  );
  const spin = inertia > 0 ? internal / inertia : 0;

  const fragments = masses.map((mass, i) => {
    const offset = offsets[i];
    const direction = offset.magnitude() > 0 ? offset.normalize() : new Vector2D(1, 0);

    // Outwards from the centre, plus the cloud's rotation.
    const outward = direction.mult(dispersal);
    const tangential = new Vector2D(-offset.y, offset.x).mult(spin);

    const fragment = new Particle(
      centre.x + offset.x,
      centre.y + offset.y,
      mass,
      velocity.x + outward.x + tangential.x,
      velocity.y + outward.y + tangential.y
    );

    fragment.angularVelocity = spin;
    // Fragments belong to the scene they came from, so they leave the same
    // length of trail as the bodies around them.
    fragment.maxTrailLength = Math.max(a.maxTrailLength, b.maxTrailLength);
    return fragment;
  });

  correctMomentum(fragments, velocity.mult(total));
  return fragments;
}

/** The masses, sizes and ring a break into `count` pieces would use. */
function layoutFor(
  total: number,
  count: number,
  impact: Vector2D
): { masses: number[]; radii: number[]; ring: number } {
  const masses = fragmentMasses(total, count);
  const radii = masses.map((mass) => Particle.radiusForMass(mass));

  return { masses, radii, ring: ringRadiusFor(radii, impact) };
}

/**
 * The smallest ring that holds these pieces without any two touching.
 *
 * Starts from the circumference the pieces need and widens until the layout is
 * clear. It matters that this is the *smallest* such ring rather than a
 * generous one: the escape check above compares the dispersal speed against the
 * escape speed at this radius, so a ring wider than necessary would refuse
 * break-ups that would have worked.
 */
function ringRadiusFor(radii: number[], impact: Vector2D): number {
  let ring = (RING_SLACK * RING_SLACK * radii.reduce((sum, r) => sum + r, 0)) / Math.PI;

  for (let attempt = 0; attempt < 12; attempt++) {
    const offsets = ringOffsets(radii, ring, impact);
    let clear = true;

    for (let i = 0; i < offsets.length && clear; i++) {
      for (let j = i + 1; j < offsets.length && clear; j++) {
        if (offsets[i].sub(offsets[j]).magnitude() <= radii[i] + radii[j]) clear = false;
      }
    }

    if (clear) return ring;
    ring *= RING_SLACK;
  }

  return ring;
}

/** Half the mass in one piece, the rest shared equally. */
function fragmentMasses(total: number, count: number): number[] {
  const largest = total * LARGEST_REMNANT_FRACTION;
  const rest = (total - largest) / (count - 1);

  return [largest, ...Array.from({ length: count - 1 }, () => rest)];
}

/**
 * Where each piece sits, laid around a ring in the order they were sized.
 *
 * Each takes an arc proportional to its own radius, so a large remnant does not
 * overlap the pieces beside it, and the ring is turned to face along the
 * impact — the debris then spreads about the line the bodies met on rather than
 * about an arbitrary direction.
 */
function ringOffsets(radii: number[], ring: number, impact: Vector2D): Vector2D[] {
  const start = impact.magnitude() > 0 ? Math.atan2(impact.y, impact.x) : 0;
  const offsets: Vector2D[] = [];

  let angle = start;
  for (const radius of radii) {
    // The slack lives here rather than only in the ring's size, and that is the
    // whole of the geometry: a slot of exactly `2r/ring` puts neighbours the
    // sum of their radii apart *along the arc*, and the straight line between
    // them is shorter than the arc — always, at every ring size — so widening
    // the ring could never separate them. Widening the slot can.
    const span = (2 * radius * RING_SLACK) / ring;
    const middle = angle + span / 2;

    offsets.push(new Vector2D(Math.cos(middle) * ring, Math.sin(middle) * ring));
    angle += span;
  }

  return offsets;
}

/**
 * Slide the ring so that the fragments' centre of mass is its centre.
 *
 * Without this the pieces are laid out symmetrically in *space* while their
 * masses are not, so their centre of mass sits off to one side of the pair's —
 * which moves the system's centre of mass, and makes every correction below
 * disagree with the angular momentum it is supposed to preserve.
 */
function balanceOffsets(offsets: Vector2D[], masses: number[]): void {
  const total = masses.reduce((sum, mass) => sum + mass, 0);

  let x = 0;
  let y = 0;
  for (let i = 0; i < offsets.length; i++) {
    x += (masses[i] * offsets[i].x) / total;
    y += (masses[i] * offsets[i].y) / total;
  }

  for (let i = 0; i < offsets.length; i++) {
    offsets[i] = new Vector2D(offsets[i].x - x, offsets[i].y - y);
  }
}

/**
 * Take the pair's momentum out of the fragments exactly, as one shared shift.
 *
 * The dispersal is radial and the rotation is tangential, so both *should* sum
 * to nothing — but the masses are unequal, and floating point does not care
 * what should happen. A common velocity shift is the only correction that
 * leaves the relative motion, and therefore the picture, exactly as it was.
 */
function correctMomentum(fragments: Particle[], wanted: Vector2D): void {
  let mass = 0;
  let px = 0;
  let py = 0;

  for (const fragment of fragments) {
    mass += fragment.mass;
    px += fragment.mass * fragment.velocity.x;
    py += fragment.mass * fragment.velocity.y;
  }

  const shift = new Vector2D((wanted.x - px) / mass, (wanted.y - py) / mass);
  for (const fragment of fragments) {
    fragment.velocity = fragment.velocity.add(shift);
  }
}

/** A fragment's own moment of inertia, from the same rule `Particle` uses. */
function spinInertia(mass: number): number {
  return 0.5 * mass * Particle.radiusForMass(mass) ** 2;
}

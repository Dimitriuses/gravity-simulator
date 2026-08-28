import { Vector2D } from './Vector2D';
import { Particle } from './Particle';
import { QuadTree } from './quadtree';

/**
 * Integration schemes, and the adaptive step-size rule that decides how finely
 * a frame has to be sliced.
 *
 * Roadmap M1. The accuracy problem this milestone exists for was never really
 * the integrator — it was the fixed step. Orbital period scales as r^1.5, so a
 * step of 1 resolves an orbit at r = 400 with 1,005 points and an orbit at
 * r = 12 with five, at which point the orbit is destroyed rather than
 * approximated. `recommendedSubSteps` fixes that; the schemes below then decide
 * how much accuracy each of those steps buys.
 */

export type IntegratorName = 'euler' | 'verlet' | 'rk4' | 'forest-ruth';

/**
 * What an integrator is allowed to ask of the world around it.
 *
 * `PhysicsEngine` implements this. Splitting it out is what keeps the schemes
 * testable in isolation — and honest, since an integrator that could reach into
 * the engine would be tempted to cache things it has no right to.
 */
export interface ForceField {
  /**
   * Recompute forces at the particles' current positions, filling in each
   * particle's `acceleration` and `netForce`.
   */
  refresh(): void;

  /** Accelerations the particles would feel at `positions`. Changes nothing. */
  accelerationsAt(positions: Vector2D[]): Vector2D[];
}

/**
 * Advance every particle by `dt`.
 *
 * **The contract, both ways round:** on entry, every particle's `acceleration`
 * is the acceleration at its current position; on exit, the same must be true
 * of its new position. Every scheme below therefore ends with the field
 * refreshed — which is also what leaves `netForce` correct for the renderer's
 * force arrows, and what lets velocity Verlet reuse the second half of its own
 * evaluation as the first half of the next step's.
 */
export type Integrator = (particles: Particle[], dt: number, field: ForceField) => void;

/**
 * Semi-implicit (symplectic) Euler — the original scheme.
 *
 * Velocity first, then position using the *new* velocity. First-order, but
 * symplectic: energy oscillates within a bound instead of growing, so orbits do
 * not spiral apart. The error shows up as phase.
 *
 * One force evaluation per step.
 */
export const symplecticEuler: Integrator = (particles, dt, field) => {
  for (const particle of particles) {
    particle.velocity = particle.velocity.add(particle.acceleration.mult(dt));
    particle.position = particle.position.add(particle.velocity.mult(dt));
  }

  field.refresh();
};

/**
 * Velocity Verlet — second-order and still symplectic.
 *
 *   x' = x + v·dt + ½·a·dt²
 *   v' = v + ½·(a + a')·dt
 *
 * The acceleration at the new position is needed to finish the velocity update,
 * and is exactly what the next step needs to start its position update, so the
 * cost is **one force evaluation per step** — the same as Euler — for an order
 * of accuracy more. That reuse is the whole reason the contract above insists
 * accelerations are current on entry as well as on exit.
 */
export const velocityVerlet: Integrator = (particles, dt, field) => {
  const previousAcceleration = particles.map((particle) => particle.acceleration);

  for (const particle of particles) {
    particle.position = particle.position
      .add(particle.velocity.mult(dt))
      .add(particle.acceleration.mult(0.5 * dt * dt));
  }

  // a' at the new positions — and the accelerations this step's successor
  // will open with.
  field.refresh();

  particles.forEach((particle, index) => {
    particle.velocity = particle.velocity.add(
      previousAcceleration[index].add(particle.acceleration).mult(0.5 * dt)
    );
  });
};

/**
 * The weights that turn three leapfrog steps into a fourth-order one.
 *
 * `w0` is negative — the middle step runs *backwards* — and the three sum to
 * one, so a composed step advances time by exactly `dt`. That is the whole
 * trick: the second-order error terms of the three sub-steps cancel because one
 * of them is taken in the opposite direction, and what is left is fourth order.
 */
const CBRT_TWO = Math.cbrt(2);
const FOREST_RUTH_OUTER = 1 / (2 - CBRT_TWO);
const FOREST_RUTH_MIDDLE = -CBRT_TWO / (2 - CBRT_TWO);

/**
 * Forest-Ruth: fourth order, symplectic, three force evaluations per step.
 *
 * The scheme this project needed and did not have. Velocity Verlet bounds its
 * energy error and pays for it in the orbit's *orientation* — on the two-body
 * problem, where the perihelion provably does not move, it turns it by
 * thousands of arcseconds a century. RK4 gets the phase right and lets energy
 * drift in one direction. So every measurement taken out of this simulation
 * came with the instruction "watch with Verlet, measure with RK4", in four
 * different files.
 *
 * This is both. It is a *composition* rather than a new derivation: three
 * velocity Verlet steps of `w1·dt`, `w0·dt`, `w1·dt`, which is why the
 * implementation is six lines and why it inherits the contract the rest of this
 * file keeps. Each Verlet step assumes the accelerations are current when it
 * starts and leaves them current when it finishes, so the three compose without
 * anything in between, and the composed step costs one evaluation per
 * sub-step — three against RK4's four, for the same order and a property RK4
 * does not have.
 *
 * The cost is that the middle step goes backwards by 1.70 dt, so a body travels
 * further within a step than the step advances it. Nothing here depends on
 * monotone time — contacts are resolved between steps, not inside them — but it
 * is the reason this is not simply the default: at a step coarse enough to make
 * the backward excursion comparable to a close approach, Verlet's smaller
 * excursion is better behaved.
 */
export const forestRuth: Integrator = (particles, dt, field) => {
  velocityVerlet(particles, FOREST_RUTH_OUTER * dt, field);
  velocityVerlet(particles, FOREST_RUTH_MIDDLE * dt, field);
  velocityVerlet(particles, FOREST_RUTH_OUTER * dt, field);
};

/**
 * Classical fourth-order Runge-Kutta, on the state (x, v) with dx/dt = v and
 * dv/dt = a(x).
 *
 * Fourth-order but **not** symplectic, which is the point of having it: over a
 * long run its energy error drifts in one direction where Verlet's oscillates
 * within a bound, so more order does not automatically mean a better orbit.
 * Having all three side by side makes that visible instead of assertable.
 *
 * Four force evaluations per step: the first stage reuses the acceleration the
 * previous step left behind (the same reuse velocity Verlet lives on), then
 * three trial stages, then one to leave the field current at the new positions —
 * k4 is evaluated at a trial point, not at where the step actually lands.
 */
export const rungeKutta4: Integrator = (particles, dt, field) => {
  const position = particles.map((particle) => particle.position);
  const velocity = particles.map((particle) => particle.velocity);

  // Stage 1 uses the accelerations the contract guarantees are already current.
  const k1v = particles.map((particle) => particle.acceleration);
  const k1x = velocity;

  const k2v = field.accelerationsAt(position.map((x, i) => x.add(k1x[i].mult(dt / 2))));
  const k2x = velocity.map((v, i) => v.add(k1v[i].mult(dt / 2)));

  const k3v = field.accelerationsAt(position.map((x, i) => x.add(k2x[i].mult(dt / 2))));
  const k3x = velocity.map((v, i) => v.add(k2v[i].mult(dt / 2)));

  const k4v = field.accelerationsAt(position.map((x, i) => x.add(k3x[i].mult(dt))));
  const k4x = velocity.map((v, i) => v.add(k3v[i].mult(dt)));

  particles.forEach((particle, index) => {
    const dx = k1x[index]
      .add(k2x[index].mult(2))
      .add(k3x[index].mult(2))
      .add(k4x[index])
      .mult(dt / 6);
    const dv = k1v[index]
      .add(k2v[index].mult(2))
      .add(k3v[index].mult(2))
      .add(k4v[index])
      .mult(dt / 6);

    particle.position = position[index].add(dx);
    particle.velocity = velocity[index].add(dv);
  });

  field.refresh();
};

export const INTEGRATORS: Record<IntegratorName, Integrator> = {
  euler: symplecticEuler,
  verlet: velocityVerlet,
  rk4: rungeKutta4,
  'forest-ruth': forestRuth,
};

/** Labels for the UI, in the order they should appear. */
export const INTEGRATOR_LABELS: ReadonlyArray<{ id: IntegratorName; label: string }> = [
  { id: 'verlet', label: 'Velocity Verlet (2nd order)' },
  { id: 'euler', label: 'Symplectic Euler (1st order)' },
  { id: 'rk4', label: 'Runge-Kutta 4 (not symplectic)' },
  { id: 'forest-ruth', label: 'Forest-Ruth (4th, symplectic)' },
];

/**
 * The step rule's timescale for one pair: the smaller of how fast their own
 * gravity turns them and how long they stay at this separation.
 *
 * Exported because it is the definition of the rule, and three other things
 * need to agree with it exactly — the pairwise scan below, the tree's
 * branch-and-bound search in `quadtree.ts`, and the tool that measures how much
 * of a frame's sub-stepping each body is responsible for. A second copy of this
 * arithmetic is a second answer waiting to disagree.
 */
export function pairTimescale(a: Particle, b: Particle, G: number): number {
  const contactDistance = a.radius + b.radius;
  const separation = Math.max(b.position.sub(a.position).magnitude(), contactDistance);

  const dynamical = Math.sqrt(separation ** 3 / (G * (a.mass + b.mass)));

  const relativeSpeed = b.velocity.sub(a.velocity).magnitude();
  const crossing = relativeSpeed > 0 ? separation / relativeSpeed : Infinity;

  return Math.min(dynamical, crossing);
}

/** The pairwise scan: a minimum over every pair in the system. */
function shortestInteractionTime(particles: Particle[], G: number): number {
  let shortest = Infinity;

  for (let i = 0; i < particles.length; i++) {
    for (let j = i + 1; j < particles.length; j++) {
      shortest = Math.min(shortest, pairTimescale(particles[i], particles[j], G));
    }
  }

  return shortest;
}

/**
 * Fraction of the shortest timescale in the system that one sub-step is allowed
 * to cover.
 *
 * A circular orbit's dynamical time is its period / 2π, so a sub-step of
 * t_dyn/16 puts about 2π·16 ≈ 100 sub-steps in the tightest orbit present,
 * whatever its radius. That is the number the fixed step could not hold on to:
 * it managed 1,005 at r = 400 and five at r = 12.
 */
export const SAFETY_FRACTION = 1 / 16;

/**
 * Ceiling on sub-steps per frame.
 *
 * Sub-stepping costs a full O(n²) force pass each, so an uncapped rule would
 * let one pathological pair take the frame rate down with it. At the cap the
 * step is simply too coarse and the encounter is wrong — but it is wrong at a
 * playable frame rate, and the readout in the UI says so.
 */
export const MAX_SUB_STEPS = 64;

/**
 * How many sub-steps this frame needs, from the closest interacting pair.
 *
 * Two timescales matter and the smaller wins:
 *
 * - **dynamical**, sqrt(r³ / (G·(m₁+m₂))) — how fast the pair's own gravity
 *   turns them. This is what collapses on tight orbits.
 * - **crossing**, r / |v₁ − v₂| — how long the pair stays at this separation.
 *   A fast flyby needs fine steps even where the dynamical time is long.
 *
 * Separation is clamped to contact distance, matching the softening in the
 * force law: below contact the force stops growing, so the timescale should
 * stop shrinking too, or two overlapping bodies would demand infinite steps.
 */
/**
 * How many sub-steps a given timescale asks for, over a step of `dt`.
 *
 * The last two lines of `recommendedSubSteps` below, pulled out so that "what
 * would *this* body need on its own?" can be asked with the same arithmetic
 * that decides what the whole system needs.
 */
export function subStepsForTimescale(
  shortest: number,
  dt: number,
  maxSubSteps: number = MAX_SUB_STEPS
): number {
  if (!Number.isFinite(shortest)) return 1;

  const safeStep = SAFETY_FRACTION * shortest;
  if (!(safeStep > 0)) return maxSubSteps;

  return Math.max(1, Math.min(maxSubSteps, Math.ceil(dt / safeStep)));
}

export function recommendedSubSteps(
  particles: Particle[],
  G: number,
  dt: number,
  maxSubSteps: number = MAX_SUB_STEPS,
  tree: QuadTree | null = null
): number {
  // The scan below is a minimum over every pair, and at a couple of thousand
  // bodies it cost more than the rest of the frame together. Given a tree, the
  // same minimum comes back from a branch-and-bound search — the same number,
  // not an estimate of it.
  const shortest = tree
    ? tree.shortestInteractionTime(G)
    : shortestInteractionTime(particles, G);

  // One body, or none: nothing accelerates, so one step is exact.
  return subStepsForTimescale(shortest, dt, maxSubSteps);
}

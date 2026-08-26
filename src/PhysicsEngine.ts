import { Particle } from './Particle';
import { VectorField, ViewBounds } from './VectorField';
import { Vector2D } from './Vector2D';
import { accelerationsAt } from './forces';
import {
  ForceField,
  INTEGRATORS,
  IntegratorName,
  MAX_SUB_STEPS,
  recommendedSubSteps,
} from './integrators';
import { CollisionMode, RESTITUTION, resolveCollisions } from './collisions';
import { DEFAULT_THETA, QuadTree, treeAt, treeOf } from './quadtree';

/**
 * Gravitational constant. Not Newton's — a tuning value picked so that the
 * masses and distances the sliders offer produce forces the field can draw.
 * Exported because `presets.ts` derives its orbital velocities from it: a
 * preset built against a different G is simply a scene that flies apart.
 */
export const SIMULATION_G = 0.5;

/** How forces are summed: over every pair, or through a Barnes-Hut tree. */
export type ForceMode = 'exact' | 'barnes-hut' | 'auto';

/** Labels for the UI, in the order they should appear. */
export const FORCE_MODE_LABELS: ReadonlyArray<{ id: ForceMode; label: string }> = [
  { id: 'auto', label: 'Auto (tree past 128)' },
  { id: 'exact', label: 'Exact pairs' },
  { id: 'barnes-hut', label: 'Barnes-Hut tree' },
];

/**
 * Body count at which `auto` switches to the tree.
 *
 * Below this the direct sum is both faster and exact, so there is nothing to
 * gain; the crossover measured in SCALING.md is around 100 bodies for the force
 * sum. Keeping the exact solver for small scenes also keeps momentum conserved
 * to machine precision in every scene the UI encourages, which the tree cannot
 * promise — see quadtree.ts.
 */
export const BARNES_HUT_THRESHOLD = 128;

/**
 * Physics engine that handles gravity calculations and updates
 */
export class PhysicsEngine implements ForceField {
  particles: Particle[] = [];
  vectorField: VectorField;
  G: number = SIMULATION_G;

  /** Which integration scheme `step()` uses. See integrators.ts. */
  integrator: IntegratorName = 'verlet';

  /**
   * Slice each frame into as many sub-steps as the closest pair needs.
   *
   * On by default: it is the whole point of roadmap M1, and it costs nothing on
   * a scene that does not need it — a wide orbit asks for one sub-step, which
   * is what the simulation did anyway.
   */
  adaptiveStepping: boolean = true;

  /** Sub-steps the last `step()` actually took. Read by the UI. */
  lastSubSteps: number = 1;

  /**
   * What happens when two bodies touch: merge, bounce, or pass through.
   *
   * Merging by default. Passing through is what the simulation did before
   * roadmap M2 and is kept because it is occasionally what you want, but it is
   * the least physical of the three.
   */
  collisionMode: CollisionMode = 'merge';

  /** Collision events resolved since the engine was created. Read by the UI. */
  collisionCount: number = 0;

  /**
   * How bouncy a contact is: 1 keeps all the approach speed, 0 none of it.
   *
   * Only bounce mode reads it — a merge is perfectly inelastic by definition.
   */
  restitution: number = RESTITUTION;

  /** How forces are summed. See `ForceMode`. */
  forceMode: ForceMode = 'auto';

  /** Barnes-Hut opening angle; 0 makes the tree exact. */
  theta: number = DEFAULT_THETA;

  /**
   * The tree built by the last `computeForces()`, reused by the field sampler.
   *
   * Both want the same tree over the same positions, and building it is the
   * expensive half of a query. Invalidated wherever `forcesDirty` is set.
   */
  private tree: QuadTree | null = null;

  /**
   * Whether `acceleration` and `netForce` are stale.
   *
   * The integrators are entitled to assume accelerations are current when they
   * are handed the particles — velocity Verlet's one-evaluation-per-step rests
   * on it. Adding or removing a body invalidates that, so it is tracked rather
   * than assumed.
   */
  private forcesDirty: boolean = true;

  constructor(baseGridSize: number = 30) {
    // Smaller grid size (30) for denser vector field visualization
    this.vectorField = new VectorField(baseGridSize);
  }

  /**
   * Add a particle to the simulation
   */
  addParticle(particle: Particle): void {
    this.particles.push(particle);
    this.invalidateForces();
  }

  /**
   * Remove a particle from the simulation
   */
  removeParticle(particle: Particle): void {
    const index = this.particles.indexOf(particle);
    if (index > -1) {
      this.particles.splice(index, 1);
      this.invalidateForces();
    }
  }

  /**
   * Clear all particles
   */
  clearParticles(): void {
    this.particles = [];
    this.invalidateForces();
  }

  /** Cached accelerations and the tree they came from are no longer usable. */
  private invalidateForces(): void {
    this.forcesDirty = true;
    this.tree = null;
  }

  /**
   * Is the tree in use for this many bodies?
   *
   * Read by the UI, which says so on screen: the approximation is worth
   * knowing about when it is switched on.
   */
  usingBarnesHut(): boolean {
    if (this.forceMode === 'exact') return false;
    if (this.forceMode === 'barnes-hut') return true;
    return this.particles.length >= BARNES_HUT_THRESHOLD;
  }

  /**
   * Clear last step's accumulation and sum the pairwise gravitational forces.
   *
   * Split out from integration so a paused simulation can still show correct
   * force arrows: the UI calls this alone while paused, so adding or deleting
   * a body updates every arrow without anything moving.
   *
   * O(n²) in the particle count — see ROADMAP.md on Barnes-Hut.
   */
  computeForces(): void {
    this.forcesDirty = false;

    for (const particle of this.particles) {
      particle.resetForces();
    }

    if (this.usingBarnesHut()) {
      // Each body queries the tree for its own acceleration. Note what is lost:
      // the pairwise loop below applies equal and opposite forces, so momentum
      // is conserved exactly, while the tree may let A see B individually and B
      // see A only as part of a cell. See quadtree.ts.
      this.tree = treeOf(this.particles);

      for (let i = 0; i < this.particles.length; i++) {
        const particle = this.particles[i];
        const acceleration = this.tree.accelerationOn(i, this.G, this.theta);

        particle.acceleration = acceleration;
        particle.netForce = acceleration.mult(particle.mass);
      }

      return;
    }

    this.tree = null;

    for (let i = 0; i < this.particles.length; i++) {
      for (let j = i + 1; j < this.particles.length; j++) {
        const particleA = this.particles[i];
        const particleB = this.particles[j];

        const force = particleA.attractionTo(particleB, this.G);

        // Equal and opposite (Newton's 3rd law)
        particleA.applyForce(force);
        particleB.applyForce(force.mult(-1));
      }
    }
  }

  /** `ForceField`: recompute forces where the particles actually are. */
  refresh(): void {
    this.computeForces();
  }

  /** `ForceField`: accelerations for a trial configuration. Mutates nothing. */
  accelerationsAt(positions: Vector2D[]): Vector2D[] {
    if (this.usingBarnesHut()) {
      // A trial configuration is a different set of positions, so it needs its
      // own tree — RK4 asks for three of these per step.
      const trial = treeAt(this.particles, positions);
      return positions.map((_, index) => trial.accelerationOn(index, this.G, this.theta));
    }

    return accelerationsAt(this.particles, positions, this.G);
  }

  /**
   * Integrate every particle forward by `dt` with the current scheme, once.
   *
   * No sub-stepping and no trail point: this is one turn of the crank, which is
   * what `step()` calls in a loop. `netForce` deliberately survives the call —
   * the renderer reads it afterwards to draw each particle's force arrow, and
   * every scheme leaves it current for the *new* positions.
   */
  integrate(dt: number = 1): void {
    if (this.forcesDirty) this.computeForces();
    INTEGRATORS[this.integrator](this.particles, dt, this);

    // Spin is advanced here rather than inside the schemes: gravity applies no
    // torque to a point mass, so there is no angular acceleration for a
    // higher-order scheme to integrate and `angle += ω·dt` is exact.
    for (const particle of this.particles) {
      particle.angle += particle.angularVelocity * dt;
    }
  }

  /**
   * Resolve contacts, and report whether anything happened.
   *
   * Kept public because a paused simulation may still need it: adding a body on
   * top of another while frozen should not leave two bodies inside each other
   * waiting for the clock to start.
   */
  resolveCollisions(previous?: Vector2D[]): number {
    const events = resolveCollisions(
      this.particles,
      this.collisionMode,
      this.forceMode === 'exact' ? Infinity : BARNES_HUT_THRESHOLD,
      this.restitution,
      previous
    );

    if (events > 0) {
      this.collisionCount += events;
      this.tree = null;
      // Merging changes the membership of the list and the masses in it;
      // bouncing changes positions. Either way every cached acceleration is
      // now wrong, and the integrator contract says they must not be.
      this.forcesDirty = true;
    }

    return events;
  }

  /**
   * One frame: however many sub-steps the closest pair needs, contacts resolved
   * after each, then one trail point per particle.
   *
   * The trail records the frame, not the sub-steps — see `Particle.recordTrail`.
   *
   * Contacts are resolved per sub-step rather than per frame because that is
   * the whole point of sub-stepping: a fast pass is sliced finely enough to
   * notice the moment of contact, instead of stepping over it.
   */
  step(dt: number = 1): void {
    if (this.adaptiveStepping) {
      // The step rule wants the closest interacting pair, which the tree can
      // find without visiting every pair. Positions and velocities have not
      // changed since the last force evaluation, so its tree still describes
      // the system exactly.
      const tree = this.usingBarnesHut() ? (this.tree ?? treeOf(this.particles)) : null;
      this.lastSubSteps = recommendedSubSteps(this.particles, this.G, dt, MAX_SUB_STEPS, tree);
    } else {
      this.lastSubSteps = 1;
    }

    const subStep = dt / this.lastSubSteps;
    for (let i = 0; i < this.lastSubSteps; i++) {
      // Where everything was before this sub-step, so contact detection can ask
      // what happened *along* the way rather than only where things ended up.
      const previous = this.particles.map((particle) => particle.position);

      this.integrate(subStep);
      this.resolveCollisions(previous);
    }

    // A collision in the last sub-step leaves accelerations stale, and the
    // renderer reads netForce as soon as this returns.
    if (this.forcesDirty) this.computeForces();

    for (const particle of this.particles) {
      particle.recordTrail();
    }
  }

  /**
   * Rebuild the vector field for the region of world space currently on
   * screen. `view` comes from the camera, so the field covers what the user
   * can actually see rather than a fixed box around the origin.
   */
  updateField(view: ViewBounds): void {
    // Sampling is O(n) per sample point over thousands of points, so the field
    // is usually the more expensive half of a frame — and it can share the tree
    // the force pass just built, since nothing has moved since.
    const tree = this.usingBarnesHut() ? (this.tree ?? treeOf(this.particles)) : null;
    this.vectorField.update(this.particles, this.G, view, tree, this.theta);
  }

  /** Step the simulation and rebuild the field. */
  update(view: ViewBounds, dt: number = 1): void {
    this.step(dt);
    this.updateField(view);
  }

  /**
   * Get particle at a specific position (for mouse interaction)
   */
  getParticleAt(x: number, y: number, threshold: number = 30): Particle | null {
    for (const particle of this.particles) {
      const distance = Math.sqrt(
        Math.pow(particle.position.x - x, 2) + Math.pow(particle.position.y - y, 2)
      );
      if (distance < threshold) {
        return particle;
      }
    }
    return null;
  }
}

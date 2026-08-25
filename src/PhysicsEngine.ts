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

/**
 * Gravitational constant. Not Newton's — a tuning value picked so that the
 * masses and distances the sliders offer produce forces the field can draw.
 * Exported because `presets.ts` derives its orbital velocities from it: a
 * preset built against a different G is simply a scene that flies apart.
 */
export const SIMULATION_G = 0.5;

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
    this.forcesDirty = true;
  }

  /**
   * Remove a particle from the simulation
   */
  removeParticle(particle: Particle): void {
    const index = this.particles.indexOf(particle);
    if (index > -1) {
      this.particles.splice(index, 1);
      this.forcesDirty = true;
    }
  }

  /**
   * Clear all particles
   */
  clearParticles(): void {
    this.particles = [];
    this.forcesDirty = true;
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
  }

  /**
   * One frame: however many sub-steps the closest pair needs, then one trail
   * point per particle.
   *
   * The trail records the frame, not the sub-steps — see `Particle.recordTrail`.
   */
  step(dt: number = 1): void {
    this.lastSubSteps = this.adaptiveStepping
      ? recommendedSubSteps(this.particles, this.G, dt, MAX_SUB_STEPS)
      : 1;

    const subStep = dt / this.lastSubSteps;
    for (let i = 0; i < this.lastSubSteps; i++) {
      this.integrate(subStep);
    }

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
    this.vectorField.update(this.particles, this.G, view);
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

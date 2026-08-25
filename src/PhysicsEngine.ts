import { Particle } from './Particle';
import { VectorField, ViewBounds } from './VectorField';

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
export class PhysicsEngine {
  particles: Particle[] = [];
  vectorField: VectorField;
  G: number = SIMULATION_G;

  constructor(baseGridSize: number = 30) {
    // Smaller grid size (30) for denser vector field visualization
    this.vectorField = new VectorField(baseGridSize);
  }

  /**
   * Add a particle to the simulation
   */
  addParticle(particle: Particle): void {
    this.particles.push(particle);
  }

  /**
   * Remove a particle from the simulation
   */
  removeParticle(particle: Particle): void {
    const index = this.particles.indexOf(particle);
    if (index > -1) {
      this.particles.splice(index, 1);
    }
  }

  /**
   * Clear all particles
   */
  clearParticles(): void {
    this.particles = [];
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

  /**
   * Integrate every particle forward by one step.
   *
   * `netForce` deliberately survives this call — the renderer reads it right
   * afterwards to draw each particle's force arrow.
   */
  integrate(dt: number = 1): void {
    for (const particle of this.particles) {
      particle.update(dt);
    }
  }

  /** One simulation step: forces, then integration. */
  step(dt: number = 1): void {
    this.computeForces();
    this.integrate(dt);
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

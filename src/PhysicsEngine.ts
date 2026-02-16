import { Particle } from './Particle';
import { VectorField } from './VectorField';

/**
 * Physics engine that handles gravity calculations and updates
 */
export class PhysicsEngine {
  particles: Particle[] = [];
  vectorField: VectorField;
  G: number = 0.5; // Gravitational constant
  private width: number;
  private height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    // Smaller grid size (30) for denser vector field visualization
    this.vectorField = new VectorField(width, height, 30);
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
   * Update all particles and vector field
   */
  update(): void {
    // Calculate gravitational forces between all particles
    for (let i = 0; i < this.particles.length; i++) {
      for (let j = i + 1; j < this.particles.length; j++) {
        const particleA = this.particles[i];
        const particleB = this.particles[j];

        // Calculate attraction force
        const force = particleA.attractionTo(particleB, this.G);

        // Apply equal and opposite forces (Newton's 3rd law)
        particleA.applyForce(force);
        particleB.applyForce(force.mult(-1));
      }
    }

    // Update all particles
    for (const particle of this.particles) {
      particle.update();
    }

    // Update vector field
    this.vectorField.update(this.particles, this.G);
  }

  /**
   * Resize the physics engine
   */
  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.vectorField.resize(width, height);
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

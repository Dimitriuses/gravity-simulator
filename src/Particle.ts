import { Vector2D } from './Vector2D';

/**
 * Represents a particle with mass in the gravity simulation
 */
export class Particle {
  position: Vector2D;
  velocity: Vector2D;
  acceleration: Vector2D;
  mass: number;
  radius: number;
  trail: Vector2D[] = [];
  maxTrailLength: number = 50;
  netForce: Vector2D = new Vector2D(0, 0); // Total gravitational force acting on this particle

  constructor(x: number, y: number, mass: number = 50, vx: number = 0, vy: number = 0) {
    this.position = new Vector2D(x, y);
    this.velocity = new Vector2D(vx, vy);
    this.acceleration = new Vector2D(0, 0);
    this.mass = mass;
    // Radius proportional to mass (cube root for area scaling)
    this.radius = Math.pow(mass, 1/3) * 2;
  }

  /**
   * Apply a force to the particle (F = ma, so a = F/m)
   */
  applyForce(force: Vector2D): void {
    // Track net force for visualization
    this.netForce = this.netForce.add(force);
    
    const acceleration = force.div(this.mass);
    this.acceleration = this.acceleration.add(acceleration);
  }

  /**
   * Update particle position and velocity
   */
  update(dt: number = 1): void {
    // Update velocity with acceleration
    this.velocity = this.velocity.add(this.acceleration.mult(dt));
    
    // Update position with velocity
    this.position = this.position.add(this.velocity.mult(dt));
    
    // Add current position to trail
    this.trail.push(this.position.copy());
    if (this.trail.length > this.maxTrailLength) {
      this.trail.shift();
    }
    
    // Reset acceleration and net force for next frame
    this.acceleration = new Vector2D(0, 0);
    this.netForce = new Vector2D(0, 0);
  }

  /**
   * Calculate gravitational force from another particle
   * F = G * m1 * m2 / r^2
   */
  attractionTo(other: Particle, G: number = 1): Vector2D {
    const direction = other.position.sub(this.position);
    const distanceSquared = direction.magnitudeSquared();
    
    // Prevent division by zero and extreme forces at very close distances
    const minDistance = (this.radius + other.radius);
    const clampedDistance = Math.max(distanceSquared, minDistance * minDistance);
    
    // Calculate force magnitude
    const forceMagnitude = (G * this.mass * other.mass) / clampedDistance;
    
    // Return force vector
    return direction.normalize().mult(forceMagnitude);
  }

  /**
   * Clear the trail
   */
  clearTrail(): void {
    this.trail = [];
  }
}

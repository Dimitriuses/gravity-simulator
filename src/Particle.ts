import { Vector2D } from './Vector2D';
import { gravitationalForce } from './forces';

/**
 * One recorded position, and whether the body *jumped* to get there.
 *
 * A merge moves the surviving body to the pair's centre of mass, which is a
 * real discontinuity rather than a fast piece of travel. Drawing a line across
 * it claims a path the body never took — visible in the README screenshots as a
 * kink in an otherwise smooth orbit — so the jump is recorded and the renderer
 * lifts the pen instead.
 */
export interface TrailPoint {
  position: Vector2D;
  jumped: boolean;
}

/**
 * Represents a particle with mass in the gravity simulation
 */
export class Particle {
  position: Vector2D;
  velocity: Vector2D;
  acceleration: Vector2D;
  mass: number;
  radius: number;
  trail: TrailPoint[] = [];

  /**
   * Set when something moved this body other than integration, and cleared by
   * the next `recordTrail()`.
   */
  private teleported = false;
  maxTrailLength: number = 50;
  netForce: Vector2D = new Vector2D(0, 0); // Total gravitational force acting on this particle

  constructor(x: number, y: number, mass: number = 50, vx: number = 0, vy: number = 0) {
    this.position = new Vector2D(x, y);
    this.velocity = new Vector2D(vx, vy);
    this.acceleration = new Vector2D(0, 0);
    this.mass = mass;
    this.radius = Particle.radiusForMass(mass);
  }

  /**
   * Radius of a body of this mass: `2 * m^(1/3)`.
   *
   * A body's radius is a pure function of its mass and nothing else. Contact
   * distance, the softening floor in the force law, the adaptive step rule's
   * clamp and the renderer all read it, so a body whose radius disagreed with
   * its mass would be a different size to every other body of the same mass and
   * would soften at the wrong distance.
   */
  static radiusForMass(mass: number): number {
    return Math.pow(mass, 1 / 3) * 2;
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
   * Clear the accumulated force and acceleration.
   *
   * Called at the *start* of a simulation step, before any force is applied —
   * deliberately not at the end of update(). `netForce` is what the renderer
   * draws as the orange force arrow, and it is read after the step completes,
   * so clearing it on the way out of update() would leave the renderer nothing
   * but zero to draw. See tests/PhysicsEngine.test.ts.
   */
  resetForces(): void {
    this.acceleration = new Vector2D(0, 0);
    this.netForce = new Vector2D(0, 0);
  }

  /**
   * Append the current position to the trail, dropping the oldest point once
   * the trail is full.
   *
   * Called once per *frame* by `PhysicsEngine.step()`, deliberately not once
   * per integration sub-step: adaptive stepping runs up to 64 sub-steps in a
   * frame, and a trail that recorded each of them would drain in a fraction of
   * a second and stutter in length as the sub-step count changed.
   */
  recordTrail(): void {
    this.trail.push({ position: this.position.copy(), jumped: this.teleported });
    this.teleported = false;

    if (this.trail.length > this.maxTrailLength) {
      this.trail.shift();
    }
  }

  /**
   * Swallow `other`, conserving mass and momentum.
   *
   * This body survives and keeps its identity, so its trail carries through the
   * collision rather than restarting; the caller drops the absorbed one from
   * the simulation. The merged body sits at the pair's centre of mass and
   * carries their combined momentum, which makes the merge perfectly inelastic
   * — kinetic energy is lost, as it is in any real merge.
   *
   * The new radius comes from the new mass, via the rule above. The roadmap
   * originally called for summing the two areas instead; that would make a
   * merged body wider than any other body of the same mass, and radius is
   * relied on as a function of mass in four other places.
   */
  absorb(other: Particle): void {
    const total = this.mass + other.mass;

    this.position = this.position
      .mult(this.mass)
      .add(other.position.mult(other.mass))
      .div(total);
    this.velocity = this.velocity
      .mult(this.mass)
      .add(other.velocity.mult(other.mass))
      .div(total);

    this.mass = total;
    this.radius = Particle.radiusForMass(total);

    // The body is now somewhere it never travelled to: everything between its
    // old position and the barycentre was skipped.
    this.teleported = true;
  }

  /**
   * Calculate gravitational force from another particle
   * F = G * m1 * m2 / r^2
   */
  attractionTo(other: Particle, G: number = 1): Vector2D {
    // The law itself lives in forces.ts, because the integrators need it at
    // positions no particle is currently at. Softening is part of it: below the
    // sum of the two radii the bodies are touching, and an unsoftened 1/r²
    // would launch them to infinity in a single step.
    return gravitationalForce(
      this.position,
      other.position,
      this.mass,
      other.mass,
      this.radius + other.radius,
      G
    );
  }

  /**
   * Clear the trail
   */
  clearTrail(): void {
    this.trail = [];
  }
}

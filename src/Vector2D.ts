/**
 * 2D Vector class for physics calculations
 */
export class Vector2D {
  constructor(public x: number = 0, public y: number = 0) {}

  /**
   * Add another vector to this vector
   */
  add(v: Vector2D): Vector2D {
    return new Vector2D(this.x + v.x, this.y + v.y);
  }

  /**
   * Subtract another vector from this vector
   */
  sub(v: Vector2D): Vector2D {
    return new Vector2D(this.x - v.x, this.y - v.y);
  }

  /**
   * Multiply vector by a scalar
   */
  mult(scalar: number): Vector2D {
    return new Vector2D(this.x * scalar, this.y * scalar);
  }

  /**
   * Divide vector by a scalar
   */
  div(scalar: number): Vector2D {
    if (scalar === 0) return new Vector2D(0, 0);
    return new Vector2D(this.x / scalar, this.y / scalar);
  }

  /**
   * Get the magnitude (length) of the vector
   */
  magnitude(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y);
  }

  /**
   * Get the squared magnitude (avoids sqrt for performance)
   */
  magnitudeSquared(): number {
    return this.x * this.x + this.y * this.y;
  }

  /**
   * Normalize the vector (make it unit length)
   */
  normalize(): Vector2D {
    const mag = this.magnitude();
    if (mag === 0) return new Vector2D(0, 0);
    return this.div(mag);
  }

  /**
   * Limit the magnitude of the vector
   */
  limit(max: number): Vector2D {
    const mag = this.magnitude();
    if (mag > max) {
      return this.normalize().mult(max);
    }
    return new Vector2D(this.x, this.y);
  }

  /**
   * Create a copy of this vector
   */
  copy(): Vector2D {
    return new Vector2D(this.x, this.y);
  }

  /**
   * Calculate distance to another vector
   */
  dist(v: Vector2D): number {
    return this.sub(v).magnitude();
  }

  /**
   * Static method to create a vector from angle and magnitude
   */
  static fromAngle(angle: number, magnitude: number = 1): Vector2D {
    return new Vector2D(Math.cos(angle) * magnitude, Math.sin(angle) * magnitude);
  }
}

import { Vector2D } from './Vector2D';
import { Particle } from './Particle';

/**
 * Represents a single vector sample point in the field
 */
interface VectorSample {
  position: Vector2D;
  force: Vector2D;
}

/**
 * Represents a vector field showing gravitational forces with adaptive density
 */
export class VectorField {
  samples: VectorSample[] = [];
  width: number;
  height: number;
  maxInfluenceRadius: number = 300; // Maximum range to show vectors (user-adjustable)
  baseGridSize: number = 30; // Base grid size for far-away vectors
  gridMode: 'uniform' | 'adaptive' = 'adaptive'; // Grid generation mode

  constructor(width: number, height: number, baseGridSize: number = 30) {
    this.width = width;
    this.height = height;
    this.baseGridSize = baseGridSize;
  }

  /**
   * Update the vector field with adaptive density
   * Denser near particles, sparser far away
   */
  update(particles: Particle[], G: number = 1): void {
    this.samples = [];

    // Early exit if no particles
    if (particles.length === 0) return;

    if (this.gridMode === 'uniform') {
      this.generateUniformGrid(particles, G);
    } else {
      this.generateAdaptiveGrid(particles, G);
    }
  }

  /**
   * Generate uniform grid covering the entire visible area
   */
  private generateUniformGrid(particles: Particle[], G: number): void {
    const gridSize = this.baseGridSize;
    
    // Generate grid points across entire visible area
    for (let x = -this.width / 2; x < this.width / 2; x += gridSize) {
      for (let y = -this.height / 2; y < this.height / 2; y += gridSize) {
        const samplePoint = new Vector2D(x, y);
        
        // Calculate force at this point
        let totalForce = new Vector2D(0, 0);
        let withinRange = false;

        for (const particle of particles) {
          const direction = particle.position.sub(samplePoint);
          const distanceSquared = direction.magnitudeSquared();
          
          // Skip if beyond user-defined max range
          if (distanceSquared > this.maxInfluenceRadius * this.maxInfluenceRadius) continue;
          
          withinRange = true;
          
          // Prevent extreme values
          const minDistSquared = Math.max(distanceSquared, particle.radius * particle.radius);
          
          // F = G * m / r^2
          const forceMagnitude = (G * particle.mass) / minDistSquared;
          const force = direction.normalize().mult(forceMagnitude);
          
          totalForce = totalForce.add(force);
        }

        // Only add sample if it's within range of at least one particle and has significant force
        if (withinRange && totalForce.magnitude() > 0.001) {
          this.samples.push({ position: samplePoint, force: totalForce });
        }
      }
    }
  }

  /**
   * Generate adaptive grid with density zones around each particle
   */
  private generateAdaptiveGrid(particles: Particle[], G: number): void {
    // For each particle, generate sample points with varying density
    for (const particle of particles) {
      // Use the user-defined maxInfluenceRadius directly
      const maxRadius = this.maxInfluenceRadius;

      // Define density zones (closer = denser)
      const zones = [
        { maxDist: maxRadius * 0.2, gridSize: this.baseGridSize * 0.3 },  // Very close: 30% spacing
        { maxDist: maxRadius * 0.4, gridSize: this.baseGridSize * 0.5 },  // Close: 50% spacing
        { maxDist: maxRadius * 0.7, gridSize: this.baseGridSize * 0.8 },  // Medium: 80% spacing
        { maxDist: maxRadius, gridSize: this.baseGridSize * 1.2 }          // Far: 120% spacing
      ];

      // Generate samples in each zone
      for (const zone of zones) {
        const innerRadius = zones.indexOf(zone) === 0 ? 0 : zones[zones.indexOf(zone) - 1].maxDist;
        this.generateSamplesInRing(particle, innerRadius, zone.maxDist, zone.gridSize, particles, G);
      }
    }
  }

  /**
   * Generate sample points in a ring around a particle
   */
  private generateSamplesInRing(
    particle: Particle,
    innerRadius: number,
    outerRadius: number,
    gridSize: number,
    allParticles: Particle[],
    G: number
  ): void {
    const centerX = particle.position.x;
    const centerY = particle.position.y;

    // Calculate bounds (world coordinates are centered at origin)
    const minX = Math.max(-this.width / 2, centerX - outerRadius);
    const maxX = Math.min(this.width / 2, centerX + outerRadius);
    const minY = Math.max(-this.height / 2, centerY - outerRadius);
    const maxY = Math.min(this.height / 2, centerY + outerRadius);

    // Generate grid points in this zone
    for (let x = minX; x < maxX; x += gridSize) {
      for (let y = minY; y < maxY; y += gridSize) {
        const dx = x - centerX;
        const dy = y - centerY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        // Only include if in this ring
        if (dist >= innerRadius && dist <= outerRadius) {
          // Check if this point already exists (avoid duplicates from overlapping particles)
          const exists = this.samples.some(s => 
            Math.abs(s.position.x - x) < gridSize * 0.5 && 
            Math.abs(s.position.y - y) < gridSize * 0.5
          );

          if (!exists) {
            const samplePoint = new Vector2D(x, y);
            const force = this.calculateForceAt(samplePoint, allParticles, G);
            
            if (force.magnitude() > 0.001) {
              this.samples.push({ position: samplePoint, force });
            }
          }
        }
      }
    }
  }

  /**
   * Calculate total gravitational force at a point
   */
  private calculateForceAt(point: Vector2D, particles: Particle[], G: number): Vector2D {
    let totalForce = new Vector2D(0, 0);

    for (const particle of particles) {
      const direction = particle.position.sub(point);
      const distanceSquared = direction.magnitudeSquared();
      
      // Skip if beyond user-defined max range
      if (distanceSquared > this.maxInfluenceRadius * this.maxInfluenceRadius) continue;
      
      // Prevent extreme values
      const minDistSquared = Math.max(distanceSquared, particle.radius * particle.radius);
      
      // F = G * m / r^2
      const forceMagnitude = (G * particle.mass) / minDistSquared;
      const force = direction.normalize().mult(forceMagnitude);
      
      totalForce = totalForce.add(force);
    }

    return totalForce;
  }

  /**
   * Resize the vector field
   */
  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  /**
   * Get all samples (for rendering)
   */
  getSamples(): VectorSample[] {
    return this.samples;
  }
}

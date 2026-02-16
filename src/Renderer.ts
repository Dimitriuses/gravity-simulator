import p5 from 'p5';
import { PhysicsEngine } from './PhysicsEngine';
import { Vector2D } from './Vector2D';

/**
 * Renderer for visualizing the gravity simulation
 */
export class Renderer {
  private p: p5;
  private engine: PhysicsEngine;
  showVectorField: boolean = true;
  showTrails: boolean = true;
  showParticleVectors: boolean = true; // Show force and velocity vectors on particles
  
  // Render settings
  particleSizeMultiplier: number = 1.0; // Multiplier for particle size
  arrowSizeMultiplier: number = 1.0; // Multiplier for arrow size
  
  private maxForceMagnitude: number = 0;
  private minForceMagnitude: number = 0;

  constructor(p: p5, engine: PhysicsEngine) {
    this.p = p;
    this.engine = engine;
  }

  /**
   * Draw the entire simulation
   */
  draw(): void {
    this.p.background(10, 15, 30);

    if (this.showVectorField) {
      this.drawVectorField();
    }

    if (this.showTrails) {
      this.drawTrails();
    }

    this.drawParticles();
    
    if (this.showParticleVectors) {
      this.drawParticleVectors();
    }
  }

  /**
   * Draw the vector field
   * Optimized: only draw non-zero vectors and calculate stats efficiently
   */
  private drawVectorField(): void {
    const samples = this.engine.vectorField.getSamples();

    // Early exit if no samples
    if (samples.length === 0) return;

    // First pass: find min and max force magnitudes
    this.maxForceMagnitude = 0;
    this.minForceMagnitude = Infinity;

    for (const sample of samples) {
      const mag = sample.force.magnitude();
      if (mag > 0.001) {
        this.maxForceMagnitude = Math.max(this.maxForceMagnitude, mag);
        this.minForceMagnitude = Math.min(this.minForceMagnitude, mag);
      }
    }

    // Ensure we have a valid range
    if (this.minForceMagnitude === Infinity) this.minForceMagnitude = 0;
    if (this.maxForceMagnitude === 0) this.maxForceMagnitude = 1;

    // Second pass: draw all samples
    for (const sample of samples) {
      this.drawArrow(sample.position.x, sample.position.y, sample.force);
    }
  }

  /**
   * Draw a single arrow for the vector field
   * Color gradient: Red (strong force) -> Yellow -> Green -> Cyan -> Blue (weak force)
   */
  private drawArrow(x: number, y: number, vector: Vector2D): void {
    const magnitude = vector.magnitude();
    
    // This shouldn't happen anymore, but safety check
    if (magnitude < 0.001) return;

    // Normalize magnitude for color and size mapping using logarithmic scale
    // This helps visualize both very small and very large forces
    const logMag = Math.log(magnitude + 1);
    const logMin = Math.log(this.minForceMagnitude + 1);
    const logMax = Math.log(this.maxForceMagnitude + 1);
    
    let normalizedMag = 0;
    if (logMax > logMin) {
      normalizedMag = (logMag - logMin) / (logMax - logMin);
    }
    
    // Clamp between 0 and 1
    normalizedMag = Math.max(0, Math.min(1, normalizedMag));

    // Color mapping: Red (0°) -> Yellow (60°) -> Green (120°) -> Cyan (180°) -> Blue (240°)
    // Invert so strong = red, weak = blue
    const hue = this.p.map(normalizedMag, 0, 1, 240, 0); // Blue to Red
    
    // Saturation and brightness for better visibility
    const saturation = this.p.map(normalizedMag, 0, 1, 60, 100);
    const brightness = 90;
    
    // Alpha based on magnitude (stronger = more opaque)
    const alpha = this.p.map(normalizedMag, 0, 1, 30, 90);
    
    this.p.push();
    this.p.colorMode(this.p.HSB, 360, 100, 100, 100);
    this.p.stroke(hue, saturation, brightness, alpha);
    this.p.fill(hue, saturation, brightness, alpha);

    // Arrow length proportional to force magnitude (with scaling)
    // Use logarithmic scaling for better visualization
    const baseScale = 25 * this.arrowSizeMultiplier; // Apply multiplier
    const arrowLength = baseScale * (0.2 + normalizedMag * 0.8);
    
    // Calculate arrow end point
    const direction = vector.normalize();
    const endX = x + direction.x * arrowLength;
    const endY = y + direction.y * arrowLength;

    // Stroke weight based on magnitude (thicker = stronger)
    const strokeWeight = this.p.map(normalizedMag, 0, 1, 1, 3) * this.arrowSizeMultiplier; // Apply multiplier
    this.p.strokeWeight(strokeWeight);

    // Draw line
    this.p.line(x, y, endX, endY);

    // Draw arrowhead (size proportional to magnitude)
    const angle = Math.atan2(direction.y, direction.x);
    const arrowheadSize = this.p.map(normalizedMag, 0, 1, 3, 8) * this.arrowSizeMultiplier; // Apply multiplier
    
    this.p.push();
    this.p.translate(endX, endY);
    this.p.rotate(angle);
    this.p.noStroke();
    this.p.triangle(
      -arrowheadSize, -arrowheadSize / 2,
      -arrowheadSize, arrowheadSize / 2,
      0, 0
    );
    this.p.pop();

    this.p.pop();
  }

  /**
   * Draw particle trails
   */
  private drawTrails(): void {
    for (const particle of this.engine.particles) {
      if (particle.trail.length < 2) continue;

      this.p.push();
      this.p.noFill();
      this.p.strokeWeight(1);

      for (let i = 0; i < particle.trail.length - 1; i++) {
        const alpha = this.p.map(i, 0, particle.trail.length - 1, 0, 100);
        this.p.stroke(200, 200, 255, alpha);
        
        const pos1 = particle.trail[i];
        const pos2 = particle.trail[i + 1];
        this.p.line(pos1.x, pos1.y, pos2.x, pos2.y);
      }

      this.p.pop();
    }
  }

  /**
   * Draw force and velocity vectors on particles
   */
  private drawParticleVectors(): void {
    for (const particle of this.engine.particles) {
      const pos = particle.position;
      
      // Draw net gravitational force vector (where it's being pulled)
      if (particle.netForce.magnitude() > 0.01) {
        this.drawParticleForceVector(pos.x, pos.y, particle.netForce);
      }
      
      // Draw velocity vector (where it's moving)
      if (particle.velocity.magnitude() > 0.01) {
        this.drawParticleVelocityVector(pos.x, pos.y, particle.velocity);
      }
    }
  }

  /**
   * Draw gravitational force vector on a particle (orange/red)
   */
  private drawParticleForceVector(x: number, y: number, force: any): void {
    this.p.push();
    
    // Orange/red color for force
    this.p.stroke(20, 100, 100, 90); // HSB: Orange
    this.p.fill(20, 100, 100, 90);
    this.p.strokeWeight(3 * this.arrowSizeMultiplier);
    
    // Scale force for visibility (logarithmic)
    const magnitude = force.magnitude();
    const scale = 30 * Math.log(magnitude + 1) / Math.log(10) * this.arrowSizeMultiplier;
    const direction = force.normalize();
    
    const endX = x + direction.x * scale;
    const endY = y + direction.y * scale;
    
    // Draw line
    this.p.line(x, y, endX, endY);
    
    // Draw arrowhead
    const angle = Math.atan2(direction.y, direction.x);
    const arrowSize = 8 * this.arrowSizeMultiplier;
    
    this.p.push();
    this.p.translate(endX, endY);
    this.p.rotate(angle);
    this.p.noStroke();
    this.p.triangle(-arrowSize, -arrowSize / 2, -arrowSize, arrowSize / 2, 0, 0);
    this.p.pop();
    
    this.p.pop();
  }

  /**
   * Draw velocity vector on a particle (cyan/blue)
   */
  private drawParticleVelocityVector(x: number, y: number, velocity: any): void {
    this.p.push();
    
    // Cyan color for velocity
    this.p.stroke(180, 100, 100, 90); // HSB: Cyan
    this.p.fill(180, 100, 100, 90);
    this.p.strokeWeight(3 * this.arrowSizeMultiplier);
    
    // Scale velocity for visibility
    const magnitude = velocity.magnitude();
    const scale = 10 * this.arrowSizeMultiplier; // Velocity already has reasonable magnitude
    const direction = velocity.normalize();
    
    const endX = x + direction.x * magnitude * scale;
    const endY = y + direction.y * magnitude * scale;
    
    // Draw line
    this.p.line(x, y, endX, endY);
    
    // Draw arrowhead
    const angle = Math.atan2(direction.y, direction.x);
    const arrowSize = 8 * this.arrowSizeMultiplier;
    
    this.p.push();
    this.p.translate(endX, endY);
    this.p.rotate(angle);
    this.p.noStroke();
    this.p.triangle(-arrowSize, -arrowSize / 2, -arrowSize, arrowSize / 2, 0, 0);
    this.p.pop();
    
    this.p.pop();
  }

  /**
   * Draw all particles
   */
  private drawParticles(): void {
    for (const particle of this.engine.particles) {
      this.drawParticle(particle);
    }
  }

  /**
   * Draw a single particle
   */
  private drawParticle(particle: any): void {
    this.p.push();

    // Apply size multiplier
    const visualRadius = particle.radius * this.particleSizeMultiplier;

    // Outer glow
    this.p.noStroke();
    this.p.fill(100, 150, 255, 30);
    this.p.circle(particle.position.x, particle.position.y, visualRadius * 3);

    // Main body
    this.p.fill(150, 200, 255);
    this.p.stroke(200, 220, 255);
    this.p.strokeWeight(2);
    this.p.circle(particle.position.x, particle.position.y, visualRadius * 2);

    // Mass indicator (text) - scale text size with particle size
    this.p.fill(255);
    this.p.noStroke();
    this.p.textAlign(this.p.CENTER, this.p.CENTER);
    this.p.textSize(Math.max(8, Math.min(14, 10 * this.particleSizeMultiplier)));
    this.p.text(Math.round(particle.mass), particle.position.x, particle.position.y);

    this.p.pop();
  }

  /**
   * Draw a preview arrow for adding velocity
   */
  drawVelocityPreview(startX: number, startY: number, endX: number, endY: number): void {
    this.p.push();
    this.p.stroke(255, 200, 0);
    this.p.strokeWeight(2);
    this.p.line(startX, startY, endX, endY);

    // Draw arrowhead
    const angle = Math.atan2(endY - startY, endX - startX);
    const arrowSize = 10;
    
    this.p.fill(255, 200, 0);
    this.p.push();
    this.p.translate(endX, endY);
    this.p.rotate(angle);
    this.p.triangle(-arrowSize, -arrowSize / 2, -arrowSize, arrowSize / 2, 0, 0);
    this.p.pop();

    this.p.pop();
  }
}

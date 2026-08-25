import p5 from 'p5';
import { PhysicsEngine } from './PhysicsEngine';
import { Particle } from './Particle';
import { Vector2D } from './Vector2D';

/**
 * Shortest and longest a particle's force/velocity arrow may be drawn, in world
 * units before the user's arrow-size multiplier. Magnitudes here span several
 * orders of magnitude (mass 100–5000 against separations of 10–2000 px), so
 * arrow length is mapped logarithmically into this band rather than being
 * proportional to the raw value — an absolute scale renders almost every real
 * arrow either sub-pixel or off-screen.
 */
const PARTICLE_ARROW_MIN_LENGTH = 18;
const PARTICLE_ARROW_MAX_LENGTH = 60;

/** Below these, an arrow says nothing worth the clutter. */
const MIN_DRAWN_FORCE = 1e-6;
const MIN_DRAWN_SPEED = 0.01;

/** Colours, RGB. These match the on-page legend in index.html. */
const COLOR_BACKGROUND = [10, 15, 30] as const;
const COLOR_FORCE_ARROW = [255, 136, 0] as const; // #ff8800
const COLOR_VELOCITY_ARROW = [0, 255, 255] as const; // #00ffff
const COLOR_TRAIL = [200, 200, 255] as const;

/**
 * Number of alpha steps a trail fades through. Each band is one polyline, so
 * this is also the number of stroke-state changes per trail per frame — the
 * cost that used to scale with trail length.
 */
const TRAIL_BANDS = 16;
const COLOR_PARTICLE_GLOW = [100, 150, 255] as const;
const COLOR_PARTICLE_BODY = [150, 200, 255] as const;
const COLOR_PARTICLE_EDGE = [200, 220, 255] as const;
const COLOR_VELOCITY_PREVIEW = [255, 200, 0] as const;

/**
 * Maps a magnitude onto 0..1 within the range present this frame, on a log
 * scale. Returns 0.5 when there is nothing to compare against, so a lone
 * particle still gets a mid-length arrow rather than the shortest possible one.
 */
function logNormalize(value: number, min: number, max: number): number {
  const logMin = Math.log(min + 1);
  const logMax = Math.log(max + 1);
  if (!(logMax > logMin)) return 0.5;
  const t = (Math.log(value + 1) - logMin) / (logMax - logMin);
  return Math.max(0, Math.min(1, t));
}

/**
 * Renderer for visualizing the gravity simulation.
 *
 * Everything here draws in world space; the caller applies the camera
 * transform first. The renderer assumes p5's default RGB colour mode and
 * switches to HSB only inside the vector-field pass, where hue carries meaning.
 */
export class Renderer {
  private p: p5;
  private engine: PhysicsEngine;
  showVectorField: boolean = true;
  showTrails: boolean = true;
  showParticleVectors: boolean = true; // Show force and velocity vectors on particles

  // Render settings
  particleSizeMultiplier: number = 1.0;
  arrowSizeMultiplier: number = 1.0;

  constructor(p: p5, engine: PhysicsEngine) {
    this.p = p;
    this.engine = engine;
  }

  /**
   * Draw the entire simulation
   */
  draw(): void {
    this.p.background(...COLOR_BACKGROUND);

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
   * Draw the vector field.
   *
   * Colour and length are both driven by force magnitude, normalized against
   * the range present in this frame so the field stays legible whatever the
   * masses and distances are.
   */
  private drawVectorField(): void {
    const samples = this.engine.vectorField.getSamples();
    if (samples.length === 0) return;

    // First pass: the frame's magnitude range.
    let maxMagnitude = 0;
    let minMagnitude = Infinity;
    for (const sample of samples) {
      const mag = sample.force.magnitude();
      if (mag > MIN_DRAWN_FORCE) {
        if (mag > maxMagnitude) maxMagnitude = mag;
        if (mag < minMagnitude) minMagnitude = mag;
      }
    }
    if (minMagnitude === Infinity) return;

    // One push for the whole pass rather than one per arrow — with a few
    // thousand samples a frame, the per-arrow state save was pure overhead.
    this.p.push();
    this.p.colorMode(this.p.HSB, 360, 100, 100, 100);

    for (const sample of samples) {
      this.drawFieldArrow(sample.position, sample.force, minMagnitude, maxMagnitude);
    }

    this.p.pop();
  }

  /**
   * One vector-field arrow.
   * Hue runs Red (strong) -> Yellow -> Green -> Cyan -> Blue (weak).
   * Requires HSB colour mode, set once by the caller.
   */
  private drawFieldArrow(
    position: Vector2D,
    vector: Vector2D,
    minMagnitude: number,
    maxMagnitude: number
  ): void {
    const magnitude = vector.magnitude();
    if (magnitude <= MIN_DRAWN_FORCE) return;

    const t = logNormalize(magnitude, minMagnitude, maxMagnitude);

    const hue = this.p.map(t, 0, 1, 240, 0); // Blue -> Red
    const saturation = this.p.map(t, 0, 1, 60, 100);
    const brightness = 90;
    const alpha = this.p.map(t, 0, 1, 30, 90);

    this.p.stroke(hue, saturation, brightness, alpha);
    this.p.fill(hue, saturation, brightness, alpha);
    this.p.strokeWeight(this.p.map(t, 0, 1, 1, 3) * this.arrowSizeMultiplier);

    const arrowLength = 25 * this.arrowSizeMultiplier * (0.2 + t * 0.8);
    const direction = vector.normalize();
    const endX = position.x + direction.x * arrowLength;
    const endY = position.y + direction.y * arrowLength;

    this.p.line(position.x, position.y, endX, endY);
    this.drawArrowhead(endX, endY, direction, this.p.map(t, 0, 1, 3, 8) * this.arrowSizeMultiplier);
  }

  /**
   * Draw particle trails, fading towards the oldest end.
   *
   * Drawn as `TRAIL_BANDS` polylines per particle rather than one `line()` per
   * point pair. A per-segment fade needs a `stroke()` before every segment, and
   * that state change is the whole cost: at the figure-eight preset's
   * period-length trail it was 7,800 stroke-and-line pairs a frame and pinned
   * the app at 30fps. Banding makes it 48 shape draws for the same picture —
   * the fade is 16 steps instead of 2,600, which is not visible on a trail that
   * is fading out anyway.
   */
  private drawTrails(): void {
    this.p.push();
    this.p.noFill();
    this.p.strokeWeight(1);

    for (const particle of this.engine.particles) {
      const trail = particle.trail;
      if (trail.length < 2) continue;

      const bandSize = Math.max(1, Math.ceil((trail.length - 1) / TRAIL_BANDS));

      for (let start = 0; start < trail.length - 1; start += bandSize) {
        // The band's alpha is taken from its midpoint, so the fade is centred
        // on the same curve the per-segment version drew.
        const end = Math.min(start + bandSize, trail.length - 1);
        const alpha = this.p.map((start + end) / 2, 0, trail.length - 1, 0, 255);
        this.p.stroke(...COLOR_TRAIL, alpha);

        this.p.beginShape();
        for (let i = start; i <= end; i++) {
          this.p.vertex(trail[i].x, trail[i].y);
        }
        this.p.endShape();
      }
    }

    this.p.pop();
  }

  /**
   * Draw the force and velocity arrow on every particle.
   *
   * Both are normalized against the range across all particles this frame, so
   * the arrows compare bodies against each other and stay on-screen whatever
   * the absolute magnitudes are.
   */
  private drawParticleVectors(): void {
    const particles = this.engine.particles;
    if (particles.length === 0) return;

    const forces = particles.map((p) => p.netForce.magnitude());
    const speeds = particles.map((p) => p.velocity.magnitude());

    const forceRange = { min: Math.min(...forces), max: Math.max(...forces) };
    const speedRange = { min: Math.min(...speeds), max: Math.max(...speeds) };

    this.p.push();
    for (const particle of particles) {
      const force = particle.netForce.magnitude();
      if (force > MIN_DRAWN_FORCE) {
        this.drawParticleArrow(
          particle,
          particle.netForce,
          logNormalize(force, forceRange.min, forceRange.max),
          COLOR_FORCE_ARROW
        );
      }

      const speed = particle.velocity.magnitude();
      if (speed > MIN_DRAWN_SPEED) {
        this.drawParticleArrow(
          particle,
          particle.velocity,
          logNormalize(speed, speedRange.min, speedRange.max),
          COLOR_VELOCITY_ARROW
        );
      }
    }
    this.p.pop();
  }

  /**
   * One particle arrow, starting at the edge of the body so it does not sit
   * underneath the mass label.
   */
  private drawParticleArrow(
    particle: Particle,
    vector: Vector2D,
    t: number,
    color: readonly [number, number, number]
  ): void {
    const direction = vector.normalize();
    const length =
      (PARTICLE_ARROW_MIN_LENGTH + (PARTICLE_ARROW_MAX_LENGTH - PARTICLE_ARROW_MIN_LENGTH) * t) *
      this.arrowSizeMultiplier;

    const startOffset = particle.radius * this.particleSizeMultiplier;
    const startX = particle.position.x + direction.x * startOffset;
    const startY = particle.position.y + direction.y * startOffset;
    const endX = startX + direction.x * length;
    const endY = startY + direction.y * length;

    this.p.stroke(...color, 230);
    this.p.fill(...color, 230);
    this.p.strokeWeight(3 * this.arrowSizeMultiplier);
    this.p.line(startX, startY, endX, endY);
    this.drawArrowhead(endX, endY, direction, 8 * this.arrowSizeMultiplier);
  }

  /**
   * Filled triangle at (x, y) pointing along `direction`.
   */
  private drawArrowhead(x: number, y: number, direction: Vector2D, size: number): void {
    this.p.push();
    this.p.translate(x, y);
    this.p.rotate(Math.atan2(direction.y, direction.x));
    this.p.noStroke();
    this.p.triangle(-size, -size / 2, -size, size / 2, 0, 0);
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
  private drawParticle(particle: Particle): void {
    this.p.push();

    const visualRadius = particle.radius * this.particleSizeMultiplier;

    // Outer glow
    this.p.noStroke();
    this.p.fill(...COLOR_PARTICLE_GLOW, 30);
    this.p.circle(particle.position.x, particle.position.y, visualRadius * 3);

    // Main body
    this.p.fill(...COLOR_PARTICLE_BODY);
    this.p.stroke(...COLOR_PARTICLE_EDGE);
    this.p.strokeWeight(2);
    this.p.circle(particle.position.x, particle.position.y, visualRadius * 2);

    // Mass label, scaled with the particle but kept legible
    this.p.fill(20, 30, 50);
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
    this.p.stroke(...COLOR_VELOCITY_PREVIEW);
    this.p.fill(...COLOR_VELOCITY_PREVIEW);
    this.p.strokeWeight(2);
    this.p.line(startX, startY, endX, endY);

    const direction = new Vector2D(endX - startX, endY - startY).normalize();
    this.drawArrowhead(endX, endY, direction, 10);

    this.p.pop();
  }
}

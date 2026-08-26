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
 * Streamlines are drawn in one colour rather than on the strength ramp: their
 * job is to show the shape of the flow, and colouring them by magnitude as well
 * makes two variables compete for the same picture. Strength is what the arrow
 * modes are for.
 */
const COLOR_STREAMLINE = [130, 190, 235] as const;

/**
 * Number of alpha steps a trail fades through. Each band is one polyline, so
 * this is also the number of stroke-state changes per trail per frame — the
 * cost that used to scale with trail length.
 */
const TRAIL_BANDS = 16;

/**
 * Below this on-screen diameter a body gets no mass label.
 *
 * A label needs room for three or four digits, and a body smaller than this
 * cannot give it any — the text would be drawn, cost the frame its most
 * expensive call, and be illegible.
 */
const MIN_LABELLED_DIAMETER_PX = 18;

/**
 * HSV to RGB, for the one place that writes pixels directly.
 *
 * Everything else asks p5 for a colour, but `image.pixels` is a raw byte array
 * and p5's colour object would have to be built and unpacked per pixel.
 */
function hsvToRgb(hue: number, saturation: number, value: number): [number, number, number] {
  const c = value * saturation;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = value - c;

  const [r, g, b] =
    hue < 60
      ? [c, x, 0]
      : hue < 120
        ? [x, c, 0]
        : hue < 180
          ? [0, c, x]
          : hue < 240
            ? [0, x, c]
            : hue < 300
              ? [x, 0, c]
              : [c, 0, x];

  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
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

  /**
   * Screen pixels per world unit — the camera's zoom, pushed in by main each
   * frame.
   *
   * Everything here draws in world coordinates, so nothing else needs it; the
   * exception is deciding whether a mass label is large enough on screen to be
   * worth drawing. See `drawParticles`.
   */
  zoom: number = 1;

  /**
   * The range of field magnitudes drawn in the last frame, and the levels the
   * contours traced — whichever the mode produced.
   *
   * Arrow length and hue are both normalized against the range *present in the
   * frame*, so without publishing the two ends of it the picture is
   * self-consistent and unreadable in absolute terms: the legend can say which
   * colour is strong, but not how strong. This is what lets it say the number.
   */
  fieldScale: { min: number; max: number } | null = null;

  /** Reused between frames; see `drawHeightmap`. */
  private heightmapImage: p5.Image | null = null;

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
      this.drawField();
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
  /** Draw whichever picture of the field the current mode produced. */
  private drawField(): void {
    this.fieldScale = null;

    const mode = this.engine.vectorField.fieldMode;
    if (mode === 'contours') {
      this.drawContours();
      return;
    }
    if (mode === 'heightmap') {
      this.drawHeightmap();
      return;
    }
    if (mode === 'streamlines') {
      this.drawStreamlines();
      return;
    }

    this.drawVectorField();
  }

  /**
   * Equipotential lines, coloured by depth on the same ramp the arrows use:
   * red for the deep well, blue for the shallows.
   *
   * Drawn as one polyline pass per level rather than per segment, for the same
   * reason the trails are banded — the stroke change is the cost.
   */
  private drawContours(): void {
    const lines = this.engine.vectorField.getContours();
    if (lines.length === 0) return;

    // Levels come back deepest-first; the ends of that range are what the
    // legend reports.
    const levels = lines.map((line) => Math.abs(line.level));
    this.fieldScale = { min: Math.min(...levels), max: Math.max(...levels) };

    this.p.push();
    this.p.colorMode(this.p.HSB, 360, 100, 100, 100);
    this.p.noFill();
    this.p.strokeWeight(1 / this.zoom);

    const logMin = Math.log(this.fieldScale.min);
    const logMax = Math.log(this.fieldScale.max);

    for (const line of lines) {
      const t =
        logMax === logMin ? 0.5 : (Math.log(Math.abs(line.level)) - logMin) / (logMax - logMin);
      // Same ramp as the arrows: blue is weak and far, red is deep and close.
      this.p.stroke(240 - t * 240, 85, 95, 70);

      for (const segment of line.segments) {
        this.p.line(segment.from.x, segment.from.y, segment.to.x, segment.to.y);
      }
    }

    this.p.pop();
  }

  /**
   * The potential as shaded ground: deep wells bright, flat space dark.
   *
   * Drawn as a small `p5.Image` stretched over the view rather than as one
   * rectangle per cell. A few thousand `rect()` calls a frame is exactly the
   * kind of per-item state change that made the trails and the particle pass
   * expensive; writing pixels and letting the canvas scale the result costs one
   * draw call, and the interpolation it does on the way up is the smooth
   * gradient a heightmap wants anyway.
   *
   * The scale is logarithmic in |potential|, for the same reason the contour
   * levels are: the value spans orders of magnitude across a single view, and
   * a linear ramp puts every visible change inside the innermost few pixels.
   */
  private drawHeightmap(): void {
    const grid = this.engine.vectorField.getHeightmap();
    if (!grid || grid.min >= 0) return;

    const view = this.engine.vectorField.lastView;
    if (!view) return;

    const deepest = Math.abs(grid.min);
    const shallowest = Math.max(Math.abs(grid.max), deepest * 1e-4);
    this.fieldScale = { min: shallowest, max: deepest };

    const logMin = Math.log(shallowest);
    const logMax = Math.log(deepest);
    const columns = grid.columns + 1;
    const rows = grid.rows + 1;

    // The image is reused between frames: allocating one per frame is a
    // megabyte of garbage a second at this resolution.
    if (!this.heightmapImage || this.heightmapImage.width !== columns || this.heightmapImage.height !== rows) {
      this.heightmapImage = this.p.createImage(columns, rows);
    }

    const image = this.heightmapImage;
    image.loadPixels();

    for (let i = 0; i < columns * rows; i++) {
      const magnitude = Math.abs(grid.values[i]);
      const t =
        logMax === logMin
          ? 0
          : Math.min(1, Math.max(0, (Math.log(Math.max(magnitude, shallowest)) - logMin) / (logMax - logMin)));

      // Same reading as everywhere else: blue is weak and far, red is deep.
      // Value rises with depth too, so the wells glow rather than merely
      // changing hue — which is what makes it read as terrain.
      const [r, g, b] = hsvToRgb(240 - t * 240, 0.85, 0.15 + t * 0.85);
      const pixel = i * 4;
      image.pixels[pixel] = r;
      image.pixels[pixel + 1] = g;
      image.pixels[pixel + 2] = b;
      image.pixels[pixel + 3] = 235;
    }

    image.updatePixels();
    this.p.push();
    this.p.image(image, view.minX, view.minY, view.maxX - view.minX, view.maxY - view.minY);
    this.p.pop();
  }

  /**
   * Streamlines, as polylines with an arrowhead partway along so the direction
   * of the flow is visible.
   */
  private drawStreamlines(): void {
    const lines = this.engine.vectorField.getStreamlines();
    if (lines.length === 0) return;

    this.p.push();
    this.p.noFill();
    this.p.stroke(...COLOR_STREAMLINE);
    this.p.strokeWeight(1 / this.zoom);

    for (const line of lines) {
      this.p.beginShape();
      for (const point of line) this.p.vertex(point.x, point.y);
      this.p.endShape();
    }

    // Arrowheads in a second pass: they are filled, and switching fill state
    // per line would cost more than the heads do.
    this.p.fill(...COLOR_STREAMLINE);
    this.p.noStroke();

    for (const line of lines) {
      if (line.length < 4) continue;

      const at = Math.floor(line.length / 2);
      const direction = line[at].sub(line[at - 1]);
      if (direction.magnitude() === 0) continue;

      this.drawArrowhead(line[at].x, line[at].y, direction.normalize(), 5 / this.zoom);
    }

    this.p.pop();
  }

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

    this.fieldScale = { min: minMagnitude, max: maxMagnitude };

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

        // A jump breaks the band into separate polylines: the body was moved
        // there rather than travelling there, and joining the two would draw a
        // segment it never covered.
        this.p.beginShape();
        for (let i = start; i <= end; i++) {
          if (i > start && trail[i].jumped) {
            this.p.endShape();
            this.p.beginShape();
          }
          this.p.vertex(trail[i].position.x, trail[i].position.y);
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
  /**
   * Draw every body: glows, then bodies, then labels.
   *
   * One pass per layer rather than one pass per body, because `fill()` and
   * `stroke()` build a colour object each time they are called and that state
   * change — not the geometry — is the cost. Six state changes per body became
   * six per frame.
   *
   * The label pass is skipped entirely when bodies are too small on screen to
   * hold a label: `text()` is the most expensive call in this file, and at the
   * galaxy preset's 22% zoom a label is about two pixels tall, so it was being
   * paid for and not read. Four hundred bodies cost 83 ms a frame before both
   * changes and 22 ms after.
   *
   * Drawing all the glows first also means a glow can no longer be painted over
   * a body drawn earlier in the list, which is what used to happen wherever two
   * bodies overlapped.
   */
  private drawParticles(): void {
    const particles = this.engine.particles;
    if (particles.length === 0) return;

    this.p.push();

    this.p.noStroke();
    this.p.fill(...COLOR_PARTICLE_GLOW, 30);
    for (const particle of particles) {
      const visualRadius = particle.radius * this.particleSizeMultiplier;
      this.p.circle(particle.position.x, particle.position.y, visualRadius * 3);
    }

    this.p.fill(...COLOR_PARTICLE_BODY);
    this.p.stroke(...COLOR_PARTICLE_EDGE);
    this.p.strokeWeight(2);
    for (const particle of particles) {
      const visualRadius = particle.radius * this.particleSizeMultiplier;
      this.p.circle(particle.position.x, particle.position.y, visualRadius * 2);
    }

    this.drawMassLabels(particles);

    this.p.pop();
  }

  /** Mass labels, for the bodies large enough on screen to carry one. */
  private drawMassLabels(particles: Particle[]): void {
    const smallestLabelled = MIN_LABELLED_DIAMETER_PX / (2 * this.particleSizeMultiplier * this.zoom);

    let any = false;
    for (const particle of particles) {
      if (particle.radius >= smallestLabelled) {
        any = true;
        break;
      }
    }
    if (!any) return;

    this.p.fill(20, 30, 50);
    this.p.noStroke();
    this.p.textAlign(this.p.CENTER, this.p.CENTER);
    this.p.textSize(Math.max(8, Math.min(14, 10 * this.particleSizeMultiplier)));

    for (const particle of particles) {
      if (particle.radius < smallestLabelled) continue;
      this.p.text(Math.round(particle.mass), particle.position.x, particle.position.y);
    }
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

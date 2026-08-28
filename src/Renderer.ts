import p5 from 'p5';
import { PhysicsEngine } from './PhysicsEngine';
import { Particle } from './Particle';
import { Vector2D } from './Vector2D';
import type { ContourLine } from './contours';
import { niceScaleLength } from './scalebar';

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

/**
 * Nothing here needs a magnitude threshold any more.
 *
 * The field pass used to drop samples below an absolute 1e-6 as it drew them,
 * which is the same mistake `VectorField` made one layer down and which roadmap
 * M17 removed from both: the sampler now filters against a fraction of the
 * strongest force in the frame, so everything that reaches the renderer is
 * already worth drawing, and a second absolute constant on top of it could only
 * disagree. The per-body arrows lost theirs in M14 for the same reason.
 */

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

/** Below this on-screen diameter a body's spin marker is not worth drawing. */
const MIN_SPUN_DIAMETER_PX = 10;

/** The radius line that shows which way a body is facing. */
const COLOR_SPIN_MARKER = [40, 60, 110] as const;

/** On-screen size of a contour's level label. */
const CONTOUR_LABEL_PX = 10;

/** Two significant figures, which is all a label on a line has room for. */
function formatLevel(value: number): string {
  const [mantissa, exponent] = Math.abs(value).toExponential(1).split('e');
  const power = Number(exponent);
  return power === 0 ? mantissa : `${mantissa}e${power}`;
}

/** The ruler along the bottom of the canvas. */
const COLOR_SCALE_BAR = [150, 165, 190] as const;

/**
 * The ring drawn around a body the camera is following, and the debug
 * overlay's text and backing.
 *
 * Both are deliberately not the body colours: a viewer has to be able to tell
 * at a glance which of two similar-looking dots the camera is holding on to,
 * and an overlay of numbers that reads as part of the simulation is worse than
 * no overlay.
 */
const COLOR_FOLLOW_RING = [255, 200, 0] as const;
const COLOR_DEBUG_TEXT = [190, 210, 240] as const;
const COLOR_DEBUG_PANEL = [10, 15, 30, 200] as const;

/**
 * The smallest a body is ever drawn, in screen pixels across.
 *
 * Sizes and distances in a real system cannot share a zoom: the Sun is 109
 * Earths wide, and the Earth's orbit is 23,000 Suns around. At the zoom that
 * frames the solar system preset's orbits, the Earth is a fiftieth of a pixel
 * and would simply not be there.
 *
 * So distance stays exact and size stops shrinking. Above this the picture is
 * to scale; below it every body is the same dot, which is the honest way for a
 * pixel to say "something is here, and it is smaller than me".
 */
const MIN_DRAWN_DIAMETER_PX = 3;

/** How far outside a followed body its ring sits, in screen pixels. */
const FOLLOW_RING_MARGIN_PX = 8;
/** ...and the smallest ring drawn, so a distant body still shows one. */
const FOLLOW_RING_MIN_RADIUS_PX = 10;

/** How far above the bottom edge the ruler sits. */
const SCALE_BAR_MARGIN_PX = 28;


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

/** A magnitude range, pinned so that arrows mean the same thing between frames. */
export interface LockedScales {
  /** The field's own range, when the mode drawing it had one. */
  field: { min: number; max: number } | null;
  /**
   * The range of *potentials*, when a mode that draws them was up.
   *
   * Separate from `field` because it is a different quantity in different
   * units: a force range pinned in an arrow mode would be a meaningless number
   * to a contour. Kept alongside rather than instead, so that switching between
   * an arrow mode and a potential mode does not throw away either lock.
   */
  potential: { min: number; max: number } | null;
  /** Net force across the bodies, and their speeds. */
  force: { min: number; max: number };
  speed: { min: number; max: number };
}

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

  /**
   * A pinned set of magnitude ranges, or null to normalize per frame.
   *
   * Everything about the arrows is otherwise relative to the frame they are
   * drawn in, which is what keeps them legible across the ~10⁶ span the sliders
   * can produce and what makes two frames incomparable by eye. Pinning the
   * range fixes that at the price the relative version was paying it for: a
   * scene that collapses after the lock is set saturates, and one that flies
   * apart fades out. Hence a control rather than a default, and hence the
   * legend having to say which of the two it is showing.
   *
   * The field entry is only meaningful for the arrow modes. Contours and the
   * heightmap draw *potential*, and streamlines have no magnitude at all, so
   * the lock does not apply to them and they go on publishing their own range —
   * a locked force range would be a number in the wrong units.
   */
  scaleLock: LockedScales | null = null;

  /**
   * Set when the viewer asks for a lock, cleared once a frame has filled it in.
   *
   * The ranges only exist part-way through a draw, so a lock asked for between
   * frames has nothing to capture yet; this defers it by one frame rather than
   * capturing an empty scale or making the caller wait for a callback.
   */
  private lockRequested = false;

  /**
   * Whether a lock was requested when this frame started.
   *
   * The request is cleared at the *end* of `draw()`, not by whichever pass
   * happens to fill in a part of it: which passes run depends on the field mode
   * and on two checkboxes, so no single pass can know whether it is the last
   * one. An earlier version cleared the flag when the field and the per-body
   * ranges were both present, and a lock set while a contour was on screen was
   * therefore never satisfied at all.
   */

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

    // Everything that was going to draw has drawn, so whatever it captured is
    // the whole of what there was to capture.
    this.lockRequested = false;
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
    const drawn = { min: Math.min(...levels), max: Math.max(...levels) };

    if (this.lockRequested) this.captureLock({ potential: drawn });

    // The locked range if there is one. The *levels* are pinned as well as the
    // colours, which is the half that matters: a contour whose value is chosen
    // from each frame's range is a different curve every frame, and colouring
    // it consistently would not make two frames comparable. `VectorField` is
    // told the range before it traces — see `main`.
    this.fieldScale = this.scaleLock?.potential ?? drawn;

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

    this.drawContourLabels(lines);
    this.p.pop();
  }

  /**
   * Write the level on every other contour, near the middle of the view.
   *
   * The legend gives the range of potentials on screen; it cannot say which
   * line is which. Labelling all of them is clutter — every other one is enough
   * to read the gradient, and choosing the segment nearest the middle height of
   * the view lines the labels up in a rough ladder, the way a contour map does
   * it.
   */
  private drawContourLabels(lines: ContourLine[]): void {
    const view = this.engine.vectorField.lastView;
    if (!view) return;

    const middleY = (view.minY + view.maxY) / 2;

    this.p.textAlign(this.p.CENTER, this.p.CENTER);
    // Constant on screen: a world-space size would be unreadable when zoomed
    // out and enormous when zoomed in.
    this.p.textSize(CONTOUR_LABEL_PX / this.zoom);
    this.p.noStroke();

    for (let i = 0; i < lines.length; i += 2) {
      const line = lines[i];

      // The segment closest to the middle height, so the labels sit in a row.
      let best = null as { x: number; y: number } | null;
      let bestDistance = Infinity;

      for (const segment of line.segments) {
        const x = (segment.from.x + segment.to.x) / 2;
        const y = (segment.from.y + segment.to.y) / 2;
        const distance = Math.abs(y - middleY);

        if (distance < bestDistance) {
          bestDistance = distance;
          best = { x, y };
        }
      }

      if (!best) continue;

      this.p.fill(0, 0, 100, 75);
      this.p.text(formatLevel(line.level), best.x, best.y);
    }
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

    const seen = {
      min: Math.max(Math.abs(grid.max), Math.abs(grid.min) * 1e-4),
      max: Math.abs(grid.min),
    };

    if (this.lockRequested) this.captureLock({ potential: seen });

    // Values outside a locked range are clamped rather than dropped, which is
    // what makes the shading comparable between frames: a well that deepens
    // past the lock saturates instead of rescaling everything around it.
    const range = this.scaleLock?.potential ?? seen;
    this.fieldScale = range;

    const shallowest = range.min;
    const logMin = Math.log(range.min);
    const logMax = Math.log(range.max);
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
      if (mag > 0) {
        if (mag > maxMagnitude) maxMagnitude = mag;
        if (mag < minMagnitude) minMagnitude = mag;
      }
    }
    if (minMagnitude === Infinity) return;

    if (this.lockRequested) this.captureLock({ field: { min: minMagnitude, max: maxMagnitude } });

    // The locked range if there is one, and this frame's otherwise. The legend
    // reads `fieldScale`, so it prints whichever is actually in use rather than
    // whichever the frame happened to contain.
    const range = this.scaleLock?.field ?? { min: minMagnitude, max: maxMagnitude };
    this.fieldScale = range;

    // One push for the whole pass rather than one per arrow — with a few
    // thousand samples a frame, the per-arrow state save was pure overhead.
    this.p.push();
    this.p.colorMode(this.p.HSB, 360, 100, 100, 100);

    for (const sample of samples) {
      this.drawFieldArrow(sample.position, sample.force, range.min, range.max);
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
    if (magnitude <= 0) return;

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

    const frameForce = { min: Math.min(...forces), max: Math.max(...forces) };
    const frameSpeed = { min: Math.min(...speeds), max: Math.max(...speeds) };

    // A lock asked for while the field is hidden is captured here instead, so
    // the per-body arrows can be pinned on their own.
    if (this.lockRequested) this.captureLock({ force: frameForce, speed: frameSpeed });

    const forceRange = this.scaleLock?.force ?? frameForce;
    const speedRange = this.scaleLock?.speed ?? frameSpeed;

    this.p.push();
    for (const particle of particles) {
      const force = particle.netForce.magnitude();
      // Anything at all, rather than anything above a fixed number. The two
      // constants that used to gate these were tuned for scenes whose masses
      // are in the hundreds, and the solar system preset is in units where the
      // Sun weighs 0.0126 and the force on the Earth is 2e-14: every arrow in
      // it fell below the threshold and the scene drew none at all. The range
      // below is what the arrows are scaled against, so a force that is small
      // only in comparison already draws a short arrow — which is the picture
      // those constants were trying to produce.
      if (force > 0) {
        this.drawParticleArrow(
          particle,
          particle.netForce,
          logNormalize(force, forceRange.min, forceRange.max),
          COLOR_FORCE_ARROW
        );
      }

      const speed = particle.velocity.magnitude();
      if (speed > 0) {
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

    // In world units, so the comparison against a body's own radius is one
    // subtraction rather than a transform per body.
    const floor = MIN_DRAWN_DIAMETER_PX / (2 * this.zoom);
    const drawnRadius = (particle: Particle) =>
      Math.max(particle.radius * this.particleSizeMultiplier, floor);

    this.p.noStroke();
    this.p.fill(...COLOR_PARTICLE_GLOW, 30);
    for (const particle of particles) {
      this.p.circle(particle.position.x, particle.position.y, drawnRadius(particle) * 3);
    }

    this.p.fill(...COLOR_PARTICLE_BODY);
    this.p.stroke(...COLOR_PARTICLE_EDGE);
    this.p.strokeWeight(2);
    for (const particle of particles) {
      this.p.circle(particle.position.x, particle.position.y, drawnRadius(particle) * 2);
    }

    this.drawSpinMarkers(particles);
    this.drawMassLabels(particles);

    this.p.pop();
  }

  /**
   * A radius line on each spinning body, so its rotation is visible.
   *
   * Without it, spin is state the simulation carries and the picture never
   * shows — an off-centre impact would look like a plain deflection and the
   * whole of M6 would be invisible. Only bodies actually turning get one, so a
   * scene with no contacts looks exactly as it did.
   */
  private drawSpinMarkers(particles: Particle[]): void {
    const smallest = MIN_SPUN_DIAMETER_PX / (2 * this.particleSizeMultiplier * this.zoom);

    let any = false;
    for (const particle of particles) {
      if (particle.angularVelocity !== 0 && particle.radius >= smallest) {
        any = true;
        break;
      }
    }
    if (!any) return;

    this.p.stroke(...COLOR_SPIN_MARKER);
    this.p.strokeWeight(1.5 / this.zoom);
    this.p.noFill();

    for (const particle of particles) {
      if (particle.angularVelocity === 0 || particle.radius < smallest) continue;

      const visualRadius = particle.radius * this.particleSizeMultiplier;
      this.p.line(
        particle.position.x,
        particle.position.y,
        particle.position.x + Math.cos(particle.angle) * visualRadius,
        particle.position.y + Math.sin(particle.angle) * visualRadius
      );
    }
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
   * A ruler along the bottom of the canvas: a bar of known world length, with
   * the length written under it.
   *
   * Everything else in the picture is relative. Arrow length is normalized
   * against the frame, body radius follows mass rather than anything the viewer
   * chose, and the zoom readout is a percentage of an arbitrary starting point —
   * so nothing on screen answered "how far apart are those two?" until this.
   *
   * **Drawn in screen space**, so it must be called after the camera transform
   * has been reset; the whole point is that its length on screen stays put
   * while the world scales underneath it.
   */
  drawScaleBar(): void {
    const { length, label } = niceScaleLength(this.zoom);
    const pixels = length * this.zoom;

    const right = this.p.width / 2 + pixels / 2;
    const left = this.p.width / 2 - pixels / 2;
    const y = this.p.height - SCALE_BAR_MARGIN_PX;

    this.p.push();
    this.p.stroke(...COLOR_SCALE_BAR);
    this.p.strokeWeight(2);
    this.p.line(left, y, right, y);
    // End ticks, so the bar reads as a measurement rather than a divider.
    this.p.line(left, y - 4, left, y + 4);
    this.p.line(right, y - 4, right, y + 4);

    this.p.noStroke();
    this.p.fill(...COLOR_SCALE_BAR);
    this.p.textAlign(this.p.CENTER, this.p.TOP);
    this.p.textSize(11);
    this.p.text(label, this.p.width / 2, y + 6);
    this.p.pop();
  }

  /**
   * Pin the arrow scales to whatever is on screen at the next opportunity.
   *
   * Takes effect on the next frame that actually draws arrows, which is also
   * the only moment the ranges exist.
   */
  lockScale(): void {
    this.lockRequested = true;
  }

  /** Go back to normalizing against each frame. */
  unlockScale(): void {
    this.lockRequested = false;
    this.scaleLock = null;
  }

  /**
   * Fill in the pending lock from the ranges a draw pass just computed.
   *
   * Whichever pass gets there first captures its own part and leaves sensible
   * values for the rest: the field pass runs before the per-body pass, and
   * either may be switched off, so neither can assume it is the one that will
   * be asked.
   */
  private captureLock(part: Partial<LockedScales>): void {
    const existing = this.scaleLock;

    this.scaleLock = {
      field: part.field ?? existing?.field ?? null,
      potential: part.potential ?? existing?.potential ?? null,
      force: part.force ?? existing?.force ?? { min: 0, max: 0 },
      speed: part.speed ?? existing?.speed ?? { min: 0, max: 0 },
    };
  }

  /**
   * A ring around the body the camera is following.
   *
   * Drawn in *screen* space, like the ruler and the overlay, for the reason
   * that makes the ring worth having: it has to stay the same size on screen
   * whatever the zoom, or the thing meant to say "this one" would shrink to
   * nothing exactly when a viewer is zoomed out and most needs it.
   */
  drawFollowRing(screenX: number, screenY: number, bodyRadiusPx: number): void {
    const radius = Math.max(bodyRadiusPx + FOLLOW_RING_MARGIN_PX, FOLLOW_RING_MIN_RADIUS_PX);

    this.p.push();
    this.p.noFill();
    this.p.stroke(...COLOR_FOLLOW_RING);
    this.p.strokeWeight(1.5);
    this.p.circle(screenX, screenY, radius * 2);

    // Four ticks rather than a solid ring: a plain circle around a body reads
    // as part of the body, and this is not physics.
    this.p.strokeWeight(2);
    for (const angle of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      this.p.line(
        screenX + cos * radius,
        screenY + sin * radius,
        screenX + cos * (radius + 5),
        screenY + sin * (radius + 5)
      );
    }
    this.p.pop();
  }

  /**
   * The debug overlay: whatever `main` decided is worth knowing, in the corner.
   *
   * Screen space, after the camera transform is reset, for the same reason the
   * ruler is. The renderer deliberately knows nothing about what the lines say
   * — it takes strings — so that adding a reading to the overlay never means
   * teaching the renderer about the simulation.
   */
  drawDebugOverlay(lines: readonly string[]): void {
    if (lines.length === 0) return;

    const padding = 8;
    const lineHeight = 14;
    const width = 232;
    const height = lines.length * lineHeight + padding * 2;
    const left = this.p.width - width - 10;
    const top = 10;

    this.p.push();
    this.p.noStroke();
    this.p.fill(...COLOR_DEBUG_PANEL);
    this.p.rect(left, top, width, height, 6);

    this.p.fill(...COLOR_DEBUG_TEXT);
    this.p.textAlign(this.p.LEFT, this.p.TOP);
    this.p.textSize(11);
    this.p.textFont('monospace');

    lines.forEach((line, index) => {
      this.p.text(line, left + padding, top + padding + index * lineHeight);
    });
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

import { Particle } from './Particle';
import { SIMULATION_G } from './PhysicsEngine';

/**
 * Starting scenes.
 *
 * Plain data and plain arithmetic — no p5, no DOM — so every scene can be run
 * through the engine in a unit test and checked for the behaviour it advertises
 * (`tests/presets.test.ts` does exactly that). Placing bodies by hand gives
 * something that flies apart within seconds; every velocity here comes from the
 * orbit equation for the engine's actual `G`, which is why `SIMULATION_G` is
 * imported rather than the number 0.5 being written out again.
 */

/** One body's initial state, in world units. */
export interface PresetBody {
  x: number;
  y: number;
  mass: number;
  vx: number;
  vy: number;
}

export interface Preset {
  /** Stable identifier — the dropdown's option value, and what the URL will carry when M4 lands. */
  id: string;
  /** Shown in the dropdown. */
  name: string;
  /** Shown as the option's tooltip; one line, no full stop. */
  summary: string;
  /** Camera zoom that frames the scene. 1 is the default 100%. */
  zoom: number;
  /**
   * Trail length, in steps, for the bodies in this scene. The default 50 is
   * tuned for hand-placed bodies; a closed orbit needs a trail comparable to
   * its period before the shape reads as a shape. Costs one line segment per
   * point per body per frame, so it is not free — see the note on the
   * figure-eight below.
   */
  trailLength?: number;
  /**
   * Whether to draw the vector field for this scene. Defaults to on.
   *
   * Only the galaxy turns it off, because it cannot afford it: the field
   * samples the visible region at up to 12,000 points regardless of how many
   * bodies there are, and at that body count it costs several times what the
   * physics does. Loading any scene applies this either way, so one scene's
   * economies do not follow you into the next; the checkbox is updated to
   * match, so what is on screen and what the control says still agree.
   */
  showVectorField?: boolean;
  /**
   * Whether to draw each body's force and velocity arrows.
   *
   * Same reasoning as `showVectorField`: two arrows per body is eight hundred
   * arrows in the galaxy, which is neither affordable nor readable.
   */
  showParticleVectors?: boolean;
  bodies: PresetBody[];
}

/**
 * Speed of a negligible mass on a circular orbit of radius `r` about mass `M`.
 *
 * v = sqrt(G·M / r), from G·M·m/r² = m·v²/r.
 */
export function circularOrbitSpeed(mass: number, radius: number): number {
  return Math.sqrt((SIMULATION_G * mass) / radius);
}

/**
 * Speed of each member of an equal-mass binary, separation `d` apart.
 *
 * Both bodies circle the barycentre at d/2, so G·m²/d² = m·v²/(d/2) and
 * v = sqrt(G·m / 2d) — half what an equivalent single primary would demand,
 * which is the mistake that leaves a hand-built binary unbound.
 */
export function binaryOrbitSpeed(mass: number, separation: number): number {
  return Math.sqrt((SIMULATION_G * mass) / (2 * separation));
}

/**
 * Speed at apoapsis for an orbit that swings between `apoapsis` and
 * `periapsis` about mass `M`.
 *
 * The vis-viva equation, v² = G·M·(2/r − 1/a), evaluated at r = apoapsis with
 * the semi-major axis a = (apoapsis + periapsis)/2.
 */
export function apoapsisSpeed(mass: number, apoapsis: number, periapsis: number): number {
  const semiMajor = (apoapsis + periapsis) / 2;
  return Math.sqrt(SIMULATION_G * mass * (2 / apoapsis - 1 / semiMajor));
}

/**
 * Cancel the scene's net momentum against its first (heaviest) body.
 *
 * Without this the whole configuration drifts off screen at a constant rate —
 * correct physics, but it looks like a bug, and the camera has no follow mode.
 * Scenes that are already symmetric are unaffected.
 */
function balanced(bodies: PresetBody[]): PresetBody[] {
  let px = 0;
  let py = 0;
  for (const body of bodies) {
    px += body.mass * body.vx;
    py += body.mass * body.vy;
  }
  const [first, ...rest] = bodies;
  return [
    { ...first, vx: first.vx - px / first.mass, vy: first.vy - py / first.mass },
    ...rest,
  ];
}

// ─── Binary ──────────────────────────────────────────────────────────────────
const BINARY_MASS = 100;
const BINARY_SEPARATION = 400;
const binarySpeed = binaryOrbitSpeed(BINARY_MASS, BINARY_SEPARATION);

// ─── Star and planets ────────────────────────────────────────────────────────
const STAR_MASS = 5000;
const PLANET_MASS = 50; // 1% of the star, so the two-body orbit equation stays a good approximation
const INNER_RADIUS = 200;
const OUTER_RADIUS = 400;

// ─── Figure eight ────────────────────────────────────────────────────────────
// The Chenciner–Montgomery choreography: three equal masses chasing each other
// along one figure-eight curve. Published for G = 1, m = 1, in which form the
// period is 6.3259 and the initial conditions are the constants below.
const EIGHT_X = 0.97000436;
const EIGHT_Y = -0.24308753;
const EIGHT_VX = -0.93240737;
const EIGHT_VY = -0.86473146;
const EIGHT_PERIOD_UNITS = 6.32591398;

// Rescaling to this engine: with r' = L·r and t' = T·t the equations of motion
// are preserved iff T = sqrt(L³ / (G·m)), so velocities scale by L/T. L = 250
// puts the orbit at a legible size on a default window.
const EIGHT_MASS = 200;
const EIGHT_LENGTH = 250;
const EIGHT_TIME = Math.sqrt(EIGHT_LENGTH ** 3 / (SIMULATION_G * EIGHT_MASS));
const eightVelocityScale = EIGHT_LENGTH / EIGHT_TIME;

/** One full figure-eight, in simulation steps. Used by the tests. */
export const FIGURE_EIGHT_PERIOD_STEPS = EIGHT_PERIOD_UNITS * EIGHT_TIME;

// ─── Lagrange points ─────────────────────────────────────────────────────────
// Two primaries on a circular mutual orbit, and two negligible bodies sitting
// at L4 and L5 — the corners of the equilateral triangles the pair makes. The
// whole configuration rotates rigidly, so in the frame turning with it nothing
// moves at all.
//
// L4 and L5 are only *linearly stable* when the primaries' mass ratio is above
// 24.96, which is why the numbers below are what they are. Measured over 20
// orbits at ratio 50: the trojans librate between 58.0 and 60.3 degrees from
// the secondary, as seen from the primary — they wobble around their points and
// stay. At ratio 25, either side of the threshold, they wander by twenty
// degrees and keep going. The trojans also have to be negligible: at mass 50
// rather than 5 the configuration comes apart inside ten orbits.
const LAGRANGE_PRIMARY_MASS = 5000;
const LAGRANGE_SECONDARY_MASS = 100; // ratio 50, comfortably above 24.96
const LAGRANGE_TROJAN_MASS = 5;
const LAGRANGE_SEPARATION = 400;

function lagrangeBodies(): PresetBody[] {
  const total = LAGRANGE_PRIMARY_MASS + LAGRANGE_SECONDARY_MASS;

  // Angular velocity of the pair: omega² = G·(M + m) / d³.
  const omega = Math.sqrt((SIMULATION_G * total) / LAGRANGE_SEPARATION ** 3);

  // Barycentre at the origin, primaries on the x axis.
  const primaryX = -LAGRANGE_SEPARATION * (LAGRANGE_SECONDARY_MASS / total);
  const secondaryX = LAGRANGE_SEPARATION * (LAGRANGE_PRIMARY_MASS / total);

  // The apex of the equilateral triangle on each side.
  const apexX = (primaryX + secondaryX) / 2;
  const apexY = (Math.sqrt(3) / 2) * LAGRANGE_SEPARATION;

  // Everything turns together about the barycentre, so v = omega x r.
  const rigid = (x: number, y: number, mass: number): PresetBody => ({
    x,
    y,
    mass,
    vx: -omega * y,
    vy: omega * x,
  });

  return [
    rigid(primaryX, 0, LAGRANGE_PRIMARY_MASS),
    rigid(secondaryX, 0, LAGRANGE_SECONDARY_MASS),
    rigid(apexX, apexY, LAGRANGE_TROJAN_MASS),
    rigid(apexX, -apexY, LAGRANGE_TROJAN_MASS),
  ];
}

// ─── Galaxy ──────────────────────────────────────────────────────────────────
// The scene the quadtree exists for. Every body is on a circular orbit about
// the centre, so the disc holds its shape rather than dispersing, and every
// velocity comes from the same orbit equation the two-body scenes use.
//
// The body count is chosen for the frame budget rather than for astronomy:
// enough that the exact pairwise sum visibly struggles, and few enough that the
// scene still animates. Measured in Chromium: 30fps at 300 bodies and 20fps at
// 400, with roughly half of each frame going on drawing. See SCALING.md.
const GALAXY_BODIES = 300;
const GALAXY_CORE_MASS = 400000;
const GALAXY_INNER_RADIUS = 300;
const GALAXY_OUTER_RADIUS = 2400;

/**
 * A tiny deterministic generator, so the galaxy is the same galaxy every time
 * it is loaded — a scene that reshuffled itself could not be tested, and could
 * not be compared against itself after a change.
 */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function galaxyBodies(): PresetBody[] {
  const random = seededRandom(20240826);
  const bodies: PresetBody[] = [
    { x: 0, y: 0, mass: GALAXY_CORE_MASS, vx: 0, vy: 0 },
  ];

  for (let i = 1; i < GALAXY_BODIES; i++) {
    // Square-rooted so the disc is evenly covered rather than crowding the
    // centre, which is where the sampling would otherwise pile up.
    const radius =
      GALAXY_INNER_RADIUS +
      Math.sqrt(random()) * (GALAXY_OUTER_RADIUS - GALAXY_INNER_RADIUS);
    const angle = random() * Math.PI * 2;
    const speed = circularOrbitSpeed(GALAXY_CORE_MASS, radius);

    bodies.push({
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      mass: 20 + random() * 60,
      vx: -Math.sin(angle) * speed,
      vy: Math.cos(angle) * speed,
    });
  }

  return bodies;
}

// ─── Comet ───────────────────────────────────────────────────────────────────
// An eccentricity-0.67 orbit: slow and distant at aphelion, whipping through
// perihelion at five times the speed. Perihelion is kept at 180 units, well
// clear of the separations where step size starts to bite; measured over 20
// passes the orbit holds its shape — 180.9 units every time, and it never asks
// for a sub-step.
const COMET_MASS = 20;
const COMET_APHELION = 900;
const COMET_PERIHELION = 180;

// ─── Slingshot ───────────────────────────────────────────────────────────────
// A hyperbolic flyby. The impact parameter is what matters: aimed straight at
// the primary the probe passes within a few units, where the softened force
// stops meaning anything. Offset by 350 it turns through 90° at a closest
// approach of 186.4 units, comfortably inside what the integrator resolves
// (see INTEGRATORS.md).
const PROBE_MASS = 20;

export const PRESETS: Preset[] = [
  {
    id: 'binary',
    name: 'Binary',
    summary: 'Two equal bodies on a circular mutual orbit',
    zoom: 1,
    // Half an orbit (the period is ~5,030 steps), so the two arcs visibly
    // chase each other instead of settling into a static circle.
    trailLength: 2500,
    bodies: balanced([
      { x: -BINARY_SEPARATION / 2, y: 0, mass: BINARY_MASS, vx: 0, vy: binarySpeed },
      { x: BINARY_SEPARATION / 2, y: 0, mass: BINARY_MASS, vx: 0, vy: -binarySpeed },
    ]),
  },
  {
    id: 'star-and-planets',
    name: 'Star and planets',
    summary: 'A heavy primary with two satellites on circular orbits',
    // The outer orbit is 400 units across the middle of an 800px-tall window,
    // which grazes the top and bottom edges at 100%.
    zoom: 0.85,
    // One full orbit of the outer satellite, three of the inner.
    trailLength: 1000,
    bodies: balanced([
      { x: 0, y: 0, mass: STAR_MASS, vx: 0, vy: 0 },
      {
        x: -INNER_RADIUS,
        y: 0,
        mass: PLANET_MASS,
        vx: 0,
        vy: circularOrbitSpeed(STAR_MASS, INNER_RADIUS),
      },
      {
        x: OUTER_RADIUS,
        y: 0,
        mass: PLANET_MASS,
        vx: 0,
        vy: -circularOrbitSpeed(STAR_MASS, OUTER_RADIUS),
      },
    ]),
  },
  {
    id: 'figure-eight',
    name: 'Figure eight',
    summary: 'Three equal masses chasing each other around one closed curve',
    zoom: 1,
    // One full period (~2,500 steps): the whole point of this scene is the
    // closed curve, and a shorter trail shows an arc that could be anything.
    // Affordable only because trails are drawn in bands — see Renderer.
    trailLength: 2600,
    bodies: balanced([
      {
        x: EIGHT_LENGTH * EIGHT_X,
        y: EIGHT_LENGTH * EIGHT_Y,
        mass: EIGHT_MASS,
        vx: (-eightVelocityScale * EIGHT_VX) / 2,
        vy: (-eightVelocityScale * EIGHT_VY) / 2,
      },
      {
        x: -EIGHT_LENGTH * EIGHT_X,
        y: -EIGHT_LENGTH * EIGHT_Y,
        mass: EIGHT_MASS,
        vx: (-eightVelocityScale * EIGHT_VX) / 2,
        vy: (-eightVelocityScale * EIGHT_VY) / 2,
      },
      {
        x: 0,
        y: 0,
        mass: EIGHT_MASS,
        vx: eightVelocityScale * EIGHT_VX,
        vy: eightVelocityScale * EIGHT_VY,
      },
    ]),
  },
  {
    id: 'comet',
    name: 'Comet',
    summary: 'A highly eccentric orbit — slow at aphelion, fast through perihelion',
    // 1,080 units across, and the orbit precesses, so the frame needs room
    // beyond the ellipse's own extent.
    zoom: 0.5,
    // One full orbit (~1,580 steps), so the whole ellipse is drawn.
    trailLength: 1600,
    bodies: balanced([
      { x: 0, y: 0, mass: STAR_MASS, vx: 0, vy: 0 },
      {
        x: -COMET_APHELION,
        y: 0,
        mass: COMET_MASS,
        vx: 0,
        vy: apoapsisSpeed(STAR_MASS, COMET_APHELION, COMET_PERIHELION),
      },
    ]),
  },
  {
    id: 'lagrange',
    name: 'Lagrange points',
    summary: 'Two bodies orbiting, and two trojans parked at L4 and L5',
    // The triangle is 692 units tall against a 400-unit separation, so the
    // scene is taller than it is wide and wants the margin.
    zoom: 0.9,
    // One full orbit of the pair, which is what makes the trojans' libration
    // about their points visible rather than inferred.
    trailLength: 1000,
    bodies: balanced(lagrangeBodies()),
  },
  {
    id: 'galaxy',
    name: 'Galaxy',
    summary: 'Three hundred bodies on circular orbits, summed through a quadtree',
    zoom: 0.22,
    // See the note on Preset.showVectorField: at this body count the field
    // costs several times what the physics does, and 12,000 arrows over 300
    // bodies is noise rather than information. Turn it back on to see both.
    showVectorField: false,
    showParticleVectors: false,
    // No trails: at this body count each trail is its own set of stroke
    // changes, and the frame cost is already mostly drawing.
    trailLength: 0,
    bodies: balanced(galaxyBodies()),
  },
  {
    id: 'slingshot',
    name: 'Slingshot',
    summary: 'A light probe whipping past a heavy primary on a hyperbolic pass',
    zoom: 0.5,
    // Long enough to keep the whole approach on screen behind the probe.
    trailLength: 1500,
    bodies: balanced([
      { x: 0, y: 0, mass: STAR_MASS, vx: 0, vy: 0 },
      { x: -1200, y: 350, mass: PROBE_MASS, vx: 3, vy: 0 },
    ]),
  },
];

/** The scene the page opens with. */
export const DEFAULT_PRESET_ID = 'binary';

export function getPreset(id: string): Preset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}

/** Fresh `Particle` instances for a preset — never shared, so loading twice is clean. */
export function presetParticles(preset: Preset): Particle[] {
  return preset.bodies.map((body) => new Particle(body.x, body.y, body.mass, body.vx, body.vy));
}

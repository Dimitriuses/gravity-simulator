import { AU_IN_METRES, G_SI, Scale, toMassUnits, toSpeedUnits, toUnits } from './units';

/**
 * The real solar system, as initial conditions. Roadmap M8.
 *
 * Every other scene in this simulation was chosen: the presets derive their
 * velocities from an orbit equation so that they do what they claim to do. This
 * one is not chosen. The numbers below are the planets' osculating orbital
 * elements at J2000, published by JPL, and what the simulation does with them
 * is either what the solar system does or it is wrong.
 *
 * Two departures from reality, both deliberate and both stated wherever a
 * result is published:
 *
 * - **It is flat.** The simulation is two-dimensional, so the inclinations and
 *   nodes are dropped and every orbit is laid in the ecliptic with its own size
 *   (`a`), shape (`e`), orientation (`ϖ`) and phase (`L`) intact. Projecting
 *   the real orbits onto the plane instead would shrink them by a part in a
 *   thousand and change the very thing being measured. The inclinations are all
 *   under 7.01°, and what is lost is the small out-of-plane part of how the
 *   planets pull on each other.
 * - **It is Newtonian**, which is the point. General relativity's contribution
 *   to Mercury's perihelion is the one number this cannot reproduce, and
 *   knowing exactly how much is missing is a better test than agreement.
 */

/** Heliocentric gravitational constant, m³ s⁻², IAU 2015. */
export const SUN_GM = 1.32712440018e20;

/** The Sun's mass and radius, from `SUN_GM / G` and IAU 2015. */
export const SUN_MASS_KG = SUN_GM / G_SI;
export const SUN_RADIUS_METRES = 6.957e8;

/**
 * One body's orbit, at J2000 and as it changes.
 *
 * `rates` are per Julian century, from the same JPL table as the elements, and
 * are what the simulation's own drift is measured against: they are the real
 * solar system's answer to the question this milestone asks.
 */
export interface OrbitalElements {
  name: string;
  /** GM in m³ s⁻², which is measured far more precisely than either factor. */
  gm: number;
  /** Equatorial radius, metres. Only the drawn size depends on it. */
  radiusMetres: number;
  /** Semi-major axis, au. */
  a: number;
  /** Eccentricity. */
  e: number;
  /** Longitude of perihelion, degrees. */
  periapsis: number;
  /** Mean longitude, degrees. */
  meanLongitude: number;
  /** Sidereal orbital period in days, as published, for comparison. */
  siderealPeriodDays: number;
  rates: {
    a: number;
    e: number;
    periapsis: number;
    meanLongitude: number;
  };
}

/**
 * Keplerian elements and their rates, J2000 through J2100, from JPL's
 * *Approximate Positions of the Major Planets* (Standish). Angles in degrees,
 * distances in au, rates per Julian century.
 *
 * The Earth's entry is the Earth-Moon barycentre, which is what the table
 * tabulates and what a one-body-per-planet simulation should carry: the Moon is
 * 1.2% of the pair and 0.0026 au away, so a simulation that placed the Earth's
 * whole mass at the Earth's own position would be wrong about where that mass
 * is by more than it is wrong about anything else here.
 */
export const PLANETS: readonly OrbitalElements[] = [
  {
    name: 'Mercury',
    gm: 2.2031868e13,
    radiusMetres: 2.4397e6,
    a: 0.38709927,
    e: 0.20563593,
    periapsis: 77.45779628,
    meanLongitude: 252.2503235,
    siderealPeriodDays: 87.9691,
    rates: { a: 0.00000037, e: 0.00001906, periapsis: 0.16047689, meanLongitude: 149472.67411175 },
  },
  {
    name: 'Venus',
    gm: 3.24858592e14,
    radiusMetres: 6.0518e6,
    a: 0.72333566,
    e: 0.00677672,
    periapsis: 131.60246718,
    meanLongitude: 181.9790995,
    siderealPeriodDays: 224.701,
    rates: { a: 0.0000039, e: -0.00004107, periapsis: 0.00268329, meanLongitude: 58517.81538729 },
  },
  {
    name: 'Earth',
    gm: 4.03503235e14,
    radiusMetres: 6.3781e6,
    a: 1.00000261,
    e: 0.01671123,
    periapsis: 102.93768193,
    meanLongitude: 100.46457166,
    siderealPeriodDays: 365.256363,
    rates: { a: 0.00000562, e: -0.00004392, periapsis: 0.32327364, meanLongitude: 35999.37244981 },
  },
  {
    name: 'Mars',
    gm: 4.282837e13,
    radiusMetres: 3.3895e6,
    a: 1.52371034,
    e: 0.0933941,
    periapsis: -23.94362959,
    meanLongitude: -4.55343205,
    siderealPeriodDays: 686.98,
    rates: { a: 0.00001847, e: 0.00007882, periapsis: 0.44441088, meanLongitude: 19140.30268499 },
  },
  {
    name: 'Jupiter',
    gm: 1.26686534e17,
    radiusMetres: 6.9911e7,
    a: 5.202887,
    e: 0.04838624,
    periapsis: 14.72847983,
    meanLongitude: 34.39644051,
    siderealPeriodDays: 4332.589,
    rates: { a: -0.00011607, e: -0.00013253, periapsis: 0.21252668, meanLongitude: 3034.74612775 },
  },
  {
    name: 'Saturn',
    gm: 3.7931187e16,
    radiusMetres: 5.8232e7,
    a: 9.53667594,
    e: 0.05386179,
    periapsis: 92.59887831,
    meanLongitude: 49.95424423,
    siderealPeriodDays: 10759.22,
    rates: { a: -0.0012506, e: -0.00050991, periapsis: -0.41897216, meanLongitude: 1222.49362201 },
  },
  {
    name: 'Uranus',
    gm: 5.793939e15,
    radiusMetres: 2.5362e7,
    a: 19.18916464,
    e: 0.04725744,
    periapsis: 170.9542763,
    meanLongitude: 313.23810451,
    siderealPeriodDays: 30685.4,
    rates: { a: -0.00196176, e: -0.00004397, periapsis: 0.40805281, meanLongitude: 428.48202785 },
  },
  {
    name: 'Neptune',
    gm: 6.836529e15,
    radiusMetres: 2.4622e7,
    a: 30.06992276,
    e: 0.00859048,
    periapsis: 44.96476227,
    meanLongitude: -55.12002969,
    siderealPeriodDays: 60189,
    rates: { a: 0.00026291, e: 0.00005105, periapsis: -0.32241464, meanLongitude: 218.45945325 },
  },
];

/** Position and velocity, in whatever units the caller asked for. */
export interface State {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const RADIANS = Math.PI / 180;

/** Wrap an angle in degrees to (-180, 180]. */
export function wrapDegrees(degrees: number): number {
  const wrapped = ((degrees + 180) % 360 + 360) % 360;
  return wrapped - 180;
}

/**
 * Kepler's equation, `E - e·sin E = M`, by Newton's method.
 *
 * There is no closed form, which is the whole reason this function exists. Six
 * iterations reach machine precision for every eccentricity in the table; the
 * loop is bounded anyway, because a solver that can spin forever on bad input
 * is a worse bug than one that returns a slightly wrong angle.
 */
export function solveKepler(meanAnomaly: number, e: number, tolerance = 1e-13): number {
  let eccentric = meanAnomaly + e * Math.sin(meanAnomaly);

  for (let i = 0; i < 40; i++) {
    const error = eccentric - e * Math.sin(eccentric) - meanAnomaly;
    if (Math.abs(error) < tolerance) break;
    eccentric -= error / (1 - e * Math.cos(eccentric));
  }

  return eccentric;
}

/**
 * A planet's heliocentric state, in simulation units, from its elements.
 *
 * The mean motion uses `GM_sun + GM_planet`, because the elements are relative
 * to the Sun and a heliocentric orbit is a two-body problem: Jupiter goes round
 * 0.05% faster than a test particle at the same distance would, which is larger
 * than several of the effects being looked for.
 */
export function stateFromElements(
  elements: OrbitalElements,
  scale: Scale,
  centuriesSinceJ2000 = 0
): State {
  const a = elements.a + elements.rates.a * centuriesSinceJ2000;
  const e = elements.e + elements.rates.e * centuriesSinceJ2000;
  const periapsis = (elements.periapsis + elements.rates.periapsis * centuriesSinceJ2000) * RADIANS;
  const meanLongitude =
    (elements.meanLongitude + elements.rates.meanLongitude * centuriesSinceJ2000) * RADIANS;

  const meanAnomaly = wrapDegrees((meanLongitude - periapsis) / RADIANS) * RADIANS;
  const eccentric = solveKepler(meanAnomaly, e);

  const semiMajorMetres = a * AU_IN_METRES;
  const mu = SUN_GM + elements.gm;

  // In the orbital frame, periapsis along +x.
  const cosE = Math.cos(eccentric);
  const sinE = Math.sin(eccentric);
  const factor = Math.sqrt(1 - e * e);

  const x = semiMajorMetres * (cosE - e);
  const y = semiMajorMetres * factor * sinE;

  // dE/dt from differentiating Kepler's equation, times the orbital-frame
  // derivatives of the position above.
  const meanMotion = Math.sqrt(mu / semiMajorMetres ** 3);
  const eccentricRate = meanMotion / (1 - e * cosE);
  const vx = -semiMajorMetres * sinE * eccentricRate;
  const vy = semiMajorMetres * factor * cosE * eccentricRate;

  // Rotate periapsis to its longitude in the ecliptic.
  const cos = Math.cos(periapsis);
  const sin = Math.sin(periapsis);

  return {
    x: toUnits(x * cos - y * sin, scale),
    y: toUnits(x * sin + y * cos, scale),
    vx: toSpeedUnits(vx * cos - vy * sin, scale),
    vy: toSpeedUnits(vx * sin + vy * cos, scale),
  };
}

/** A body's mass in simulation units. */
export const massInUnits = (gm: number, scale: Scale): number => toMassUnits(gm / G_SI, scale);

/**
 * The osculating orbit a body is on right now: the ellipse it would follow from
 * this position and velocity if everything else vanished.
 *
 * This is how the simulation is asked what it has done. A planet's semi-major
 * axis and eccentricity wander a little as its neighbours pull on it, and its
 * perihelion turns — slowly, and in a direction the two-body problem has no
 * opinion about. Reading the ellipse back out every so often is what turns a
 * list of positions into something comparable with a published rate.
 *
 * Everything is in the caller's units, including `mu = G·(M₁ + M₂)`.
 */
export function osculatingElements(
  state: State,
  mu: number
): { a: number; e: number; periapsisDegrees: number } {
  const r = Math.hypot(state.x, state.y);
  const speedSquared = state.vx * state.vx + state.vy * state.vy;
  const radialSpeed = state.x * state.vx + state.y * state.vy;

  const a = 1 / (2 / r - speedSquared / mu);

  // The eccentricity vector points at periapsis and its length is e.
  const scale = speedSquared - mu / r;
  const ex = (scale * state.x - radialSpeed * state.vx) / mu;
  const ey = (scale * state.y - radialSpeed * state.vy) / mu;

  return {
    a,
    e: Math.hypot(ex, ey),
    periapsisDegrees: Math.atan2(ey, ex) / RADIANS,
  };
}

/**
 * The Sun's velocity that puts the system's momentum at zero.
 *
 * The elements are heliocentric, so they describe where the planets are
 * relative to the Sun and say nothing about what the Sun itself is doing. Left
 * at rest it is not the centre of anything: Jupiter alone would swing it around
 * the barycentre at 12 m/s, and the whole system would drift off across the
 * canvas. Momentum is conserved exactly by the pairwise solver, so setting it
 * to zero once keeps the barycentre still for as long as the run lasts.
 */
export function sunVelocity(
  states: readonly { state: State; mass: number }[],
  sunMass: number
): { vx: number; vy: number } {
  let px = 0;
  let py = 0;

  for (const { state, mass } of states) {
    px += mass * state.vx;
    py += mass * state.vy;
  }

  return { vx: -px / sunMass, vy: -py / sunMass };
}

import { SIMULATION_G } from './PhysicsEngine';

/**
 * Turning the simulation's units into real ones, and back. Roadmap M8.
 *
 * `SIMULATION_G` is 0.5 — a number chosen so that the mass slider produces
 * forces the vector field can draw, not a measurement of anything. That is
 * fine until you want to compare the simulation against the real solar system,
 * at which point the question "how long is a step, in seconds?" has to have an
 * answer.
 *
 * It does, and only one. Gravity fixes the relationship between the three
 * scales: with lengths in `metresPerUnit`, masses in `kilogramsPerUnit` and
 * times in `secondsPerUnit`,
 *
 * ```
 *   G_sim = G · kilogramsPerUnit · secondsPerUnit² / metresPerUnit³
 * ```
 *
 * so choosing any two of the three decides the third. Nothing here is a
 * conversion factor someone picked to make a number come out nicely: declare a
 * length scale and a mass scale, and the length of a second follows.
 */

/** CODATA 2018, m³ kg⁻¹ s⁻². */
export const G_SI = 6.6743e-11;

/** The astronomical unit, exactly, in metres (IAU 2012). */
export const AU_IN_METRES = 1.495978707e11;

/** A Julian day and a Julian century, in seconds. */
export const DAY_IN_SECONDS = 86400;
export const CENTURY_IN_SECONDS = 36525 * DAY_IN_SECONDS;

/** How one simulation unit of length, mass and time measures in SI. */
export interface Scale {
  metresPerUnit: number;
  kilogramsPerUnit: number;
  secondsPerUnit: number;
}

/**
 * The scale implied by a length unit and a mass unit.
 *
 * The time unit is not a choice — it is whatever makes the simulation's `G`
 * come out at the value it actually uses.
 */
export function scaleFor(
  metresPerUnit: number,
  kilogramsPerUnit: number,
  simulationG: number = SIMULATION_G
): Scale {
  const secondsPerUnit = Math.sqrt(
    (simulationG * metresPerUnit ** 3) / (G_SI * kilogramsPerUnit)
  );

  return { metresPerUnit, kilogramsPerUnit, secondsPerUnit };
}

/**
 * The mass unit that makes `Particle.radiusForMass` reproduce a known body's
 * actual radius.
 *
 * The radius rule is `r = 2·m^(1/3)`, which is a statement that everything has
 * the same density. Nothing in the simulation depends on which density that is,
 * so it may as well be a real one — anchored on the Sun, the bodies of a solar
 * system come out close to their real sizes, and the ones that do not are the
 * ones whose density really is different.
 */
export function massUnitFromRadius(
  massKg: number,
  radiusMetres: number,
  metresPerUnit: number
): number {
  const radiusInUnits = radiusMetres / metresPerUnit;
  return massKg / (radiusInUnits / 2) ** 3;
}

/**
 * A solar system at a hundred units to the astronomical unit.
 *
 * The length scale puts Mercury's orbit at 39 units and Saturn's at 954, which
 * is the range the presets and the camera already work in. The mass scale is
 * the Sun's own, through the radius rule above, which fixes one simulation
 * second at about 400 real ones.
 */
export const SOLAR_SYSTEM_SCALE: Scale = scaleFor(
  AU_IN_METRES / 100,
  massUnitFromRadius(1.98847e30, 6.957e8, AU_IN_METRES / 100)
);

/** Metres to simulation length units, and back. */
export const toUnits = (metres: number, scale: Scale): number => metres / scale.metresPerUnit;
export const toMetres = (units: number, scale: Scale): number => units * scale.metresPerUnit;

/** Kilograms to simulation mass units, and back. */
export const toMassUnits = (kg: number, scale: Scale): number => kg / scale.kilogramsPerUnit;
export const toKilograms = (units: number, scale: Scale): number => units * scale.kilogramsPerUnit;

/** Seconds to simulation time units, and back. */
export const toTimeUnits = (seconds: number, scale: Scale): number =>
  seconds / scale.secondsPerUnit;
export const toSeconds = (units: number, scale: Scale): number => units * scale.secondsPerUnit;

/** Metres per second to simulation units of speed, and back. */
export const toSpeedUnits = (metresPerSecond: number, scale: Scale): number =>
  (metresPerSecond * scale.secondsPerUnit) / scale.metresPerUnit;
export const toMetresPerSecond = (units: number, scale: Scale): number =>
  (units * scale.metresPerUnit) / scale.secondsPerUnit;

import { describe, it, expect } from 'vitest';
import {
  AU_IN_METRES,
  DAY_IN_SECONDS,
  G_SI,
  SOLAR_SYSTEM_SCALE,
  massUnitFromRadius,
  scaleFor,
  toKilograms,
  toMassUnits,
  toMetres,
  toMetresPerSecond,
  toSeconds,
  toSpeedUnits,
  toTimeUnits,
  toUnits,
} from '../src/units';
import { SUN_MASS_KG, SUN_RADIUS_METRES } from '../src/ephemeris';
import { Particle } from '../src/Particle';
import { SIMULATION_G } from '../src/PhysicsEngine';

/**
 * The scaling is one equation, and everything published in EPHEMERIS.md rests
 * on it being right. So it is checked twice: once as the identity it is derived
 * from, and once against a number nobody in this repository chose — the length
 * of a year.
 */
describe('the unit system', () => {
  it('makes G come out at the value the simulation actually uses', () => {
    const scale = scaleFor(1.2e9, 3.4e31);

    const g =
      (G_SI * scale.kilogramsPerUnit * scale.secondsPerUnit ** 2) / scale.metresPerUnit ** 3;

    expect(g).toBeCloseTo(SIMULATION_G, 12);
  });

  it('leaves the time unit as the only thing that is not a choice', () => {
    // Same length scale, four times the mass scale: the second halves, because
    // G ties them together as s² ∝ 1/kg.
    const light = scaleFor(1e9, 1e31);
    const heavy = scaleFor(1e9, 4e31);

    expect(heavy.secondsPerUnit).toBeCloseTo(light.secondsPerUnit / 2, 6);
  });

  it('anchors the mass unit on a real density, via the radius rule', () => {
    const metresPerUnit = AU_IN_METRES / 100;
    const kilogramsPerUnit = massUnitFromRadius(SUN_MASS_KG, SUN_RADIUS_METRES, metresPerUnit);

    const sunInUnits = SUN_MASS_KG / kilogramsPerUnit;
    const radius = Particle.radiusForMass(sunInUnits);

    expect(toMetres(radius, { metresPerUnit, kilogramsPerUnit, secondsPerUnit: 1 })).toBeCloseTo(
      SUN_RADIUS_METRES,
      -3
    );
  });

  it('gives a year its real length, which is the whole point', () => {
    // A circular orbit of one au about one solar mass, timed by the simulation's
    // own arithmetic and read back in days. Nothing here was fitted to 365: the
    // length scale is a choice, the mass scale comes from the Sun's radius, the
    // time scale falls out of G, and this is what those three produce.
    const radius = toUnits(AU_IN_METRES, SOLAR_SYSTEM_SCALE);
    const mass = toMassUnits(SUN_MASS_KG, SOLAR_SYSTEM_SCALE);

    const speed = Math.sqrt((SIMULATION_G * mass) / radius);
    const period = (2 * Math.PI * radius) / speed;

    const days = toSeconds(period, SOLAR_SYSTEM_SCALE) / DAY_IN_SECONDS;
    expect(days).toBeCloseTo(365.2569, 3);

    // ...and the speed on that orbit is the Earth's, to the tenth of a km/s.
    const kmPerSecond = toMetresPerSecond(speed, SOLAR_SYSTEM_SCALE) / 1000;
    expect(kmPerSecond).toBeCloseTo(29.785, 2);
  });

  it('converts in both directions without losing anything', () => {
    const scale = SOLAR_SYSTEM_SCALE;

    expect(toMetres(toUnits(1234.5, scale), scale)).toBeCloseTo(1234.5, 6);
    expect(toKilograms(toMassUnits(9.87e24, scale), scale) / 9.87e24).toBeCloseTo(1, 12);
    expect(toSeconds(toTimeUnits(5000, scale), scale)).toBeCloseTo(5000, 6);
    expect(toMetresPerSecond(toSpeedUnits(29780, scale), scale)).toBeCloseTo(29780, 6);
  });
});

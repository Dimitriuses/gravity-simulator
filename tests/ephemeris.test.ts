import { describe, it, expect } from 'vitest';
import {
  PLANETS,
  SUN_GM,
  SUN_MASS_KG,
  massInUnits,
  osculatingElements,
  solveKepler,
  stateFromElements,
  sunVelocity,
  wrapDegrees,
} from '../src/ephemeris';
import {
  AU_IN_METRES,
  DAY_IN_SECONDS,
  SOLAR_SYSTEM_SCALE,
  toMassUnits,
  toMetres,
  toMetresPerSecond,
} from '../src/units';
import { SIMULATION_G } from '../src/PhysicsEngine';

const scale = SOLAR_SYSTEM_SCALE;
const planet = (name: string) => PLANETS.find((p) => p.name === name)!;

describe('Kepler', () => {
  it('solves its own equation, at every eccentricity in the table', () => {
    for (const e of [0, 0.0067, 0.0934, 0.2056, 0.6, 0.9]) {
      for (const degrees of [-179, -90, -0.4, 0, 0.4, 37, 90, 179]) {
        const meanAnomaly = degrees * (Math.PI / 180);
        const eccentric = solveKepler(meanAnomaly, e);

        expect(eccentric - e * Math.sin(eccentric)).toBeCloseTo(meanAnomaly, 12);
      }
    }
  });

  it('wraps angles the short way round', () => {
    expect(wrapDegrees(190)).toBeCloseTo(-170, 12);
    expect(wrapDegrees(-190)).toBeCloseTo(170, 12);
    expect(wrapDegrees(252.25)).toBeCloseTo(-107.75, 12);
    expect(wrapDegrees(720 + 45)).toBeCloseTo(45, 12);
  });
});

describe('states from the J2000 elements', () => {
  it('puts the Earth where it was on the first of January 2000', () => {
    // J2000 is 1 January 2000 at noon TT, two days before perihelion, so the
    // Earth is very near its closest — 0.9833 au — and moving at its fastest.
    const state = stateFromElements(planet('Earth'), scale);

    const au = toMetres(Math.hypot(state.x, state.y), scale) / AU_IN_METRES;
    const kmPerSecond = toMetresPerSecond(Math.hypot(state.vx, state.vy), scale) / 1000;

    expect(au).toBeCloseTo(0.9833, 3);
    expect(kmPerSecond).toBeCloseTo(30.28, 1);
  });

  it('gives every planet the orbital period it is published as having', () => {
    // The period comes from the state, not from the table's period column:
    // 2π·sqrt(a³/μ) on the semi-major axis the position and velocity imply. It
    // is the first thing that would break if the length scale, the mass scale
    // or the time scale were wrong, and it is checked against a number measured
    // by watching the sky.
    //
    // A tenth of a percent rather than a thousandth, because the two are not
    // quite the same quantity: the table's `a` is where the planet's orbit
    // happened to be at J2000 and the published period belongs to the orbit it
    // is on *on average*. Uranus is the widest gap at 0.056%, its axis being
    // swung a couple of thousandths of an au by Saturn and Neptune; the inner
    // planets all come in under 0.01%.
    for (const body of PLANETS) {
      const state = stateFromElements(body, scale);
      const mu = SIMULATION_G * (toMassUnits(SUN_MASS_KG, scale) + massInUnits(body.gm, scale));

      const { a } = osculatingElements(state, mu);
      const period = 2 * Math.PI * Math.sqrt(a ** 3 / mu);
      const days = (period * scale.secondsPerUnit) / DAY_IN_SECONDS;

      const error = Math.abs(days - body.siderealPeriodDays) / body.siderealPeriodDays;
      const label = `${body.name}: ${days.toFixed(3)} d vs ${body.siderealPeriodDays}`;
      expect(error, label).toBeLessThan(0.001);
    }
  });

  it('reads back the ellipse it was given', () => {
    // Round trip: elements to a state and back. Osculating elements are how the
    // simulation is asked what it has done, so a bias in this direction would
    // quietly become a bias in every measured drift.
    for (const body of PLANETS) {
      const state = stateFromElements(body, scale);
      const mu = SIMULATION_G * (toMassUnits(SUN_MASS_KG, scale) + massInUnits(body.gm, scale));

      const found = osculatingElements(state, mu);

      expect(found.a / 100, body.name).toBeCloseTo(body.a, 6);
      expect(found.e, body.name).toBeCloseTo(body.e, 9);
      expect(wrapDegrees(found.periapsisDegrees - body.periapsis), body.name).toBeCloseTo(0, 7);
    }
  });

  it('reproduces the elements a century on, rates and all', () => {
    // The same arithmetic asked for J2100, which is what the century-long run
    // is measured against.
    const mercury = planet('Mercury');
    const state = stateFromElements(mercury, scale, 1);
    const mu = SIMULATION_G * (toMassUnits(SUN_MASS_KG, scale) + massInUnits(mercury.gm, scale));

    const found = osculatingElements(state, mu);

    expect(found.periapsisDegrees).toBeCloseTo(mercury.periapsis + mercury.rates.periapsis, 6);
    expect(found.e).toBeCloseTo(mercury.e + mercury.rates.e, 9);
  });
});

describe('the Sun', () => {
  it('is given the velocity that leaves the system standing still', () => {
    const sunMass = toMassUnits(SUN_MASS_KG, scale);
    const bodies = PLANETS.map((body) => ({
      state: stateFromElements(body, scale),
      mass: massInUnits(body.gm, scale),
    }));

    const velocity = sunVelocity(bodies, sunMass);

    let px = sunMass * velocity.vx;
    let py = sunMass * velocity.vy;
    for (const { state, mass } of bodies) {
      px += mass * state.vx;
      py += mass * state.vy;
    }

    expect(px).toBeCloseTo(0, 18);
    expect(py).toBeCloseTo(0, 18);

    // Jupiter alone swings the Sun at about 12 m/s, so this is not a rounding
    // detail: left at rest the Sun would carry the whole system off the canvas.
    const speed = toMetresPerSecond(Math.hypot(velocity.vx, velocity.vy), scale);
    expect(speed).toBeGreaterThan(1);
    expect(speed).toBeLessThan(30);
  });

  it('agrees with its own GM', () => {
    expect((SUN_MASS_KG * 6.6743e-11) / SUN_GM).toBeCloseTo(1, 12);
  });
});

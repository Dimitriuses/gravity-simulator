import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PRESET_ID,
  FIGURE_EIGHT_PERIOD_STEPS,
  PRESETS,
  Preset,
  binaryOrbitSpeed,
  circularOrbitSpeed,
  getPreset,
  presetParticles,
} from '../src/presets';
import { BARNES_HUT_THRESHOLD, PhysicsEngine, SIMULATION_G } from '../src/PhysicsEngine';
import { Particle } from '../src/Particle';
import { Vector2D } from '../src/Vector2D';
import { PLANETS } from '../src/ephemeris';
import { DAY_IN_SECONDS, SOLAR_SYSTEM_SCALE } from '../src/units';

/**
 * A preset is a claim about behaviour — "these two bodies orbit each other" —
 * and the only way to check it is to run it. Placing bodies by eye produces
 * scenes that quietly fly apart: the original hard-coded opening scene gave its
 * two bodies twice their circular speed, which is above the pair's escape
 * velocity, and its separation grew from 400 to 14,735 units over 20,000 steps
 * (measured under the fixed-step Euler scheme of the time). Every scene below is
 * run through the real engine for thousands of steps.
 */

/**
 * Run a preset and hand back the engine.
 *
 * At the scene's own `timeStep`, because for one of them "one step" is 398
 * seconds and running it at 1 would be measuring a thousandth of an orbit.
 */
function simulate(preset: Preset, steps: number, onStep?: (engine: PhysicsEngine) => void) {
  const engine = new PhysicsEngine(30);
  for (const particle of presetParticles(preset)) engine.addParticle(particle);
  for (let i = 0; i < steps; i++) {
    engine.step(preset.timeStep ?? 1);
    onStep?.(engine);
  }
  return engine;
}

function preset(id: string): Preset {
  const found = getPreset(id);
  if (!found) throw new Error(`no preset ${id}`);
  return found;
}

const separation = (a: Particle, b: Particle) => a.position.sub(b.position).magnitude();

describe('preset catalogue', () => {
  it('has unique ids, a name and a summary for every scene', () => {
    const ids = PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const scene of PRESETS) {
      expect(scene.name.length).toBeGreaterThan(0);
      expect(scene.summary.length).toBeGreaterThan(0);
      expect(scene.bodies.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('frames every scene within the camera zoom range', () => {
    for (const scene of PRESETS) {
      expect(scene.zoom).toBeGreaterThanOrEqual(0.1);
      expect(scene.zoom).toBeLessThanOrEqual(5);
    }
  });

  it('asks for trails it can afford to draw', () => {
    for (const scene of PRESETS) {
      if (scene.trailLength === undefined) continue;
      // Zero is a real answer: a scene with hundreds of bodies pays for each
      // trail in stroke changes, and the galaxy asks for none.
      expect(scene.trailLength).toBeGreaterThanOrEqual(0);
      // Trails are drawn in bands, so length costs vertices rather than state
      // changes — but a scene asking for tens of thousands of points would
      // still be a mistake rather than a decision.
      expect(scene.trailLength).toBeLessThanOrEqual(5000);
    }
  });

  it('resolves the default preset', () => {
    expect(getPreset(DEFAULT_PRESET_ID)).toBeDefined();
    expect(getPreset('no-such-scene')).toBeUndefined();
  });

  it('builds independent particles, so loading twice does not share state', () => {
    const scene = preset(DEFAULT_PRESET_ID);
    const first = presetParticles(scene);
    const second = presetParticles(scene);

    expect(first[0]).toBeInstanceOf(Particle);
    expect(first[0]).not.toBe(second[0]);

    first[0].position = first[0].position.add(new Vector2D(1000, 0));
    expect(second[0].position.x).toBe(scene.bodies[0].x);
  });

  it('starts every scene at rest overall, so nothing drifts off screen', () => {
    for (const scene of PRESETS) {
      const px = scene.bodies.reduce((sum, b) => sum + b.mass * b.vx, 0);
      const py = scene.bodies.reduce((sum, b) => sum + b.mass * b.vy, 0);
      expect(Math.abs(px)).toBeLessThan(1e-9);
      expect(Math.abs(py)).toBeLessThan(1e-9);
    }
  });
});

describe('orbit arithmetic', () => {
  it('gives the circular speed for a negligible mass', () => {
    // G·M·m/r² = m·v²/r  ->  v = sqrt(G·M/r)
    expect(circularOrbitSpeed(5000, 200)).toBeCloseTo(Math.sqrt((SIMULATION_G * 5000) / 200), 10);
  });

  it('gives half the naive speed for an equal-mass binary', () => {
    // Each body circles the barycentre at d/2, not d, and the attracting mass
    // is m rather than 2m — the factor that decides bound from unbound.
    const d = 400;
    const m = 100;
    expect(binaryOrbitSpeed(m, d)).toBeCloseTo(Math.sqrt((SIMULATION_G * m) / (2 * d)), 10);
  });
});

describe('binary', () => {
  it('holds its separation for tens of orbits', () => {
    const scene = preset('binary');
    let min = Infinity;
    let max = 0;
    simulate(scene, 20000, (engine) => {
      const d = separation(engine.particles[0], engine.particles[1]);
      min = Math.min(min, d);
      max = Math.max(max, d);
    });

    // ~4 orbits. Measured 400.0 – 400.0 over 60,000 steps under the default
    // scheme; it was 399.8 – 400.3 under the fixed-step Euler this replaced.
    // The bounds stay loose so the test tracks the scene, not the integrator.
    expect(min).toBeGreaterThan(395);
    expect(max).toBeLessThan(405);
  });

  it('stays centred on the origin', () => {
    const engine = simulate(preset('binary'), 20000);
    const centre = engine.particles[0].position.add(engine.particles[1].position).div(2);
    expect(centre.magnitude()).toBeLessThan(1);
  });
});

describe('star and planets', () => {
  it('keeps both satellites on their orbits', () => {
    const scene = preset('star-and-planets');
    let innerMin = Infinity;
    let innerMax = 0;
    let outerMin = Infinity;
    let outerMax = 0;

    const engine = simulate(scene, 20000, (e) => {
      const inner = separation(e.particles[1], e.particles[0]);
      const outer = separation(e.particles[2], e.particles[0]);
      innerMin = Math.min(innerMin, inner);
      innerMax = Math.max(innerMax, inner);
      outerMin = Math.min(outerMin, outer);
      outerMax = Math.max(outerMax, outer);
    });

    // ~56 orbits of the inner satellite. Measured 193.6 – 204.1 and
    // 396.9 – 413.1; the wobble is the satellites pulling on each other, not
    // the integrator — it barely moved when the scheme changed.
    expect(innerMin).toBeGreaterThan(180);
    expect(innerMax).toBeLessThan(220);
    expect(outerMin).toBeGreaterThan(370);
    expect(outerMax).toBeLessThan(430);

    // The star should sit still rather than being kicked around.
    expect(engine.particles[0].position.magnitude()).toBeLessThan(20);
  });
});

describe('figure eight', () => {
  it('returns to its starting configuration after one period', () => {
    const scene = preset('figure-eight');
    const engine = simulate(scene, Math.round(FIGURE_EIGHT_PERIOD_STEPS));

    engine.particles.forEach((particle, index) => {
      const start = scene.bodies[index];
      const drift = Math.hypot(particle.position.x - start.x, particle.position.y - start.y);
      // One period is ~2,500 steps; the choreography closes to within 0.37
      // units of where it started (it was a few units under fixed-step Euler).
      expect(drift).toBeLessThan(10);
    });
  });

  it('stays a closed curve rather than ejecting a body', () => {
    const scene = preset('figure-eight');
    let furthest = 0;
    let closestPair = Infinity;

    simulate(scene, Math.round(FIGURE_EIGHT_PERIOD_STEPS * 5), (engine) => {
      for (const particle of engine.particles) {
        furthest = Math.max(furthest, particle.position.magnitude());
      }
      for (let a = 0; a < engine.particles.length; a++) {
        for (let b = a + 1; b < engine.particles.length; b++) {
          closestPair = Math.min(closestPair, separation(engine.particles[a], engine.particles[b]));
        }
      }
    });

    // Measured over five periods: nothing leaves 270 units, and no pair closes
    // to within 173 — comfortably outside the separations where step size
    // starts to matter (INTEGRATORS.md).
    expect(furthest).toBeLessThan(320);
    expect(closestPair).toBeGreaterThan(100);
  });
});

describe('comet', () => {
  it('holds a stable eccentric orbit', () => {
    const scene = preset('comet');
    let closest = Infinity;
    let furthest = 0;

    // ~10 orbits; the period is ~1,580 steps.
    simulate(scene, 16000, (engine) => {
      const r = separation(engine.particles[1], engine.particles[0]);
      closest = Math.min(closest, r);
      furthest = Math.max(furthest, r);
    });

    // Measured over 20 passes: perihelion 180.9, aphelion 900.0, unchanged
    // pass to pass. The symplectic schemes preserve the shape of an orbit;
    // what they lose is phase, which here shows up as slow precession rather
    // than decay.
    expect(closest).toBeGreaterThan(175);
    expect(closest).toBeLessThan(190);
    expect(furthest).toBeGreaterThan(890);
    expect(furthest).toBeLessThan(910);
  });

  it('really is eccentric rather than a circle', () => {
    const scene = preset('comet');
    let closest = Infinity;
    let furthest = 0;
    simulate(scene, 16000, (engine) => {
      const r = separation(engine.particles[1], engine.particles[0]);
      closest = Math.min(closest, r);
      furthest = Math.max(furthest, r);
    });
    const eccentricity = (furthest - closest) / (furthest + closest);
    expect(eccentricity).toBeGreaterThan(0.6);
  });
});

describe('lagrange points', () => {
  /**
   * Where each trojan sits, as the angle at the *primary* between the secondary
   * and the trojan.
   *
   * That is the angle the equilateral triangle actually fixes, and it is 60
   * degrees by construction. Measured from the barycentre instead it would be
   * 61.0 degrees here and would move with the mass ratio, which makes it a
   * worse thing to assert.
   */
  function trojanAngles(engine: PhysicsEngine) {
    const primary = engine.particles[0].position;
    const toSecondary = engine.particles[1].position.sub(primary);
    const base = Math.atan2(toSecondary.y, toSecondary.x);

    return [2, 3].map((index) => {
      const toTrojan = engine.particles[index].position.sub(primary);
      const angle = Math.atan2(toTrojan.y, toTrojan.x);
      return ((((angle - base) * 180) / Math.PI + 540) % 360) - 180;
    });
  }

  it('parks the trojans 60 degrees from the secondary and keeps them there', () => {
    const engine = new PhysicsEngine(30);
    engine.collisionMode = 'none';
    for (const particle of presetParticles(preset('lagrange'))) engine.addParticle(particle);

    const [aheadStart, behindStart] = trojanAngles(engine);
    expect(aheadStart).toBeCloseTo(60, 1);
    expect(behindStart).toBeCloseTo(-60, 1);

    // Twenty orbits of the pair; the period is ~995 steps.
    let worstAhead = 0;
    let worstBehind = 0;
    for (let i = 0; i < 20000; i++) {
      engine.step();
      const [ahead, behind] = trojanAngles(engine);
      worstAhead = Math.max(worstAhead, Math.abs(ahead - 60));
      worstBehind = Math.max(worstBehind, Math.abs(behind + 60));
    }

    // Measured: they librate a few degrees around the points rather than
    // drifting away from them. Libration is the interesting part — a trojan
    // that sat perfectly still would look like a bug.
    expect(worstAhead).toBeLessThan(15);
    expect(worstBehind).toBeLessThan(15);
  }, 30000);

  it('keeps the two primaries on their circular orbit', () => {
    const engine = new PhysicsEngine(30);
    engine.collisionMode = 'none';
    for (const particle of presetParticles(preset('lagrange'))) engine.addParticle(particle);

    let min = Infinity;
    let max = 0;
    for (let i = 0; i < 10000; i++) {
      engine.step();
      const d = separation(engine.particles[0], engine.particles[1]);
      min = Math.min(min, d);
      max = Math.max(max, d);
    }

    expect(min).toBeGreaterThan(395);
    expect(max).toBeLessThan(405);
  }, 30000);
});

describe('solar system', () => {
  /**
   * The one scene in this file whose numbers nobody here chose, so the
   * assertions are against the sky rather than against the arithmetic that
   * produced it: the orbital periods, the distances at closest and furthest
   * approach, and the ordering of the eight planets.
   *
   * `npm run ephemeris` is the thorough version of this — a millennium through
   * RK4, checked against JPL's published rates. What is here is what a *scene*
   * has to promise: that it is stable, that it is the right size, and that it
   * goes round at the right speed under the integrator the app actually uses.
   */
  const scene = preset('solar-system');
  const scale = SOLAR_SYSTEM_SCALE;

  /** Simulation time units per day, for turning a step count into a date. */
  const stepsPerDay = DAY_IN_SECONDS / scale.secondsPerUnit / (scene.timeStep ?? 1);

  it('is the Sun and the eight planets, in order', () => {
    const bodies = presetParticles(scene);
    expect(bodies).toHaveLength(9);

    const [sun, ...planets] = bodies;
    const distances = planets.map((planet) => planet.position.sub(sun.position).magnitude());

    // 0.39 au to 30 au, each further out than the last.
    expect(distances[0]).toBeGreaterThan(30);
    expect(distances[distances.length - 1]).toBeLessThan(3100);
    for (let i = 1; i < distances.length; i++) {
      expect(distances[i], PLANETS[i].name).toBeGreaterThan(distances[i - 1]);
    }
  });

  it('gives the inner planets years of the right length', () => {
    // Measured the way a year is: from one crossing of a heliocentric direction
    // to the next. Nothing in the scene was fitted to these numbers — the
    // positions and velocities come from the J2000 elements, and the length of
    // a step comes from G through `src/units.ts`.
    const engine = new PhysicsEngine(30);
    for (const particle of presetParticles(scene)) engine.addParticle(particle);

    const sun = engine.particles[0];
    const inner = [0, 1, 2, 3];
    const angle = (index: number) => {
      const planet = engine.particles[index + 1];
      return Math.atan2(planet.position.y - sun.position.y, planet.position.x - sun.position.x);
    };

    const start = inner.map(angle);
    const previous = [...start];
    const year = inner.map(() => 0);

    for (let step = 1; step <= 1500; step++) {
      engine.step(scene.timeStep ?? 1);

      for (const index of inner) {
        const now = angle(index);
        const crossed = previous[index] < start[index] && now >= start[index];
        if (year[index] === 0 && step > 10 && crossed) {
          year[index] = step;
        }
        previous[index] = now;
      }
    }

    for (const index of inner) {
      const days = year[index] / stepsPerDay;
      const published = PLANETS[index].siderealPeriodDays;

      expect(year[index], `${PLANETS[index].name} never came round`).toBeGreaterThan(0);
      expect(
        Math.abs(days - published) / published,
        `${PLANETS[index].name}: ${days.toFixed(2)} d against ${published}`
      ).toBeLessThan(0.005);
    }
  });

  it('keeps every planet on the orbit its elements describe', () => {
    // Two Earth years, watching the extremes. Perihelion and aphelion are
    // published numbers, and an orbit that decayed, precessed into another or
    // was flung out by the integrator would miss them.
    const bounds = [
      { name: 'Mercury', low: 0.3075, high: 0.4667 },
      { name: 'Venus', low: 0.7184, high: 0.7282 },
      { name: 'Earth', low: 0.9833, high: 1.0167 },
      { name: 'Mars', low: 1.3814, high: 1.666 },
    ];

    const engine = new PhysicsEngine(30);
    for (const particle of presetParticles(scene)) engine.addParticle(particle);

    const sun = engine.particles[0];
    const seen = bounds.map(() => ({ min: Infinity, max: 0 }));

    for (let step = 0; step < 1500; step++) {
      engine.step(scene.timeStep ?? 1);

      bounds.forEach((_, index) => {
        const planet = engine.particles[index + 1];
        const au = planet.position.sub(sun.position).magnitude() / 100;
        seen[index].min = Math.min(seen[index].min, au);
        seen[index].max = Math.max(seen[index].max, au);
      });
    }

    bounds.forEach((bound, index) => {
      // 1% either side: the scene runs velocity Verlet at 173 steps of
      // Mercury's orbit, which holds an orbit's shape while turning it — see
      // EPHEMERIS.md on why measurement wants RK4 and watching does not.
      expect(seen[index].min, `${bound.name} perihelion`).toBeGreaterThan(bound.low * 0.99);
      expect(seen[index].max, `${bound.name} aphelion`).toBeLessThan(bound.high * 1.01);
    });
  });

  it('holds together, and holds its energy, over eleven simulated years', () => {
    const engine = new PhysicsEngine(30);
    for (const particle of presetParticles(scene)) engine.addParticle(particle);

    const before = engine.diagnostics();
    for (let step = 0; step < 8000; step++) engine.step(scene.timeStep ?? 1);
    const after = engine.diagnostics();

    const sun = engine.particles[0];
    expect(engine.particles).toHaveLength(9);
    for (let i = 1; i < engine.particles.length; i++) {
      const au = engine.particles[i].position.sub(sun.position).magnitude() / 100;
      expect(au, PLANETS[i - 1].name).toBeGreaterThan(0.3);
      expect(au, PLANETS[i - 1].name).toBeLessThan(31);
    }

    // Velocity Verlet at the frame pace this scene sets: bounded, and small.
    // What it does *not* bound is the orbits' orientation — see EPHEMERIS.md,
    // which is why the published measurement uses RK4 and this scene does not
    // need to.
    expect(Math.abs((after.energy - before.energy) / before.energy)).toBeLessThan(1e-6);
  });
});

describe('galaxy', () => {
  it('holds its disc rather than dispersing or collapsing', () => {
    const scene = preset('galaxy');
    // Contacts off: this is a claim about the orbits, and merging would slowly
    // eat the disc while the claim was being checked.
    const engine = new PhysicsEngine(30);
    engine.collisionMode = 'none';
    for (const particle of presetParticles(scene)) engine.addParticle(particle);

    const core = engine.particles[0];
    const radii = () =>
      engine.particles.slice(1).map((p) => p.position.sub(core.position).magnitude());

    const before = radii();
    for (let i = 0; i < 150; i++) engine.step();
    const after = radii();

    // Every body started between 300 and 2,400 units out and should still be
    // in that band: circular orbits, so radius is what does not change.
    expect(Math.min(...before)).toBeGreaterThan(295);
    expect(Math.max(...before)).toBeLessThan(2405);
    expect(Math.min(...after)).toBeGreaterThan(250);
    expect(Math.max(...after)).toBeLessThan(2600);

    // And the core should not have wandered off.
    expect(core.position.magnitude()).toBeLessThan(50);
  }, 30000);

  it('is big enough to be worth a tree, and uses one', () => {
    const engine = new PhysicsEngine(30);
    for (const particle of presetParticles(preset('galaxy'))) engine.addParticle(particle);

    expect(engine.particles.length).toBeGreaterThanOrEqual(BARNES_HUT_THRESHOLD);
    expect(engine.usingBarnesHut()).toBe(true);
  });

  it('is the same galaxy every time it is loaded', () => {
    // Built from a seeded generator: a scene that reshuffled itself could not
    // be tested, and could not be compared against itself after a change.
    const first = presetParticles(preset('galaxy'));
    const second = presetParticles(preset('galaxy'));

    expect(first).toHaveLength(second.length);
    for (let i = 0; i < first.length; i++) {
      expect(first[i].position.x).toBe(second[i].position.x);
      expect(first[i].mass).toBe(second[i].mass);
    }
  });
});

describe('slingshot', () => {
  it('passes wide enough for the integrator to resolve the flyby', () => {
    const scene = preset('slingshot');
    let closest = Infinity;

    simulate(scene, 1200, (engine) => {
      closest = Math.min(closest, separation(engine.particles[1], engine.particles[0]));
    });

    // Aimed straight at the primary this is ~8 units, deep inside the softened
    // force where nothing is meaningful. Measured closest approach: 186.4.
    expect(closest).toBeGreaterThan(150);
  });

  it('whips the probe through a large angle and lets it escape', () => {
    const scene = preset('slingshot');
    const probeStart = scene.bodies[1];
    const engine = simulate(scene, 1200);
    const probe = engine.particles[1];

    const before = Math.atan2(probeStart.vy, probeStart.vx);
    const after = Math.atan2(probe.velocity.y, probe.velocity.x);
    const turn = Math.abs((((after - before) * 180) / Math.PI + 540) % 360 - 180);

    expect(turn).toBeGreaterThan(45);
    expect(separation(probe, engine.particles[0])).toBeGreaterThan(2000);
  });
});

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
import { PhysicsEngine, SIMULATION_G } from '../src/PhysicsEngine';
import { Particle } from '../src/Particle';
import { Vector2D } from '../src/Vector2D';

/**
 * A preset is a claim about behaviour — "these two bodies orbit each other" —
 * and the only way to check it is to run it. Placing bodies by eye produces
 * scenes that quietly fly apart: the original hard-coded opening scene gave its
 * two bodies twice their circular speed, which is above the pair's escape
 * velocity, and its separation grew from 400 to 14,735 units over 20,000 steps
 * (measured under the fixed-step Euler scheme of the time). Every scene below is
 * run through the real engine for thousands of steps.
 */

/** Run a preset and hand back the engine. */
function simulate(preset: Preset, steps: number, onStep?: (engine: PhysicsEngine) => void) {
  const engine = new PhysicsEngine(30);
  for (const particle of presetParticles(preset)) engine.addParticle(particle);
  for (let i = 0; i < steps; i++) {
    engine.step();
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
      expect(scene.trailLength).toBeGreaterThan(0);
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

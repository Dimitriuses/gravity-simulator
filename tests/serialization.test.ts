import { describe, it, expect } from 'vitest';
import {
  MAX_DECODED_BODIES,
  SCENE_FORMAT_VERSION,
  SavedScene,
  decodeScene,
  encodeScene,
} from '../src/serialization';
import { PRESETS, presetParticles } from '../src/presets';
import { PhysicsEngine } from '../src/PhysicsEngine';

/**
 * Two things matter about a saved scene: that it comes back as what went in,
 * and that a link from a stranger cannot do anything worse than fail to load.
 * The second is why decoding is tested with rubbish as hard as it is tested
 * with valid input.
 */

const decoded = (text: string): SavedScene => {
  const result = decodeScene(text);
  if ('error' in result) throw new Error(`expected a scene, got: ${result.error}`);
  return result.scene;
};

const failure = (text: string): string => {
  const result = decodeScene(text);
  if ('error' in result) return result.error;
  throw new Error(`expected a failure, got a scene`);
};

describe('round trips', () => {
  it('carries a whole scene there and back', () => {
    const scene: SavedScene = {
      bodies: [
        { x: -200, y: 0, mass: 100, vx: 0, vy: 0.25 },
        { x: 200, y: 0, mass: 100, vx: 0, vy: -0.25 },
      ],
      camera: { x: 12, y: -34, zoom: 0.5 },
      trailLength: 2500,
      showVectorField: false,
      showParticleVectors: true,
      showTrails: true,
      integrator: 'rk4',
      collisionMode: 'bounce',
      forceMode: 'exact',
      adaptiveStepping: false,
    };

    expect(decoded(encodeScene(scene))).toEqual(scene);
  });

  it('carries a preset reference, which is the short form', () => {
    const scene: SavedScene = { preset: 'figure-eight' };
    const text = encodeScene(scene);

    // The whole point of the short form: it fits anywhere.
    expect(text.length).toBeLessThan(30);
    expect(decoded(text)).toEqual(scene);
  });

  it('keeps six significant digits, which is more than the physics has', () => {
    const scene: SavedScene = {
      bodies: [{ x: 242.501090, y: -60.7718825, mass: 200, vx: 0.294861, vy: 0.273453 }],
    };

    const body = decoded(encodeScene(scene)).bodies![0];
    expect(body.x).toBeCloseTo(242.501, 3);
    expect(body.y).toBeCloseTo(-60.7719, 4);
    expect(body.vx).toBeCloseTo(0.294861, 6);
  });

  it('survives every preset in the catalogue', () => {
    // Six *significant* digits is a relative promise, not an absolute one: it
    // is a hundredth of a unit on a 2,400-unit orbital radius and a millionth
    // on an orbital speed of 3.5. Checking it as decimal places would either
    // pass trivially or fail on the large numbers.
    const withinSixDigits = (actual: number, expected: number) =>
      Math.abs(actual - expected) <= Math.max(Math.abs(expected), 1e-6) * 1e-5;

    for (const preset of PRESETS) {
      const restored = decoded(encodeScene({ bodies: preset.bodies }));
      expect(restored.bodies, preset.id).toHaveLength(preset.bodies.length);

      for (let i = 0; i < preset.bodies.length; i++) {
        const original = preset.bodies[i];
        const copy = restored.bodies![i];

        for (const key of ['x', 'y', 'mass', 'vx', 'vy'] as const) {
          expect(
            withinSixDigits(copy[key], original[key]),
            `${preset.id} body ${i} ${key}: ${copy[key]} vs ${original[key]}`
          ).toBe(true);
        }
      }
    }
  });

  it('produces a link a browser will accept, for a hand-sized scene', () => {
    // Twenty bodies is a generous hand-built scene; 2,000 characters is the
    // length every browser and chat client handles without complaint.
    const bodies = Array.from({ length: 20 }, (_, i) => ({
      x: i * 37.5,
      y: -i * 12.25,
      mass: 100 + i,
      vx: 0.5,
      vy: -0.25,
    }));

    expect(encodeScene({ bodies, camera: { x: 0, y: 0, zoom: 1 } }).length).toBeLessThan(2000);
  });

  it('uses only characters a URL fragment allows unescaped', () => {
    const text = encodeScene({
      bodies: [{ x: -1.5, y: 2e-7, mass: 100, vx: 0, vy: 0 }],
      camera: { x: 0, y: 0, zoom: 1 },
      integrator: 'verlet',
    });

    expect(encodeURI(text)).toBe(text);
    expect(text).not.toMatch(/[#?&%\s]/);
  });
});

describe('what a scene restores', () => {
  it('restores a preset to the same simulation, step for step', () => {
    // The claim a shared link makes: you are looking at what I was looking at.
    const preset = PRESETS.find((p) => p.id === 'figure-eight')!;
    const restored = decoded(encodeScene({ bodies: preset.bodies }));

    const run = (bodies: typeof preset.bodies) => {
      const engine = new PhysicsEngine(30);
      for (const body of bodies) {
        engine.addParticle(presetParticles({ ...preset, bodies: [body] })[0]);
      }
      for (let i = 0; i < 500; i++) engine.step();
      return engine.particles.map((p) => p.position);
    };

    const original = run(preset.bodies);
    const copy = run(restored.bodies!);

    for (let i = 0; i < original.length; i++) {
      // Six significant digits in, so the two runs diverge only in the noise.
      expect(copy[i].x).toBeCloseTo(original[i].x, 2);
      expect(copy[i].y).toBeCloseTo(original[i].y, 2);
    }
  });
});

describe('rejecting what it should reject', () => {
  it('refuses input that is not a scene', () => {
    expect(failure('')).toBe('empty');
    expect(failure('   ')).toBe('empty');
    expect(failure('hello')).toContain('not a key=value field');
    expect(failure('b=1,2,3,4,5')).toBe('no version');
    expect(failure('v=1')).toBe('no bodies and no scene id');
  });

  it('refuses a scene from a newer format than it knows', () => {
    // Forward compatibility has to fail loudly: a v2 link may mean something
    // different by the same letters, and guessing would be worse than refusing.
    expect(failure(`v=${SCENE_FORMAT_VERSION + 1};s=binary`)).toContain('newer version');
  });

  it('ignores keys it does not know, so a later version can add fields', () => {
    const scene = decoded('v=1;s=binary;zzz=whatever;q=1,2,3');
    expect(scene.preset).toBe('binary');
  });

  it('refuses malformed numbers rather than turning them into NaN', () => {
    expect(failure('v=1;b=1,2,three,4,5')).toContain('bad body');
    expect(failure('v=1;b=1,2,3,4')).toContain('bad body');
    expect(failure('v=1;c=0,0')).toBe('bad camera');
    expect(failure('v=1;s=binary;t=-5')).toBe('bad trail length');
    expect(failure('v=1;s=binary;o=11')).toBe('bad overlay flags');
  });

  it('refuses a massless or negative-mass body', () => {
    // Mass divides in F = ma, so zero would put an infinity into the state on
    // the first step and never come out.
    expect(failure('v=1;b=0,0,0,0,0')).toContain('positive mass');
    expect(failure('v=1;b=0,0,-100,0,0')).toContain('positive mass');
  });

  it('refuses settings that are not settings', () => {
    expect(failure('v=1;s=binary;p=leapfrog,merge,auto,1')).toBe('bad physics settings');
    expect(failure('v=1;s=binary;p=verlet,explode,auto,1')).toBe('bad physics settings');
    expect(failure('v=1;s=binary;p=verlet,merge,auto')).toBe('bad physics settings');
  });

  it('refuses a link asking for more bodies than a browser can draw', () => {
    const many = Array.from({ length: MAX_DECODED_BODIES + 1 }, () => '0,0,1,0,0').join('|');
    expect(failure(`v=1;b=${many}`)).toContain('too many bodies');
  });

  it('refuses a scene id that is not an id', () => {
    // It is used to look up a preset, so it stays a plain slug.
    expect(failure('v=1;s=../../etc/passwd')).toBe('bad scene id');
    expect(failure('v=1;s=<script>')).toBe('bad scene id');
  });

  it('tolerates the decorations a copied link arrives with', () => {
    expect(decoded('#v=1;s=binary').preset).toBe('binary');
    expect(decoded('  v=1;s=binary  ').preset).toBe('binary');
    expect(decoded('scene=v=1;s=binary').preset).toBe('binary');
  });
});

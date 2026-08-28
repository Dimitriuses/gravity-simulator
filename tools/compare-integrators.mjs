// ─── Integrator comparison ───────────────────────────────────────────────────
//
//   npm run compare
//
// Runs the same initial conditions under all three schemes, with the fixed step
// and with adaptive sub-stepping, and prints the result as markdown tables ready
// to paste into INTEGRATORS.md. Roadmap M1's deliverable: the integrator choice
// made visible rather than asserted.
//
// It loads the TypeScript sources directly through Vite's SSR module loader, so
// there is one implementation of the physics and this measures the same code the
// browser runs — not a re-implementation that could drift from it.

import { createServer } from 'vite';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WANT_FILE = process.argv.includes('--write');

const server = await createServer({ server: { middlewareMode: true }, logLevel: 'error' });
const { PhysicsEngine, SIMULATION_G } = await server.ssrLoadModule('/src/PhysicsEngine.ts');
const { Particle } = await server.ssrLoadModule('/src/Particle.ts');

const SCHEMES = [
  ['euler', 'Symplectic Euler'],
  ['verlet', 'Velocity Verlet'],
  ['rk4', 'Runge-Kutta 4'],
  ['forest-ruth', 'Forest-Ruth'],
];

// The satellite has mass, so the two-body problem's gravitational parameter is
// G·(M + m) and both bodies move about their common barycentre. Using G·M and a
// fixed primary instead biases the ideal orbit by ~0.01% in period, which shows
// up as a phase error of about 0.14°/orbit that belongs to the measurement
// rather than to any of the schemes — it was large enough to swamp what RK4
// actually does at a well-resolved radius.
const SATELLITE_MASS = 1;
const parameter = (primaryMass) => SIMULATION_G * (primaryMass + SATELLITE_MASS);

/**
 * A circular orbit: heavy primary near the origin, satellite at radius r on a
 * circular *relative* orbit, with the pair's momentum balanced so the
 * barycentre stays put.
 */
function circularOrbit(radius, primaryMass, integrator, adaptive) {
  const engine = new PhysicsEngine(30);
  engine.integrator = integrator;
  engine.adaptiveStepping = adaptive;

  const relativeSpeed = Math.sqrt(parameter(primaryMass) / radius);
  const satelliteSpeed = (relativeSpeed * primaryMass) / (primaryMass + SATELLITE_MASS);
  const primarySpeed = (relativeSpeed * SATELLITE_MASS) / (primaryMass + SATELLITE_MASS);

  engine.addParticle(new Particle(0, 0, primaryMass, 0, -primarySpeed));
  engine.addParticle(new Particle(radius, 0, SATELLITE_MASS, 0, satelliteSpeed));
  return engine;
}

const period = (radius, primaryMass) =>
  2 * Math.PI * Math.sqrt(radius ** 3 / parameter(primaryMass));

/** Specific orbital energy, v²/2 − μ/r: the quantity a symplectic scheme bounds. */
function specificEnergy(engine, primaryMass) {
  const [primary, satellite] = engine.particles;
  const r = satellite.position.sub(primary.position).magnitude();
  const v = satellite.velocity.sub(primary.velocity).magnitude();
  return (v * v) / 2 - parameter(primaryMass) / r;
}

/**
 * Run `orbits` orbits and report what the scheme did to them.
 *
 * Phase is measured against where a perfect Kepler orbit would be at the same
 * time, so it accumulates: it is the error you see as a body sitting in the
 * right orbit at the wrong place along it.
 */
function measure({ radius, primaryMass, integrator, adaptive, orbits }) {
  const engine = circularOrbit(radius, primaryMass, integrator, adaptive);
  const T = period(radius, primaryMass);
  const steps = Math.round(T * orbits);

  const energy0 = specificEnergy(engine, primaryMass);
  let minRadius = Infinity;
  let maxRadius = 0;
  let minEnergy = energy0;
  let maxEnergy = energy0;
  let subSteps = 1;

  for (let i = 0; i < steps; i++) {
    engine.step();
    subSteps = Math.max(subSteps, engine.lastSubSteps);

    const [primary, satellite] = engine.particles;
    const r = satellite.position.sub(primary.position).magnitude();
    minRadius = Math.min(minRadius, r);
    maxRadius = Math.max(maxRadius, r);

    const e = specificEnergy(engine, primaryMass);
    minEnergy = Math.min(minEnergy, e);
    maxEnergy = Math.max(maxEnergy, e);
  }

  const [primary, satellite] = engine.particles;
  const actualAngle = Math.atan2(
    satellite.position.y - primary.position.y,
    satellite.position.x - primary.position.x
  );
  const idealAngle = ((2 * Math.PI * steps) / T) % (2 * Math.PI);
  let phaseError = ((actualAngle - idealAngle) * 180) / Math.PI;
  phaseError = ((phaseError + 540) % 360) - 180;

  return {
    radiusBand: `${minRadius.toFixed(1)} – ${maxRadius.toFixed(1)}`,
    radiusSpreadPct: ((maxRadius - minRadius) / radius) * 100,
    energyDriftPct: Math.abs((specificEnergy(engine, primaryMass) - energy0) / energy0) * 100,
    energySpreadPct: Math.abs((maxEnergy - minEnergy) / energy0) * 100,
    phasePerOrbit: phaseError / orbits,
    subSteps,
    stepsPerOrbit: T,
  };
}

const rows = [];
const line = (s) => rows.push(s);

line('## Accuracy by scheme, on a circular orbit');
line('');
line('Mass-5000 primary, negligible satellite, 100 orbits, `dt = 1`, adaptive');
line('stepping **off** so this is the scheme alone.');
line('');
line('| orbit radius | steps/orbit | scheme | radius stays within | spread | energy drift | phase error/orbit |');
line('|---:|---:|---|---|---:|---:|---:|');

for (const radius of [400, 200, 100, 50]) {
  for (const [id, label] of SCHEMES) {
    const r = measure({ radius, primaryMass: 5000, integrator: id, adaptive: false, orbits: 100 });
    line(
      `| ${radius} | ${r.stepsPerOrbit.toFixed(0)} | ${label} | ${r.radiusBand} | ` +
        `${r.radiusSpreadPct.toFixed(2)}% | ${r.energyDriftPct.toFixed(4)}% | ${r.phasePerOrbit.toFixed(3)}° |`
    );
  }
}

line('');
line('## What adaptive stepping adds');
line('');
line('The same orbits, velocity Verlet throughout, with and without sub-stepping.');
line('');
line('| orbit radius | steps/orbit | fixed step: spread | adaptive: spread | sub-steps used |');
line('|---:|---:|---:|---:|---:|');

for (const radius of [400, 200, 100, 50]) {
  const fixed = measure({ radius, primaryMass: 5000, integrator: 'verlet', adaptive: false, orbits: 100 });
  const adaptive = measure({ radius, primaryMass: 5000, integrator: 'verlet', adaptive: true, orbits: 100 });
  line(
    `| ${radius} | ${fixed.stepsPerOrbit.toFixed(0)} | ${fixed.radiusSpreadPct.toFixed(2)}% | ` +
      `${adaptive.radiusSpreadPct.toFixed(2)}% | ${adaptive.subSteps} |`
  );
}

line('');
line('## The tightest orbit that is still an orbit');
line('');
line('A satellite cannot circle closer than the primary\'s own radius, and below');
line('that the force law softens, so there is a floor on how badly a *physical*');
line('orbit can be under-resolved: about 25 steps per orbit, whatever the masses.');
line('A mass-1000 primary has a radius of 20 units, so an orbit at 25 units is');
line('close to that floor.');
line('');
line('| scheme | adaptive | radius stays within | spread | phase error/orbit | sub-steps |');
line('|---|---|---|---:|---:|---:|');

for (const [id, label] of SCHEMES) {
  for (const adaptive of [false, true]) {
    const r = measure({ radius: 25, primaryMass: 1000, integrator: id, adaptive, orbits: 100 });
    line(
      `| ${label} | ${adaptive ? 'on' : 'off'} | ${r.radiusBand} | ${r.radiusSpreadPct.toFixed(2)}% | ` +
        `${r.phasePerOrbit.toFixed(2)}° | ${r.subSteps} |`
    );
  }
}

line('');
line('## Long run: is it symplectic?');
line('');
line('This is the reason RK4 is offered for comparison rather than as the');
line('default. A symplectic scheme trades energy back and forth within a bound,');
line('so its error stops growing; a non-symplectic one accumulates in one');
line('direction however high its order. Measured at r = 50 — 44 steps per orbit,');
line('coarse enough for the difference to be visible inside a few hundred orbits.');
line('');
line('Each cell is the **total** energy excursion up to that point — the widest');
line("the orbit's energy ever got from where it started. A bounded scheme stops");
line('growing; RK4 keeps going.');
line('');
line('| scheme | by 100 orbits | by 500 | by 1,000 | radius over 1,000 orbits |');
line('|---|---:|---:|---:|---|');

for (const [id, label] of SCHEMES) {
  const runs = [100, 500, 1000].map((orbits) =>
    measure({ radius: 50, primaryMass: 5000, integrator: id, adaptive: false, orbits })
  );
  line(
    `| ${label} | ${runs.map((d) => `${d.energySpreadPct.toFixed(4)}%`).join(' | ')} | ` +
      `${runs[2].radiusBand} |`
  );
}

const report = rows.join('\n') + '\n';
console.log('\n' + report);

if (WANT_FILE) {
  const target = path.join(ROOT, 'INTEGRATORS.generated.md');
  await writeFile(target, report, 'utf8');
  console.log(`wrote ${path.relative(ROOT, target)}`);
}

await server.close();

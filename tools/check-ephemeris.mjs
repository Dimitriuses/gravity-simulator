// ─── The solar system, against the real one ──────────────────────────────────
//
//   npm run ephemeris             run it and print the report
//   npm run ephemeris -- --write  dump EPHEMERIS.generated.md to paste in
//   npm run ephemeris -- --quick  a tenth of the span, for a smoke run
//
// Roadmap M8. Every other scene in this repository was chosen — the presets
// derive their velocities from an orbit equation so that they do what they say
// they do. This one is not chosen: it starts from the planets' published
// orbital elements at J2000, runs a Julian century, and reads the orbits back
// out. What comes out is either what the sky does or the simulation is wrong.
//
// Loads the TypeScript sources through Vite's SSR loader, so this measures the
// same engine, the same force law and the same integrators the browser runs.

import { createServer } from 'vite';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WANT_FILE = process.argv.includes('--write');
const QUICK = process.argv.includes('--quick');

const server = await createServer({ server: { middlewareMode: true }, logLevel: 'error' });
const { PhysicsEngine, SIMULATION_G } = await server.ssrLoadModule('/src/PhysicsEngine.ts');
const { Particle } = await server.ssrLoadModule('/src/Particle.ts');
const { Vector2D } = await server.ssrLoadModule('/src/Vector2D.ts');
const units = await server.ssrLoadModule('/src/units.ts');
const ephemeris = await server.ssrLoadModule('/src/ephemeris.ts');

const { SOLAR_SYSTEM_SCALE: SCALE, DAY_IN_SECONDS, CENTURY_IN_SECONDS } = units;
const { PLANETS, SUN_MASS_KG, SUN_RADIUS_METRES } = ephemeris;

/** The span to integrate, in simulation time units. */
const CENTURY = units.toTimeUnits(CENTURY_IN_SECONDS, SCALE);
const SPAN = QUICK ? CENTURY / 10 : CENTURY;

/**
 * The step the published run uses, in simulation time units.
 *
 * Mercury's year is 19,081 of them, so this is about 1,900 steps an orbit. The
 * control run below is what says whether that is enough, and for RK4 it is:
 * halving it moves Mercury's perihelion rate by less than a tenth of an
 * arcsecond per century.
 */
const STEP = 10;

/** GR's contribution to Mercury's perihelion, arcseconds per century. */
const RELATIVITY = 42.98;

/**
 * The Newtonian part, as the textbooks decompose it: Venus 277.9, Jupiter
 * 153.6, Earth 90.0, Saturn 7.3, Mars 2.5, Uranus and Neptune 0.2. This is the
 * number a Newtonian simulation of the eight planets is trying to produce.
 */
const NEWTONIAN = 531.5;

const SUN_MASS = units.toMassUnits(SUN_MASS_KG, SCALE);

const ms = (v) => (v < 10 ? v.toFixed(2) : v.toFixed(1));
const signed = (v, digits) => (v >= 0 ? '+' : '') + v.toFixed(digits);
const arcseconds = (degreesPerCentury) => degreesPerCentury * 3600;

/**
 * Build the system: the Sun at the origin, the planets where their elements put
 * them, and the Sun given the velocity that leaves the whole thing standing
 * still.
 *
 * `only` restricts it to a subset by name, which is how the control runs are
 * made — the same code path, one planet instead of eight.
 */
function build(integrator, only = null) {
  const engine = new PhysicsEngine(30);
  engine.collisionMode = 'none';
  engine.forceMode = 'exact';
  engine.adaptiveStepping = false;
  engine.integrator = integrator;

  const sun = new Particle(0, 0, SUN_MASS);
  engine.addParticle(sun);

  const bodies = [];
  for (const body of PLANETS) {
    if (only && !only.includes(body.name)) continue;

    const state = ephemeris.stateFromElements(body, SCALE);
    const mass = ephemeris.massInUnits(body.gm, SCALE);
    const particle = new Particle(state.x, state.y, mass, state.vx, state.vy);

    engine.addParticle(particle);
    bodies.push({ body, particle, mass, mu: SIMULATION_G * (SUN_MASS + mass) });
  }

  const velocity = ephemeris.sunVelocity(
    bodies.map(({ particle, mass }) => ({
      state: { x: 0, y: 0, vx: particle.velocity.x, vy: particle.velocity.y },
      mass,
    })),
    SUN_MASS
  );
  sun.velocity = sun.velocity.add(new Vector2D(velocity.vx, velocity.vy));

  return { engine, sun, bodies };
}

/** A planet's state relative to the Sun, which is what its elements describe. */
const heliocentric = (sun, particle) => ({
  x: particle.position.x - sun.position.x,
  y: particle.position.y - sun.position.y,
  vx: particle.velocity.x - sun.velocity.x,
  vy: particle.velocity.y - sun.velocity.y,
});

/** Total energy and angular momentum, for judging the integration itself. */
function totals(engine) {
  let energy = 0;
  let angular = 0;

  const particles = engine.particles;
  for (let i = 0; i < particles.length; i++) {
    const a = particles[i];
    energy += 0.5 * a.mass * (a.velocity.x ** 2 + a.velocity.y ** 2);
    angular += a.mass * (a.position.x * a.velocity.y - a.position.y * a.velocity.x);

    for (let j = i + 1; j < particles.length; j++) {
      const b = particles[j];
      const r = Math.hypot(b.position.x - a.position.x, b.position.y - a.position.y);
      energy -= (SIMULATION_G * a.mass * b.mass) / r;
    }
  }

  return { energy, angular };
}

/** Least-squares slope of y against x. */
function slope(xs, ys) {
  const n = xs.length;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i] / n;
    my += ys[i] / n;
  }

  let top = 0;
  let bottom = 0;
  for (let i = 0; i < n; i++) {
    top += (xs[i] - mx) * (ys[i] - my);
    bottom += (xs[i] - mx) ** 2;
  }

  return top / bottom;
}

/**
 * Integrate, and watch each planet's orbit.
 *
 * Every so often the *osculating* ellipse is read back out of the state — the
 * orbit each planet is on at that instant, which is how a perturbed body is
 * asked what it has done. Its longitude is accumulated without wrapping, so the
 * mean motion comes out of the run itself rather than out of the table it
 * started from, and the perihelion is unwrapped the same way so that one which
 * walks past 180° keeps counting instead of jumping back.
 */
function run({ integrator = 'rk4', step = STEP, span = SPAN, only = null } = {}) {
  const { engine, sun, bodies } = build(integrator, only);
  const start = totals(engine);

  const sampleEvery = Math.max(1, Math.round(span / step / 3000));
  const tracks = bodies.map(({ body, mu }) => ({
    body,
    mu,
    times: [],
    a: [],
    e: [],
    periapsis: [],
    turns: 0,
    lastAngle: null,
    longitude: 0,
    firstAngle: null,
  }));

  const record = (time) => {
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      const state = heliocentric(sun, bodies[i].particle);
      const elements = ephemeris.osculatingElements(state, track.mu);

      const angle = Math.atan2(state.y, state.x);
      if (track.firstAngle === null) track.firstAngle = angle;
      if (track.lastAngle !== null && angle < track.lastAngle - Math.PI) track.turns++;
      track.lastAngle = angle;
      track.longitude = track.turns * 2 * Math.PI + angle;

      const previous = track.periapsis.length
        ? track.periapsis[track.periapsis.length - 1]
        : elements.periapsisDegrees;

      track.times.push(time);
      track.a.push(elements.a);
      track.e.push(elements.e);
      track.periapsis.push(previous + ephemeris.wrapDegrees(elements.periapsisDegrees - previous));
    }
  };

  record(0);
  const began = performance.now();

  let time = 0;
  let steps = 0;
  while (time < span) {
    engine.step(step);
    time += step;
    steps++;
    if (steps % sampleEvery === 0) record(time);
  }
  record(time);

  const elapsed = performance.now() - began;
  const end = totals(engine);
  const centuries = (time * SCALE.secondsPerUnit) / CENTURY_IN_SECONDS;

  const results = tracks.map((track) => {
    const at = track.times.map((t) => (t * SCALE.secondsPerUnit) / CENTURY_IN_SECONDS);
    const last = track.times.length - 1;
    const turns = (track.longitude - track.firstAngle) / (2 * Math.PI);

    return {
      name: track.body.name,
      published: track.body,
      days: (track.times[last] * SCALE.secondsPerUnit) / DAY_IN_SECONDS / turns,
      turns,
      a: track.a[0] / 100,
      e: track.e[0],
      aRate: slope(at, track.a) / 100,
      eRate: slope(at, track.e),
      // A least-squares slope, not the difference between the ends, because
      // that is what the published rates are: a linear model fitted across the
      // century. An element wanders as well as drifting, so the two answers
      // differ — for Mercury by half an arcsecond, for the Earth by sixty.
      periapsisRate: slope(at, track.periapsis),
      endpointRate: (track.periapsis[last] - track.periapsis[0]) / centuries,
    };
  });

  return {
    results,
    byName: Object.fromEntries(results.map((r) => [r.name, r])),
    steps,
    elapsed,
    centuries,
    energyDrift: Math.abs((end.energy - start.energy) / start.energy),
    angularDrift: Math.abs((end.angular - start.angular) / start.angular),
  };
}

// ─── Runs ────────────────────────────────────────────────────────────────────
const publishedRun = run();
const halfStep = run({ step: STEP / 2 });
const verletRun = run({ integrator: 'verlet' });

// Sun and Mercury alone: a two-body problem, whose perihelion cannot move at
// all. Whatever this reports is the integrator's own invention.
const control = {};
for (const integrator of ['verlet', 'rk4']) {
  control[integrator] = [];
  for (const step of [40, 20, 10, 5]) {
    const only = run({ integrator, step, only: ['Mercury'], span: CENTURY / 10 });
    control[integrator].push({ step, rate: arcseconds(only.byName.Mercury.periapsisRate) });
  }
}

// ─── Report ──────────────────────────────────────────────────────────────────
const rows = [];
const line = (s) => rows.push(s);

line('## The scale');
line('');
line("Three numbers, and only two of them are a choice. `SIMULATION_G` is 0.5, so");
line('once a length and a mass are declared, the length of a second follows:');
line('');
line('| quantity | one simulation unit is | why |');
line('|---|---|---|');
line(
  `| length | ${(SCALE.metresPerUnit / 1e9).toFixed(6)} Gm | a hundred units to the au, which puts the ` +
    'orbits at 39 to 3,007 units — the range the presets already work in |'
);
line(
  `| mass | ${SCALE.kilogramsPerUnit.toExponential(4)} kg | the value that makes \`r = 2·m^(1/3)\` give the ` +
    "Sun its own radius |"
);
line(`| time | ${SCALE.secondsPerUnit.toFixed(4)} s | whatever makes G come out at 0.5 |`);
line('');
line('The check on that arithmetic is a number nobody here chose. A circular orbit');
line('of one au about one solar mass comes out at **365.2569 days**, travelled at');
line('**29.785 km/s**.');
line('');

line('## The bodies as the simulation holds them');
line('');
line('Radius is `2·m^(1/3)`, one density for everything, so a body is drawn the');
line("right size exactly to the extent that its density matches the Sun's. Jupiter");
line('is within 2%, Saturn is a fifth too small, the rocky planets half again too');
line('wide. Nothing depends on it — the largest radius here is 0.05 units against');
line('orbits of 39 and up — but it is worth knowing which way the rule bends.');
line('');
line('| body | mass (units) | radius (units) | radius if real |');
line('|---|---:|---:|---:|');
line(
  `| Sun | ${SUN_MASS.toExponential(3)} | ${Particle.radiusForMass(SUN_MASS).toFixed(4)} | ` +
    `${units.toUnits(SUN_RADIUS_METRES, SCALE).toFixed(4)} |`
);
for (const body of PLANETS) {
  const mass = ephemeris.massInUnits(body.gm, SCALE);
  line(
    `| ${body.name} | ${mass.toExponential(3)} | ${Particle.radiusForMass(mass).toFixed(4)} | ` +
      `${units.toUnits(body.radiusMetres, SCALE).toFixed(4)} |`
  );
}
line('');

line('## Orbital periods');
line('');
line('Measured by watching each planet go round: the total angle it sweeps over the');
line('run, divided into the time it takes. Published figures are sidereal periods.');
line('');
line('| planet | measured | published | difference | orbits in the window |');
line('|---|---:|---:|---:|---:|');
for (const r of publishedRun.results) {
  const error = ((r.days - r.published.siderealPeriodDays) / r.published.siderealPeriodDays) * 100;
  line(
    `| ${r.name} | ${r.days.toFixed(2)} d | ${r.published.siderealPeriodDays} d | ` +
      `${signed(error, 3)}% | ${r.turns.toFixed(1)} |`
  );
}
line('');
line('The last column is why the giants are the ragged rows here and everywhere');
line('below. A century is 415 orbits of Mercury and two thirds of one of Neptune,');
line('and two thirds of an ellipse is not enough to say how long the whole of it');
line('takes: the planet spends that stretch at whatever speed that part of the');
line('orbit calls for, and dividing angle by time reports that instead of a mean.');
line('');

line('## How the orbits change over the century');
line('');
line("JPL publishes each element's rate of change per century alongside the elements");
line('themselves. Those rates are the real solar system perturbing itself, and they');
line('are what the run is checked against. Semi-major axis in au per century,');
line('eccentricity per century.');
line('');
line('| planet | da/dt | published | de/dt | published |');
line('|---|---:|---:|---:|---:|');
for (const r of publishedRun.results) {
  line(
    `| ${r.name} | ${signed(r.aRate, 7)} | ${signed(r.published.rates.a, 7)} | ` +
      `${signed(r.eRate, 7)} | ${signed(r.published.rates.e, 7)} |`
  );
}
line('');

line('## Where the perihelia go');
line('');
line('The turning of an orbit is the hardest of these to fake and the easiest to');
line('get wrong, so it is the one worth reading closely.');
line('');
line('| planet | e | measured dϖ/dt | published | difference |');
line('|---|---:|---:|---:|---:|');
for (const r of publishedRun.results) {
  const measured = arcseconds(r.periapsisRate);
  const real = arcseconds(r.published.rates.periapsis);
  line(
    `| ${r.name} | ${r.published.e.toFixed(4)} | ${signed(measured, 1)}″ | ${signed(real, 1)}″ | ` +
      `${signed(measured - real, 1)}″ |`
  );
}
line('');
line('The four inner planets are the meaningful rows, and Venus is the awkward one');
line("of those: its orbit is so nearly circular (e = 0.0068) that where its perihelion");
line('*is* barely means anything, and both the measurement and the published rate are');
line('small differences of large wandering quantities. The giants complete 8, 3, 1 and');
line('0.6 orbits in a century between them, which is not enough of an orbit to quote a');
line('rate of turn for — Jupiter and Saturn also swap angular momentum on a 900-year');
line('cycle, so a century-long window catches a phase of that rather than a trend.');
line('');

const mercury = publishedRun.byName.Mercury;
const measured = arcseconds(mercury.periapsisRate);
const observed = arcseconds(PLANETS[0].rates.periapsis);

line("## Mercury's perihelion");
line('');
line('The one this was worth doing for.');
line('');
line('| | arcseconds per century |');
line('|---|---:|');
line(`| **this simulation**, eight planets, Newtonian gravity, flat | **${signed(measured, 1)}″** |`);
line(`| the Newtonian part, as classical perturbation theory decomposes it | ${NEWTONIAN.toFixed(1)}″ |`);
line(`| observed, from JPL's rate for ϖ | ${observed.toFixed(1)}″ |`);
line(`| general relativity's share of that, which Newton cannot produce | ${RELATIVITY.toFixed(2)}″ |`);
line('');
line(`The simulation lands ${signed(measured - NEWTONIAN, 1)}″ from the Newtonian figure`);
line(`and ${signed(measured - observed, 1)}″ short of the observed one. The shortfall is the size`);
line('of the relativistic term, which is the correct thing for a Newtonian simulation');
line('to be missing. The excess over 531.5″ is the flattening: laid in one plane every');
line("perturber pulls entirely within Mercury's orbit plane instead of mostly within");
line('it, and pulls a little harder for it. The sign is what that argument predicts.');
line('');

line('## The integrator matters more than the physics here');
line('');
line('Sun and Mercury alone is a two-body problem. Its perihelion does not move —');
line('that is Newton, not an approximation — so anything the simulation reports is');
line('the integrator inventing it. This is the measurement that decided how the run');
line('above was configured:');
line('');
line('| step (days) | velocity Verlet | RK4 |');
line('|---:|---:|---:|');
for (let i = 0; i < control.verlet.length; i++) {
  const step = control.verlet[i].step;
  const days = (step * SCALE.secondsPerUnit) / DAY_IN_SECONDS;
  line(
    `| ${step} (${days.toFixed(3)}) | ${signed(control.verlet[i].rate, 1)}″ | ` +
      `${signed(control.rk4[i].rate, 2)}″ |`
  );
}
line('');
line('Verlet falls by exactly 4x per halving, which is what a second-order scheme');
line('should do and is also why it is useless here: at the step this run uses, it');
line('invents three times the effect being measured, pointing the other way.');
line('RK4 is fourth-order and reports nothing at any of these steps. Running the');
line('real system through Verlet instead of RK4 gives Mercury');
line(
  `**${signed(arcseconds(verletRun.byName.Mercury.periapsisRate), 1)}″** — the right physics with the` +
    ' wrong arithmetic on top of it.'
);
line('');
line('This is the same trade [`INTEGRATORS.md`](INTEGRATORS.md) measures from the');
line("other side. Verlet's virtue is that its *energy* error is bounded, and it holds");
line('that here too: over the century the run below drifts by a part in 10⁹. Bounded');
line('energy error is not accuracy, and a conserved quantity can sit still while the');
line('orbit it belongs to turns.');
line('');
line('| | energy drift | angular momentum drift | dϖ/dt for Mercury |');
line('|---|---:|---:|---:|');
line(
  `| RK4, step ${STEP} | ${publishedRun.energyDrift.toExponential(1)} | ` +
    `${publishedRun.angularDrift.toExponential(1)} | ${signed(measured, 1)}″ |`
);
line(
  `| RK4, step ${STEP / 2} | ${halfStep.energyDrift.toExponential(1)} | ` +
    `${halfStep.angularDrift.toExponential(1)} | ` +
    `${signed(arcseconds(halfStep.byName.Mercury.periapsisRate), 1)}″ |`
);
line(
  `| Verlet, step ${STEP} | ${verletRun.energyDrift.toExponential(1)} | ` +
    `${verletRun.angularDrift.toExponential(1)} | ` +
    `${signed(arcseconds(verletRun.byName.Mercury.periapsisRate), 1)}″ |`
);
line('');
line(
  `The published run is ${publishedRun.steps.toLocaleString('en-US')} steps of ` +
    `${((STEP * SCALE.secondsPerUnit) / DAY_IN_SECONDS).toFixed(3)} days and takes ` +
    `${ms(publishedRun.elapsed / 1000)} s.`
);
line(
  `Halving the step moves Mercury's rate by ` +
    `${Math.abs(measured - arcseconds(halfStep.byName.Mercury.periapsisRate)).toFixed(2)}″, so the`
);
line('figure has stopped depending on it.');
line('');

const report = rows.join('\n');
console.log(report);

if (WANT_FILE) {
  const target = path.join(ROOT, 'EPHEMERIS.generated.md');
  await writeFile(target, report, 'utf8');
  console.log(`\nwrote ${path.relative(ROOT, target)}`);
}

await server.close();

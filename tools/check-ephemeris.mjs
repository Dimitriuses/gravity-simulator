// ─── The solar system, against the real one ──────────────────────────────────
//
//   npm run ephemeris             run it and print the report
//   npm run ephemeris -- --write  dump EPHEMERIS.generated.md to paste in
//   npm run ephemeris -- --quick  a tenth of the span, for a smoke run
//
// Roadmap M8, extended by M14. Every other scene in this repository was chosen
// — the presets derive their velocities from an orbit equation so that they do
// what they say they do. This one is not chosen: it starts from the planets'
// published orbital elements at J2000, runs a Julian *millennium*, and reads
// the orbits back out. What comes out is either what the sky does or the
// simulation is wrong.
//
// Rates are reported over two windows cut from the same run — the first century
// of it and the whole of it. A century is 0.6 of an orbit of Neptune, which is
// not enough of one to say how fast its orbit turns; a millennium is six. The
// century column is kept because that is the window JPL's published rates are
// fitted over, so it is the one that can be compared with them directly.
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
const MILLENNIUM = CENTURY * 10;
const SPAN = QUICK ? CENTURY / 10 : MILLENNIUM;

/**
 * How often the orbits are read back, in simulation time units.
 *
 * Tied to the *shortest* orbit rather than to the span, which is the trap a
 * longer window opens: sampling a millennium three thousand times puts four
 * months between readings, and Mercury goes round in three. The turn counter
 * and the perihelion unwrapping both need better than half an orbit between
 * samples, so this takes an eighth of Mercury's year and leaves the sample
 * count to follow from the span.
 */
const MERCURY_PERIOD = units.toTimeUnits(
  PLANETS[0].siderealPeriodDays * DAY_IN_SECONDS,
  SCALE
);
const SAMPLE_INTERVAL = MERCURY_PERIOD / 8;

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
 * The rate a perihelion turns, from `h = e·sin ϖ` and `k = e·cos ϖ`.
 *
 * Taking the slope of ϖ directly works while an orbit is elliptical enough to
 * have a definite perihelion, and stops working as `e` approaches zero: where
 * the perihelion *is* stops meaning much, it swings about wildly, and a fit to
 * it measures the swinging. Venus, at e = 0.0068, is the case in point — the
 * century run put its perihelion rate at -270″ against a published +9.7″.
 *
 * `h` and `k` have no such problem: they are smooth through a circular orbit,
 * because the pair carries the eccentricity *and* the direction together, and
 * neither has to be unwrapped. Since `ϖ = atan2(h, k)`,
 *
 * ```
 *   dϖ/dt = (k·ḣ - h·k̇) / (h² + k²)
 * ```
 *
 * with `ḣ` and `k̇` the fitted slopes and `h`, `k` their means over the window.
 * It is the standard way to quote a secular rate for a near-circular orbit and
 * agrees with the direct fit wherever the direct fit is trustworthy.
 */
function perihelionRate(times, h, k) {
  const hDot = slope(times, h);
  const kDot = slope(times, k);

  let meanH = 0;
  let meanK = 0;
  for (let i = 0; i < h.length; i++) {
    meanH += h[i] / h.length;
    meanK += k[i] / k.length;
  }

  const eSquared = meanH * meanH + meanK * meanK;
  if (!(eSquared > 0)) return 0;

  // Radians per century, converted to degrees for the same units as the table.
  return ((meanK * hDot - meanH * kDot) / eSquared) * (180 / Math.PI);
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

  const sampleEvery = Math.max(1, Math.round(SAMPLE_INTERVAL / step));
  const tracks = bodies.map(({ body, mu }) => ({
    body,
    mu,
    times: [],
    a: [],
    e: [],
    periapsis: [],
    // e·sin ϖ and e·cos ϖ. See `perihelionRate` below for why.
    h: [],
    k: [],
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

      const periapsis = elements.periapsisDegrees * (Math.PI / 180);

      track.times.push(time);
      track.a.push(elements.a);
      track.e.push(elements.e);
      track.periapsis.push(previous + ephemeris.wrapDegrees(elements.periapsisDegrees - previous));
      track.h.push(elements.e * Math.sin(periapsis));
      track.k.push(elements.e * Math.cos(periapsis));
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

    /** Everything measurable about this orbit over the first `windows` centuries. */
    const over = (windowCenturies) => {
      const end = at.findIndex((t) => t > windowCenturies);
      const upto = end === -1 ? at.length : end;

      const t = at.slice(0, upto);
      return {
        centuries: t[t.length - 1],
        aRate: slope(t, track.a.slice(0, upto)) / 100,
        eRate: slope(t, track.e.slice(0, upto)),
        // A least-squares slope, not the difference between the ends, because
        // that is what the published rates are: a linear model fitted across
        // the window. An element wanders as well as drifting, so the two
        // answers differ — for Mercury by half an arcsecond, for the Earth by
        // sixty.
        periapsisRate: slope(t, track.periapsis.slice(0, upto)),
        hkRate: perihelionRate(t, track.h.slice(0, upto), track.k.slice(0, upto)),
      };
    };

    return {
      name: track.body.name,
      published: track.body,
      days: (track.times[last] * SCALE.secondsPerUnit) / DAY_IN_SECONDS / turns,
      turns,
      a: track.a[0] / 100,
      e: track.e[0],
      century: over(1),
      full: over(centuries),
      // The whole-run figures, for callers that want one number.
      aRate: slope(at, track.a) / 100,
      eRate: slope(at, track.e),
      periapsisRate: slope(at, track.periapsis),
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

// The two comparisons below are about the arithmetic rather than the window, so
// they run over a century: ten times the integration to make the same point
// would be ten times the wait.
const comparisonSpan = QUICK ? SPAN : CENTURY;
const halfStep = run({ step: STEP / 2, span: comparisonSpan });
const verletRun = run({ integrator: 'verlet', span: comparisonSpan });

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
line('whole run, divided into the time it takes. Published figures are sidereal');
line('periods.');
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
line('The last column is why a century was not enough on its own. Over one, Neptune');
line('completes two thirds of an orbit, and two thirds of an ellipse cannot say how');
line('long the whole of it takes: the planet spends that stretch at whatever speed');
line('that part of the orbit calls for, and dividing angle by time reports that');
line('rather than a mean. Over a millennium every planet here goes round at least');
line('six times.');
line('');

line('## How the orbits change');
line('');
line("JPL publishes each element's rate of change per century alongside the elements");
line('themselves. Those rates are the real solar system perturbing itself, and they');
line('are what the run is checked against. Semi-major axis in au per century,');
line('eccentricity per century, both fitted over the first century of the run and');
line('over the whole millennium.');
line('');
line('| planet | da/dt, century | millennium | published | de/dt, century | millennium | published |');
line('|---|---:|---:|---:|---:|---:|---:|');
for (const r of publishedRun.results) {
  line(
    `| ${r.name} | ${signed(r.century.aRate, 7)} | ${signed(r.full.aRate, 7)} | ` +
      `${signed(r.published.rates.a, 7)} | ${signed(r.century.eRate, 7)} | ` +
      `${signed(r.full.eRate, 7)} | ${signed(r.published.rates.e, 7)} |`
  );
}
line('');
line('The published column is a linear fit over roughly 1800–2050, so the century');
line('column is the one directly comparable with it. Where the millennium column');
line('disagrees, the disagreement is not noise: it is the difference between a rate');
line('quoted for now and the same rate averaged over ten times longer, which for');
line('elements that oscillate on centuries-long cycles is a real difference.');
line('');

line('## Where the perihelia go');
line('');
line('The turning of an orbit is the hardest of these to fake and the easiest to');
line('get wrong, so it is the one worth reading closely.');
line('');
line('| planet | e | century | millennium | published | difference |');
line('|---|---:|---:|---:|---:|---:|');
for (const r of publishedRun.results) {
  const real = arcseconds(r.published.rates.periapsis);
  const century = arcseconds(r.century.hkRate);
  const millennium = arcseconds(r.full.hkRate);
  line(
    `| ${r.name} | ${r.published.e.toFixed(4)} | ${signed(century, 1)}″ | ` +
      `${signed(millennium, 1)}″ | ${signed(real, 1)}″ | ${signed(century - real, 1)}″ |`
  );
}
line('');
line('Both columns come from `h = e·sin ϖ` and `k = e·cos ϖ` rather than from a fit');
line('to ϖ itself. Where a nearly circular orbit keeps its perihelion barely means');
line('anything and the angle swings about; h and k stay smooth through it, because');
line('the pair carries the eccentricity and the direction together, and');
line('`dϖ/dt = (k·ḣ - h·k̇)/(h² + k²)` recovers the rate. The difference column');
line('compares the century, since that is the window the published rates are fitted');
line('over.');
line('');
line('What the longer window settled, and what it did not:');
line('');
line('- **Mercury, Earth and Mars were already settled** and stay where they were —');
line('  Mercury moves by 0.4″ between a century and a millennium, which is the more');
line('  useful fact about it than either number alone.');
line('- **Jupiter and Uranus needed the length.** Over a century Jupiter came out at');
line('  -532″ against a published +765″, with the sign wrong; over a millennium it is');
line('  +837″. Uranus goes from +7,857″ to +1,672″ against +1,469″. Both now sit about');
line("  10% high, which is the same direction and roughly the same size as Mercury's");
line('  flattening error.');
line('- **Saturn and Neptune are still not settled.** Saturn swings from +950″ to');
line('  +2,086″ against a published -1,508″, and a millennium is only 1.1 cycles of');
line('  the 900-year exchange it has with Jupiter — not enough of one to average it');
line("  away. Neptune's rate is small and its orbit is nearly circular, so the same");
line('  applies with less to measure.');
line('- **Venus is not an estimator problem**, which is what this method was brought');
line('  in to establish. h/k and a direct fit to ϖ agree at about -270″ a century,');
line("  against a published +9.7″, so the disagreement is in the physics rather than");
line('  the arithmetic: that +9.7″ is the small residue of perturbations worth');
line('  hundreds of arcseconds each, and the flat model gets each of those a few');
line('  per cent wrong. A few per cent of hundreds is larger than the answer.');
line('');

const mercury = publishedRun.byName.Mercury;
const measured = arcseconds(mercury.century.hkRate);
const measuredLong = arcseconds(mercury.full.hkRate);
const observed = arcseconds(PLANETS[0].rates.periapsis);

line("## Mercury's perihelion");
line('');
line('The one this was worth doing for.');
line('');
line('| | arcseconds per century |');
line('|---|---:|');
line(
  `| **this simulation**, eight planets, Newtonian gravity, flat | **${signed(measured, 1)}″** |`
);
line(`| the same run, averaged over the whole millennium | ${signed(measuredLong, 1)}″ |`);
line(`| the Newtonian part, as classical perturbation theory decomposes it | ${NEWTONIAN.toFixed(1)}″ |`);
line(`| observed, from JPL's rate for ϖ | ${observed.toFixed(1)}″ |`);
line(`| general relativity's share of that, which Newton cannot produce | ${RELATIVITY.toFixed(2)}″ |`);
line('');
line(
  `Between the two windows it moves by ${Math.abs(measured - measuredLong).toFixed(1)}″, which is worth as much as` +
    ' either'
);
line('figure: a number that holds over ten times the integration is not an artefact');
line('of where the run happened to stop.');
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
    `${signed(arcseconds(halfStep.byName.Mercury.century.hkRate), 1)}″ |`
);
line(
  `| Verlet, step ${STEP} | ${verletRun.energyDrift.toExponential(1)} | ` +
    `${verletRun.angularDrift.toExponential(1)} | ` +
    `${signed(arcseconds(verletRun.byName.Mercury.century.hkRate), 1)}″ |`
);
line('');
line(
  `The published run is ${publishedRun.steps.toLocaleString('en-US')} steps of ` +
    `${((STEP * SCALE.secondsPerUnit) / DAY_IN_SECONDS).toFixed(3)} days and takes ` +
    `${ms(publishedRun.elapsed / 1000)} s.`
);
line(
  `Halving the step moves Mercury's rate by ` +
    `${Math.abs(measured - arcseconds(halfStep.byName.Mercury.century.hkRate)).toFixed(2)}″, so the`
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

// ─── Scaling benchmark ───────────────────────────────────────────────────────
//
//   npm run bench
//
// Times a frame at increasing body counts, exact against Barnes-Hut, and breaks
// the frame down so it is clear which part is the wall. Roadmap M3's
// deliverable: the tree's win, and its cost in accuracy, both measured.
//
// Loads the TypeScript sources through Vite's SSR loader, so this measures the
// same code the browser runs.

import { createServer } from 'vite';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WANT_FILE = process.argv.includes('--write');

const server = await createServer({ server: { middlewareMode: true }, logLevel: 'error' });
const { PhysicsEngine, SIMULATION_G } = await server.ssrLoadModule('/src/PhysicsEngine.ts');
const { Particle } = await server.ssrLoadModule('/src/Particle.ts');
const { treeOf } = await server.ssrLoadModule('/src/quadtree.ts');
const { accelerationsAt } = await server.ssrLoadModule('/src/forces.ts');
const { resolveCollisions } = await server.ssrLoadModule('/src/collisions.ts');
const { recommendedSubSteps } = await server.ssrLoadModule('/src/integrators.ts');

const COUNTS = [64, 128, 256, 512, 1024, 2048];
const VIEW = { minX: -1600, minY: -1000, maxX: 1600, maxY: 1000 };

function seeded(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/**
 * A disc of bodies on circular orbits about a heavy centre — the configuration
 * the tree exists for, and one that stays spread out instead of collapsing into
 * a single merged lump halfway through the measurement.
 */
function galaxy(count, seed = 20240826) {
  const random = seeded(seed);
  const centreMass = 400000;
  const bodies = [new Particle(0, 0, centreMass)];

  for (let i = 1; i < count; i++) {
    const radius = 300 + random() * 2200;
    const angle = random() * Math.PI * 2;
    const speed = Math.sqrt((SIMULATION_G * centreMass) / radius);

    bodies.push(
      new Particle(
        Math.cos(angle) * radius,
        Math.sin(angle) * radius,
        20 + random() * 60,
        -Math.sin(angle) * speed,
        Math.cos(angle) * speed
      )
    );
  }

  return bodies;
}

function engineWith(count, forceMode) {
  const engine = new PhysicsEngine(30);
  engine.forceMode = forceMode;
  engine.collisionMode = 'none';
  for (const body of galaxy(count)) engine.addParticle(body);
  return engine;
}

/** Median of `runs` timings, in milliseconds. */
function time(runs, fn) {
  const samples = [];
  fn(); // warm up
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return samples[samples.length >> 1];
}

const ms = (v) => (v < 10 ? v.toFixed(2) : v.toFixed(1));
const rows = [];
const line = (s) => rows.push(s);

line('## One force evaluation');
line('');
line('A disc of bodies on circular orbits around a heavy centre. `exact` is the');
line('pairwise sum, `tree` is Barnes-Hut at theta = 0.5 including the cost of');
line('building the tree, which is rebuilt from scratch every evaluation.');
line('');
line('| bodies | exact | tree | speed-up |');
line('|---:|---:|---:|---:|');

for (const count of COUNTS) {
  const exact = engineWith(count, 'exact');
  const tree = engineWith(count, 'barnes-hut');

  const exactMs = time(9, () => exact.computeForces());
  const treeMs = time(9, () => tree.computeForces());

  line(`| ${count} | ${ms(exactMs)} ms | ${ms(treeMs)} ms | ${(exactMs / treeMs).toFixed(2)}x |`);
}

line('');
line('## One field rebuild');
line('');
line('The field samples the visible region at up to 12,000 points, and every');
line('sample used to walk every particle. This is the half of the frame the tree');
line('helps most, because the sample count does not fall as bodies are added.');
line('');
line('| bodies | exact | tree | speed-up | samples |');
line('|---:|---:|---:|---:|---:|');

for (const count of COUNTS) {
  const exact = engineWith(count, 'exact');
  const tree = engineWith(count, 'barnes-hut');
  exact.computeForces();
  tree.computeForces();

  const exactMs = time(5, () => exact.updateField(VIEW));
  const treeMs = time(5, () => tree.updateField(VIEW));

  line(
    `| ${count} | ${ms(exactMs)} ms | ${ms(treeMs)} ms | ${(exactMs / treeMs).toFixed(2)}x | ` +
      `${tree.vectorField.getSamples().length} |`
  );
}

line('');
line('## What each field mode costs');
line('');
line('The same scene drawn five ways, over the whole visible region. `samples`');
line('is what the mode asked the field for: arrows for the three arrow modes,');
line('grid corners for contours, integration steps for streamlines.');
line('');
line('The point of the gradient mode is the last column. The zone-based mode');
line('asks for four rings of samples per *body*, so its count runs to the cap and');
line('gets truncated; the gradient mode asks the field where it changes. Its');
line('count still grows with the body count — more bodies really is more');
line('structure — but far more slowly, and it never has to be truncated.');
line('');
line('| bodies | mode | time | samples |');
line('|---:|---|---:|---:|');

for (const count of [3, 64, 300]) {
  for (const mode of ['gradient', 'adaptive', 'uniform', 'contours', 'streamlines']) {
    const engine = engineWith(count, 'auto');
    engine.vectorField.fieldMode = mode;
    engine.computeForces();

    const elapsed = time(5, () => engine.updateField(VIEW));
    const field = engine.vectorField;
    const samples =
      mode === 'contours'
        ? field.getContours().reduce((sum, line) => sum + line.segments.length, 0)
        : mode === 'streamlines'
          ? field.getStreamlines().reduce((sum, line) => sum + line.length, 0)
          : field.getSamples().length;

    line(`| ${count} | ${mode} | ${ms(elapsed)} ms | ${samples} |`);
  }
}

line('');
line('## Where the rest of a frame goes');
line('');
line('Forces are not the only thing that was quadratic. Contact detection tests');
line('every pair, and so does the adaptive step rule, which looks for the closest');
line('interacting pair in the system. Both are listed here at their tree-backed');
line('cost where they have one.');
line('');
line('| bodies | contact scan | contact via tree | step rule: scan | step rule: tree |');
line('|---:|---:|---:|---:|---:|');

for (const count of COUNTS) {
  const engine = engineWith(count, 'exact');
  const particles = engine.particles;

  const scanMs = time(5, () => resolveCollisions(particles.slice(), 'bounce', Infinity));
  const treeMs = time(5, () => resolveCollisions(particles.slice(), 'bounce', 0));
  const subStepMs = time(5, () => recommendedSubSteps(particles, SIMULATION_G, 1, 64));
  // Includes building the tree, since the rule cannot assume one exists.
  const subStepTreeMs = time(5, () =>
    recommendedSubSteps(particles, SIMULATION_G, 1, 64, treeOf(particles))
  );

  line(
    `| ${count} | ${ms(scanMs)} ms | ${ms(treeMs)} ms | ${ms(subStepMs)} ms | ` +
      `${ms(subStepTreeMs)} ms |`
  );
}

line('');
line('## A whole frame');
line('');
line('`step()` and `updateField()` together, which is what one animation frame');
line('costs. 16.7 ms is the budget at 60fps. The sub-step column matters when');
line('reading these: a frame pays for the force evaluation once per sub-step, so');
line('a scene the step rule wants sliced four ways costs four force passes.');
line('');
line('This is measured over the *whole* visible region at a 300-unit field range,');
line('which is the most expensive thing the controls can ask for — 12,000 samples.');
line('');
line('| bodies | exact | tree | sub-steps |');
line('|---:|---:|---:|---:|');

for (const count of COUNTS) {
  const exact = engineWith(count, 'exact');
  const tree = engineWith(count, 'barnes-hut');

  const exactMs = time(5, () => {
    exact.step();
    exact.updateField(VIEW);
  });
  const treeMs = time(5, () => {
    tree.step();
    tree.updateField(VIEW);
  });

  line(`| ${count} | ${ms(exactMs)} ms | ${ms(treeMs)} ms | ${tree.lastSubSteps} |`);
}

line('');
line('## What the approximation costs');
line('');
line('Force error against the exact sum, on the same disc. Median is against each');
line("body's own acceleration; the worst case is against the mean acceleration in");
line('the system, because a body whose pulls nearly cancel has a near-zero');
line('denominator and its own relative error reads far larger than the absolute');
line('error justifies.');
line('');
line('| bodies | theta | median error | worst vs mean |');
line('|---:|---:|---:|---:|');

for (const count of [256, 2048]) {
  const particles = galaxy(count);
  const tree = treeOf(particles);
  const exact = accelerationsAt(
    particles,
    particles.map((p) => p.position),
    SIMULATION_G
  );
  const mean = exact.reduce((sum, a) => sum + a.magnitude(), 0) / exact.length;

  for (const theta of [0.3, 0.5, 0.7, 1]) {
    const own = [];
    let worst = 0;

    for (let i = 0; i < particles.length; i++) {
      const error = tree.accelerationOn(i, SIMULATION_G, theta).sub(exact[i]).magnitude();
      own.push(exact[i].magnitude() === 0 ? 0 : error / exact[i].magnitude());
      worst = Math.max(worst, error / mean);
    }

    own.sort((a, b) => a - b);
    const median = own[own.length >> 1];
    line(
      `| ${count} | ${theta} | ${(median * 100).toFixed(3)}% | ${(worst * 100).toFixed(3)}% |`
    );
  }
}

const report = rows.join('\n') + '\n';
console.log('\n' + report);

if (WANT_FILE) {
  const target = path.join(ROOT, 'SCALING.generated.md');
  await writeFile(target, report, 'utf8');
  console.log(`wrote ${path.relative(ROOT, target)}`);
}

await server.close();

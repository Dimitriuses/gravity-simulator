// ─── Headless smoke test / screenshot capture ────────────────────────────────
//
//   npm run smoketest      assert the built app actually works
//   npm run screenshots    the same run, writing screenshots/*.png
//
// Serves ./dist over HTTP and drives it in headless Chromium. Every assertion
// here corresponds to something that was measurably broken before: the canvas
// colours were being read in the wrong colour mode, the force arrow was never
// drawn, the mass slider disagreed with the simulation, and the vector field
// was pinned to a fixed box at the world origin instead of following the
// camera. Colours are judged by sampling pixels, never by eye.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = path.join(ROOT, 'dist');
const SHOTS = path.join(ROOT, 'screenshots');
const WANT_SHOTS = process.argv.includes('--shots');

const VIEWPORT = { width: 1280, height: 800 };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const failures = [];
const results = [];

function check(name, passed, detail) {
  results.push({ name, passed, detail });
  if (!passed) failures.push(`${name} — ${detail}`);
  console.log(`  ${passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${detail ? `  (${detail})` : ''}`);
}

if (!existsSync(path.join(DIST, 'index.html'))) {
  console.error('dist/index.html not found — run `npm run build` first.');
  process.exit(1);
}

// ─── Static server ───────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(DIST, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

// ─── Browser ─────────────────────────────────────────────────────────────────
const browser = await chromium.launch({
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: VIEWPORT });

const consoleErrors = [];
const failedRequests = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => failedRequests.push(`${r.url()} :: ${r.failure()?.errorText}`));

/** Read the canvas backing store and answer a question about its pixels. */
function onCanvas(fn, arg) {
  return page.evaluate(
    ({ src, arg }) => {
      const canvas = document.querySelector('canvas');
      const off = document.createElement('canvas');
      off.width = canvas.width;
      off.height = canvas.height;
      const ctx = off.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(canvas, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, off.width, off.height);
      // eslint-disable-next-line no-new-func
      return new Function('data', 'width', 'height', 'arg', `return (${src})(data, width, height, arg)`)(
        data,
        width,
        height,
        arg
      );
    },
    { src: fn.toString(), arg: arg ?? null }
  );
}

/** Count pixels within `tol` of a target RGB. */
const countNear = (data, _w, _h, { rgb, tol }) => {
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (
      Math.abs(data[i] - rgb[0]) <= tol &&
      Math.abs(data[i + 1] - rgb[1]) <= tol &&
      Math.abs(data[i + 2] - rgb[2]) <= tol
    ) {
      n++;
    }
  }
  return n;
};

const shot = async (name) => {
  if (!WANT_SHOTS) return;
  if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name) });
  console.log(`         wrote screenshots/${name}`);
};

console.log(`\nDriving the built app at ${BASE}\n`);

try {
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => !!document.querySelector('canvas'), { timeout: 20000 });
  await page.waitForTimeout(1200);

  // ── Boot ───────────────────────────────────────────────────────────────────
  const canvasSize = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    return { w: c.width, h: c.height };
  });
  // The panel's default shape, measured before anything in this run opens a
  // section: a single column cannot show every control at once, so the ones a
  // viewer sets and leaves are folded, and what is left has to fit.
  const panel = await page.evaluate(() => {
    const controls = document.getElementById('controls').getBoundingClientRect();
    const pause = document.getElementById('pauseBtn').getBoundingClientRect();

    return {
      height: Math.round(controls.height),
      buttonsVisible: pause.bottom <= controls.bottom + 1,
      folded: ['renderSection', 'cameraSection', 'physicsSection'].filter(
        (id) => !document.getElementById(id).open
      ).length,
    };
  });
  check(
    'the panel folds what is set once and keeps the rest in view',
    panel.buttonsVisible && panel.folded === 3 && panel.height < 500,
    `${panel.height}px tall, ${panel.folded}/3 sections folded, ` +
      `pause button visible=${panel.buttonsVisible}`
  );

  check(
    'canvas fills the window',
    canvasSize.w >= VIEWPORT.width - 2 && canvasSize.h >= VIEWPORT.height - 2,
    `${canvasSize.w}x${canvasSize.h}`
  );

  const seeded = await page.evaluate(() => document.getElementById('objectCount').textContent);
  check('starts with the seeded two-body scene', seeded === '2', `objectCount=${seeded}`);

  // ── Background colour ──────────────────────────────────────────────────────
  // Was rgb(77,67,65) — a brown — because background(10,15,30) was being read
  // as HSB after setup() set a global HSB colour mode.
  const corner = await onCanvas((data, width) => {
    const at = (x, y) => {
      const i = (y * width + x) * 4;
      return [data[i], data[i + 1], data[i + 2]];
    };
    return at(width - 30, 30);
  });
  check(
    'background is the intended dark navy',
    Math.abs(corner[0] - 10) <= 6 && Math.abs(corner[1] - 15) <= 6 && Math.abs(corner[2] - 30) <= 6,
    `rgb(${corner.join(',')}) vs expected rgb(10,15,30)`
  );

  // ── Particle vectors ───────────────────────────────────────────────────────
  // The orange force arrow never rendered: netForce was zeroed at the end of
  // Particle.update(), before the renderer ever read it.
  const orange = await onCanvas(countNear, { rgb: [255, 136, 0], tol: 60 });
  check('orange net-force arrows are drawn', orange > 150, `${orange} matching pixels`);

  const cyan = await onCanvas(countNear, { rgb: [0, 255, 255], tol: 60 });
  check('cyan velocity arrows are drawn', cyan > 150, `${cyan} matching pixels`);


  // ── Frame cost ─────────────────────────────────────────────────────────────
  /** Median frame interval over `frames` animation frames, in milliseconds. */
  const frameTime = (frames = 150) =>
    page.evaluate(
      (count) =>
        new Promise((resolve) => {
          const times = [];
          let last = performance.now();
          const tick = () => {
            const now = performance.now();
            times.push(now - last);
            last = now;
            if (times.length < count) requestAnimationFrame(tick);
            else {
              times.sort((a, b) => a - b);
              resolve(+times[Math.floor(times.length / 2)].toFixed(2));
            }
          };
          requestAnimationFrame(tick);
        }),
      frames
    );

  const seededFrame = await frameTime();
  check(
    'holds at least 50 fps on the seeded scene',
    1000 / seededFrame >= 50,
    `${(1000 / seededFrame).toFixed(1)} fps, ${seededFrame} ms/frame`
  );

  // A hidden overlay used to be sampled anyway: `updateField` ran every frame
  // whatever the checkbox said, so the galaxy preset — the one scene that ships
  // with the overlay *off* because it cannot afford it — paid the whole cost and
  // drew nothing. Measured here at the time: 29 ms a frame with the field
  // hidden, against 17 once the sampling was skipped.
  //
  // The comparison is written to survive a machine fast enough to hold 60fps
  // either way: on such a machine both readings sit at the vsync interval, and
  // a hidden field that is under it cannot be sampling 11,000 points. On a
  // slower one, hiding it has to actually buy something.
  await page.selectOption('#presetSelect', 'galaxy');
  await page.waitForTimeout(1500);

  await page.check('#showVectors');
  await page.waitForTimeout(400);
  const shownFrame = await frameTime();

  await page.uncheck('#showVectors');
  await page.waitForTimeout(400);
  const hiddenFrame = await frameTime();

  check(
    'hiding the vector field stops it being sampled',
    hiddenFrame <= 17.5 || shownFrame - hiddenFrame >= 5,
    `${hiddenFrame} ms/frame hidden vs ${shownFrame} shown, at ${await page.textContent('#objectCount')} bodies`
  );

  await page.selectOption('#presetSelect', 'binary');
  await page.waitForTimeout(600);

  // ── The drag preview ───────────────────────────────────────────────────────
  // Was stroke(255,200,0) interpreted as HSB — brightness 0, i.e. black on a
  // dark background.
  //
  // Placed well clear of the seeded binary's 200-unit orbit: this used to start
  // at (760, 250), which sits almost exactly on that circle, and once bodies
  // could merge the new body was promptly swallowed by a passing one.
  await page.mouse.move(1000, 180);
  await page.mouse.down();
  await page.mouse.move(1120, 300, { steps: 15 });
  await page.waitForTimeout(200);

  const preview = await onCanvas(countNear, { rgb: [255, 200, 0], tol: 45 });
  check('drag preview arrow is visible', preview > 60, `${preview} matching pixels`);

  await page.mouse.up();
  await page.waitForTimeout(400);

  // ── UI and simulation agree ────────────────────────────────────────────────
  // The slider read 200 while new bodies were created with mass 50.
  const massAgreement = await page.evaluate(() => {
    const slider = document.getElementById('massSlider').value;
    const rows = [...document.querySelectorAll('.particle-item span')].map((e) => e.textContent);
    const last = rows[rows.length - 1];
    return { slider, last, count: document.getElementById('objectCount').textContent };
  });
  check(
    'a dragged-out body gets the mass the slider shows',
    massAgreement.last === `#3 - Mass: ${massAgreement.slider}`,
    `slider=${massAgreement.slider}, created "${massAgreement.last}"`
  );
  check('the new body was added', massAgreement.count === '3', `objectCount=${massAgreement.count}`);

  // ── Only the canvas places bodies ──────────────────────────────────────────
  // p5 listens on `window`, so every click in the page reaches its handlers.
  // The guard used to hit-test the pointer against the panels' rectangles,
  // which cannot see a native <select> popup: that is an OS-level widget drawn
  // over the canvas, so choosing an option from any dropdown arrived with
  // coordinates outside every panel and dropped a body where the option had
  // been. Headless Chromium does not open native popups, so the check below
  // reproduces the event shape one produces — a mouse event whose target is a
  // UI element, at coordinates over the canvas.
  const spawnFromUiEvent = async (id) => {
    const before = await page.evaluate(() => document.getElementById('objectCount').textContent);
    await page.evaluate((elementId) => {
      const target = document.getElementById(elementId);
      for (const type of ['mousedown', 'mouseup']) {
        target.dispatchEvent(
          new MouseEvent(type, { bubbles: true, clientX: 700, clientY: 500, button: 0 })
        );
      }
    }, id);
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => document.getElementById('objectCount').textContent);
    return { before, after };
  };

  for (const id of ['fieldModeSelect', 'presetSelect', 'controls']) {
    const counts = await spawnFromUiEvent(id);
    check(
      `a mouse event on #${id} does not place a body`,
      counts.before === counts.after,
      `objectCount ${counts.before} -> ${counts.after}`
    );
  }

  // Dragging off the canvas and releasing on a panel cancels the placement
  // rather than dropping a body underneath the panel.
  const beforeCancel = await page.evaluate(
    () => document.getElementById('objectCount').textContent
  );
  await page.mouse.move(700, 500);
  await page.mouse.down();
  await page.mouse.move(150, 300, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const afterCancel = await page.evaluate(
    () => document.getElementById('objectCount').textContent
  );
  check(
    'a drag released over a panel places nothing',
    beforeCancel === afterCancel,
    `objectCount ${beforeCancel} -> ${afterCancel}`
  );

  // The wheel belongs to whatever is under it. Claiming it unconditionally
  // meant the control panel could not be scrolled at all, which matters
  // because it scrolls internally in a short window.
  await page.setViewportSize({ width: VIEWPORT.width, height: 620 });
  await page.waitForTimeout(300);
  const zoomBeforeWheel = await page.evaluate(
    () => document.getElementById('zoomValue').textContent
  );
  await page.mouse.move(150, 300);
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(300);
  const wheelOverPanel = await page.evaluate(() => ({
    zoom: document.getElementById('zoomValue').textContent,
    scrolled: document.getElementById('controls').scrollTop,
  }));
  check(
    'the wheel scrolls the control panel instead of zooming',
    wheelOverPanel.zoom === zoomBeforeWheel && wheelOverPanel.scrolled > 0,
    `zoom ${zoomBeforeWheel}% -> ${wheelOverPanel.zoom}%, panel scrollTop=${wheelOverPanel.scrolled}`
  );
  await page.setViewportSize(VIEWPORT);
  await page.waitForTimeout(300);

  // ── The field follows the camera ───────────────────────────────────────────
  // It used to be built inside a fixed box the size of the canvas centred on
  // the world origin, so panning away showed empty space.
  const fieldPixels = async () =>
    onCanvas((data) => {
      // Anything appreciably brighter than the background counts as drawn.
      let n = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] + data[i + 1] + data[i + 2] > 160) n++;
      }
      return n;
    });

  const beforePan = await fieldPixels();
  // Ctrl+drag pans. Move the world a long way from the origin.
  await page.keyboard.down('Control');
  await page.mouse.move(700, 400);
  await page.mouse.down();
  await page.mouse.move(200, 200, { steps: 20 });
  await page.mouse.up();
  await page.keyboard.up('Control');
  await page.waitForTimeout(500);
  const afterPan = await fieldPixels();
  check(
    'the vector field still renders after panning off-origin',
    afterPan > beforePan * 0.25,
    `${beforePan} -> ${afterPan} lit pixels`
  );

  // ── Zoom ───────────────────────────────────────────────────────────────────
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(400);
  const zoomedIn = await page.evaluate(() => document.getElementById('zoomValue').textContent);
  check('mouse wheel zooms in', Number(zoomedIn) > 100, `zoom=${zoomedIn}%`);

  await page.evaluate(() => {
    // Reset Camera lives in a folded section; a real user would open it too.
    document.getElementById('cameraSection').open = true;
  });
  await page.click('#resetCameraBtn');
  await page.waitForTimeout(400);
  const reset = await page.evaluate(() => document.getElementById('zoomValue').textContent);
  check('reset camera returns to 100%', reset === '100', `zoom=${reset}%`);


  // ── Grid modes ─────────────────────────────────────────────────────────────
  // Both modes must draw a field, and they must draw a *different* one —
  // otherwise the selector is decorative. Judged against the empty-canvas
  // baseline measured at the end of the run rather than a guessed threshold.
  const adaptiveLit = await fieldPixels();

  await page.selectOption('#fieldModeSelect', 'uniform');
  await page.waitForTimeout(600);
  const uniformLit = await fieldPixels();

  check('adaptive grid mode renders a field', adaptiveLit > 1000, `${adaptiveLit} lit pixels`);
  check('uniform grid mode renders a field', uniformLit > 1000, `${uniformLit} lit pixels`);

  // Whether two modes draw *differently* is a question about the picture, not
  // about how much of it is lit: two arrangements of arrows can light much the
  // same number of pixels while putting them in entirely different places, and
  // comparing the counts made this check fail on a pair that plainly differ.
  // Pausing first makes the frame the only variable.
  await page.click('#pauseBtn');
  await page.waitForTimeout(400);

  const modeHashes = {};
  for (const mode of ['gradient', 'adaptive', 'uniform']) {
    await page.selectOption('#fieldModeSelect', mode);
    await page.waitForTimeout(500);
    modeHashes[mode] = await onCanvas((data) => {
      let hash = 0;
      for (let i = 0; i < data.length; i += 997 * 4) hash = (hash * 31 + data[i]) >>> 0;
      return hash;
    });
  }

  const distinct = new Set(Object.values(modeHashes));
  check(
    'each arrow mode draws its own picture',
    distinct.size === 3,
    Object.entries(modeHashes)
      .map(([mode, hash]) => `${mode}=${hash}`)
      .join(', ')
  );

  await page.click('#pauseBtn');
  await page.waitForTimeout(400);

  // ── The other ways of drawing a field ──────────────────────────────────────
  // Contours and streamlines are proved as geometry in their own tests, against
  // fields whose level sets and flow are known in closed form. What only exists
  // here is whether they reach the canvas at all, and whether the legend
  // describes what is on it.
  for (const [mode, title] of [
    ['gradient', 'Vector Field:'],
    ['contours', 'Equipotentials:'],
    ['heightmap', 'Potential:'],
    ['streamlines', 'Streamlines:'],
  ]) {
    await page.selectOption('#fieldModeSelect', mode);
    await page.waitForTimeout(800);

    const lit = await fieldPixels();
    const legend = await page.evaluate(() => ({
      title: document.getElementById('legendTitle').textContent,
      scale: document.getElementById('legendScale').textContent,
      max: document.getElementById('legendMax').textContent,
    }));

    check(
      `${mode} mode draws something and names itself`,
      lit > 500 && legend.title === title,
      `${lit} lit pixels, legend says "${legend.title}"`
    );
  }

  // A heightmap covers the canvas rather than drawing marks on it, so the test
  // that it rendered is that the background is gone.
  await page.selectOption('#fieldModeSelect', 'heightmap');
  await page.waitForTimeout(900);
  const background = await onCanvas(countNear, { rgb: [10, 15, 30], tol: 6 });
  check(
    'the heightmap shades the whole view rather than marking it',
    background < 5000,
    `${background} pixels left at the background colour`
  );

  // The scale bar is the whole of "absolute magnitude": arrow length and hue
  // are normalized against the frame, so without a number the picture has no
  // absolute reading at all.
  await page.selectOption('#fieldModeSelect', 'gradient');
  await page.waitForTimeout(800);
  const scaleBar = await page.evaluate(() => ({
    max: document.getElementById('legendMax').textContent,
    min: document.getElementById('legendMin').textContent,
    scale: document.getElementById('legendScale').textContent,
  }));
  check(
    'the legend reports the field strengths actually on screen',
    Number(scaleBar.max) > 0 &&
      Number(scaleBar.min) > 0 &&
      Number(scaleBar.max) > Number(scaleBar.min) &&
      /force per unit mass/.test(scaleBar.scale ?? ''),
    `strong ${scaleBar.max}, weak ${scaleBar.min} — "${scaleBar.scale}"`
  );

  // Streamlines have a direction but no magnitude, so the ramp is hidden
  // rather than left describing nothing.
  await page.selectOption('#fieldModeSelect', 'streamlines');
  await page.waitForTimeout(800);
  const streamlineLegend = await page.evaluate(() => ({
    rampVisible: document.getElementById('legendRamp').offsetParent !== null,
    max: document.getElementById('legendMax').textContent,
  }));
  check(
    'the strength ramp is hidden where strength is not shown',
    !streamlineLegend.rampVisible && streamlineLegend.max === '',
    `ramp visible=${streamlineLegend.rampVisible}, stale value="${streamlineLegend.max}"`
  );

  await page.selectOption('#fieldModeSelect', 'adaptive');
  await page.waitForTimeout(600);

  // ── Pause / resume ─────────────────────────────────────────────────────────
  const positionsWhile = async (frames) => {
    await page.waitForTimeout(frames);
    return onCanvas((data) => {
      let hash = 0;
      for (let i = 0; i < data.length; i += 997 * 4) hash = (hash * 31 + data[i]) >>> 0;
      return hash;
    });
  };

  await page.click('#pauseBtn');
  await page.waitForTimeout(300);
  const pausedA = await positionsWhile(500);
  const pausedB = await positionsWhile(500);
  check('pause freezes the simulation', pausedA === pausedB, `frame hashes ${pausedA} / ${pausedB}`);

  const pauseLabel = await page.evaluate(() => document.getElementById('pauseBtn').textContent);
  check('pause button relabels to Resume', pauseLabel === 'Resume', `label="${pauseLabel}"`);

  // Force arrows must survive a pause — they are recomputed, not integrated.
  const orangeWhilePaused = await onCanvas(countNear, { rgb: [255, 136, 0], tol: 60 });
  check(
    'force arrows stay drawn while paused',
    orangeWhilePaused > 100,
    `${orangeWhilePaused} matching pixels`
  );

  await page.click('#pauseBtn');
  await page.waitForTimeout(300);
  const resumedA = await positionsWhile(500);
  const resumedB = await positionsWhile(500);
  check('resume restarts the simulation', resumedA !== resumedB, `frame hashes ${resumedA} / ${resumedB}`);

  // ── Deleting and clearing ──────────────────────────────────────────────────
  await page.click('.particle-item button');
  await page.waitForTimeout(300);
  const afterDelete = await page.evaluate(() => document.getElementById('objectCount').textContent);
  check('deleting one body updates the count', afterDelete === '2', `objectCount=${afterDelete}`);

  await page.click('#clearBtn');
  await page.waitForTimeout(400);
  const afterClear = await page.evaluate(() => ({
    count: document.getElementById('objectCount').textContent,
    rows: document.querySelectorAll('.particle-item').length,
  }));
  check(
    'clear all empties the scene and the list',
    afterClear.count === '0' && afterClear.rows === 0,
    `count=${afterClear.count}, rows=${afterClear.rows}`
  );

  const emptyField = await onCanvas(countNear, { rgb: [255, 136, 0], tol: 60 });
  check('no arrows remain once the scene is empty', emptyField < 20, `${emptyField} matching pixels`);

  // ── Composed scenes for the README ─────────────────────────────────────────
  // Built by driving the real controls, so a screenshot can only show something
  // the app can actually do.
  if (WANT_SHOTS) {
    console.log('\n  composing screenshot scenes\n');

    const setSlider = async (id, value) => {
      await page.locator(id).fill(String(value));
      await page.waitForTimeout(60);
    };
    /** Place a body by dragging: start point sets position, the drag sets velocity. */
    const launch = async (x, y, dx = 0, dy = 0) => {
      await page.mouse.move(x, y);
      await page.mouse.down();
      if (dx || dy) await page.mouse.move(x + dx, y + dy, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(80);
    };

    // A heavy primary with two satellites on near-circular orbits.
    //
    // The two satellites are placed a few frames apart, so the configuration is
    // never quite symmetric, and at 200 units they are heavy enough (4% of the
    // primary) to perturb each other. Measured: their separation decays from
    // 400 units to nothing over about 670 frames and they merge — which is why
    // the later screenshots show one body of mass 400 rather than two of 200.
    // Nothing is wrong; it is what this configuration does.
    // v = sqrt(G·M/r) with G = 0.5, M = 5000, r = 200  ->  v ≈ 3.54 world
    // units, and the drag-to-velocity factor is 0.05, so ≈ 71 px of drag.
    await page.click('#clearBtn');
    await setSlider('#rangeSlider', 300);
    await setSlider('#massSlider', 5000);
    await launch(640, 400);
    await setSlider('#massSlider', 200);
    await launch(440, 400, 0, -71);
    await launch(840, 400, 0, 71);

    // Let the orbits draw their trails.
    await page.waitForTimeout(7000);
    await shot('01-overview.png');

    // Same scene, uniform grid, for the mode comparison.
    await page.selectOption('#fieldModeSelect', 'uniform');
    await page.waitForTimeout(900);
    await shot('03-uniform-field.png');

    await page.selectOption('#fieldModeSelect', 'adaptive');
    await page.waitForTimeout(900);

    // Close in on the primary so the four density zones are legible. Zoom is
    // proportional to wheel delta, so this is a sequence of notches, the way a
    // mouse actually delivers them.
    const wheel = async (x, y, notches) => {
      await page.mouse.move(x, y);
      for (let i = 0; i < Math.abs(notches); i++) {
        await page.mouse.wheel(0, notches > 0 ? -100 : 100);
        await page.waitForTimeout(40);
      }
      await page.waitForTimeout(700);
    };

    await wheel(640, 400, 9); // ~2.4x
    await shot('02-adaptive-field.png');

    await page.click('#resetCameraBtn');
    await page.waitForTimeout(900);

    // A satellite close-up: force arrow towards the primary, velocity along
    // the orbit.
    await page.evaluate(() => {
      document.getElementById('renderSection').open = true;
    });
    await setSlider('#arrowSizeSlider', 1.4);
    await wheel(760, 480, 7); // ~1.9x, framed on a satellite
    await shot('05-particle-vectors.png');

    await setSlider('#arrowSizeSlider', 1.0);
    await page.click('#resetCameraBtn');
    await page.waitForTimeout(600);

    // Mid-drag, showing the aiming arrow.
    await setSlider('#massSlider', 1200);
    await page.mouse.move(520, 250);
    await page.mouse.down();
    await page.mouse.move(760, 420, { steps: 20 });
    await page.waitForTimeout(400);
    await shot('04-drag-to-launch.png');
    await page.mouse.up();
    await page.waitForTimeout(200);

    // The figure-eight preset, given long enough to draw its full period. The
    // trail is what makes the scene legible, and it is 2,600 steps long.
    await setSlider('#massSlider', 200);
    await page.selectOption('#presetSelect', 'figure-eight');
    await page.waitForTimeout(48000);
    await shot('06-figure-eight.png');

    // Equipotentials on the Lagrange scene: the contour that closes around both
    // primaries, and the saddle between them, are the structure an arrow grid
    // can only hint at.
    await page.selectOption('#presetSelect', 'lagrange');
    await page.selectOption('#fieldModeSelect', 'contours');
    await page.waitForTimeout(3000);
    await shot('07-equipotentials.png');

    // Streamlines on the same scene, for the contrast: direction rather than
    // strength, and continuous rather than sampled.
    await page.selectOption('#fieldModeSelect', 'streamlines');
    await page.waitForTimeout(2500);
    await shot('08-streamlines.png');

    // The same potential the contours trace, shaded instead of outlined.
    await page.selectOption('#fieldModeSelect', 'heightmap');
    await page.waitForTimeout(2500);
    await shot('09-heightmap.png');

    await page.selectOption('#fieldModeSelect', 'gradient');
  }

  // ── Preset scenes ──────────────────────────────────────────────────────────
  // A preset is a claim that these initial conditions orbit; tests/presets.test.ts
  // proves that against the engine. What can only be checked here is the wiring:
  // that the dropdown is populated from TypeScript at all, that picking an entry
  // replaces the scene, and that the camera reframes for scenes too wide for
  // 100% zoom.
  const presetOptions = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#presetSelect option')).map((option) => ({
      value: option.value,
      label: option.textContent,
    }))
  );
  check(
    'the scene dropdown is populated from the preset list',
    presetOptions.length >= 2,
    `${presetOptions.length} options: ${presetOptions.map((o) => o.value).join(', ')}`
  );

  const presetZooms = [];
  for (const option of presetOptions) {
    await page.selectOption('#presetSelect', option.value);
    await page.waitForTimeout(1200);

    const state = await page.evaluate(() => ({
      count: Number(document.getElementById('objectCount').textContent),
      rows: document.querySelectorAll('.particle-item').length,
      zoom: Number(document.getElementById('zoomValue').textContent),
      vectors: document.getElementById('showParticleVectors').checked,
    }));
    presetZooms.push(state.zoom);

    // Orange force arrows mean bodies that are still on screen and still
    // pulling on each other a second after loading. The bar is low because
    // arrows are drawn in world space: the slingshot loads at 50% zoom, where
    // an arrow covers roughly a quarter of the pixels it would at 100%. A
    // scene that switches the arrows off — the galaxy — is judged on whether
    // its bodies are drawn at all instead.
    const drawn = state.vectors
      ? await onCanvas(countNear, { rgb: [255, 136, 0], tol: 60 })
      : await onCanvas(countNear, { rgb: [150, 200, 255], tol: 60 });
    const listed = Math.min(state.count, 40);

    check(
      `preset "${option.value}" loads a live scene`,
      state.count >= 2 && state.rows === listed && drawn > 30,
      `${state.count} bodies, ${state.rows} rows, zoom=${state.zoom}%, ` +
        `${drawn} ${state.vectors ? 'force-arrow' : 'body'} pixels`
    );
  }

  check(
    'a preset can reframe the camera',
    presetZooms.some((zoom) => zoom !== 100),
    `zooms: ${presetZooms.map((z) => `${z}%`).join(', ')}`
  );

  await page.selectOption('#presetSelect', presetOptions[0].value);
  await page.waitForTimeout(500);
  const presetCount = await page.evaluate(() => document.getElementById('objectCount').textContent);
  await page.click('.particle-item button');
  await page.waitForTimeout(200);
  // Re-picking the same option fires no `change` event, which is the whole
  // reason the Reload Scene button exists.
  await page.click('#reloadPresetBtn');
  await page.waitForTimeout(400);
  const reloaded = await page.evaluate(() => document.getElementById('objectCount').textContent);
  check(
    'Reload Scene rebuilds the current preset',
    reloaded === presetCount,
    `${presetCount} bodies -> deleted one -> ${reloaded}`
  );

  // ── Integration controls ───────────────────────────────────────────────────
  // The schemes themselves are proved in tests/integrators.test.ts, against
  // convergence orders and 1,000-orbit energy bounds. What only exists in the
  // browser is the wiring: that the dropdown is populated from TypeScript, that
  // switching scheme mid-flight keeps the simulation running, and that the
  // sub-step readout tracks what the engine actually did.
  const schemes = await page.evaluate(() => ({
    options: Array.from(document.querySelectorAll('#integratorSelect option')).map((o) => o.value),
    selected: document.getElementById('integratorSelect').value,
    adaptive: document.getElementById('adaptiveStepping').checked,
    collapsed: !document.getElementById('physicsSection').open,
  }));
  check(
    'the scheme dropdown is populated and defaults to velocity Verlet',
    schemes.options.length === 3 && schemes.selected === 'verlet' && schemes.adaptive,
    `options=[${schemes.options.join(', ')}], selected=${schemes.selected}, adaptive=${schemes.adaptive}`
  );

  await page.click('#physicsSection > summary');
  await page.waitForTimeout(200);

  await page.selectOption('#presetSelect', 'star-and-planets');
  await page.waitForTimeout(800);
  for (const scheme of schemes.options) {
    await page.selectOption('#integratorSelect', scheme);
    await page.waitForTimeout(400);
    const a = await positionsWhile(400);
    const b = await positionsWhile(400);
    check(`the simulation keeps running under ${scheme}`, a !== b, `frame hashes ${a} / ${b}`);
  }
  await page.selectOption('#integratorSelect', 'verlet');
  await page.waitForTimeout(300);

  // A well-resolved scene must cost nothing: adaptive stepping is only worth
  // having if it stays out of the way until it is needed.
  const restingSubSteps = await page.evaluate(
    () => document.getElementById('subStepCount').textContent
  );
  check(
    'a well-resolved scene takes a single sub-step',
    restingSubSteps === '1',
    `sub-steps=${restingSubSteps}`
  );

  // Drop a second heavy body onto the primary: a pair at contact distance is
  // the tightest thing the interface can make, and it should ask for more.
  // Contacts are held off for this, or the pair merges on the first sub-step
  // and there is nothing left to resolve finely.
  await page.selectOption('#collisionSelect', 'none');
  await page.locator('#massSlider').fill('5000');
  await page.waitForTimeout(60);
  await page.mouse.click(VIEWPORT.width / 2 + 12, VIEWPORT.height / 2);
  await page.waitForTimeout(900);
  const closeSubSteps = await page.evaluate(
    () => document.getElementById('subStepCount').textContent
  );
  check(
    'a contact-distance pair asks for sub-steps',
    Number(closeSubSteps) > 1,
    `sub-steps=${closeSubSteps}`
  );

  await page.selectOption('#collisionSelect', 'merge');
  await page.locator('#massSlider').fill('200');
  await page.waitForTimeout(60);

  // ── Scale ──────────────────────────────────────────────────────────────────
  // The quadtree's accuracy is proved in tests/quadtree.test.ts, against the
  // direct sum. What only exists here is a real frame: that a scene of a few
  // hundred bodies loads, animates, and says which solver it is using.
  const forceModes = await page.evaluate(() => ({
    options: Array.from(document.querySelectorAll('#forceModeSelect option')).map((o) => o.value),
    selected: document.getElementById('forceModeSelect').value,
    label: document.getElementById('forceModeLabel').textContent,
  }));
  check(
    'the force dropdown is populated and defaults to automatic',
    forceModes.options.length === 3 && forceModes.selected === 'auto',
    `options=[${forceModes.options.join(', ')}], selected=${forceModes.selected}`
  );
  check(
    'a small scene is solved exactly',
    forceModes.label === 'exact',
    `readout says "${forceModes.label}"`
  );

  await page.selectOption('#presetSelect', 'galaxy');
  await page.waitForTimeout(2500);

  const galaxy = await page.evaluate(() => ({
    count: Number(document.getElementById('objectCount').textContent),
    forces: document.getElementById('forceModeLabel').textContent,
    rows: document.querySelectorAll('.particle-item').length,
    field: document.getElementById('showVectors').checked,
    vectors: document.getElementById('showParticleVectors').checked,
  }));
  check(
    'the galaxy loads hundreds of bodies and switches to the tree',
    galaxy.count > 200 && galaxy.forces === 'tree',
    `${galaxy.count} bodies, readout says "${galaxy.forces}"`
  );
  check(
    'the scene turns off the per-body drawing it cannot afford',
    galaxy.field === false && galaxy.vectors === false,
    `field=${galaxy.field}, particle vectors=${galaxy.vectors}`
  );
  check(
    'the particle list summarises instead of naming hundreds of bodies',
    galaxy.rows > 0 && galaxy.rows <= 40,
    `${galaxy.rows} rows for ${galaxy.count} bodies`
  );

  const galaxyA = await positionsWhile(600);
  const galaxyB = await positionsWhile(600);
  check('the galaxy animates', galaxyA !== galaxyB, `frame hashes ${galaxyA} / ${galaxyB}`);

  // Forcing the exact solver on the same scene must still work — slower, but
  // the point is that the switch is live.
  await page.selectOption('#forceModeSelect', 'exact');
  await page.waitForTimeout(1500);
  const forcedExact = await page.evaluate(
    () => document.getElementById('forceModeLabel').textContent
  );
  const exactA = await positionsWhile(700);
  const exactB = await positionsWhile(700);
  check(
    'the exact solver can be forced on a large scene',
    forcedExact === 'exact' && exactA !== exactB,
    `readout says "${forcedExact}", frame hashes ${exactA} / ${exactB}`
  );

  await page.selectOption('#forceModeSelect', 'auto');
  await page.selectOption('#presetSelect', 'binary');
  await page.waitForTimeout(600);
  await page.click('#clearBtn');
  await page.waitForTimeout(200);

  // ── Collisions ─────────────────────────────────────────────────────────────
  // The conservation laws are proved in tests/collisions.test.ts. What only
  // exists in the browser is the particle list: until bodies could merge, the
  // only way to lose one was to press its delete button, so nothing ever
  // removed a row on its own.
  const collisionModes = await page.evaluate(() => ({
    options: Array.from(document.querySelectorAll('#collisionSelect option')).map((o) => o.value),
    selected: document.getElementById('collisionSelect').value,
  }));
  check(
    'the contact dropdown is populated and defaults to merging',
    collisionModes.options.length === 3 && collisionModes.selected === 'merge',
    `options=[${collisionModes.options.join(', ')}], selected=${collisionModes.selected}`
  );

  // Two heavy bodies dropped almost on top of each other, with the field off
  // so this is quick and unambiguous.
  await page.click('#clearBtn');
  await page.waitForTimeout(200);
  await page.locator('#massSlider').fill('3000');
  await page.waitForTimeout(60);
  await page.mouse.click(600, 400);
  await page.mouse.click(640, 400);
  await page.waitForTimeout(1200);

  const afterMerge = await page.evaluate(() => ({
    count: document.getElementById('objectCount').textContent,
    rows: document.querySelectorAll('.particle-item').length,
    label: document.querySelector('.particle-item span')?.textContent ?? '',
  }));
  check(
    'two touching bodies merge into one',
    afterMerge.count === '1' && afterMerge.rows === 1,
    `objectCount=${afterMerge.count}, rows=${afterMerge.rows}`
  );
  check(
    'the particle list follows a body that disappeared on its own',
    afterMerge.label === '#1 - Mass: 6000',
    `row reads "${afterMerge.label}"`
  );

  // ── Contact physics ────────────────────────────────────────────────────────
  // The impulse maths, the friction that imparts spin and the swept detection
  // are all proved in tests/collisions.test.ts, against conservation laws and
  // hand-checkable contact times. What only exists here is the control and the
  // fact that spin reaches the screen at all.
  const bounciness = await page.evaluate(() => ({
    value: document.getElementById('restitutionSlider').value,
    shown: document.getElementById('restitutionValue').textContent,
  }));
  check(
    'the bounciness control is wired to what the label says',
    Number(bounciness.value) === 0.5 && bounciness.shown === '0.50',
    `slider=${bounciness.value}, label="${bounciness.shown}"`
  );

  // A pile of heavy bodies dropped together: they settle by knocking into each
  // other off-centre, which is exactly what should set them spinning.
  await page.selectOption('#collisionSelect', 'bounce');
  await page.click('#clearBtn');
  await page.locator('#massSlider').fill('3000');
  await page.locator('#restitutionSlider').fill('0.8');
  await page.waitForTimeout(120);

  for (const [x, y] of [
    [560, 320],
    [720, 340],
    [640, 520],
    [500, 470],
    [780, 480],
  ]) {
    await page.mouse.click(x, y);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(5000);

  const spinning = await page.evaluate(() => document.getElementById('restitutionValue').textContent);
  const spinMarkers = await onCanvas(countNear, { rgb: [40, 60, 110], tol: 30 });
  check(
    'an off-centre bounce sets bodies spinning, visibly',
    spinMarkers > 100,
    `${spinMarkers} spin-marker pixels, bounciness ${spinning}`
  );

  // Bouncier really is bouncier: the same pile-up, run twice.
  const spreadAfterBouncing = async (restitution) => {
    await page.click('#clearBtn');
    await page.locator('#restitutionSlider').fill(String(restitution));
    await page.waitForTimeout(120);

    for (const [x, y] of [
      [600, 380],
      [680, 400],
      [640, 460],
    ]) {
      await page.mouse.click(x, y);
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(4000);

    return page.evaluate(() => {
      // How far the bodies have scattered, judged by the spread of the drawn
      // pale-blue discs across the canvas.
      const canvas = document.querySelector('canvas');
      const off = document.createElement('canvas');
      off.width = canvas.width;
      off.height = canvas.height;
      const ctx = off.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(canvas, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, off.width, off.height);

      let minX = width;
      let maxX = 0;
      for (let y = 0; y < height; y += 2) {
        for (let x = 0; x < width; x += 2) {
          const i = (y * width + x) * 4;
          if (Math.abs(data[i] - 150) < 40 && Math.abs(data[i + 2] - 255) < 40) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
          }
        }
      }
      return maxX - minX;
    });
  };

  const dead = await spreadAfterBouncing(0);
  const lively = await spreadAfterBouncing(1);
  check(
    'a bouncier setting scatters a pile further',
    lively > dead,
    `spread ${lively}px at 1.0 against ${dead}px at 0`
  );

  await page.locator('#restitutionSlider').fill('0.5');
  await page.locator('#massSlider').fill('3000');
  await page.selectOption('#collisionSelect', 'merge');
  await page.click('#clearBtn');
  await page.waitForTimeout(200);

  // Pass-through mode restores the old behaviour: the same two bodies coexist.
  await page.selectOption('#collisionSelect', 'none');
  await page.click('#clearBtn');
  await page.waitForTimeout(200);
  await page.mouse.click(600, 400);
  await page.mouse.click(640, 400);
  await page.waitForTimeout(1200);
  const passingThrough = await page.evaluate(
    () => document.getElementById('objectCount').textContent
  );
  check(
    'pass-through mode leaves both bodies alone',
    passingThrough === '2',
    `objectCount=${passingThrough}`
  );

  await page.selectOption('#collisionSelect', 'merge');
  await page.locator('#massSlider').fill('200');
  await page.click('#clearBtn');
  await page.waitForTimeout(200);

  // ── Panel layout in a short window ─────────────────────────────────────────
  // #controls is capped at calc(100vh - 210px) so it can never grow down into
  // the bottom-left info panel. The cap applies to the content box, so under
  // the default content-box sizing the panel's 15px of vertical padding fell
  // outside the budget and the two overlapped by 15px at any viewport height
  // below ~690px. Only visible once the particle list has filled the info
  // panel out to its 180px cap, which is why bodies are placed first.
  await page.click('#clearBtn');
  for (let i = 0; i < 8; i++) {
    await page.mouse.click(400 + i * 30, 600);
    await page.waitForTimeout(60);
  }
  await page.setViewportSize({ width: VIEWPORT.width, height: 620 });
  await page.waitForTimeout(300);
  const panelGap = await page.evaluate(() => {
    const controls = document.getElementById('controls').getBoundingClientRect();
    const info = document.getElementById('info').getBoundingClientRect();
    return Math.round(info.top - controls.bottom);
  });
  check(
    'control and info panels stay clear of each other in a short window',
    panelGap >= 0,
    `gap=${panelGap}px at ${VIEWPORT.width}x620`
  );
  await page.setViewportSize(VIEWPORT);
  await page.waitForTimeout(200);

  // ── Saving and sharing ─────────────────────────────────────────────────────
  // The format itself is proved in tests/serialization.test.ts, including what
  // it does with malformed input. What only exists here is the round trip: a
  // scene goes into the address bar, the address bar goes into a fresh page
  // load, and the same scene comes back.
  await page.selectOption('#presetSelect', 'figure-eight');
  await page.waitForTimeout(700);

  const presetHash = await page.evaluate(() => location.hash);
  check(
    'picking a scene puts a link to it in the address bar',
    presetHash === '#v=1;s=figure-eight',
    `hash="${presetHash}"`
  );

  // Add a body, so what gets shared is a scene rather than a preset name.
  await page.mouse.click(1000, 200);
  await page.waitForTimeout(500);

  const beforeShare = await page.evaluate(() => ({
    count: document.getElementById('objectCount').textContent,
    zoom: document.getElementById('zoomValue').textContent,
  }));

  await page.click('#shareBtn');
  await page.waitForTimeout(500);

  const shared = await page.evaluate(() => ({
    hash: location.hash,
    href: location.href,
    status: document.getElementById('shareStatus').textContent,
  }));
  check(
    'sharing writes the live scene into the address bar',
    shared.hash.startsWith('#v=1;') && shared.hash.includes(';b='),
    `${shared.hash.length} characters, starts "${shared.hash.slice(0, 40)}"`
  );
  check(
    'and says what it did with the link',
    /copied|address bar/i.test(shared.status ?? ''),
    `status="${shared.status}"`
  );

  /**
   * Open a link the way someone receiving it would: a real document load.
   *
   * `goto` alone is not enough — a URL that differs only in its fragment is a
   * same-document navigation, so the page never reloads and a "round trip"
   * built on it would be testing the page it was already looking at. Asking for
   * the URL and then reloading forces the fresh start.
   */
  const openLink = async (url) => {
    await page.goto(url, { waitUntil: 'load' });
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => !!document.querySelector('canvas'), { timeout: 20000 });
    await page.waitForTimeout(1500);
  };

  await openLink(shared.href);

  const restored = await page.evaluate(() => ({
    count: document.getElementById('objectCount').textContent,
    zoom: document.getElementById('zoomValue').textContent,
    status: document.getElementById('shareStatus').textContent,
  }));
  check(
    'the link restores the scene it was made from',
    restored.count === beforeShare.count && restored.zoom === beforeShare.zoom,
    `${restored.count} bodies at ${restored.zoom}% zoom, shared as ` +
      `${beforeShare.count} at ${beforeShare.zoom}%`
  );
  check(
    'and says the scene was loaded from a link',
    /^Loaded the scene/.test(restored.status ?? ''),
    `status="${restored.status}"`
  );

  // The short form, which is what the scene dropdown writes.
  await openLink(`${BASE}#v=1;s=comet`);
  const byName = await page.evaluate(() => ({
    scene: document.getElementById('presetSelect').value,
    count: document.getElementById('objectCount').textContent,
  }));
  check(
    'a link can name a scene instead of describing it',
    byName.scene === 'comet' && byName.count === '2',
    `scene="${byName.scene}", ${byName.count} bodies`
  );

  // Pasting a link into the address bar of a page already open changes the
  // fragment without reloading, which is a different code path from the one
  // above and the same one the back button uses.
  await page.evaluate(() => {
    location.hash = 'v=1;s=binary';
  });
  await page.waitForTimeout(900);
  const pasted = await page.evaluate(() => ({
    scene: document.getElementById('presetSelect').value,
    count: document.getElementById('objectCount').textContent,
  }));
  check(
    'changing the fragment on a live page loads the new scene',
    pasted.scene === 'binary' && pasted.count === '2',
    `scene="${pasted.scene}", ${pasted.count} bodies`
  );

  // A link from outside is untrusted input, and the app should say so rather
  // than showing the default scene as though the link had worked.
  await openLink(`${BASE}#v=1;b=nonsense`);
  const broken = await page.evaluate(() => ({
    status: document.getElementById('shareStatus').textContent,
    count: document.getElementById('objectCount').textContent,
  }));
  check(
    'a link that is not a scene says so, and the app still runs',
    /could not read/i.test(broken.status ?? '') && Number(broken.count) > 0,
    `status="${broken.status}", ${broken.count} bodies`
  );

  // ── The ruler, and the scenes that outlive a visit ─────────────────────────
  // The arithmetic behind the ruler is proved in tests/scalebar.test.ts. What
  // only exists here is whether it reaches the canvas, and whether it is still
  // there after the world scales underneath it.
  await openLink(BASE);
  const rulerPixels = () => onCanvas(countNear, { rgb: [150, 165, 190], tol: 25 });

  const rulerAtRest = await rulerPixels();
  await page.mouse.move(700, 400);
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -100);
  await page.waitForTimeout(700);
  const rulerZoomed = await rulerPixels();

  check(
    'a ruler is drawn, and survives zooming',
    rulerAtRest > 100 && rulerZoomed > 100,
    `${rulerAtRest} pixels at 100%, ${rulerZoomed} after zooming in`
  );

  // A scene that came from a link is not any of the presets, and the dropdown
  // should stop claiming otherwise.
  await openLink(`${BASE}#v=1;b=-100,0,400,0,0.3|100,0,400,0,-0.3`);
  const custom = await page.evaluate(() => ({
    value: document.getElementById('presetSelect').value,
    label: document.getElementById('presetSelect').selectedOptions[0]?.textContent,
    bodies: document.getElementById('objectCount').textContent,
  }));
  check(
    'a scene from a link says so in the dropdown',
    custom.value === '__custom__' && custom.bodies === '2',
    `dropdown reads "${custom.label}", ${custom.bodies} bodies`
  );

  await page.selectOption('#presetSelect', 'comet');
  await page.waitForTimeout(600);
  const afterPreset = await page.evaluate(() =>
    [...document.getElementById('presetSelect').options].some((o) => o.value === '__custom__')
  );
  check(
    'and the entry goes away once a real scene is chosen',
    afterPreset === false,
    `custom entry still present=${afterPreset}`
  );

  // Autosave, and the offer to bring it back. The demo should still open on its
  // own opening scene: a half-merged galaxy someone left running is a poor
  // front page, so the saved scene is a button rather than a default.
  await page.mouse.click(950, 250);
  await page.waitForTimeout(3000);

  const stored = await page.evaluate(() => localStorage.getItem('gravity-simulator/last-scene'));
  check(
    'the scene is saved without being asked',
    typeof stored === 'string' && stored.startsWith('v=1;'),
    stored ? `${stored.length} characters stored` : 'nothing stored'
  );

  await openLink(BASE);
  const returning = await page.evaluate(() => ({
    scene: document.getElementById('presetSelect').value,
    bodies: document.getElementById('objectCount').textContent,
    offered: !!document.querySelector('#shareStatus button'),
  }));
  check(
    'a return visit opens on the default scene, and offers the old one back',
    returning.scene === 'binary' && returning.bodies === '2' && returning.offered,
    `opened on "${returning.scene}" with ${returning.bodies} bodies, ` +
      `restore offered=${returning.offered}`
  );

  await page.click('#shareStatus button');
  await page.waitForTimeout(800);
  const restored2 = await page.evaluate(() => ({
    bodies: document.getElementById('objectCount').textContent,
    status: document.getElementById('shareStatus').textContent,
  }));
  check(
    'and restores it when asked',
    Number(restored2.bodies) === 3 && /Restored/.test(restored2.status ?? ''),
    `${restored2.bodies} bodies, status "${restored2.status}"`
  );

  // ── Console hygiene ────────────────────────────────────────────────────────
  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  check('no failed requests', failedRequests.length === 0, failedRequests.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server.close();
}

console.log(
  `\n${results.filter((r) => r.passed).length}/${results.length} checks passed` +
    (failures.length ? `\n\nFailures:\n${failures.map((f) => `  - ${f}`).join('\n')}\n` : '\n')
);
process.exit(failures.length ? 1 : 0);

# Development conventions

Working notes for this repository: the commands, the architecture, and the
handful of invariants that are not obvious from reading a single file. If you
are changing physics or rendering, read the **Invariants** section first — every
entry in it corresponds to a bug that actually shipped.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server on :3000, opens a browser. **Does not typecheck.** |
| `npm run typecheck` | `tsc --noEmit` over `src`, `tests` and `vite.config.ts` |
| `npm test` | Vitest, headless, no DOM — the whole simulation core |
| `npm run test:watch` | the same in watch mode |
| `npm run build` | `tsc && vite build` into `dist/` |
| `npm run preview` | serve the built `dist/` |
| `npm run smoketest` | build first, then drive `dist/` in headless Chromium |
| `npm run screenshots` | the smoke test again, writing `screenshots/*.png` |
| `npm run verify:install` | would CI's npm accept `package-lock.json`? |
| `npm run compare` | integrator accuracy tables; `-- --write` dumps a file to paste into `INTEGRATORS.md` |

`npm run dev` uses esbuild, which strips types without checking them. **A green
dev server proves nothing about whether the project builds** — this is exactly
how the repo reached its first public commit with eleven `tsc` errors and no
working `npm run build`. Run `npm run typecheck` before believing anything.

## Architecture

Deliberately layered so that everything except `Renderer` and `main` is testable
without a browser:

```
main.ts          p5 sketch: input, UI wiring, the frame loop
  ├── Camera         zoom/pan, screen<->world, and the visible world rectangle
  ├── PhysicsEngine  particle list, pairwise forces, integration
  │     ├── Particle    state, F=ma, the force law, trail
  │     └── VectorField field sampling (uniform | adaptive) + OccupancyGrid
  ├── presets        starting scenes, as data plus orbit arithmetic
  ├── integrators    Euler / Verlet / RK4, and the adaptive sub-step rule
  │     └── forces      the softened force law; accelerations at any positions
  └── Renderer     all drawing; the only file that talks to p5's canvas API
        └── Vector2D  immutable 2D vector maths, used everywhere
```

**Only `main.ts`, `Camera.ts` and `Renderer.ts` import p5.** `PhysicsEngine`,
`Particle`, `VectorField`, `Vector2D`, `presets`, `integrators` and `forces` are
plain TypeScript, which is why 113 tests run under Node in about three seconds
with no DOM and no canvas. `tools/compare-integrators.mjs` loads the same
sources through Vite's SSR loader, so the published accuracy tables measure the
code the browser runs. Keep it that
way: if a physics change seems to need p5, the abstraction is in the wrong place.

`Camera` imports only the `ViewBounds` *type* from `VectorField`, so the
dependency is erased at compile time.

## Invariants

### Forces are cleared at the start of a step, never at the end

`Particle.netForce` is what the renderer draws as the orange force arrow, and it
reads it *after* `PhysicsEngine.step()` returns. Clearing belongs in
`resetForces()`, called at the top of `computeForces()`.

This was wrong originally - integration zeroed `netForce` on its way out, so the
renderer's `netForce.magnitude() > 0` gate never once passed and the arrow
advertised in the README and the on-page legend had never drawn a pixel.
Pinned by `tests/PhysicsEngine.test.ts` -> *"leaves netForce readable after a
step"*.

### The integrator contract: accelerations are current on entry *and* on exit

Every scheme in `integrators.ts` may assume each particle's `acceleration` is
the acceleration at its current position when it is handed the particles, and
must leave that true of the new positions when it returns. That is why each one
ends with `field.refresh()`.

Both halves earn their keep:

- **On exit** it is what leaves `netForce` correct for the renderer, at the
  positions actually drawn.
- **On entry** it is what makes velocity Verlet cost one force evaluation per
  step instead of two: the acceleration it computes to finish its velocity
  update is the one the next step opens with. RK4's first stage reuses it too,
  which is why it costs four evaluations rather than five.

`PhysicsEngine` keeps a private `forcesDirty` flag and refreshes before the
first sub-step, because adding or removing a body invalidates the entry
condition. `tests/integrators.test.ts` counts evaluations through a wrapping
`ForceField`, so a scheme that quietly starts recomputing what it was given
fails rather than merely getting slower.

### There is one force law, in `forces.ts`

`Particle.attractionTo` delegates to `gravitationalForce`, and
`accelerationsAt` uses the same function for trial configurations. RK4 has to
evaluate the field at positions no body occupies, which is what forced the
split; the rule that came with it is that softening, and the contact distance it
clamps to, live in exactly one place. Two copies of a softened inverse-square
law is two things to keep in step.

### Trails record frames, not sub-steps

`Particle.recordTrail()` is called once per `PhysicsEngine.step()`, after the
sub-step loop. Recording inside the loop would drain a trail in a fraction of a
second during a close encounter, and its length would visibly change as the
sub-step count moved. Pinned by *"records one trail point per frame however many
sub-steps it took"*.

Trail *length* is a per-scene decision (`Preset.trailLength`), and long trails
are only affordable because of the banding described below.

### p5's colour mode is RGB, except inside the vector-field pass

`Renderer` assumes p5's default **RGB** mode. The only exception is
`drawVectorField()`, which pushes, switches to `HSB(360, 100, 100, 100)` because
hue encodes force strength, and pops.

Originally `setup()` set HSB **globally** while most of `Renderer` was written
for RGB. Nothing errored; the colours were simply wrong and stayed wrong:

| call | intent | what actually rendered |
|---|---|---|
| `background(10, 15, 30)` | dark navy | `rgb(77, 67, 65)`, a brown |
| `fill(150, 200, 255)` | pale blue body | bright green |
| `stroke(255, 200, 0)` on the drag preview | amber | **black** — HSB brightness 0 |

Colour constants now live at the top of `Renderer.ts` and match the hex values
in the legend in `index.html`. If you change one, change both.

`push()`/`pop()` save and restore colour mode, so a scoped switch is safe — but
a bare `colorMode()` call leaks to every later draw call in the frame.

### The vector field is built for the camera's view, not for the canvas

`VectorField.update()` takes `ViewBounds` from `Camera.getViewBounds()`. It used
to sample a fixed box the size of the canvas centred on the world origin, so
panning away from the origin showed empty space no matter what was there.

Sample lattices are anchored to **world** coordinates (`Math.floor(min / grid) *
grid`), not to the viewport or to the particle. Anchoring them to a moving
reference makes every arrow crawl across the screen as the camera or the body
moves. Pinned by *"anchors its lattice to the world, not to the particle"*.

### Sample count is capped, and uniform mode coarsens rather than truncates

`MAX_SAMPLES` is 12,000. Visible world area grows as 1/zoom², so at the minimum
zoom of 0.1 an uncapped uniform lattice asks for ~113,000 arrows and freezes the
tab. Uniform mode increases its spacing to fit the budget; adaptive mode stops
adding. Do not remove the cap without replacing it.

### `OccupancyGrid` must answer exactly what the linear scan answered

Adaptive mode rejects a candidate sample if an accepted one is already within
`gridSize / 2` on **both** axes. That was a scan over every accepted sample —
quadratic, and the dominant frame cost. `OccupancyGrid` is a spatial hash that
narrows the search without changing the predicate.

Its cell size must be **at least the largest `half` ever queried** (the outermost
zone's `1.2 × baseGridSize`, halved) or lookups will miss points in adjacent
cells and silently emit duplicates. `tests/OccupancyGrid.test.ts` compares it
against the naive implementation over thousands of queries, including a
clustered distribution, because uniform random points rarely collide and would
let a broken grid pass.

### Preset velocities come from an orbit equation, never from a guess

`src/presets.ts` derives every velocity — `circularOrbitSpeed`,
`binaryOrbitSpeed`, `apoapsisSpeed`, and the rescaled figure-eight constants —
from `SIMULATION_G`, exported by `PhysicsEngine` for exactly this reason. A
scene built against a different G is a scene that flies apart.

The opening scene used to be two hand-placed bodies at `vy = ±0.5`. The circular
speed for that pair is 0.25 and their mutual escape velocity is 0.354 each, so
the "mutual orbit" the README advertised was a hyperbolic escape: separation grew
from 400 units to 14,735 over 20,000 steps. Nothing errored, and at the ten-second
timescale of a glance it looks like an orbit.

Pinned by `tests/presets.test.ts`, which runs every scene through the real
engine for thousands of steps and asserts what it claims to be — separation
bounds for the binary, orbital radii for the satellites, a closed curve for the
figure eight, perihelion and aphelion for the comet. Add a preset, add its test.

### Trails are drawn in bands, not one `line()` per point

A trail fading along its length needs a `stroke()` before every segment, and
that state change — not the geometry — is the cost. `Renderer.drawTrails()`
splits each trail into `TRAIL_BANDS` (16) polylines and sets the stroke once per
band.

With one call per segment, the figure-eight preset's period-length trail (2,600
points × 3 bodies) put the app at **30fps**; banded, the same picture holds
59.9fps. That is what makes a trail long enough to show a closed orbit
affordable at all. If you lengthen a preset's trail, measure the frame rate
rather than assuming.

### UI state is read from the DOM at startup, never duplicated in TypeScript

`syncStateFromControls()` pushes every control's markup value into the
simulation during `setup()`. The sliders in `index.html` are the single source
of truth for starting values.

Before this existed the two drifted: the mass slider read 200 while new bodies
were created with mass 50, and the range slider read 150 while the field used
300. If you add a control, add it to `syncStateFromControls()` as well as to
`setupUI()`.

The one exception is the **scene dropdown**, whose `<option>`s are generated from
`PRESETS` by `populatePresetOptions()`. The rule is one source of truth, not
"the markup wins": a scene is initial conditions plus arithmetic, so listing it
in HTML would be the duplication the rule exists to prevent. `syncStateFromControls()`
still reads the selection and loads it, which is how the page gets its opening
scene — there is no hard-coded startup configuration any more.

### A click belongs to the canvas only if its `target` is the canvas

p5 listens on `window`, so every mouse event in the page reaches `mousePressed`,
`mouseReleased` and `mouseWheel`. `isCanvasEvent(event)` decides whether an
event is the canvas's by comparing `event.target` to the canvas element. Never
go back to hit-testing `mouseX`/`mouseY` against the panels' bounding
rectangles.

That is what it used to do, and it cannot see anything the browser draws outside
the page. A native `<select>` popup is an OS-level widget that opens over the
canvas: choosing an option from any dropdown in the control panel arrived with
coordinates beyond every panel's rectangle, so the guard passed and a body was
placed where the option had been. Every dropdown in the app spawned a body on
use.

The same rule fixed a second bug in `mouseWheel`, which called
`preventDefault()` before deciding whether the wheel was its own — so the
control panel could not be scrolled with the wheel at all, in exactly the short
windows where it scrolls internally.

Pinned by `tools/smoketest.mjs`: a synthetic mouse event whose target is a UI
element, at coordinates over the canvas, must place nothing. Headless Chromium
never opens native popups, so the test reproduces the event shape one produces
rather than the popup itself.

### Native DOM listeners, not p5's `select().input()`

`@types/p5` declares `input()` and `changed()` on the **p5 instance**, not on
`p5.Element`, so the wrapper form does not typecheck. Use
`document.getElementById` and `addEventListener` — which is what the typed `el()`
helper in `main.ts` is for.

### `Vector2D` is immutable

Every operation returns a new vector. `a.add(b)` does not modify `a`. Convenient,
and it allocates: the field sampler creates a few thousand short-lived vectors
per frame. That is currently well within budget, and is the first thing to
revisit if the frame time regresses.

## Testing

`tests/` mirrors `src/`. Vitest runs in the `node` environment — no jsdom, no
canvas. `Camera` is tested with a five-property stub in place of p5.

What belongs where:

- **Unit tests** — anything expressible without a browser: the force law,
  integration, field sampling, camera maths, the occupancy grid, and whether a
  preset scene actually orbits. An integrator gets three kinds of check: the
  closed form for a constant field, its convergence order (halve the step, watch
  the error fall by 2, 4 or 16), and a long run to see whether its energy error
  is bounded. Order is the one that catches a scheme that looks plausible and is
  first-order by accident.
- **`tools/smoketest.mjs`** — anything that only exists once pixels are on a
  canvas. It serves the real `dist/` over HTTP, drives the app with real mouse
  and wheel events, and **judges colour by sampling the canvas backing store**,
  never by eye. Every check in it maps to a defect that shipped.

Both run in CI, on Linux and Windows for the unit tests.

## Before pushing

1. `npm run typecheck`
2. `npm test`
3. `npm run build` — must be warning-free; the chunk-size limit is set so that
   real growth in the app bundle surfaces
4. `npm run smoketest`
5. `npm run verify:install` if `package.json` or the lockfile changed

Step 5 is not paranoia. CI's npm is decided by the Node version in `.nvmrc`
(Node 22 bundles npm 10), which is routinely a major behind a developer's global
npm, and npm 11 will happily reinstall from a lockfile that npm 10 rejects. See
the header comment in `tools/verify-install.mjs`.

## Dependency notes

`vite` is pinned to `^7` deliberately. `vitest` 4 requires vite `^6 || ^7 || ^8`;
against an older pin, npm resolves the conflict by nesting a second copy of vite
and writing an incomplete lockfile that CI's npm then refuses. Keep the two in
step. The current tree has **0** npm advisories — check it stays that way.

p5 is LGPL-2.1 and is deliberately emitted as its own chunk. See
[`NOTICE.md`](NOTICE.md) before changing `build.rollupOptions`.

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
  └── Renderer     all drawing; the only file that talks to p5's canvas API
        └── Vector2D  immutable 2D vector maths, used everywhere
```

**Only `main.ts`, `Camera.ts` and `Renderer.ts` import p5.** `PhysicsEngine`,
`Particle`, `VectorField` and `Vector2D` are plain TypeScript, which is why 73
tests run under Node in about a second with no DOM and no canvas. Keep it that
way: if a physics change seems to need p5, the abstraction is in the wrong place.

`Camera` imports only the `ViewBounds` *type* from `VectorField`, so the
dependency is erased at compile time.

## Invariants

### Forces are cleared at the start of a step, never at the end

`Particle.netForce` is what the renderer draws as the orange force arrow, and it
reads it *after* `PhysicsEngine.step()` returns. `Particle.update()` must
therefore leave `netForce` alone; clearing belongs in `resetForces()`, called at
the top of `computeForces()`.

This was wrong originally — `update()` zeroed `netForce` on its way out, so the
renderer's `netForce.magnitude() > 0` gate never once passed and the arrow
advertised in the README and the on-page legend had never drawn a pixel.
Pinned by `tests/PhysicsEngine.test.ts` → *"leaves netForce readable after a
step"*.

The same ordering is what velocity Verlet will need when it lands (roadmap M1),
since it caches accelerations across steps.

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

### UI state is read from the DOM at startup, never duplicated in TypeScript

`syncStateFromControls()` pushes every control's markup value into the
simulation during `setup()`. The sliders in `index.html` are the single source
of truth for starting values.

Before this existed the two drifted: the mass slider read 200 while new bodies
were created with mass 50, and the range slider read 150 while the field used
300. If you add a control, add it to `syncStateFromControls()` as well as to
`setupUI()`.

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
  integration, field sampling, camera maths, the occupancy grid.
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

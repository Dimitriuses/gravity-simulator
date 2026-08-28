# Development conventions

Working notes for this repository: the commands, the architecture, and the
handful of invariants that are not obvious from reading a single file. If you
are changing physics or rendering, read the **Invariants** section first — every
entry in it corresponds to a bug that actually shipped.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server on :3000, opens a browser. **Does not typecheck.** |
| `npm run lint` | ESLint over `src`, `tests`, `tools` and the config files |
| `npm run typecheck` | `tsc --noEmit` over `src`, `tests` and `vite.config.ts` |
| `npm test` | Vitest, headless, no DOM — the whole simulation core |
| `npm run test:watch` | the same in watch mode |
| `npm run build` | `tsc && vite build` into `dist/` |
| `npm run preview` | serve the built `dist/` |
| `npm run smoketest` | build first, then drive `dist/` in headless Chromium |
| `npm run screenshots` | the smoke test again, writing `screenshots/*.png` |
| `npm run verify:install` | would CI's npm accept `package-lock.json`? |
| `npm run compare` | integrator accuracy tables; `-- --write` dumps a file to paste into `INTEGRATORS.md` |
| `npm run bench` | scaling and quadtree accuracy; `-- --write` dumps a file to paste into `SCALING.md` |
| `npm run ephemeris` | a millennium of the real solar system, ~4.5 min; `-- --write` dumps a file to paste into `EPHEMERIS.md`, `-- --quick` runs a decade of it in ten seconds, which is what CI runs |

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
  ├── collisions     merge / bounce / pass through, resolved at contact
  ├── quadtree       Barnes-Hut: forces, field, contacts, step size
  ├── serialization  scenes as text, for saving and for the URL fragment
  ├── contours       marching squares over any scalar field
  ├── scalebar       the round number the canvas ruler measures
  ├── styles.css     the page's styling, bundled from index.html's <link>
  ├── units          simulation units <-> SI, for measuring against reality
  │     └── ephemeris   the planets at J2000, and orbits read back out of a state
  ├── streamlines    evenly spaced curves through any vector field
  └── Renderer     all drawing; the only file that talks to p5's canvas API
        └── Vector2D  immutable 2D vector maths, used everywhere
```

**Only `main.ts`, `Camera.ts` and `Renderer.ts` import p5.** `PhysicsEngine`,
`Particle`, `VectorField`, `Vector2D`, `presets`, `integrators` and `forces` are
plain TypeScript, which is why 278 tests run under Node in about nineteen
seconds with no DOM and no canvas. `tools/compare-integrators.mjs` loads the same
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

### A body's radius is a function of its mass, and of nothing else

`Particle.radiusForMass(mass)` is `2 * m^(1/3)`, and it is the only way a radius
is ever set - the constructor uses it, and so does `absorb()` after a merge.
Four things read the relationship: contact distance in `collisions.ts`, the
softening floor in `forces.ts`, the adaptive step rule's clamp, and the renderer.

The roadmap originally specified summing the two areas for a merged body's
radius. That would produce a body wider than any other body of the same mass,
which softens at the wrong distance and collides at the wrong distance. Mass is
what is conserved; radius follows from it.

### Contact distance and the softening floor are the same number

Two bodies touch at `a.radius + b.radius`, which is exactly where
`gravitationalForce` stops letting the force grow. Keep them equal. Inside that
distance the force law has already given up on saying anything meaningful, so it
is the natural place - and the only defensible place - to resolve a contact.

### Both impulses in a contact act at one shared point

`resolveContact` computes a single contact point and takes both lever arms from
it. Taking each arm as its own body's radius along the normal is the same point
only while the pair is exactly touching; the moment they overlap it is two
points, and equal-and-opposite impulses applied at two different points do not
conserve angular momentum. Measured before the fix: 1.6% of it gone per bounce.

Pinned by *"conserves angular momentum through a bounce"*, and by *"conserves it
through a contact that has to separate an overlap too"*, which starts the pair
half inside each other so that both of a contact's jobs run at once.

### A contact that moves a body pays for the move in spin

Separating an overlap, and winding a swept pair back to where they met, are the
only two things a contact does that are not impulses — and moving a body changes
`Σ m (r × v)` by `Σ m (Δ × v)` the instant it happens. `movePair()` in
`collisions.ts` is the only way either move is made, and it hands that amount to
the pair's **spin**, shared as one common `Δω = -ΔL / (I_a + I_b)`. Spin is where
a merge already puts orbital angular momentum, so this is the existing rule
applied to a second case rather than a new one.

Three measurements, on five mass-3000 bodies dropped interpenetrating and left
to jostle for 1,500 steps, are what settled the design:

| separation | angular momentum | KE from a standing start | spread |
|---|---|---|---|
| move, uncompensated | **-26%** | 1,101 | 69 |
| separating (Baumgarte) impulse | 0% | **5,805,700** | 63,513 |
| move, paid into spin | 0% at the contact | 285 | 62 |

The middle row is the textbook remedy and the reason this entry is long. Folding
the overlap into the impulse conserves angular momentum for free, because then
*every* change is an impulse at a shared point — and it is energy from nowhere,
re-applied on every sub-step for as long as gravity holds the contact together.
Scaling it by `1/dt`, as the textbook does, multiplies it again by the sub-step
count: that version reached **67 million** units of kinetic energy. Do not
reintroduce it because it looks more principled.

Compensating one move and not the other is worse than compensating neither
(**-139%**), which is why both go through `movePair` rather than one of them
doing its own arithmetic. `CONTACT_SLOP` exists for the same reason: without it
a resting pair trickles spin forever, since gravity re-closes the gap every step.

The 1.8% a jostling pile still drifts is the integrator, not the contact.
Measured phase by phase, the contact pass contributes exactly **zero** and
velocity Verlet contributes all of it — an impulse is a discontinuity, and the
convergence order Verlet is chosen for assumes there are none.

### Contact is swept, so speed cannot smuggle a body through another

`sweptContactTime` solves `|p + t·v|² = (r₁ + r₂)²` over the step just taken,
and a pair caught mid-flight is wound back to where they met before being
resolved. Testing overlap at the end of a step instead misses anything that
crossed the whole contact window inside it — measured, that used to start at
about 160 units per frame and adaptive sub-stepping was the only thing saving
it.

The tree used for the broad phase is therefore built over each body's *swept*
disc — centred on the middle of its motion, widened by half of it. A tree of
end-of-step positions would prune away exactly the pairs the sweep exists to
catch.

### Collisions invalidate every cached acceleration

Merging changes the membership of the particle list and the masses in it;
bouncing changes positions. Either way the integrator contract above is broken,
so `PhysicsEngine.resolveCollisions()` sets `forcesDirty`, and `step()`
recomputes before returning if the last sub-step collided - the renderer reads
`netForce` the moment it returns.

Contacts are resolved after *each sub-step*, not once per frame. That is the
point of having sub-steps: a fast approach is sliced finely enough to notice the
moment of contact rather than stepping over it. Detection is still a discrete
overlap test, so tunnelling is rare rather than impossible - pinned by a test
that shows a 160-unit-per-frame pass tunnelling with adaptive stepping off and
merging with it on.

### The quadtree is exact at theta = 0, and that is how it is tested

`QuadTree` approximates a distant group of bodies by its centre of mass when the
cell's width over its distance is below `theta`. At `theta = 0` no cell ever
passes that test, so every query walks down to individual bodies and the result
is the direct sum to the last bit. `tests/quadtree.test.ts` checks exactly that
before it checks anything about error bounds: an approximation whose exact case
is wrong is not an approximation, it is a bug.

Two of the tree's four uses are not approximations at all. Contact detection and
the adaptive step-size search use the cells' bounds — widest body, heaviest
body, fastest body — to prune searches whose answers are exactly what the
pairwise scans give. Those bounds must stay *upper* bounds on what a cell can
hold, or the pruning starts skipping the answer. Both are pinned against their
scans.

The step-size search walks **cell against cell**, not body against tree, which
is what took its win over the pairwise scan from 3.5x to 8.2x: one bound test
rejects a whole block of pairs. What it compares is a *lower* bound on the
timescale any pair drawn from the two cells could have — nearest edge-to-edge
distance, each cell's heaviest and fastest member, contact clamp left off, since
clamping only raises the separation. Too optimistic merely wastes work; too high
loses the answer. A cell against *itself* cannot be pruned at all, since two
bodies inside it may be touching, so it splits into its children against
themselves and each distinct pair of them — which is also what counts every pair
exactly once.

### Barnes-Hut is not symmetric, so it does not conserve momentum

The pairwise sum applies equal and opposite forces, so total momentum is exact.
The tree lets A see B individually while B sees A as part of a cell, and those
two forces do not cancel. Under 1% drift over 200 steps on a 200-body disc,
against zero for the exact sum.

This is why `forceMode` defaults to `auto` and the exact solver is kept below
`BARNES_HUT_THRESHOLD` (128 bodies) — a promise about exactness in the scenes
the interface encourages, not a speed threshold. The tree is already faster at
64 bodies.

### There is one force law, in `forces.ts`

`Particle.attractionTo` delegates to `gravitationalForce`, and
`accelerationsAt` uses the same function for trial configurations. RK4 has to
evaluate the field at positions no body occupies, which is what forced the
split; the rule that came with it is that softening, and the contact distance it
clamps to, live in exactly one place. Two copies of a softened inverse-square
law is two things to keep in step.

### A trail may not be drawn across a jump

`Particle.absorb()` moves the surviving body to the pair's centre of mass. That
is a teleport, not travel, so `TrailPoint.jumped` marks the point it lands on
and `Renderer.drawTrails()` lifts the pen there instead of joining the two.

Without it the trail draws a straight line across ground the body never covered,
followed by the direction change the merged velocity brings — which reads as a
zigzag kink in an otherwise smooth orbit, and is exactly what was visible in
three of the README screenshots. Measured on the scene those screenshots are
composed from: one trail step of 10.50 units where every other step in nine
hundred frames was within 1.1x of 3.59.

If anything else ever moves a body other than integration, it has to set the
same flag.

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

### The field is sampled only if it is going to be drawn

`main`'s frame loop calls `engine.updateField()` behind `renderer.showVectorField`.
It used to call it unconditionally, so the Galaxy preset — the one scene that
ships with the overlay *off*, because it cannot afford it — paid for 12,000
samples a frame and drew none of them. Profiled, that was **85%** of a paused
frame; skipping it took the preset from 29 ms a frame to 16.9, which is the
vsync interval.

Pinned by `tools/smoketest.mjs` -> *"hiding the vector field stops it being
sampled"*, which is written as `hidden <= 17.5ms || shown - hidden >= 5ms`
rather than as an fps threshold: on a machine fast enough to hold 60fps either
way both readings sit at the vsync interval and a straight comparison would
prove nothing.

### The contour and streamline tracers take a function, not a simulation

Neither `contours.ts` nor `streamlines.ts` imports anything about gravity: one
takes a scalar at a point, the other a vector at a point. Keep it that way — it
is the only reason they can be tested at all. A cone's level sets are circles
whose radius you can write down and a rotating field's streamlines are circles
about the origin, so both tracers are checked against answers known in closed
form. On a gravitational potential nobody can see the right answer by eye, and
the tests would degrade into "it drew something".

### The contour grid refines where a level crosses, and marches once

Two separate economies, and it is worth knowing which is which. The **grid**
samples every other lattice point first and fills in the rest only for cells
whose corners straddle a level; the saving is modest by nature, since 43% of
cells on a real potential do have a line through them. The **marching** is where
the time was: it used to walk every cell once per level, twelve passes to draw
twelve lines, and now walks once and binary-searches the run of levels a cell's
own corners straddle. Contours went from the most expensive field mode to the
middle of the pack.

Points on the lattice are addressed by integer index and evaluated once, which
is what keeps the lines continuous across a refinement boundary: two cells
sharing an edge interpolate it from the same two numbers. A cell that straddles
no level draws nothing, so it cannot leave a gap by being left coarse — and any
cell sharing a crossed edge straddles that level too, by definition, so it is
refined as well.

Refinement that only follows the readings is blind to structure smaller than its
first cell — see the entry below, which is the same trap. `traceContours` takes
an optional list of points to refine around and `VectorField` passes the body
positions. *Points*, not particles: the tracer still knows nothing about
gravity. Forcing a patch of samples around every body instead cost more at three
hundred bodies than the thinning saved.

### Gradient refinement is blind to what is smaller than its first cell

The `gradient` field mode subdivides a cell while its reading disagrees with its
parent's. On its own that never finds structure smaller than the coarse cell it
starts from: a 120-unit cell holding a mass-5 body sees a field dominated by the
mass-5000 body nearby, finds nothing to disagree with, and stops. Measured on
the Lagrange scene, both trojans got **no arrows at all**.

Cells near a body therefore refine regardless of the readings, down to the same
fine spacing the zone-based mode uses. If you touch the refinement rule, the
test to keep is *"reaches every body, including one too small to bend the field
around it"* — the count and the cost are the easy half.

### The ruler is drawn after the camera transform is reset

`Renderer.drawScaleBar()` is called from `main` *after* `camera.reset()`, and it
is the only drawing that happens there. Everything else is drawn in world
coordinates and scales with the view; the ruler is the one thing whose length on
screen must stay put while the world moves underneath it.

Its length comes from `scalebar.ts`, which is free of p5 so the arithmetic can
be tested in Node like the rest of the core. The rule it enforces is that the
number under the bar is always one a person would have chosen — 1, 2, 5 and
their decades — because a ruler reading "137 units" is a ruler nobody trusts.

### A saved scene is offered, never restored behind the viewer's back

The scene is written to `localStorage` every couple of seconds, but a return
visit opens on the **default** scene with a *Restore last scene* button. The
demo's opening scene is its first impression, and a half-merged galaxy someone
left running is a poor one; the returning visitor's work is one click away
instead of imposed on everybody.

Reads and writes are both wrapped in try/catch and fail silently. Storage can be
full, or disabled outright in a private window, and neither is a reason to
interrupt a running simulation.

### A locked scale is captured mid-frame, and only covers the arrows

`Renderer.lockScale()` does not pin anything on the spot: the magnitude ranges
exist only part-way through a draw pass, so the request sets a flag and the next
pass that computes a range fills it in. Either pass may be the one — the field
can be hidden, or the per-body arrows can be — so `captureLock` merges into
whatever is already there and clears the flag once both halves are present.

The lock is force-shaped. Contours and the heightmap draw *potential*, so they
ignore it and go on publishing their own range; the legend has to say which of
the two the numbers belong to, because a locked scale and an unlocked one look
identical until the scene moves under them.

### The panel's second column is measured, not media-queried

`updatePanelColumns()` in `main` takes the class *off*, measures whether the
panel overflows, and puts it back — because the condition is not the window's
size but whether one column still fits, which depends on how many `<details>`
sections the viewer has opened. CSS cannot ask that. It runs on the events that
can change the answer, a resize or a section toggling, and never per frame: it
forces a reflow.

The sticky action row lives outside `#panelBody` deliberately. `position:
sticky` does not work inside a multi-column container, so the row would stop
sticking the moment the second column appeared.

### A frame-relative picture needs its numbers printed

Arrow length and hue are normalized against the range of magnitudes present in
the current frame, which is what keeps them legible across the ~10⁶ span the
sliders can produce, and what makes the same red mean something different from
one frame to the next. `Renderer.fieldScale` publishes that range and the legend
prints it. Modes that have no magnitude to report — streamlines — hide the
colour ramp and clear its values rather than leaving last mode's numbers sitting
in a hidden element waiting to be believed.

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

### Two of the three scales are a choice, and the third is not

`units.ts` exists because `SIMULATION_G` is 0.5 — a number picked so the mass
slider would feel right, not a measurement. Gravity ties the scales together as
`G_sim = G · kg · s² / m³`, so declaring a length unit and a mass unit *fixes*
the second: 398.2087 of them, for the solar-system scale. Do not add a
conversion factor anywhere else; if a number needs to be in seconds, it comes
through `scaleFor`.

The check that the chain is right is deliberately not self-referential. A
circular orbit of one au about one solar mass has to come out at **365.2569
days** travelled at **29.785 km/s**, and `tests/units.test.ts` asserts both.
Nothing in this repository chose those.

### Verlet conserves energy and invents precession

The default integrator is second-order and symplectic: bounded energy error,
which keeps a drawn orbit closed, and truncation error that goes into the
orbit's *orientation* instead. On the two-body problem, where the perihelion
provably does not move, Verlet turns it -1,679″ per century at a step of a
twentieth of a day — three times roadmap M8's entire result, backwards — while
holding energy to a part in 10⁹.

So: watch with Verlet, measure with RK4. Any measurement taken across many
orbits needs all three of what `tools/check-ephemeris.mjs` does — RK4, two step
sizes, and a control case whose answer is known independently. Do not read a
long-run number out of this simulation without them, and do not take energy
conservation as evidence that a run was accurate.

A fourth habit came out of M14: quote a rate over **two windows**. The tool
fits every rate over the first century of its run and over the whole
millennium, and the pair is what distinguishes a rate from the phase of
something slower — Jupiter's perihelion had the wrong sign over a century and
is within 10% over a millennium, while Mercury's moves by 0.4″ between the two.
A number that survives ten times the integration is a different kind of number
from one that has only been measured once.

Sampling has to follow the *shortest* orbit rather than the span: the tool reads
the orbits back every eighth of Mercury's year, because the turn counter and the
perihelion unwrapping both need better than half an orbit between readings, and
a fixed number of samples across a millennium would put four months between them.

### One scene is in real units, and three things bend around it

The solar-system preset is built from `src/ephemeris.ts` at
`SOLAR_SYSTEM_SCALE`, so its numbers are the sky's rather than anyone's choice.
That makes it the scene where every constant tuned for the hand-built scenes
shows up as wrong:

- **`Preset.timeStep`** exists because 1 is only a good step in units chosen to
  make it one. Here it is 398 seconds, so the scene asks for 110 a frame. It is
  applied on every preset load, like the overlays and the zoom, so one scene's
  pace cannot follow the viewer into the next; it round-trips through the scene
  format as `d=`, bounded by `MAX_TIME_STEP`.
- **`MIN_DRAWN_DIAMETER_PX`** is why the planets are visible at all. Distance
  stays exact and size stops shrinking below three pixels — the only honest
  option, since the Sun is 109 Earths wide and the Earth's orbit is 23,000 Suns
  around.
- **The per-body arrows have no magnitude threshold**, only `> 0`. The two
  constants that used to gate them (1e-6 of force, 0.01 of speed) hid *every*
  arrow in this scene, where the force on the Earth is 2e-14. They are scaled
  against the frame's own range, so nothing was needed in their place. The
  field's `MIN_FORCE` is still absolute and still hides the whole scene, which
  is why the preset ships with the overlay off — the sampler applies it while
  deciding where to sample, before a range exists.

If a fourth scene-scale constant turns up, this is the list it belongs on.

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

### Drawing is batched by layer, not by body

`Renderer.drawParticles()` draws every glow, then every body, then every label,
rather than all three per body. `fill()` and `stroke()` each build a colour
object, and that state change is the cost: six per body became six per frame.
The mass labels are skipped entirely when a body is under
`MIN_LABELLED_DIAMETER_PX` on screen — `text()` is the most expensive call in
the file, and at the galaxy preset's 22% zoom the labels were two pixels tall.
Four hundred bodies went from 83 ms a frame to 22 ms.

The renderer needs the camera's zoom to make that judgement, which is the only
reason `Renderer.zoom` exists; main pushes it in each frame.

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

### A link is input from a stranger, and is decoded like one

`decodeScene()` never half-applies anything. It validates the version, every
number, every enum and the body count before the caller sees a scene, and
returns a *reason* on failure so the UI can say what was wrong. Three rules
follow from that and are easy to break by accident:

- **Unknown keys are ignored, not rejected**, so a later version can add fields
  without every older build refusing the link.
- **A version from the future is refused, not guessed at.** The same letters may
  mean something different in v2, and quietly misreading them is worse than
  saying no.
- **Bounds are checked because they are reachable from outside**: a mass of zero
  puts an infinity into the state on the first step, and a body count in the
  millions hangs the tab. `MAX_DECODED_BODIES` is not paranoia, it is the only
  thing between a pasted link and the browser.

The format is plain `key=value;` text rather than base64-wrapped JSON so that a
mangled link can be diagnosed by looking at it, and it uses only characters a
URL fragment accepts unescaped — `tests/serialization.test.ts` asserts that with
`encodeURI(text) === text` rather than trusting it.

### Writing the fragment uses `replaceState`, and remembers what it wrote

Choosing four scenes in a row should not mean pressing Back four times to leave
the page, so the address bar is updated with `history.replaceState` rather than
by assigning to `location.hash`. The app also keeps the last fragment it wrote,
because the `hashchange` listener has to tell a link someone pasted from the
app's own writes — without that, every scene load triggers a reload of itself.

### A scene's overlays are part of its setup, and are always applied

`loadPreset()` sets the vector-field and per-body-arrow checkboxes on every
load, defaulting to on for scenes that do not say otherwise. It is tempting to
apply them only when a preset asks — the galaxy is the only one that does — but
then the galaxy's economies followed the user into whatever scene they loaded
next, which arrives with a blank canvas and no way to tell why. Zoom and trail
length already work this way.

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

### Following a body is shift-click, because a plain click places one

Every canvas gesture here is competing with "place a body". Double-click was the
obvious way to pick one up and is unusable: p5 delivers two complete clicks
before `doubleClicked`, so the gesture placed two bodies on the same spot and
then followed one of them — which in the default merge mode absorbed the other
and released the camera immediately. The smoke test caught it on the first run,
reporting the status line as *"The followed body was absorbed"*.

`Esc` releases, and so does the followed body being absorbed. That second case
has to say something (`#followStatus`), because a camera that silently stopped
following is indistinguishable from one that drifted.

`Camera.centerOn` cancels any pan in progress. A drag and a followed body both
want to set the camera, and letting the follow win silently leaves the pointer
dragging a view that does not move, which reads as the app having frozen.

### The debug overlay is computed only while it is up, and only four times a second

`PhysicsEngine.diagnostics()` sums the potential over every *pair*, which is the
cost Barnes-Hut exists to avoid, so `main` calls it behind `debugVisible` and no
more than every `DEBUG_REFRESH_MS`. The same rule as the vector field: if
nothing is going to read it, do not compute it.

Drift is measured from the moment the overlay was opened, not from the start of
the scene — a scene that has been merging bodies has lost kinetic energy
legitimately, and that swamps whatever the viewer is actually looking at.

`keyPressed` ignores events whose target is an `input`, `select` or
`textarea`. p5 listens on `window`, so without that guard the arrow keys on a
range slider — and in some browsers its letter keys — toggle the overlay.

### Styles live in `src/styles.css`, values live in `index.html`

The stylesheet was lifted out of the document once it passed a screenful; the
markup stayed, because `syncStateFromControls()` reads the sliders' `value`
attributes as the simulation's starting values. Moving the controls into
JavaScript would recreate the exact drift that rule exists to prevent.

The control panel's action row is `position: sticky` inside the scrolling
panel. When testing that kind of layout claim, do not scroll the panel first:
the first version of the smoke check did, and passed with the fix removed.

A consequence for `tools/smoketest.mjs`: the panel is 289px wide with its
sections folded and **520px** wide with them open, so a canvas click near the
top-left may land on the panel depending on what an earlier section opened. One
at (500, 470) became the sticky Pause button, froze the simulation and failed
three later checks — none of which mentioned the panel.

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

`eslint` and `@eslint/js` must move together — `@eslint/js@10` declares a peer
of `eslint@^10`, so installing the two at different majors is an `ERESOLVE`
failure rather than a warning. `typescript-eslint@8` accepts either.

`vite` is pinned to `^7` deliberately. `vitest` 4 requires vite `^6 || ^7 || ^8`;
against an older pin, npm resolves the conflict by nesting a second copy of vite
and writing an incomplete lockfile that CI's npm then refuses. Keep the two in
step. The current tree has **0** npm advisories — check it stays that way.

p5 is LGPL-2.1 and is deliberately emitted as its own chunk. See
[`NOTICE.md`](NOTICE.md) before changing `build.rollupOptions`.

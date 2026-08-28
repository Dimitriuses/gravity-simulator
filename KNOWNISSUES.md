# Known issues

Measured, reproducible limitations of the current build. Anything here is known
and either scheduled in [`ROADMAP.md`](ROADMAP.md) or deliberately accepted.

Every entry is one of three things, and the index says which:

- **Resolved** — it was a defect, it was fixed, and the entry is kept because
  the measurement that found it is worth having and because the fix has a shape
  that can be undone by accident.
- **Accepted** — a property of the model rather than a defect. Nothing is
  planned, and the reason is in the entry.
- **Open** — work that has not been done, with the milestone that will do it.

| | entry | status |
|---|---|---|
| 1 | Tight orbits are the least accurate | **Resolved** (M1); the floor at ~25 steps an orbit is **accepted** |
| 2 | Which scheme bounds its error, and which does not | **Accepted**, and **resolved** in the respect that mattered: Forest-Ruth (M18) is both |
| 3 | Contacts are resolved, but crudely | **Resolved** (M2, M6, M12, M16); no tidal torque is **accepted**, in M10 |
| 4 | Arrow length is relative | **Resolved** (M5, M13, M17) |
| 5 | Saving happens on its own; restoring does not | **Resolved** (M4, M11); the length of a link for a large scene is **open**, M19 |
| 6 | Performance ceiling | **Measured** (M3, M7, M15) — the field's sample budget is **accepted**, per-body stepping **declined with numbers** |
| 7 | The default integrator turns orbits that should not turn | **Accepted** as a property of the *default*; M18 added a scheme that does not |
| 8 | The solar system model is flat, and Newtonian | **Accepted** (M10); the windows that do not settle are **accepted** (M14) |
| 9 | The debug overlay costs a full pairwise pass | **Open**, small — M19 |
| 10 | The solar system scene is to scale in distance, not size or time | **Accepted** — and the field overlay draws it since M17 |
| 11 | Barnes-Hut gives up exact momentum conservation | **Accepted** (M10) |
| 12 | Zooming out far in uniform mode coarsens the grid | **Accepted** |
| 13 | Desktop only | **Accepted** (M10) |
| 14 | Very short windows scroll the control panel | **Resolved** (M9, M13) |
| 15 | The linter is narrow, and there is no formatter | **Accepted**, and the formatter is a decision rather than a defect — M19 |

---

## Tight orbits are the least accurate, and there is a floor on how tight

Resolution depends on how many steps fit into one orbital period, and period
scales as r^1.5, so a fixed step of 1 gives a wide orbit thousands of points and
a tight one a handful. Adaptive sub-stepping (roadmap M1, done) now subdivides
the frame for whatever the closest pair needs, and velocity Verlet replaced
symplectic Euler as the default scheme.

Mass-5000 primary, negligible satellite, 100 orbits. "Was" is the original
fixed-step symplectic Euler; "now" is the shipping default, velocity Verlet with
adaptive sub-stepping:

| orbit radius | steps/orbit | was: radius within | now: radius within | sub-steps used |
|---:|---:|---|---|---:|
| 400 | 1005 | 398.8 - 401.3 (0.63%) | 400.0 - 400.0 (0.00%) | 1 |
| 200 | 355 | 198.3 - 201.8 (1.77%) | 200.0 - 200.0 (0.02%) | 1 |
| 100 | 126 | 97.6 - 102.6 (5.00%) | 100.0 - 100.1 (0.12%) | 1 |
| 50 | 44 | 47.0 - 54.0 (14.18%) | 50.0 - 50.1 (0.11%) | 3 |

**A previous version of this table went further, to radius 25 and radius 12,
and reported the orbit being destroyed outright. Those two rows were
misleading.** A mass-5000 body has a radius of 34.2 units, so a satellite at
r = 25 or r = 12 is *inside* the primary, where the force law softens
deliberately. What those rows measured was mostly softening, not step size.

Since a body cannot orbit inside the primary and radius goes as `2*m^(1/3)`,
the tightest *physical* circular orbit is about **25 steps per orbit** whatever
the masses - the mass cancels. r = 50 above is close to that floor, and it is
the worst case a real orbit can present.

Remaining limitation: sub-stepping is **global**. One pair in a tight encounter
subdivides the step for every body in the scene, including bodies that did not
need it. Per-body time-stepping would confine the cost to the bodies that earn
it. Capped at 64 sub-steps per frame; the UI reports the count, and at the cap
the encounter is beyond what the frame can resolve.

## Which scheme bounds its error, and which does not

Symplectic Euler and velocity Verlet are both symplectic: energy oscillates
within a bound rather than growing, so orbits do not spiral apart. RK4 is
fourth-order and is **not** symplectic - over a long run its energy error
accumulates in one direction. At r = 50 (44 steps per orbit), total energy
excursion:

| scheme | by 100 orbits | by 500 | by 1,000 |
|---|---:|---:|---:|
| Symplectic Euler | 2.0096% | 2.0096% | 2.0096% |
| Velocity Verlet | 0.0097% | 0.0097% | 0.0097% |
| Runge-Kutta 4 | 0.0997% | 0.5086% | 1.0444% |

The symplectic pair reach their widest excursion early and stay there. RK4 keeps
going, which is why it is offered for comparison rather than as the default, and
why the tests assert momentum conservation rather than energy conservation -
momentum is exact under all three, because every stage applies forces in equal
and opposite pairs.

Error that remains under every scheme shows up as **phase**: a body in the right
orbit at the wrong place along it. Full tables in
[`INTEGRATORS.md`](INTEGRATORS.md), regenerated by `npm run compare`.

## Contacts are resolved, but crudely

Bodies used to pass straight through one another. They now merge on contact by
default, or bounce inelastically, or pass through if you ask them to (roadmap
M2, done). Contact is defined at the sum of the two radii, which is exactly
where the force law softens - past that point the bodies are inside each other
and the simulation has nothing meaningful left to say about them.

Bodies also carry spin, gain it from off-centre impacts through contact
friction, and keep the pair's angular momentum through a merge (roadmap M6).
Contact is detected along the path each body travelled rather than by testing
overlap at the end of a step, so speed no longer lets anything through: measured
against a 23-unit target, a pass is caught at 160, 1,000 and 20,000 units per
frame, with or without sub-stepping.

What the model still does not include:

- **Merging is perfectly inelastic**, and in merge mode it is irreversible: mass,
  momentum and angular momentum are conserved exactly, kinetic energy is not,
  and two bodies that graze at high speed merge as readily as two that settle
  together. The *shatter* mode (roadmap M16) is the exception — there, an impact
  carrying more energy than it would take to pull the merged body apart breaks
  the pair into a largest remnant and smaller pieces instead.
- **Shattering has three numbers in it that are choices**, and they are named as
  such in [`src/fragmentation.ts`](src/fragmentation.ts): half the mass stays in
  the largest piece, half the leftover energy goes into throwing the pieces
  apart, and no impact makes more than five. The threshold itself and the
  dispersal speed are consequences rather than choices — they come from the
  binding energy the mass rule implies. In practice the *escape* condition binds
  first: breaking starts at about 3.5x the binding energy, not 1x, because
  pieces that cannot outrun each other fall back together and the pair merges
  instead.
- **The sweep assumes straight-line motion within a sub-step.** It is exact for
  the step it is given, so what is left is the curvature the step itself
  ignores, which adaptive stepping already bounds. Accepted as a property rather
  than tracked as work — see roadmap M12, which closed with it stated.
- **Separating an overlap moves bodies, and moving bodies costs angular
  momentum.** It is the one thing a contact does that is not an impulse: two
  bodies found inside each other are pushed apart along the normal, the heavier
  giving least ground, which leaves the centre of mass alone but changes
  `Σ m (r × v)` by `Σ m (Δ × v)`. That amount is no longer dropped — it is added
  to the pair's spin, where a merge already puts orbital angular momentum, so
  the total across a contact comes out unchanged to floating-point. The same is
  done for the swept rewind, which is a displacement too.

  What is left is not the contact's: a pile of five heavy bodies jostling for
  1,500 steps drifts by **1.8%**, and measuring phase by phase attributes all of
  it to velocity Verlet under repeated impulses and none of it to the contact
  pass. A contact is a discontinuity, and the convergence order the integrator
  is chosen for assumes there are none.
- **A resting contact keeps a sliver of overlap.** The separation ignores the
  last twentieth of a unit, because gravity presses a resting pair together by a
  hair every step and answering each one would trickle angular momentum into
  spin for as long as the scene ran. The sliver is far below a pixel at any zoom
  the camera allows.
- **Gravity applies no torque.** A body is a point mass to the force law, so
  spin changes only at contact — there are no tidal effects, and nothing spins
  up or down by orbiting. Accepted rather than open: a tidal torque needs a body
  with a *shape*, and every body here is a disc whose radius is a function of
  its mass alone. Roadmap M10 names it with the rest of what is deliberately
  not being done.
- **A merged body's trail has a gap in it**, where the survivor was moved to the
  pair's centre of mass. The gap is deliberate: the body was teleported there,
  and a line across it would claim a path it never took. It used to be drawn as
  a line, and appeared as an unexplained zigzag in the README screenshots.
- **Merging destroys the interesting dynamics**, which is a property of merging
  rather than a defect. A three-body configuration that would be worth watching
  becomes one body the moment two of them touch. Bounce mode exists for that
  reason.

## Arrow length is relative; the numbers beside it are not

Both the field arrows and the per-particle force and velocity arrows map
magnitude logarithmically onto a fixed length band, normalized against the range
present in the *current* frame. That is what keeps them legible across the ~10⁶
range of forces the mass and distance sliders can produce.

The consequence used to be that the picture had no absolute reading at all. The
legend now prints the two ends of the range on screen — strong and weak, in
force per unit mass — and updates them every frame (roadmap M5). What remains:

- **Lengths are frame-relative until you say otherwise.** *Lock arrow scale*
  (roadmap M13) pins the range to what is on screen when it is set, and the
  legend says when it is pinned. Unlocked is still the default, because a locked
  scale on a collapsing scene saturates to red and on an escaping one fades to
  nothing — the relative version is what keeps the picture legible while the
  scene is changing, and the lock is what makes two moments comparable.
- **The lock covers the potential modes too**, since roadmap M17, and as a
  *second* pinned range rather than a change to the first: a force range applied
  to a contour would be a number in the wrong units. Switching between an arrow
  mode and a potential one keeps both. For contours the levels are pinned as
  well as the colours, so the same curves are drawn from frame to frame — a
  level the scene has moved away from goes missing rather than being replaced.
  Distance, meanwhile, has an absolute scale in every mode: the ruler along the
  bottom of the canvas.

## Saving happens on its own; restoring does not

A scene can be written into the address bar and restored from it — **Copy Link**
does that, and choosing a preset puts its short form there (roadmap M4, done).
The scene is also written to `localStorage` every couple of seconds. A return
visit still opens on the **default** scene and offers the saved one back as a
button, rather than restoring it silently: the demo should open on the scene it
was designed to open on, and a half-merged galaxy someone left running is a poor
front page.

Storage can be full or disabled outright, in which case nothing is saved and
nothing is offered. That failure is silent by design — it is not worth
interrupting a simulation for.

Two smaller edges:

- A link is as long as the scene is — *open, roadmap M19*: about 210 characters
  for a four-body scene, and about 55 per body after that. The 300-body galaxy
  is roughly 16,000 characters, which is fine in the address bar and too long
  for most chat clients. Above 2,000 characters the app says so rather than
  pretending otherwise, which is honest and not the same as fixing it.

## Performance ceiling

Force computation and field sampling both go through a Barnes-Hut quadtree past
128 bodies (roadmap M3), which moved the ceiling but did not remove it.

Measured by `npm run smoketest` on the seeded two-body scene in headless
Chromium: **59.9 fps, 16.7 ms/frame**. Measured on the 300-body Galaxy preset in
the same browser: **30 fps with the tree, 12 fps forced onto the exact sum**.

What limits it now, in order:

- **The field is sample-bound.** It samples up to 12,000 points regardless of
  the body count — filtered against a thousandth of the strongest force present
  rather than an absolute floor, so the count does not depend on the scene's
  scale — and so it costs tens of milliseconds even in a small scene shown
  at full range — and hundreds in a wide view of a large one. The Galaxy preset
  turns it off for that reason; the cap was chosen when the field was the only
  thing on screen. It is not sampled at all while the overlay is hidden, which
  it used to be.
- **The force evaluation**, once per sub-step. On the Galaxy preset with the
  overlay off this is most of what is left, and the frame is capped by the
  display rather than by the work.
- **Sub-stepping is global**, so one tight pair slices the frame for every body
  in the scene. Measured (roadmap M15): every scene the app ships takes a single
  sub-step and wastes nothing; the Galaxy preset takes three where the median
  body needs one, which is 3.5 ms of a frame with seven to spare. A scene with
  one very close pair in it takes ten and wastes 88% — reachable by leaving a
  pile of bodies in bounce mode, where a resting contact holds the whole scene
  at a fine step for as long as it sits there. Per-body stepping is the standard
  answer and was measured rather than built; M15 says why, and what would make
  it worth revisiting.
- **Drawing**, which is *not* the wall it was once assumed to be: profiling a
  paused 211-body frame puts it at about 1.1 ms against 79% idle. Roadmap M7
  proposed dropping the glow pass and the measurement argued against it.

Turning off *Show Vector Field* still removes the single largest cost in most
scenes, and now removes it completely rather than only hiding it. Full tables in
[`SCALING.md`](SCALING.md). Roadmap M7 closed with its costs measured; the one
structural change it did not make — per-body time-stepping, so that one tight
pair stops subdividing the step for bodies nowhere near it — is roadmap M15.

## The default integrator turns orbits that should not turn

Velocity Verlet is symplectic, so its energy error is bounded — an orbit drawn
with it stays closed rather than spiralling, which is exactly what is wanted
while watching one. Its second-order truncation error goes somewhere else
instead: into the orientation of the ellipse.

On the two-body problem, where the true answer is that the perihelion does not
move at all, Verlet reports it moving backwards at 1,679 arcseconds per century
at a step of a twentieth of a day, and four times that at twice the step. RK4
reports 0.01″. Nothing about the energy figure hints at it: over the same run
energy holds to a part in 10⁹.

It is invisible in ordinary use, and it is fatal to a measurement — roadmap M8's
whole result, Mercury's perihelion, is 545″ per century, which Verlet would have
buried three times over. Anything measured out of this simulation across many
orbits belongs in RK4, checked at two step sizes. See
[`EPHEMERIS.md`](EPHEMERIS.md) and [`INTEGRATORS.md`](INTEGRATORS.md).

Since roadmap M18 there is a fourth scheme that is symplectic **and** accurate
in phase — Forest-Ruth, three velocity Verlet steps with signed weights — which
invents +0.19″ per century on that same control where Verlet invents -1,677″,
while holding energy to 0.0000% over a thousand orbits. It is not the default,
because it costs three force evaluations a step against Verlet's one and an
interactive frame is bound by cost; it is what to select before measuring
anything. The advice is now *watch with Verlet, measure with Forest-Ruth*.

## The solar system model is flat, and Newtonian

Both on purpose, both stated wherever a number from it is published. The
simulation is two-dimensional, so the ephemeris check lays every orbit in the
ecliptic with its size, shape, orientation and phase intact and drops the
inclinations. That is worth about +14″ per century on Mercury's perihelion, in
the direction the argument predicts: laid flat, every perturber pulls entirely
within Mercury's orbital plane instead of mostly within it.

Newtonian is not a defect either. The 43″ per century that general relativity
contributes to that same number is the one thing this cannot produce, and a
Newtonian simulation that produced it would have a bug.

The published run is a Julian millennium (roadmap M14), which settled most of
what a century could not: every orbital period now lands within 0.35%, and
Jupiter's perihelion — which had the wrong sign over a century — comes out
within 10%. Two rows still do not settle, and both are stated in
[`EPHEMERIS.md`](EPHEMERIS.md) beside the numbers they qualify:

- **Saturn**, because a millennium is 1.1 cycles of its 900-year exchange with
  Jupiter, and a window has to cover several cycles of a thing to average it
  away.
- **Venus**, whose published perihelion rate of +9.7″ a century is the small
  residue of perturbations worth hundreds of arcseconds each. The measurement
  is not the problem — fitting `e·sin ϖ` and `e·cos ϖ` gives the same answer as
  fitting ϖ directly — the flat model is: a few per cent off each of several
  hundred arcseconds is larger than the residue they add up to.

## The debug overlay costs a full pairwise pass

*Open, roadmap M19.* `D` shows energy, momentum and angular momentum, and the
potential term in the first of those is a sum over every *pair* — the one cost
Barnes-Hut exists to avoid, and one the tree could do approximately for a
readout that is already only refreshed four times a second. It is computed four times a second and only while the overlay is up, so a
scene of a few hundred bodies pays for it about as often as it can be read; at a
few thousand, leaving the overlay open is measurably slower than not.

The drift figures are relative to the moment the overlay was opened, not to the
start of the scene. A scene that has been merging bodies has lost kinetic energy
legitimately, and that swamps everything else if it is counted.

## The solar system scene is to scale in distance, not in size or time

Three compromises, all of them forced, all of them visible in the scene rather
than hidden:

- **Sizes.** The Sun is 109 Earths across and the Earth's orbit is 23,000 Suns
  around, so no zoom shows both the bodies and their orbits. Bodies are never
  drawn smaller than three pixels across, so below that everything is the same
  dot. The distances are exact.
- **Time.** One simulation unit is 398 seconds at this scale, so the scene sets
  `timeStep` to 110 — about twelve hours a frame, an Earth year in ten seconds.
  That is a display choice rather than a change to the physics, and the adaptive
  rule still subdivides it when a close pair needs it.
- **The field overlay works here since roadmap M17.** It did not before: the
  sampler discarded anything below an absolute 0.001, and the field at the
  Earth's distance from a Sun weighing 0.0126 units is 6e-7, so the whole scene
  fell through the threshold and the preset shipped with the overlay off. The
  floor is now a thousandth of the strongest force in the frame, which means the
  same thing at any scale. The threshold is absolute because the sampler applies
  it while deciding where to sample, before it knows the range. The per-body
  force and velocity arrows *do* work: they are scaled against the range present
  in the frame, so they needed no such number once the constants that used to
  gate them were removed.

Masses in this scene are correspondingly small — the Sun is 0.0126 units and the
Earth 3.8e-8 — because the radius rule `r = 2·m^(1/3)` ties mass to size, and a
Sun heavy enough to read as a round number would have a radius wider than
Mercury's orbit. Readouts show three significant figures rather than rounding
such masses to zero.

## Barnes-Hut gives up exact momentum conservation

The approximation is not symmetric: body A may be close enough to see B
individually while B is far enough to see A only as part of a cell, so their
forces are not equal and opposite. Momentum then drifts — measured at under 1%
of the system's total scalar momentum over 200 steps on a 200-body disc, against
zero to machine precision for the exact pairwise sum.

This is inherent to the method rather than a defect in this implementation, and
it is why the exact solver remains the default below 128 bodies and can be
forced at any size from the Physics section. Symmetrising the traversal would
remove it and is deliberately not planned — roadmap M10 names the reason. Force error itself is small: at the
default opening angle of 0.5, a median of 0.03% on a 256-body disc and 0.2% at
2,048.

## Zooming out far in uniform mode coarsens the grid

The visible world area grows as 1/zoom², so at the minimum zoom of 10% a
fixed 30px lattice would ask for ~113,000 arrows and lock the tab. Uniform mode
responds by increasing its spacing to stay within the 12,000-sample budget, so
the field stays uniform but gets visibly sparser as you zoom out. This is
deliberate; adaptive mode is unaffected, because its sampling is anchored to the
bodies rather than to the viewport.

## Desktop only

The interaction model needs three mouse buttons, a scroll wheel and Ctrl:
left-drag places a body, middle-drag or Ctrl+drag pans, wheel zooms. There is no
touch equivalent, so on a phone or tablet you can place bodies but not pan or
zoom. The page loads and runs; it is just not controllable. Roadmap M10 — a
touch version needs its own interaction design rather than a polyfill.

## Very short windows scroll the control panel

The control panel is capped at `calc(100vh - 210px)` and scrolls internally
below that, so it can never collide with the bottom-left info panel. Its natural
height is 455px including padding, so below about **665px** of viewport height
you have to scroll inside the panel to reach the lower controls. (Until the
mouse-target fix, the wheel could not scroll it: the canvas claimed every wheel
event in the page before deciding whether it was over the canvas.)

Every control added to the panel raises that threshold, which is the cost of a
single column. Render Settings, Camera and Physics are therefore `<details>`
closed by default, which took the panel from 584px to 455px and the threshold
from 776px down to 665px; the smoke test measures both at boot.

Opening all three at once still makes the panel taller than the space it has,
but that no longer hides anything: the action row is sticky inside it, so Clear
All and Pause sit at the bottom edge whatever the scroll position, and a short
window tightens the panel's spacing rather than its contents. And since M13 it is not always a single column: when one has stopped fitting and
the window is at least 1000px wide, the sections flow into two. That is measured
in JavaScript rather than expressed as a media query, because the condition is
whether the panel fits — which depends on how many sections are open, and CSS
cannot ask. Below 1000px it still scrolls, which is what the wheel-over-panel
check in the smoke test now exercises.

Width is not a factor. Measured across 320–1280px with the particle list
populated, the info panel never exceeds 127px wide and the legend 134px, so the
bottom pair never collide horizontally — the panels overlay the canvas by
design, but never each other.

The cap only started working once `#controls` was made `border-box`: `max-height`
applies to the *content* box, so the panel's 15px of padding above and below
originally sat outside the 210px budget and it reached 30px lower than intended.
That overlapped the info panel by 15px at any viewport height below ~690px —
visible only with the particle list populated, which is why it survived the
original fix. Now checked by `npm run smoketest` at 1280×620.

## The linter is narrow, and there is no formatter

ESLint 10 with typescript-eslint runs in CI ahead of the typecheck (roadmap M9),
but what it enforces is deliberately small: the rules that catch mistakes a type
checker cannot see — `eqeqeq`, `no-fallthrough`, no `any`, unused parameters, an
unawaited promise. `strict`, `noUnusedLocals`, `noUnusedParameters` and
`noFallthroughCasesInSwitch` were doing the heavy lifting before it and still
are; the linter found exactly one thing on its first run across the whole
codebase.

There is no formatter, and adding one would rewrite every file in the project in
a single commit. Layout is therefore by hand and by eye, and it is consistent
enough to describe: two-space indent, code lines under 100 columns bar eight of
them, and prose comments wrapped at 80 — measured across `src/` and `tests/`,
where the median comment line is 71 characters and the longest is 87.

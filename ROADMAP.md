# Roadmap

Where this project is going, and what is deliberately not being done. Ordered by
what would most change the thing's usefulness, not by what is easiest.

Status is honest: items marked **blocked** have been attempted or investigated
and the obstacle is named.

---

## M1 — Adaptive time-stepping

**The largest accuracy gap, and it is the step size rather than the integrator.**

The integrator is semi-implicit (symplectic) Euler — velocity is advanced first,
then position using the *new* velocity. That is a better starting point than the
name "Euler" suggests: it is symplectic, so energy oscillates within a bound
instead of growing, and orbits do not spiral apart. Measured over 1000 orbits at
r = 200, energy moved 0.017% and the radius stayed inside 198.2 – 201.8.

The problem is the **fixed step of `dt = 1`**. Orbital period scales as r^1.5, so
resolution collapses as orbits tighten — from 1005 steps per orbit at r = 400 to
5 at r = 12, where the orbit is destroyed outright. The full table is in
[`KNOWNISSUES.md`](KNOWNISSUES.md).

Planned, in order:

1. **Adaptive stepping** driven by the closest interacting pair, so a tight orbit
   or a near-miss gets sub-stepped instead of silently degrading. This is the fix
   that matters, and it is worth more than changing integrator.
2. **Velocity Verlet.** Second-order and still symplectic, at the same cost per
   step as the current scheme for a conservative force — one force evaluation, if
   accelerations are cached between steps. Cuts the phase error (currently
   ~0.066°/orbit at r = 200) rather than the energy error, which is already
   small.
3. **RK4** as an opt-in for comparison only. Fourth-order but *not* symplectic,
   so for long-running orbits it is not automatically better than Verlet —
   which is exactly why having all three, side by side, is more instructive than
   picking one and asserting it is best.

The deliverable is that comparison: identical initial conditions under each
scheme, plotting orbital radius and phase against time. That makes the
integrator choice visible instead of a README claim.

Caching accelerations across steps is what makes Verlet cheap, and it interacts
with the force-reset ordering — see the invariant in [`CLAUDE.md`](CLAUDE.md).

## M2 — Collisions and merging

Bodies currently pass straight through each other. The force is softened at
contact distance (see `Particle.attractionTo`), which keeps the simulation
finite, but "finite" is not "physical".

- Detect overlap, then merge: conserve mass and momentum, sum the areas for the
  new radius, and drop the absorbed body from the list.
- An inelastic-bounce mode as an alternative, since merging destroys the more
  interesting dynamics.
- The particle list UI needs to cope with bodies disappearing on their own,
  which it currently never does.

## M3 — Scale: Barnes–Hut

`PhysicsEngine.computeForces()` is O(n²) over particle pairs, and
`VectorField.calculateForceAt()` is O(n) per sample point over several thousand
sample points. Both are fine at the tens of bodies the UI encourages and neither
is fine at thousands.

A Barnes–Hut quadtree fixes both at once — the same tree answers "net force on
this body" and "field at this sample point" — taking the pair cost to O(n log n)
and the field cost to O(s log n). This is the prerequisite for anything
resembling a galaxy, which is the obvious next demo.

**Not started.** It should wait for M1, because changing the integrator and the
force approximation at the same time makes any accuracy regression impossible to
attribute.

## M4 — Save, load, and share

Nothing survives a refresh. Wanted:

- Serialize the scene (positions, velocities, masses, camera, render settings).
- Encode it into the URL fragment so a configuration can be linked directly.
  This is the feature that would make the live demo genuinely shareable — "here
  is a figure-eight three-body orbit" as a link.
- A small library of preset scenes: two-body, the figure-eight three-body
  solution, a Lagrange-point configuration, a slingshot.

Presets are cheap and would improve the demo's first thirty seconds more than
anything else on this list. Likely to land before M3.

## M5 — Making the field readable

The vector field draws direction and relative strength. It does not yet convey:

- **Absolute** magnitude. Arrow length is normalized against the range present
  in the current frame, so the picture is self-consistent but has no scale bar.
  A legend keyed to actual force values would fix it.
- **Equipotential contours**, which show orbital structure — Lagrange points,
  the Hill sphere — far better than an arrow grid does.
- **Streamlines** rather than discrete arrows, for a continuous read of the
  field.

The adaptive sampler's four fixed zones are also a crude proxy for "sample where
the field has structure". Sampling on the field's local gradient instead would
be both better looking and cheaper.

## M6 — Deliberately deferred

Recorded so the omissions read as decisions rather than oversights.

- **3D.** A genuinely different project: the camera, the picking, the field
  visualization and the renderer would all be replaced, and a 3D vector field is
  substantially harder to read than a 2D one. Not planned.
- **Relativistic corrections.** Precise, invisible at these scales, and would
  make the simulation slower and no more instructive.
- **Alternative force laws** (inverse-cube, spring). A one-line change to
  `attractionTo`, but every calibrated constant in the renderer and the field
  sampler assumes 1/r². Cheap to add, not cheap to make *look* right.
- **Mobile / touch support.** The interaction model is built on three mouse
  buttons, a wheel, and Ctrl. A touch version needs its own interaction design,
  not a polyfill. The page is usable but not good on a phone.
- **A physics-accuracy test against real ephemeris data.** Tempting, and it
  would mean little while M1 is outstanding: the fixed-step error would dominate
  any comparison.

## M7 — Housekeeping

- No linter. The project is small enough that TypeScript's `strict` plus
  `noUnusedLocals` has caught everything so far, but ESLint should go in before
  the codebase grows.
- `index.html` carries its styles and markup inline. Fine at this size; it
  should be split if the UI grows.
- The UI panels have no responsive behaviour and will overlap the canvas
  awkwardly below roughly 900 px of width. See
  [`KNOWNISSUES.md`](KNOWNISSUES.md).

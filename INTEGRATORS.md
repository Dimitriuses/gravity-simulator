# Integration

How the simulation advances time, what each scheme costs, and what each one gets
wrong. Roadmap M1.

Everything below is measured, and measured by running the same code the browser
runs: `npm run compare` loads `src/` through Vite and prints these tables. Rerun
it after touching anything in [`src/integrators.ts`](src/integrators.ts) and
paste the result back in.

---

## The three schemes

| scheme | order | symplectic | force evaluations per step |
|---|---|---|---|
| Symplectic Euler | 1st | yes | 1 |
| **Velocity Verlet** (default) | 2nd | yes | 1 |
| Runge-Kutta 4 | 4th | **no** | 4 |

Velocity Verlet is the default because it is a free upgrade. The acceleration it
computes to finish its velocity update is exactly the one the next step needs to
start its position update, so with that value carried across the step boundary
it costs **one force evaluation**, the same as Euler, for an order of accuracy
more. `tests/integrators.test.ts` counts the evaluations rather than trusting
the claim.

RK4 is offered for comparison rather than as the default. It is fourth-order and
it is the most accurate scheme here over a few hundred orbits — and it is not
symplectic, so its energy error accumulates in one direction forever while the
other two oscillate within a bound. Over a long enough run that is the error
that matters. The last table below is that argument in numbers.

## Adaptive sub-stepping

The step size, not the scheme, was the real accuracy gap. Orbital period scales
as r^1.5, so a fixed step of 1 resolves an orbit at r = 400 with 1,005 points
and one at r = 50 with 44.

Each frame is now sliced into as many sub-steps as the closest interacting pair
needs. Two timescales are computed for every pair and the smallest anywhere in
the system wins:

- **dynamical**, `sqrt(r³ / (G·(m₁ + m₂)))` — how quickly the pair's own gravity
  turns them;
- **crossing**, `r / |v₁ − v₂|` — how long they stay at this separation, which is
  what catches a fast flyby through a region where the dynamical time is long.

One sub-step is allowed to cover 1/16th of that, which puts roughly 2π·16 ≈ 100
sub-steps into the tightest orbit present whatever its radius. Separation is
clamped at contact distance to match the softening in the force law: below
contact the force stops growing, so the timescale must stop shrinking, or two
overlapping bodies would ask for an unbounded number of sub-steps. The count is
capped at 64 per frame regardless, and the UI reports what was used.

**It costs nothing when it is not needed.** Every scene in the preset list runs
at one sub-step per frame; the readout only moves when something genuinely tight
turns up.

## There is a floor on how badly an orbit can be resolved

A satellite cannot orbit closer than the primary's own radius, and `Particle`
derives radius from mass as `2·m^(1/3)`. Put those together with the softening
floor and the tightest *physical* circular orbit works out at about **25 steps
per orbit**, whatever the masses — the mass cancels.

This corrects an earlier claim. [`KNOWNISSUES.md`](KNOWNISSUES.md) used to
report a radius-12 orbit around a mass-5000 primary wandering between 17.6 and
327.6 units, presented as the fixed step destroying an orbit. That primary is
34.2 units in radius, so radius 12 is *inside* it: what that row measured was
mostly the softened force law, not the step size. The two rows above it are the
honest ones, and r = 50 — 44 steps per orbit, just outside contact — is the
tightest case a real orbit can present.

---

## Accuracy by scheme, on a circular orbit

Mass-5000 primary, negligible satellite, 100 orbits, `dt = 1`, adaptive
stepping **off** so this is the scheme alone.

| orbit radius | steps/orbit | scheme | radius stays within | spread | energy drift | phase error/orbit |
|---:|---:|---|---|---:|---:|---:|
| 400 | 1005 | Symplectic Euler | 398.8 – 401.3 | 0.63% | 0.0000% | -0.010° |
| 400 | 1005 | Velocity Verlet | 400.0 – 400.0 | 0.00% | 0.0000% | -0.005° |
| 400 | 1005 | Runge-Kutta 4 | 400.0 – 400.0 | 0.00% | 0.0000% | 0.000° |
| 200 | 355 | Symplectic Euler | 198.3 – 201.8 | 1.77% | 0.0001% | -0.080° |
| 200 | 355 | Velocity Verlet | 200.0 – 200.0 | 0.02% | 0.0000% | -0.038° |
| 200 | 355 | Runge-Kutta 4 | 200.0 – 200.0 | 0.00% | 0.0000% | 0.000° |
| 100 | 126 | Symplectic Euler | 97.6 – 102.6 | 5.00% | 0.0297% | -0.631° |
| 100 | 126 | Velocity Verlet | 100.0 – 100.1 | 0.12% | 0.0000% | -0.300° |
| 100 | 126 | Runge-Kutta 4 | 100.0 – 100.0 | 0.00% | 0.0005% | 0.002° |
| 50 | 44 | Symplectic Euler | 47.0 – 54.0 | 14.18% | 0.1275% | -1.433° |
| 50 | 44 | Velocity Verlet | 50.0 – 50.5 | 1.00% | 0.0029% | 1.218° |
| 50 | 44 | Runge-Kutta 4 | 49.9 – 50.0 | 0.10% | 0.0997% | 0.272° |

## What adaptive stepping adds

The same orbits, velocity Verlet throughout, with and without sub-stepping.

| orbit radius | steps/orbit | fixed step: spread | adaptive: spread | sub-steps used |
|---:|---:|---:|---:|---:|
| 400 | 1005 | 0.00% | 0.00% | 1 |
| 200 | 355 | 0.02% | 0.02% | 1 |
| 100 | 126 | 0.12% | 0.12% | 1 |
| 50 | 44 | 1.00% | 0.11% | 3 |

## The tightest orbit that is still an orbit

A satellite cannot circle closer than the primary's own radius, and below
that the force law softens, so there is a floor on how badly a *physical*
orbit can be under-resolved: about 25 steps per orbit, whatever the masses.
A mass-1000 primary has a radius of 20 units, so an orbit at 25 units is
close to that floor.

| scheme | adaptive | radius stays within | spread | phase error/orbit | sub-steps |
|---|---|---|---:|---:|---:|
| Symplectic Euler | off | 23.2 – 27.6 | 17.97% | -0.65° | 1 |
| Symplectic Euler | on | 24.4 – 25.6 | 5.14% | -0.73° | 4 |
| Velocity Verlet | off | 25.0 – 25.4 | 1.59% | -0.19° | 1 |
| Velocity Verlet | on | 25.0 – 25.0 | 0.18% | -0.43° | 3 |
| Runge-Kutta 4 | off | 24.9 – 25.0 | 0.33% | 0.89° | 1 |
| Runge-Kutta 4 | on | 25.0 – 25.0 | 0.00% | 0.00° | 3 |

## Long run: is it symplectic?

This is the reason RK4 is offered for comparison rather than as the
default. A symplectic scheme trades energy back and forth within a bound,
so its error stops growing; a non-symplectic one accumulates in one
direction however high its order. Measured at r = 50 — 44 steps per orbit,
coarse enough for the difference to be visible inside a few hundred orbits.

Each cell is the **total** energy excursion up to that point — the widest
the orbit's energy ever got from where it started. A bounded scheme stops
growing; RK4 keeps going.

| scheme | by 100 orbits | by 500 | by 1,000 | radius over 1,000 orbits |
|---|---:|---:|---:|---|
| Symplectic Euler | 2.0096% | 2.0096% | 2.0096% | 47.0 – 54.0 |
| Velocity Verlet | 0.0097% | 0.0097% | 0.0097% | 50.0 – 50.5 |
| Runge-Kutta 4 | 0.0997% | 0.5086% | 1.0444% | 49.5 – 50.0 |

---

## Reading these numbers

**Radius spread** is the width of the band the orbit's radius wandered over —
the visible symptom, a circle that breathes. **Energy drift** is what says
whether the scheme is stable in the long run. **Phase error** is where the body
sits *along* its orbit compared to where Kepler says it should be; it
accumulates even when the orbit's shape is perfect, and it is the error that
survives everything else.

Two details worth knowing before trusting the phase column: the satellite has
mass, so the ideal orbit uses `G·(M + m)` and both bodies move about their
common barycentre. An earlier version of this harness used `G·M` with a fixed
primary, which biased every scheme's phase by about 0.14°/orbit — enough to hide
what RK4 was actually doing at a well-resolved radius.

## What is still open

Adaptive stepping is global: one pair in a tight encounter sub-steps the entire
system, including bodies that did not need it. Per-body or block time-stepping
would confine the cost to the bodies that earn it, and is the obvious next move
if a scene ever has enough bodies for it to matter. See
[`ROADMAP.md`](ROADMAP.md).

# Integration

How the simulation advances time, what each scheme costs, and what each one gets
wrong. Roadmap M1.

Everything below is measured, and measured by running the same code the browser
runs: `npm run compare` loads `src/` through Vite and prints these tables. Rerun
it after touching anything in [`src/integrators.ts`](src/integrators.ts) and
paste the result back in.

---

## The four schemes

| scheme | order | symplectic | force evaluations per step |
|---|---|---|---|
| Symplectic Euler | 1st | yes | 1 |
| **Velocity Verlet** (default) | 2nd | yes | 1 |
| Runge-Kutta 4 | 4th | **no** | 4 |
| Forest-Ruth | 4th | yes | 3 |

Velocity Verlet is the default because it is a free upgrade. The acceleration it
computes to finish its velocity update is exactly the one the next step needs to
start its position update, so with that value carried across the step boundary
it costs **one force evaluation**, the same as Euler, for an order of accuracy
more. `tests/integrators.test.ts` counts the evaluations rather than trusting
the claim.

RK4 is offered for comparison rather than as the default. It is fourth-order —
and it is not symplectic, so its energy error accumulates in one direction
forever while the others oscillate within a bound. Over a long enough run that
is the error that matters.

Forest-Ruth (roadmap M18) is both: fourth order *and* symplectic, for three
evaluations rather than RK4's four. It is three velocity Verlet steps of
`w₁·dt`, `w₀·dt`, `w₁·dt` with `w₁ = 1/(2 − ∛2)` and `w₀ = −∛2/(2 − ∛2)` — the
middle one runs backwards, which is what cancels the second-order error, and the
three weights sum to one so a step still advances time by `dt`. It is not the
default because a step costs three times what Verlet's does, and an interactive
frame is bound by cost rather than by accuracy; it is the scheme to choose when
the answer matters more than the frame rate.

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

## Accuracy by scheme, on a circular orbit

Mass-5000 primary, negligible satellite, 100 orbits, `dt = 1`, adaptive
stepping **off** so this is the scheme alone.

| orbit radius | steps/orbit | scheme | radius stays within | spread | energy drift | phase error/orbit |
|---:|---:|---|---|---:|---:|---:|
| 400 | 1005 | Symplectic Euler | 398.8 – 401.3 | 0.63% | 0.0000% | -0.010° |
| 400 | 1005 | Velocity Verlet | 400.0 – 400.0 | 0.00% | 0.0000% | -0.005° |
| 400 | 1005 | Runge-Kutta 4 | 400.0 – 400.0 | 0.00% | 0.0000% | 0.000° |
| 400 | 1005 | Forest-Ruth | 400.0 – 400.0 | 0.00% | 0.0000% | 0.000° |
| 200 | 355 | Symplectic Euler | 198.3 – 201.8 | 1.77% | 0.0001% | -0.080° |
| 200 | 355 | Velocity Verlet | 200.0 – 200.0 | 0.02% | 0.0000% | -0.038° |
| 200 | 355 | Runge-Kutta 4 | 200.0 – 200.0 | 0.00% | 0.0000% | 0.000° |
| 200 | 355 | Forest-Ruth | 200.0 – 200.0 | 0.00% | 0.0000% | 0.000° |
| 100 | 126 | Symplectic Euler | 97.6 – 102.6 | 5.00% | 0.0297% | -0.631° |
| 100 | 126 | Velocity Verlet | 100.0 – 100.1 | 0.12% | 0.0000% | -0.300° |
| 100 | 126 | Runge-Kutta 4 | 100.0 – 100.0 | 0.00% | 0.0005% | 0.002° |
| 100 | 126 | Forest-Ruth | 100.0 – 100.0 | 0.00% | 0.0000% | 0.002° |
| 50 | 44 | Symplectic Euler | 47.0 – 54.0 | 14.18% | 0.1275% | -1.433° |
| 50 | 44 | Velocity Verlet | 50.0 – 50.5 | 1.00% | 0.0029% | 1.218° |
| 50 | 44 | Runge-Kutta 4 | 49.9 – 50.0 | 0.10% | 0.0997% | 0.272° |
| 50 | 44 | Forest-Ruth | 50.0 – 50.0 | 0.04% | 0.0000% | 0.134° |

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
| Forest-Ruth | off | 25.0 – 25.0 | 0.11% | 0.35° | 1 |
| Forest-Ruth | on | 25.0 – 25.0 | 0.00% | 0.00° | 3 |

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
| Forest-Ruth | 0.0000% | 0.0000% | 0.0000% | 50.0 – 50.0 |

## Bounded energy error is not accuracy

The tables above measure phase error against Kepler over a few hundred orbits,
which is the right test for the schemes and understates how badly the difference
between them can bite. Roadmap M8 ran into the sharp version of it.

Sun and Mercury alone is a two-body problem, so its perihelion does not move at
all — not approximately, exactly. Measured over a decade of simulated time, with
each scheme asked what it thinks the perihelion did:

| step, in days | velocity Verlet | RK4 | Forest-Ruth |
|---:|---:|---:|---:|
| 0.184 | -26,823″ per century | +1.58″ | +48.78″ |
| 0.092 | -6,707″ | +0.10″ | +3.05″ |
| 0.046 | -1,677″ | +0.01″ | +0.19″ |
| 0.023 | -419″ | +0.00″ | +0.01″ |

Verlet's invention falls by exactly 4x per halving, as a second-order scheme's
should. It is also, at the third row, three times the size of the real effect
that run was trying to measure, pointing the other way — while conserving energy
to a part in 10⁹ the whole time. The two fourth-order schemes fall by 16, as
theirs should, and both are negligible against the 545″ being measured.

That is the honest shape of the trade this page opens with, and until roadmap
M18 it had no third answer: Verlet's bounded energy error keeps a drawn orbit
closed and says nothing about which way the ellipse is pointing, while RK4 gets
the pointing right and lets energy accumulate. **Forest-Ruth is both**, and the
cost of that is three force evaluations a step rather than one.

At equal cost the comparison is not close. Over 121 orbits of an eccentric
two-body problem, at 180,000 force evaluations each:

| | precession invented | worst energy error |
|---|---:|---:|
| Velocity Verlet, at a third of the step | 0.222° | 4.6e-6 |
| Forest-Ruth, at the full step | **0.0033°** | **1.8e-8** |

So: watch simulations with Verlet, because an interactive frame is bound by cost
and a closed orbit is all the eye asks for. Measure them with Forest-Ruth, and
check any long-run measurement against a case whose answer is known.
[`EPHEMERIS.md`](EPHEMERIS.md) is that argument in full — and keeps RK4 for its
own published run, because on that particular problem RK4's error constant is
the smaller of the two fourth-order schemes and a four-minute measurement can
afford the extra evaluation.

## What is still open

Adaptive stepping is global: one pair in a tight encounter sub-steps the entire
system, including bodies that did not need it. Per-body or block time-stepping
would confine the cost to the bodies that earn it, and roadmap M15 measured what
that would be worth before building it — every scene the app ships takes a
single sub-step and wastes nothing, so it was declined with the numbers rather
than done. [`SCALING.md`](SCALING.md) has them.

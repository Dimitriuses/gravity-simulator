# Scaling

What happens as the body count grows, and what the Barnes-Hut quadtree does
about it. Roadmap M3.

Everything below is measured by `npm run bench`, which loads `src/` through Vite
and times the same code the browser runs. Rerun it after touching
[`src/quadtree.ts`](src/quadtree.ts) and paste the result back in.

---

## The problem

Two things were quadratic, and only one of them was obvious:

- **Forces.** Every body pulls on every other, so a step is O(n²) pairs.
- **The field.** The visible region is sampled at up to 12,000 points and every
  sample summed over every particle — O(s·n), and `s` does not shrink as `n`
  grows, which makes this the more expensive half in practice.

Two more turned up while fixing those, both introduced by earlier milestones:

- **Contact detection** (M2) tested every pair.
- **The adaptive step rule** (M1) looks for the closest interacting pair, which
  is a minimum over every pair. At 2,048 bodies it cost more than everything
  else in a frame put together.

## What the tree does

A quadtree over the bodies, with each cell carrying the total mass and centre of
mass of everything beneath it. A cell can stand in for its contents when it is
far enough away that its width over its distance is below `theta`; otherwise it
is opened and its children considered in turn. One query costs about log n
instead of n, and the same tree answers all four questions above.

**Theta = 0 makes it exact.** No cell ever passes the test, so every query walks
down to individual bodies and the result is the direct sum to the last bit. That
is what the tests check the traversal against.

The two searches that are not force sums are not approximations at all:

- **Contact detection** asks each body for the bodies near enough to touch it.
  Each cell knows the largest body radius beneath it, so a branch is discarded
  when even its widest member could not reach. Same pairs as the linear scan.
- **The step rule** is a branch-and-bound search for the shortest interaction
  timescale: a cell is skipped when even its heaviest and fastest member, placed
  at the cell's nearest edge, could not beat the best pair found so far. Both
  are upper bounds on what a cell can hold, so nothing that could win is ever
  skipped — it returns exactly what the scan returns.

## What it costs

Barnes-Hut is **not symmetric**. Body A may be close enough to see B
individually while B is far enough to see A only as part of a cell, so their
forces are not equal and opposite and total momentum is no longer conserved to
machine precision. Measured over 200 steps on a 200-body disc, momentum drifts
by under 1% of the system's total scalar momentum, against zero to machine
precision for the exact sum.

That is the reason the exact solver stays the default below **128 bodies**,
which is roughly where the scenes the interface encourages end and the scenes
the tree is for begin. It is not a speed threshold — the tree is already faster
at 64 bodies — it is a promise about exactness in the scenes small enough to
keep it.

---

## One force evaluation

A disc of bodies on circular orbits around a heavy centre. `exact` is the
pairwise sum, `tree` is Barnes-Hut at theta = 0.5 including the cost of
building the tree, which is rebuilt from scratch every evaluation.

| bodies | exact | tree | speed-up |
|---:|---:|---:|---:|
| 64 | 0.53 ms | 0.41 ms | 1.28x |
| 128 | 1.47 ms | 0.86 ms | 1.70x |
| 256 | 4.98 ms | 1.26 ms | 3.96x |
| 512 | 20.2 ms | 3.10 ms | 6.51x |
| 1024 | 72.4 ms | 7.33 ms | 9.88x |
| 2048 | 290.4 ms | 17.1 ms | 17.00x |

## One field rebuild

The field samples the visible region at up to 12,000 points, and every
sample used to walk every particle. This is the half of the frame the tree
helps most, because the sample count does not fall as bodies are added.

| bodies | exact | tree | speed-up | samples |
|---:|---:|---:|---:|---:|
| 64 | 9.41 ms | 5.75 ms | 1.64x | 3203 |
| 128 | 26.9 ms | 12.9 ms | 2.09x | 6164 |
| 256 | 78.3 ms | 29.4 ms | 2.66x | 10063 |
| 512 | 165.0 ms | 58.7 ms | 2.81x | 11999 |
| 1024 | 316.2 ms | 85.5 ms | 3.70x | 11999 |
| 2048 | 615.8 ms | 130.0 ms | 4.74x | 12000 |

## What each field mode costs

The same scene drawn five ways, over the whole visible region. `drawn`
is what the mode produced: arrows for the three arrow modes, line
segments for contours, integration steps for streamlines.

The point of the gradient mode is the last column. The zone-based mode
asks for four rings of samples per *body*, so its count runs to the cap and
gets truncated; the gradient mode asks the field where it changes. Its
count still grows with the body count — more bodies really is more
structure — but far more slowly, and it never has to be truncated.

| bodies | mode | time | drawn |
|---:|---|---:|---:|
| 3 | gradient | 0.29 ms | 417 |
| 3 | adaptive | 2.06 ms | 1166 |
| 3 | uniform | 1.59 ms | 467 |
| 3 | contours | 3.61 ms | 1444 |
| 3 | streamlines | 1.97 ms | 286 |
| 64 | gradient | 7.54 ms | 3203 |
| 64 | adaptive | 35.3 ms | 9828 |
| 64 | uniform | 8.71 ms | 2468 |
| 64 | contours | 5.55 ms | 1443 |
| 64 | streamlines | 9.11 ms | 1844 |
| 300 | gradient | 35.3 ms | 11260 |
| 300 | adaptive | 39.3 ms | 12000 |
| 300 | uniform | 13.4 ms | 6167 |
| 300 | contours | 17.8 ms | 1445 |
| 300 | streamlines | 12.6 ms | 2258 |

## Where the rest of a frame goes

Forces are not the only thing that was quadratic. Contact detection tests
every pair, and so does the adaptive step rule, which looks for the closest
interacting pair in the system. Both are listed here at their tree-backed
cost where they have one.

| bodies | contact scan | contact via tree | step rule: scan | step rule: tree |
|---:|---:|---:|---:|---:|
| 64 | 0.37 ms | 0.28 ms | 1.00 ms | 0.81 ms |
| 128 | 0.34 ms | 0.19 ms | 1.11 ms | 0.47 ms |
| 256 | 0.39 ms | 0.36 ms | 3.69 ms | 1.07 ms |
| 512 | 2.09 ms | 0.66 ms | 15.0 ms | 3.21 ms |
| 1024 | 8.59 ms | 1.40 ms | 61.7 ms | 8.92 ms |
| 2048 | 36.8 ms | 3.32 ms | 243.6 ms | 29.8 ms |

## A whole frame

`step()` and `updateField()` together, which is what one animation frame
costs. 16.7 ms is the budget at 60fps. The sub-step column matters when
reading these: a frame pays for the force evaluation once per sub-step, so
a scene the step rule wants sliced four ways costs four force passes.

This is measured over the *whole* visible region at a 300-unit field range,
which is the most expensive thing the controls can ask for — 12,000 samples.

| bodies | exact | tree | sub-steps |
|---:|---:|---:|---:|
| 64 | 12.2 ms | 5.79 ms | 2 |
| 128 | 36.3 ms | 15.6 ms | 3 |
| 256 | 111.7 ms | 34.8 ms | 3 |
| 512 | 284.3 ms | 71.9 ms | 3 |
| 1024 | 726.0 ms | 130.2 ms | 3 |
| 2048 | 2252.7 ms | 243.9 ms | 3 |

## What the approximation costs

Force error against the exact sum, on the same disc. Median is against each
body's own acceleration; the worst case is against the mean acceleration in
the system, because a body whose pulls nearly cancel has a near-zero
denominator and its own relative error reads far larger than the absolute
error justifies.

| bodies | theta | median error | worst vs mean |
|---:|---:|---:|---:|
| 256 | 0.3 | 0.006% | 0.015% |
| 256 | 0.5 | 0.025% | 0.066% |
| 256 | 0.7 | 0.060% | 0.220% |
| 256 | 1 | 0.181% | 1.725% |
| 2048 | 0.3 | 0.059% | 0.367% |
| 2048 | 0.5 | 0.211% | 1.102% |
| 2048 | 0.7 | 0.498% | 6.959% |
| 2048 | 1 | 1.350% | 78.962% |

---

## Where this leaves things

At a few hundred bodies the browser holds the display's own 60fps on the Galaxy
preset, measured in headless Chromium at 1280x800, where before roadmap M7 it
held 35 and before the tree, 12. Almost none of what remains is drawing.

Three things are worth knowing about the numbers above:

**The field's cost is sample-bound, not body-bound**, and the sampling policy is
what decides it. The gradient mode (roadmap M5) is the answer to that: it asks
the field where it changes instead of laying rings around every body, and spends
a third of the samples on a small scene for a picture that still reaches every
body. It does not repeal the problem — three hundred bodies really is more
structure, and by then it too is at the cap — but it moves the wall a long way,
and the Galaxy preset is the scene that still cannot afford any of them.

**Contours are no longer the most expensive mode**, and getting them there took
two changes rather than the one the roadmap expected. The grid now thins out:
a coarse pass finds which cells a level actually crosses and only those are
sampled at full resolution, which on this scene is 4,100 evaluations instead of
5,278. The larger half was the marching itself, which walked all 5,130 cells
once per level and threw away 98% of the answers — twelve passes to draw twelve
lines. One walk, touching only the levels a cell's own corners straddle, cut a
two-body trace from 4.62 ms to 2.59 and the mode as a whole from 24.3 ms to 17.8
at three hundred bodies, and from 7.05 ms to 2.95 on a small scene, with the
same lines coming out of it.

**The step rule was the least improved, and now is not.** Branch and bound —
each body against the tree — cut it by 3.5x rather than by an order of
magnitude, because the bound is weak exactly when it matters: the answer being
searched for is the shortest timescale in the system, so almost nothing can be
excluded on the grounds of being slower than it. Comparing *cells against
cells* rejects a whole block of pairs on one test where the old traversal
rejected one body's share of them and had to re-derive the bound for the next
body. Measured on the same scenes, the search itself went from 67.1 ms to 34.0
at two thousand bodies, and the win over the pairwise scan from 3.5x to 8.2x.

**Drawing is not the wall, and the thing that was is now gone.** The galaxy
preset ran at 35fps with a frame that profiled as 85% *field sampling* — on a
scene that ships with the field overlay switched off, because it cannot afford
it. `updateField()` ran every frame regardless of whether anything was going to
draw the result. Skipping it when the overlay is hidden took the preset from 29
ms a frame to 16.9, which is the vsync interval: it is now capped by the
display rather than by the work.

What is left of drawing was measured the same way, by profiling a paused frame:
about **1.1 ms** of it at 211 bodies, some 7%, against 79% idle. The glow pass
this list proposed removing is roughly half of that. It stays — a change that
alters the picture to win half a millisecond in a frame with 13 to spare is not
a trade worth making, and now there is a number to say so rather than an
assumption.

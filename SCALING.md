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
| 64 | 0.53 ms | 0.46 ms | 1.16x |
| 128 | 1.83 ms | 0.90 ms | 2.03x |
| 256 | 5.25 ms | 1.48 ms | 3.54x |
| 512 | 20.5 ms | 3.50 ms | 5.85x |
| 1024 | 81.0 ms | 7.99 ms | 10.14x |
| 2048 | 334.6 ms | 19.6 ms | 17.12x |

## One field rebuild

The field samples the visible region at up to 12,000 points, and every
sample used to walk every particle. This is the half of the frame the tree
helps most, because the sample count does not fall as bodies are added.

| bodies | exact | tree | speed-up | samples |
|---:|---:|---:|---:|---:|
| 64 | 11.5 ms | 6.75 ms | 1.71x | 3203 |
| 128 | 28.8 ms | 14.8 ms | 1.95x | 6164 |
| 256 | 89.8 ms | 34.7 ms | 2.59x | 10063 |
| 512 | 244.8 ms | 59.6 ms | 4.11x | 11999 |
| 1024 | 484.1 ms | 93.9 ms | 5.15x | 11999 |
| 2048 | 957.8 ms | 144.7 ms | 6.62x | 12000 |

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
| 3 | gradient | 0.31 ms | 417 |
| 3 | adaptive | 2.62 ms | 1166 |
| 3 | uniform | 1.65 ms | 467 |
| 3 | contours | 5.34 ms | 1444 |
| 3 | streamlines | 2.84 ms | 286 |
| 64 | gradient | 11.4 ms | 3203 |
| 64 | adaptive | 40.0 ms | 9828 |
| 64 | uniform | 10.7 ms | 2468 |
| 64 | contours | 4.79 ms | 1443 |
| 64 | streamlines | 11.5 ms | 1844 |
| 300 | gradient | 39.1 ms | 11260 |
| 300 | adaptive | 40.1 ms | 12000 |
| 300 | uniform | 14.4 ms | 6167 |
| 300 | contours | 18.8 ms | 1445 |
| 300 | streamlines | 13.5 ms | 2258 |

## Where the rest of a frame goes

Forces are not the only thing that was quadratic. Contact detection tests
every pair, and so does the adaptive step rule, which looks for the closest
interacting pair in the system. Both are listed here at their tree-backed
cost where they have one.

| bodies | contact scan | contact via tree | step rule: scan | step rule: tree |
|---:|---:|---:|---:|---:|
| 64 | 0.38 ms | 0.30 ms | 1.03 ms | 0.75 ms |
| 128 | 0.74 ms | 0.20 ms | 1.89 ms | 0.49 ms |
| 256 | 0.40 ms | 0.39 ms | 4.12 ms | 1.16 ms |
| 512 | 2.22 ms | 0.70 ms | 17.0 ms | 3.42 ms |
| 1024 | 8.29 ms | 1.59 ms | 67.5 ms | 10.8 ms |
| 2048 | 39.6 ms | 4.13 ms | 273.0 ms | 31.4 ms |

## Who is paying for the sub-steps

Sub-stepping is global: the rule finds the shortest interaction timescale
anywhere in the system and slices the frame finely enough for *that* pair,
then every body takes every sub-step. This asks what each body would have
needed on its own — the same arithmetic, over only the pairs that body is
actually in — and compares the two.

`global` is the sub-steps the engine takes. `needed` is the median and the
maximum over the bodies. `wasted` is the fraction of body-steps spent on
bodies that did not need them: 1 - (sum of what each body needed) / (bodies
x global). It is the ceiling on what per-body stepping could save on the
force pass, before any of the cost of arranging it.

| scene | bodies | global | needed, median | needed, max | wasted |
|---|---:|---:|---:|---:|---:|
| Binary | 2 | 1 | 1 | 1 | 0.0% |
| Star and planets | 3 | 1 | 1 | 1 | 0.0% |
| Figure eight | 3 | 1 | 1 | 1 | 0.0% |
| Comet | 2 | 1 | 1 | 1 | 0.0% |
| Lagrange points | 4 | 1 | 1 | 1 | 0.0% |
| Solar System (J2000) | 9 | 1 | 1 | 1 | 0.0% |
| Galaxy | 300 | 3 | 1 | 3 | 64.9% |
| Slingshot | 2 | 1 | 1 | 1 | 0.0% |
| galaxy, 2048 bodies | 2048 | 3 | 1 | 3 | 56.1% |
| the same, plus one tight pair | 302 | 10 | 1 | 10 | 88.3% |

And what that ceiling is worth in milliseconds. `1 sub-step` is the same
frame with adaptive stepping switched off, so the difference between the two
columns is the entire cost of sub-stepping — of which per-body stepping could
recover the fraction in the table above, less whatever arranging it costs.

| bodies | adaptive | 1 sub-step | sub-stepping costs | ceiling on the saving |
|---:|---:|---:|---:|---:|
| 300 | 7.44 ms | 2.00 ms | 5.44 ms | 3.53 ms |
| 2048 | 115.3 ms | 28.0 ms | 87.3 ms | 49.0 ms |

## A whole frame

`step()` and `updateField()` together, which is what one animation frame
costs. 16.7 ms is the budget at 60fps. The sub-step column matters when
reading these: a frame pays for the force evaluation once per sub-step, so
a scene the step rule wants sliced four ways costs four force passes.

This is measured over the *whole* visible region at a 300-unit field range,
which is the most expensive thing the controls can ask for — 12,000 samples.

| bodies | exact | tree | sub-steps |
|---:|---:|---:|---:|
| 64 | 12.7 ms | 6.54 ms | 2 |
| 128 | 45.2 ms | 16.4 ms | 3 |
| 256 | 143.2 ms | 38.3 ms | 3 |
| 512 | 397.1 ms | 77.2 ms | 3 |
| 1024 | 1170.7 ms | 136.2 ms | 3 |
| 2048 | 3474.4 ms | 262.9 ms | 3 |

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

**Sub-stepping is global, and most of it is paid for by bodies that did not ask
for it** — but the bill is small where it can be seen. Every scene the interface
offers takes *one* sub-step, so on eight of the ten scenes measured above
per-body stepping would save exactly nothing. On the Galaxy preset the rule asks
for three, the median body needs one, and 65% of the body-steps are waste: 3.5 ms
of a frame that has seven to spare. At two thousand bodies the same waste is
worth 49 ms, which is real, and it is a scene the app does not offer and could
not draw at an interactive rate anyway.

The case where it bites is a scene with one tight pair in it: a hundred-fold
difference in timescale between the closest pair and everything else takes the
count to ten and the waste to 88%. That is reachable — drop a pile of bodies in
bounce mode and it stays that way — and it is the argument for roadmap M15, held
against the three contracts per-body stepping would break. See M15 for why it is
measured and not built.

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

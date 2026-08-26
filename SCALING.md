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
| 64 | 0.87 ms | 0.46 ms | 1.89x |
| 128 | 2.09 ms | 0.92 ms | 2.26x |
| 256 | 5.21 ms | 1.40 ms | 3.72x |
| 512 | 20.9 ms | 3.44 ms | 6.07x |
| 1024 | 78.1 ms | 8.03 ms | 9.72x |
| 2048 | 325.3 ms | 19.9 ms | 16.39x |

## One field rebuild

The field samples the visible region at up to 12,000 points, and every
sample used to walk every particle. This is the half of the frame the tree
helps most, because the sample count does not fall as bodies are added.

| bodies | exact | tree | speed-up | samples |
|---:|---:|---:|---:|---:|
| 64 | 42.6 ms | 35.8 ms | 1.19x | 9828 |
| 128 | 68.3 ms | 38.6 ms | 1.77x | 12000 |
| 256 | 89.9 ms | 41.8 ms | 2.15x | 12000 |
| 512 | 152.5 ms | 53.5 ms | 2.85x | 12000 |
| 1024 | 289.9 ms | 75.5 ms | 3.84x | 12000 |
| 2048 | 560.5 ms | 117.4 ms | 4.78x | 12000 |

## Where the rest of a frame goes

Forces are not the only thing that was quadratic. Contact detection tests
every pair, and so does the adaptive step rule, which looks for the closest
interacting pair in the system. Both are listed here at their tree-backed
cost where they have one.

| bodies | contact scan | contact via tree | step rule: scan | step rule: tree |
|---:|---:|---:|---:|---:|
| 64 | 0.32 ms | 0.28 ms | 0.98 ms | 0.90 ms |
| 128 | 0.66 ms | 0.31 ms | 1.39 ms | 1.31 ms |
| 256 | 2.61 ms | 1.86 ms | 5.80 ms | 2.50 ms |
| 512 | 2.74 ms | 1.38 ms | 21.2 ms | 6.69 ms |
| 1024 | 9.60 ms | 1.52 ms | 64.4 ms | 19.7 ms |
| 2048 | 36.7 ms | 3.97 ms | 267.0 ms | 73.7 ms |

## A whole frame

`step()` and `updateField()` together, which is what one animation frame
costs. 16.7 ms is the budget at 60fps. The sub-step column matters when
reading these: a frame pays for the force evaluation once per sub-step, so
a scene the step rule wants sliced four ways costs four force passes.

This is measured over the *whole* visible region at a 300-unit field range,
which is the most expensive thing the controls can ask for — 12,000 samples.

| bodies | exact | tree | sub-steps |
|---:|---:|---:|---:|
| 64 | 38.7 ms | 31.0 ms | 2 |
| 128 | 73.4 ms | 43.4 ms | 3 |
| 256 | 137.2 ms | 61.9 ms | 3 |
| 512 | 253.7 ms | 81.5 ms | 3 |
| 1024 | 630.5 ms | 131.6 ms | 3 |
| 2048 | 1801.6 ms | 251.8 ms | 3 |

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

At a few hundred bodies the browser holds 30fps with the tree and 12fps without
it, on the same scene — the Galaxy preset, measured in headless Chromium at
1280x800. Roughly half of what remains is drawing rather than physics.

Three things are worth knowing about the numbers above:

**The field's cost is now sample-bound, not body-bound.** 12,000 samples cost
tens of milliseconds however few bodies there are, because that is 12,000 tree
queries. The sample cap was chosen when the field was the only thing on screen;
a scene with hundreds of bodies wants far fewer arrows, not more, and the Galaxy
preset turns the field off for that reason. The fix is a sampling policy rather
than a faster query — roadmap M5.

**The step rule is the least improved.** Branch and bound cuts it by about 3.5x,
not by an order of magnitude, because the bound is weak exactly when it matters:
the answer being searched for is the shortest timescale in the system, so almost
nothing can be excluded on the grounds of being slower than it. A dual-tree
traversal — comparing cells against cells rather than bodies against cells —
would prune far better. Roadmap M7.

**Drawing is now a real share of the frame.** Hundreds of bodies means hundreds
of circles, and p5 charges for every `fill()` and `stroke()`. Batching those
into one pass per layer took 400 bodies from 83 ms a frame to 22 ms; the next
thing to go would be the glow pass. Roadmap M7.

# Known issues

Measured, reproducible limitations of the current build. Anything here is known
and either scheduled in [`ROADMAP.md`](ROADMAP.md) or deliberately accepted.

---

## Accuracy collapses on tight orbits

**The one that actually bites.** The integrator runs at a fixed step of
`dt = 1`, so how well an orbit is resolved depends entirely on how many steps
fit into one period — and period scales as r^1.5. A wide orbit gets thousands of
steps; a tight one gets a handful.

Measured with a mass-5000 primary, a negligible satellite on a circular orbit at
radius `r`, over 50 orbits:

| orbit radius | steps per orbit | radius stays within | phase error per orbit |
|---:|---:|---|---:|
| 400 | 1005 | 398.7 – 401.2 (0.6%) | 0.13° |
| 200 | 355 | 198.2 – 201.8 (1.8%) | 0.07° |
| 100 | 126 | 97.6 – 102.6 (5.0%) | −0.50° |
| 50 | 44 | 47.0 – 54.0 (14%) | 2.52° |
| 25 | 16 | 24.7 – 46.4 (86%) | −2.17° |
| 12 | 5 | 17.6 – 327.6 (2583%) | 3.09° |

Below roughly 50 world units of separation the orbit visibly deforms; below 25
it is not a meaningful simulation at all. **Keep orbits above ~100 units for
results you can trust.** Adaptive time-stepping is M1 in the roadmap.

## The integrator is first-order, but it is symplectic

Worth stating precisely, because "Euler" usually implies worse than this is.
`Particle.update()` advances velocity first and then uses the *new* velocity to
advance position — semi-implicit (symplectic) Euler, not explicit Euler. The
consequence is that energy oscillates within a bound rather than growing without
limit, so orbits do not spiral apart.

Measured on a circular orbit at r = 200 over **1000 orbits** (355,000 steps):

- radius stayed within 198.2 – 201.8
- specific orbital energy varied by 0.031%, ending 0.017% from where it started
- the orbit precessed 65.7° in total — about 0.066° per orbit

So the error shows up as **phase**, not as energy: bodies end up in the right
orbit at the wrong place along it. That is the expected first-order behaviour and
it is why the tests assert momentum conservation but not energy conservation.

## Bodies pass through each other

There is no collision detection. Gravity is softened at contact distance — the
force is capped at its surface value rather than diverging as r → 0 — which
keeps the simulation numerically finite, but two bodies aimed at each other will
overlap, swing through, and fly apart. Roadmap M2.

## Arrow length is relative, not absolute

Both the field arrows and the per-particle force/velocity arrows map magnitude
logarithmically onto a fixed length band, normalized against the range present
in the *current frame*. This is what keeps them legible across the ~10⁶ range of
forces the mass and distance sliders can produce.

The consequence: arrow length compares bodies against each other **within one
frame**, and cannot be compared between frames or read as an absolute value.
There is no scale bar. Roadmap M5.

## Everything is lost on refresh

No save, no load, no URL state. Building an interesting configuration and
reloading loses it. Roadmap M4.

## Performance ceiling

Force computation is O(n²) in the number of bodies and the field sampler is O(n)
per sample point, with up to 12,000 sample points a frame.

Measured by `npm run smoketest` on the seeded two-body scene in headless
Chromium: **59.9 fps, 16.7 ms/frame**. A three-body scene with the range slider
at 300 rebuilds its field (1,267 samples) in 1.5 ms. Expect the frame rate to
fall away somewhere in the low hundreds of bodies, sooner with the vector range
slider at maximum.

Mitigations that already exist: the field is only sampled inside the visible
region, sample count is capped, and turning off *Show Vector Field* removes the
dominant cost entirely. The real fix is a Barnes–Hut quadtree — roadmap M3.

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
zoom. The page loads and runs; it is just not controllable. Roadmap M6 — a touch
version needs its own interaction design rather than a polyfill.

## Very short windows scroll the control panel

The control panel is capped at `calc(100vh - 210px)` and scrolls internally
below that, so it can never collide with the bottom-left info panel. Its
natural height is 524px including padding, so below about **735px** of viewport
height you have to scroll inside the panel to reach the lower controls.

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

## No linter

TypeScript runs with `strict`, `noUnusedLocals`, `noUnusedParameters` and
`noFallthroughCasesInSwitch`, which has been sufficient at this size, but there
is no ESLint configuration. Roadmap M7.

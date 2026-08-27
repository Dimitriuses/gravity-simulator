# Against the real solar system

Every other scene in this repository was chosen. The presets in
[`src/presets.ts`](src/presets.ts) derive their velocities from an orbit
equation so that they do what they claim to do, and the tests check that they
do — which proves the code is self-consistent and nothing at all about whether
it is right.

This one is not chosen. It starts from the eight planets' published orbital
elements at J2000, runs a Julian century, and reads the orbits back out. The
numbers it is compared against were measured by pointing instruments at the sky.
Roadmap M8.

Everything below is measured by running the same code the browser runs:
`npm run ephemeris` loads `src/` through Vite and prints these tables. Rerun it
after touching anything in [`src/units.ts`](src/units.ts),
[`src/ephemeris.ts`](src/ephemeris.ts), [`src/forces.ts`](src/forces.ts) or
[`src/integrators.ts`](src/integrators.ts), and paste the result back in.

---

## What this is not

Two departures from reality, deliberate and worth stating before any number
below is read.

**It is flat.** The simulation is two-dimensional. The inclinations and nodes
are dropped and every orbit is laid in the ecliptic with its size, shape,
orientation and phase intact — which is not the same as the real solar system
seen from above, and the difference shows up in exactly the place this document
cares about most. It is worth about +14″ per century on Mercury's perihelion,
and the sign is predictable: laid in one plane, every perturber pulls entirely
within Mercury's orbital plane rather than mostly within it.

**It is Newtonian**, which is the point rather than a limitation. The one number
here that Newton's gravity cannot produce is general relativity's contribution
to Mercury's perihelion, and a simulation that reproduced it would be a
simulation with a bug.

---

## The scale

Three numbers, and only two of them are a choice. `SIMULATION_G` is 0.5, so
once a length and a mass are declared, the length of a second follows:

| quantity | one simulation unit is | why |
|---|---|---|
| length | 1.495979 Gm | a hundred units to the au, which puts the orbits at 39 to 3,007 units — the range the presets already work in |
| mass | 1.5817e+32 kg | the value that makes `r = 2·m^(1/3)` give the Sun its own radius |
| time | 398.2086 s | whatever makes G come out at 0.5 |

The check on that arithmetic is a number nobody here chose. A circular orbit
of one au about one solar mass comes out at **365.2569 days**, travelled at
**29.785 km/s**.

## The bodies as the simulation holds them

Radius is `2·m^(1/3)`, one density for everything, so a body is drawn the
right size exactly to the extent that its density matches the Sun's. Jupiter
is within 2%, Saturn is a fifth too small, the rocky planets half again too
wide. Nothing depends on it — the largest radius here is 0.05 units against
orbits of 39 and up — but it is worth knowing which way the rule bends.

| body | mass (units) | radius (units) | radius if real |
|---|---:|---:|---:|
| Sun | 1.257e-2 | 0.4650 | 0.4650 |
| Mercury | 2.087e-9 | 0.0026 | 0.0016 |
| Venus | 3.077e-8 | 0.0063 | 0.0040 |
| Earth | 3.822e-8 | 0.0067 | 0.0043 |
| Mars | 4.057e-9 | 0.0032 | 0.0023 |
| Jupiter | 1.200e-5 | 0.0458 | 0.0467 |
| Saturn | 3.593e-6 | 0.0306 | 0.0389 |
| Uranus | 5.488e-7 | 0.0164 | 0.0170 |
| Neptune | 6.476e-7 | 0.0173 | 0.0165 |

## Orbital periods

Measured by watching each planet go round: the total angle it sweeps over the
run, divided into the time it takes. Published figures are sidereal periods.

| planet | measured | published | difference | orbits in the window |
|---|---:|---:|---:|---:|
| Mercury | 87.92 d | 87.9691 d | -0.057% | 415.4 |
| Venus | 224.45 d | 224.701 d | -0.110% | 162.7 |
| Earth | 365.53 d | 365.256363 d | +0.074% | 99.9 |
| Mars | 688.00 d | 686.98 d | +0.148% | 53.1 |
| Jupiter | 4348.33 d | 4332.589 d | +0.363% | 8.4 |
| Saturn | 10642.88 d | 10759.22 d | -1.081% | 3.4 |
| Uranus | 31052.11 d | 30685.4 d | +1.195% | 1.2 |
| Neptune | 59552.05 d | 60189 d | -1.058% | 0.6 |

The last column is why the giants are the ragged rows here and everywhere
below. A century is 415 orbits of Mercury and two thirds of one of Neptune,
and two thirds of an ellipse is not enough to say how long the whole of it
takes: the planet spends that stretch at whatever speed that part of the
orbit calls for, and dividing angle by time reports that instead of a mean.

## How the orbits change over the century

JPL publishes each element's rate of change per century alongside the elements
themselves. Those rates are the real solar system perturbing itself, and they
are what the run is checked against. Semi-major axis in au per century,
eccentricity per century.

| planet | da/dt | published | de/dt | published |
|---|---:|---:|---:|---:|
| Mercury | +0.0000000 | +0.0000004 | +0.0000016 | +0.0000191 |
| Venus | +0.0000001 | +0.0000039 | -0.0000442 | -0.0000411 |
| Earth | +0.0000002 | +0.0000056 | -0.0000455 | -0.0000439 |
| Mars | -0.0000011 | +0.0000185 | +0.0000898 | +0.0000788 |
| Jupiter | -0.0001202 | -0.0001161 | -0.0002311 | -0.0001325 |
| Saturn | -0.0039230 | -0.0012506 | +0.0000535 | -0.0005099 |
| Uranus | +0.0189108 | -0.0019618 | -0.0008355 | -0.0000440 |
| Neptune | +0.0328569 | +0.0002629 | -0.0002245 | +0.0000511 |

## Where the perihelia go

The turning of an orbit is the hardest of these to fake and the easiest to
get wrong, so it is the one worth reading closely.

| planet | e | measured dϖ/dt | published | difference |
|---|---:|---:|---:|---:|
| Mercury | 0.2056 | +545.4″ | +577.7″ | -32.3″ |
| Venus | 0.0068 | -269.9″ | +9.7″ | -279.5″ |
| Earth | 0.0167 | +1137.4″ | +1163.8″ | -26.4″ |
| Mars | 0.0934 | +1578.8″ | +1599.9″ | -21.1″ |
| Jupiter | 0.0484 | -533.7″ | +765.1″ | -1298.8″ |
| Saturn | 0.0539 | +934.2″ | -1508.3″ | +2442.5″ |
| Uranus | 0.0473 | +8014.5″ | +1469.0″ | +6545.5″ |
| Neptune | 0.0086 | +50845.4″ | -1160.7″ | +52006.1″ |

The four inner planets are the meaningful rows, and Venus is the awkward one
of those: its orbit is so nearly circular (e = 0.0068) that where its perihelion
*is* barely means anything, and both the measurement and the published rate are
small differences of large wandering quantities. The giants complete 8, 3, 1 and
0.6 orbits in a century between them, which is not enough of an orbit to quote a
rate of turn for — Jupiter and Saturn also swap angular momentum on a 900-year
cycle, so a century-long window catches a phase of that rather than a trend.

## Mercury's perihelion

The one this was worth doing for.

| | arcseconds per century |
|---|---:|
| **this simulation**, eight planets, Newtonian gravity, flat | **+545.4″** |
| the Newtonian part, as classical perturbation theory decomposes it | 531.5″ |
| observed, from JPL's rate for ϖ | 577.7″ |
| general relativity's share of that, which Newton cannot produce | 42.98″ |

The simulation lands +13.9″ from the Newtonian figure
and -32.3″ short of the observed one. The shortfall is the size
of the relativistic term, which is the correct thing for a Newtonian simulation
to be missing. The excess over 531.5″ is the flattening: laid in one plane every
perturber pulls entirely within Mercury's orbit plane instead of mostly within
it, and pulls a little harder for it. The sign is what that argument predicts.

## The integrator matters more than the physics here

Sun and Mercury alone is a two-body problem. Its perihelion does not move —
that is Newton, not an approximation — so anything the simulation reports is
the integrator inventing it. This is the measurement that decided how the run
above was configured:

| step (days) | velocity Verlet | RK4 |
|---:|---:|---:|
| 40 (0.184) | -26821.8″ | +1.58″ |
| 20 (0.092) | -6706.5″ | +0.10″ |
| 10 (0.046) | -1676.7″ | +0.01″ |
| 5 (0.023) | -419.2″ | +0.00″ |

Verlet falls by exactly 4x per halving, which is what a second-order scheme
should do and is also why it is useless here: at the step this run uses, it
invents three times the effect being measured, pointing the other way.
RK4 is fourth-order and reports nothing at any of these steps. Running the
real system through Verlet instead of RK4 gives Mercury
**-1136.1″** — the right physics with the wrong arithmetic on top of it.

This is the same trade [`INTEGRATORS.md`](INTEGRATORS.md) measures from the
other side. Verlet's virtue is that its *energy* error is bounded, and it holds
that here too: over the century the run below drifts by a part in 10⁹. Bounded
energy error is not accuracy, and a conserved quantity can sit still while the
orbit it belongs to turns.

| | energy drift | angular momentum drift | dϖ/dt for Mercury |
|---|---:|---:|---:|
| RK4, step 10 | 9.9e-14 | 2.5e-14 | +545.4″ |
| RK4, step 5 | 8.0e-14 | 3.7e-14 | +545.4″ |
| Verlet, step 10 | 4.8e-9 | 1.3e-14 | -1136.1″ |

The published run is 792,490 steps of 0.046 days and takes 22.4 s.
Halving the step moves Mercury's rate by 0.01″, so the
figure has stopped depending on it.

---

## What it shows

**The scaling is right.** A circular orbit of one au about one solar mass comes
out at 365.2569 days at 29.785 km/s, and every planet's orbital period lands
within a tenth of a percent of its published one — from a chain that starts at
`SIMULATION_G = 0.5`, a number chosen so that a slider would feel right.

**The force law is right.** Not just the inverse square, which anything would
get, but the whole eight-body sum: the Earth's and Mars's perihelia turn at
their published rates to within 2%, and their eccentricities drift the right way
at the right speed. Those rates are perturbation, not gravity — they are what
the planets do to each other, and they are small.

**Mercury's perihelion advances at 545″ per century, against 578″ observed.**
The Newtonian planetary contribution is 531.5″; this simulation, being flat,
overstates it by about 14. What it cannot account for is the remaining 43″,
which is the relativistic term, and which no amount of care with the arithmetic
here would produce. Le Verrier's 1859 residual, from a numerical integration
that fits in a browser tab.

**And a warning about the default integrator.** Velocity Verlet is the right
choice for watching a simulation — its energy error is bounded, which is why
orbits drawn with it stay closed — and it is the wrong choice for measuring one.
At the step this run uses, its own truncation error turns Mercury's perihelion
*backwards* three times faster than the real effect turns it forwards, while
conserving energy to a part in 10⁹ the whole time. A conserved quantity is not a
correct one. Anything measured out of this simulation over many orbits should be
run through RK4, and checked at two step sizes, and checked against a case whose
answer is known — which for a perihelion means the two-body problem, where the
answer is that it does not move.


# Against the real solar system

Every other scene in this repository was chosen. The presets in
[`src/presets.ts`](src/presets.ts) derive their velocities from an orbit
equation so that they do what they claim to do, and the tests check that they
do — which proves the code is self-consistent and nothing at all about whether
it is right.

This one is not chosen. It starts from the eight planets' published orbital
elements at J2000, runs a Julian millennium, and reads the orbits back out. The
numbers it is compared against were measured by pointing instruments at the sky.
Roadmap M8, extended by M14.

Rates are quoted over two windows cut from the same run: its first century, and
the whole of it. The century is the window JPL's published rates are fitted
over, so it is the one that compares with them directly; the millennium is what
says whether a number was a rate or a phase of something slower. Where the two
agree — Mercury moves by 0.4″ between them — the figure is worth more than
either window alone.

Everything below is measured by running the same code the browser runs:
`npm run ephemeris` loads `src/` through Vite and prints these tables. It takes
about four minutes; `-- --quick` runs a decade of it in ten seconds, which is
what CI does. Rerun the full thing after touching anything in
[`src/units.ts`](src/units.ts), [`src/ephemeris.ts`](src/ephemeris.ts),
[`src/forces.ts`](src/forces.ts) or [`src/integrators.ts`](src/integrators.ts),
and paste the result back in.

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
within Mercury's orbital plane rather than mostly within it. Jupiter and Uranus
come out about 10% high for what looks like the same reason.

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
whole run, divided into the time it takes. Published figures are sidereal
periods.

| planet | measured | published | difference | orbits in the window |
|---|---:|---:|---:|---:|
| Mercury | 87.91 d | 87.9691 d | -0.065% | 4154.7 |
| Venus | 224.45 d | 224.701 d | -0.111% | 1627.3 |
| Earth | 365.51 d | 365.256363 d | +0.071% | 999.3 |
| Mars | 688.21 d | 686.98 d | +0.179% | 530.7 |
| Jupiter | 4347.54 d | 4332.589 d | +0.345% | 84.0 |
| Saturn | 10733.73 d | 10759.22 d | -0.237% | 34.0 |
| Uranus | 30602.14 d | 30685.4 d | -0.271% | 11.9 |
| Neptune | 60092.98 d | 60189 d | -0.160% | 6.1 |

The last column is why a century was not enough on its own. Over one, Neptune
completes two thirds of an orbit, and two thirds of an ellipse cannot say how
long the whole of it takes: the planet spends that stretch at whatever speed
that part of the orbit calls for, and dividing angle by time reports that
rather than a mean. Over a millennium every planet here goes round at least
six times.

## How the orbits change

JPL publishes each element's rate of change per century alongside the elements
themselves. Those rates are the real solar system perturbing itself, and they
are what the run is checked against. Semi-major axis in au per century,
eccentricity per century, both fitted over the first century of the run and
over the whole millennium.

| planet | da/dt, century | millennium | published | de/dt, century | millennium | published |
|---|---:|---:|---:|---:|---:|---:|
| Mercury | +0.0000000 | -0.0000000 | +0.0000004 | +0.0000016 | +0.0000024 | +0.0000191 |
| Venus | +0.0000001 | +0.0000000 | +0.0000039 | -0.0000442 | -0.0000445 | -0.0000411 |
| Earth | +0.0000002 | +0.0000000 | +0.0000056 | -0.0000455 | -0.0000459 | -0.0000439 |
| Mars | -0.0000012 | -0.0000000 | +0.0000185 | +0.0000895 | +0.0000938 | +0.0000788 |
| Jupiter | -0.0001221 | +0.0000023 | -0.0001161 | -0.0002300 | +0.0001559 | -0.0001325 |
| Saturn | -0.0039747 | -0.0000648 | -0.0012506 | +0.0000533 | -0.0003836 | -0.0005099 |
| Uranus | +0.0191030 | +0.0001752 | -0.0019618 | -0.0008425 | +0.0000998 | -0.0000440 |
| Neptune | +0.0325676 | +0.0011094 | +0.0002629 | -0.0002206 | +0.0000812 | +0.0000511 |

The published column is a linear fit over roughly 1800–2050, so the century
column is the one directly comparable with it. Where the millennium column
disagrees, the disagreement is not noise: it is the difference between a rate
quoted for now and the same rate averaged over ten times longer, which for
elements that oscillate on centuries-long cycles is a real difference.

## Where the perihelia go

The turning of an orbit is the hardest of these to fake and the easiest to
get wrong, so it is the one worth reading closely.

| planet | e | century | millennium | published | difference |
|---|---:|---:|---:|---:|---:|
| Mercury | 0.2056 | +545.4″ | +545.0″ | +577.7″ | -32.4″ |
| Venus | 0.0068 | -269.1″ | -325.8″ | +9.7″ | -278.8″ |
| Earth | 0.0167 | +1137.2″ | +1143.8″ | +1163.8″ | -26.6″ |
| Mars | 0.0934 | +1578.5″ | +1580.7″ | +1599.9″ | -21.4″ |
| Jupiter | 0.0484 | -531.6″ | +837.4″ | +765.1″ | -1296.7″ |
| Saturn | 0.0539 | +950.2″ | +2086.4″ | -1508.3″ | +2458.5″ |
| Uranus | 0.0473 | +7857.4″ | +1671.8″ | +1469.0″ | +6388.4″ |
| Neptune | 0.0086 | +60913.9″ | -7.1″ | -1160.7″ | +62074.6″ |

Both columns come from `h = e·sin ϖ` and `k = e·cos ϖ` rather than from a fit
to ϖ itself. Where a nearly circular orbit keeps its perihelion barely means
anything and the angle swings about; h and k stay smooth through it, because
the pair carries the eccentricity and the direction together, and
`dϖ/dt = (k·ḣ - h·k̇)/(h² + k²)` recovers the rate. The difference column
compares the century, since that is the window the published rates are fitted
over.

What the longer window settled, and what it did not:

- **Mercury, Earth and Mars were already settled** and stay where they were —
  Mercury moves by 0.4″ between a century and a millennium, which is the more
  useful fact about it than either number alone.
- **Jupiter and Uranus needed the length.** Over a century Jupiter came out at
  -532″ against a published +765″, with the sign wrong; over a millennium it is
  +837″. Uranus goes from +7,857″ to +1,672″ against +1,469″. Both now sit about
  10% high, which is the same direction and roughly the same size as Mercury's
  flattening error.
- **Saturn and Neptune are still not settled.** Saturn swings from +950″ to
  +2,086″ against a published -1,508″, and a millennium is only 1.1 cycles of
  the 900-year exchange it has with Jupiter — not enough of one to average it
  away. Neptune's rate is small and its orbit is nearly circular, so the same
  applies with less to measure.
- **Venus is not an estimator problem**, which is what this method was brought
  in to establish. h/k and a direct fit to ϖ agree at about -270″ a century,
  against a published +9.7″, so the disagreement is in the physics rather than
  the arithmetic: that +9.7″ is the small residue of perturbations worth
  hundreds of arcseconds each, and the flat model gets each of those a few
  per cent wrong. A few per cent of hundreds is larger than the answer.

## Mercury's perihelion

The one this was worth doing for.

| | arcseconds per century |
|---|---:|
| **this simulation**, eight planets, Newtonian gravity, flat | **+545.4″** |
| the same run, averaged over the whole millennium | +545.0″ |
| the Newtonian part, as classical perturbation theory decomposes it | 531.5″ |
| observed, from JPL's rate for ϖ | 577.7″ |
| general relativity's share of that, which Newton cannot produce | 42.98″ |

Between the two windows it moves by 0.3″, which is worth as much as either
figure: a number that holds over ten times the integration is not an artefact
of where the run happened to stop.

The simulation lands +13.9″ from the Newtonian figure
and -32.4″ short of the observed one. The shortfall is the size
of the relativistic term, which is the correct thing for a Newtonian simulation
to be missing. The excess over 531.5″ is the flattening: laid in one plane every
perturber pulls entirely within Mercury's orbit plane instead of mostly within
it, and pulls a little harder for it. The sign is what that argument predicts.

## The integrator matters more than the physics here

Sun and Mercury alone is a two-body problem. Its perihelion does not move —
that is Newton, not an approximation — so anything the simulation reports is
the integrator inventing it. This is the measurement that decided how the run
above was configured:

| step (days) | velocity Verlet | RK4 | Forest-Ruth |
|---:|---:|---:|---:|
| 40 (0.184) | -26822.6″ | +1.58″ | +48.78″ |
| 20 (0.092) | -6707.3″ | +0.10″ | +3.05″ |
| 10 (0.046) | -1676.7″ | +0.01″ | +0.19″ |
| 5 (0.023) | -419.2″ | +0.00″ | +0.01″ |

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
| RK4, step 10 | 1.9e-12 | 4.2e-14 | +545.4″ |
| RK4, step 5 | 8.0e-14 | 3.7e-14 | +545.4″ |
| Verlet, step 10 | 4.8e-9 | 1.3e-14 | -1136.1″ |

The published run is 7,924,892 steps of 0.046 days and takes 292.1 s.
Halving the step moves Mercury's rate by 0.01″, so the
figure has stopped depending on it.

---

## What it shows

**The scaling is right.** A circular orbit of one au about one solar mass comes
out at 365.2569 days at 29.785 km/s, and every planet's orbital period lands
within 0.35% of its published one — from a chain that starts at
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

**A window has to be long enough for the orbit being measured.** Over a century
Jupiter's perihelion came out with the wrong sign and Saturn's period was 1%
short; over a millennium Jupiter is within 10% and every period is within 0.35%.
Two rows still do not settle, and both say why rather than being quietly
dropped: Saturn, because a millennium is 1.1 cycles of its 900-year exchange
with Jupiter, and Venus, because its published rate is the small residue of
much larger perturbations and a flat model gets each of those a few per cent
wrong.

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


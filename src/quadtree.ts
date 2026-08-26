import { Vector2D } from './Vector2D';
import { Particle } from './Particle';

/**
 * A Barnes-Hut quadtree. Roadmap M3.
 *
 * Summing forces over every pair is O(n²), and sampling the field at a few
 * thousand points is O(n) per sample on top of that. Both are fine at tens of
 * bodies and neither is fine at thousands.
 *
 * Barnes-Hut replaces a distant *group* of bodies with a single body at their
 * centre of mass. A node is far enough to stand in for its contents when
 * `s / d < theta`, where `s` is the node's width and `d` the distance to it —
 * so the cost of one query falls from n to about log n, and the same tree
 * answers both questions the simulation asks: the net force on a body, and the
 * field at a point no body occupies.
 *
 * What it costs is exactness, and one thing that is not obvious: the
 * approximation is **not symmetric**. Body A may be close enough to see B
 * individually while B is far enough to see A only as part of a cell, so the
 * two forces are not equal and opposite and total momentum is no longer
 * conserved to machine precision. That is inherent to the method, not a defect
 * here, and it is why the exact solver remains the default for scenes small
 * enough to afford it.
 */

/**
 * The minimum a body has to offer the tree: where it is, how heavy, how wide,
 * and how fast.
 *
 * Velocity is there for the adaptive step rule, which needs the shortest
 * interaction timescale in the system and gets it from the same tree.
 */
export interface TreeBody {
  x: number;
  y: number;
  mass: number;
  radius: number;
  vx: number;
  vy: number;
}

/**
 * Opening angle. A node is used as a single mass when its width over its
 * distance is below this.
 *
 * 0.5 is the value the literature settled on, and the measurements in
 * SCALING.md bear it out: median force error of 0.08% on a scene dominated by a
 * central mass, and 0.7% on a sparse uniform cloud where the net force on a
 * body is a small residual of large opposing pulls. **Zero makes the tree
 * exact** — no node ever passes the test, so every query walks down to
 * individual bodies — which is what the tests use to prove the traversal itself
 * is right.
 */
export const DEFAULT_THETA = 0.5;

/**
 * Depth limit.
 *
 * Subdivision separates bodies by putting them in different quadrants, which
 * never terminates for two bodies at the same coordinates — and coincident
 * bodies are easy to produce by clicking one on top of another. At the limit a
 * leaf simply holds everything that reached it and is summed directly.
 */
const MAX_DEPTH = 24;

class QuadNode {
  /** Total mass in this node, and where its centre of mass sits. */
  mass = 0;
  comX = 0;
  comY = 0;

  /** Largest body radius anywhere under this node; used by contact queries. */
  maxRadius = 0;

  /**
   * Largest single mass and largest speed anywhere under this node.
   *
   * Both are upper bounds used to prune the timescale search: a cell cannot
   * contain a pair that interacts faster than its heaviest, fastest member
   * would at the cell's nearest edge.
   */
  maxMass = 0;
  maxSpeed = 0;

  /** Indices into the body array. Non-empty only for leaves. */
  bodies: number[] = [];

  /** Four children, or null while this is a leaf. */
  children: QuadNode[] | null = null;

  constructor(
    readonly cx: number,
    readonly cy: number,
    readonly half: number
  ) {}
}

export class QuadTree {
  private root: QuadNode;

  private constructor(
    private readonly bodies: TreeBody[],
    root: QuadNode
  ) {
    this.root = root;
  }

  /**
   * Build a tree over `bodies`.
   *
   * The root is the smallest square containing every body, padded slightly so
   * nothing sits exactly on a boundary. An empty list still yields a usable
   * tree, so callers do not need to special-case it.
   */
  static build(bodies: TreeBody[]): QuadTree {
    if (bodies.length === 0) {
      return new QuadTree(bodies, new QuadNode(0, 0, 1));
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const body of bodies) {
      if (body.x < minX) minX = body.x;
      if (body.y < minY) minY = body.y;
      if (body.x > maxX) maxX = body.x;
      if (body.y > maxY) maxY = body.y;
    }

    const half = Math.max((maxX - minX) / 2, (maxY - minY) / 2, 1e-6) * 1.01;
    const root = new QuadNode((minX + maxX) / 2, (minY + maxY) / 2, half);

    const tree = new QuadTree(bodies, root);
    for (let i = 0; i < bodies.length; i++) {
      tree.insert(root, i, 0);
    }
    tree.summarise(root);

    return tree;
  }

  private insert(node: QuadNode, index: number, depth: number): void {
    // An internal node: descend into the quadrant this body belongs to.
    if (node.children) {
      this.insert(node.children[this.quadrantOf(node, index)], index, depth + 1);
      return;
    }

    // An empty leaf, or one that cannot usefully be split any further.
    if (node.bodies.length === 0 || depth >= MAX_DEPTH) {
      node.bodies.push(index);
      return;
    }

    // An occupied leaf: split it, push the sitting tenants down, then retry.
    const existing = node.bodies;
    node.bodies = [];
    node.children = this.subdivide(node);

    for (const occupant of existing) {
      this.insert(node.children[this.quadrantOf(node, occupant)], occupant, depth + 1);
    }
    this.insert(node.children[this.quadrantOf(node, index)], index, depth + 1);
  }

  private subdivide(node: QuadNode): QuadNode[] {
    const quarter = node.half / 2;
    return [
      new QuadNode(node.cx - quarter, node.cy - quarter, quarter),
      new QuadNode(node.cx + quarter, node.cy - quarter, quarter),
      new QuadNode(node.cx - quarter, node.cy + quarter, quarter),
      new QuadNode(node.cx + quarter, node.cy + quarter, quarter),
    ];
  }

  private quadrantOf(node: QuadNode, index: number): number {
    const body = this.bodies[index];
    return (body.x >= node.cx ? 1 : 0) + (body.y >= node.cy ? 2 : 0);
  }

  /** Fill in mass, centre of mass and max radius, bottom up. */
  private summarise(node: QuadNode): void {
    node.mass = 0;
    node.comX = 0;
    node.comY = 0;
    node.maxRadius = 0;
    node.maxMass = 0;
    node.maxSpeed = 0;

    if (node.children) {
      for (const child of node.children) {
        this.summarise(child);
        if (child.mass === 0) continue;

        node.mass += child.mass;
        node.comX += child.comX * child.mass;
        node.comY += child.comY * child.mass;
        node.maxRadius = Math.max(node.maxRadius, child.maxRadius);
        node.maxMass = Math.max(node.maxMass, child.maxMass);
        node.maxSpeed = Math.max(node.maxSpeed, child.maxSpeed);
      }
    } else {
      for (const index of node.bodies) {
        const body = this.bodies[index];
        node.mass += body.mass;
        node.comX += body.x * body.mass;
        node.comY += body.y * body.mass;
        node.maxRadius = Math.max(node.maxRadius, body.radius);
        node.maxMass = Math.max(node.maxMass, body.mass);
        node.maxSpeed = Math.max(node.maxSpeed, Math.hypot(body.vx, body.vy));
      }
    }

    if (node.mass > 0) {
      node.comX /= node.mass;
      node.comY /= node.mass;
    }
  }

  /**
   * Acceleration on the body at `index` from everything else in the tree.
   *
   * Softening matches `forces.ts` exactly wherever individual bodies are
   * reached: a pair never pulls harder than it does at contact, the sum of the
   * two radii. A cell standing in for many bodies softens on its widest member
   * instead, which only matters in dense configurations — the opening angle
   * already guarantees a cell is far away before it is used at all.
   */
  accelerationOn(index: number, G: number, theta: number = DEFAULT_THETA): Vector2D {
    const body = this.bodies[index];
    const acceleration = { x: 0, y: 0 };
    this.walk(this.root, body.x, body.y, body.radius, index, G, theta * theta, acceleration);
    return new Vector2D(acceleration.x, acceleration.y);
  }

  /**
   * Acceleration at a point that is not a body: the field, in other words.
   *
   * `maxRange` mirrors the range cutoff the field sampler has always applied —
   * bodies beyond it contribute nothing — and lets whole branches be discarded
   * without opening them.
   */
  accelerationAt(
    x: number,
    y: number,
    G: number,
    theta: number = DEFAULT_THETA,
    maxRange: number = Infinity
  ): Vector2D {
    const acceleration = { x: 0, y: 0 };
    this.walk(this.root, x, y, 0, -1, G, theta * theta, acceleration, maxRange);
    return new Vector2D(acceleration.x, acceleration.y);
  }

  private walk(
    node: QuadNode,
    x: number,
    y: number,
    radius: number,
    skip: number,
    G: number,
    thetaSquared: number,
    out: { x: number; y: number },
    maxRange: number = Infinity
  ): void {
    if (node.mass === 0) return;

    if (maxRange !== Infinity && this.distanceToBox(node, x, y) > maxRange) return;

    const dx = node.comX - x;
    const dy = node.comY - y;
    const distanceSquared = dx * dx + dy * dy;

    if (node.children) {
      const width = node.half * 2;

      // A cell that straddles the range cutoff has to be opened even if it is
      // far enough to approximate: some of what it holds counts and some does
      // not, and standing in for all of it with one centre of mass would drag
      // in mass the direct sum excludes. Measured before this check, samples
      // near the cutoff disagreed with the direct sum by up to 15%.
      const wholeCellInRange =
        maxRange === Infinity || this.farDistanceToBox(node, x, y) <= maxRange;

      // s/d < theta, squared to keep the square root out of the hot loop.
      if (wholeCellInRange && width * width < thetaSquared * distanceSquared) {
        // The floor is the widest body in the cell, which is what the leaf path
        // would have used for its closest member. Deriving one from the cell's
        // total mass instead would soften over a far larger distance than any
        // body in it actually occupies.
        this.pull(dx, dy, distanceSquared, node.mass, node.maxRadius + radius, G, out);
        return;
      }

      for (const child of node.children) {
        this.walk(child, x, y, radius, skip, G, thetaSquared, out, maxRange);
      }
      return;
    }

    for (const index of node.bodies) {
      if (index === skip) continue;

      const body = this.bodies[index];
      const bodyDx = body.x - x;
      const bodyDy = body.y - y;
      const bodyDistanceSquared = bodyDx * bodyDx + bodyDy * bodyDy;

      if (maxRange !== Infinity && bodyDistanceSquared > maxRange * maxRange) continue;

      this.pull(bodyDx, bodyDy, bodyDistanceSquared, body.mass, body.radius + radius, G, out);
    }
  }

  /** One softened inverse-square pull, accumulated into `out`. */
  private pull(
    dx: number,
    dy: number,
    distanceSquared: number,
    mass: number,
    contactDistance: number,
    G: number,
    out: { x: number; y: number }
  ): void {
    if (distanceSquared === 0) return;

    const softened = Math.max(distanceSquared, contactDistance * contactDistance);
    const distance = Math.sqrt(distanceSquared);
    const magnitude = (G * mass) / softened;

    out.x += (dx / distance) * magnitude;
    out.y += (dy / distance) * magnitude;
  }

  /**
   * The shortest interaction timescale between any two bodies in the tree —
   * the number the adaptive step rule divides the frame by.
   *
   * The rule wants a minimum over all pairs, which is a quadratic scan, and at
   * two thousand bodies it cost more than everything else in a frame put
   * together. This is the same minimum, found by branch and bound: for each
   * body, a cell is skipped when even its heaviest and fastest member, placed
   * at the cell's nearest edge, could not beat the best pair found so far.
   *
   * Both bounds are upper bounds on what a cell can contain, so nothing that
   * could win is ever skipped: **this returns exactly what the pairwise scan
   * returns**, which `tests/integrators.test.ts` checks directly rather than
   * taking on trust.
   */
  shortestInteractionTime(G: number): number {
    let best = Infinity;

    for (let i = 0; i < this.bodies.length; i++) {
      best = this.searchTimescale(this.root, i, G, best);
    }

    return best;
  }

  private searchTimescale(node: QuadNode, index: number, G: number, best: number): number {
    if (node.mass === 0) return best;

    const body = this.bodies[index];

    // The optimistic case for this whole cell: its nearest edge, its heaviest
    // member, its fastest member. Nothing inside can do better than this.
    const nearest = this.distanceToBox(node, body.x, body.y);
    if (nearest > 0) {
      const speed = Math.hypot(body.vx, body.vy) + node.maxSpeed;
      const dynamical = Math.sqrt(nearest ** 3 / (G * (body.mass + node.maxMass)));
      const crossing = speed > 0 ? nearest / speed : Infinity;

      if (Math.min(dynamical, crossing) >= best) return best;
    }

    if (node.children) {
      // Nearest child first. The bound is only as good as the best pair found
      // so far, so descending towards the query point before wandering away
      // from it is what makes the pruning bite.
      const order = this.quadrantOf(node, index);
      best = this.searchTimescale(node.children[order], index, G, best);

      for (let i = 0; i < 4; i++) {
        if (i === order) continue;
        best = this.searchTimescale(node.children[i], index, G, best);
      }
      return best;
    }

    for (const other of node.bodies) {
      // Each pair is examined from both ends, which costs a little and keeps
      // the traversal simple; the answer is symmetric either way.
      if (other === index) continue;

      const partner = this.bodies[other];
      const contact = body.radius + partner.radius;
      const separation = Math.max(Math.hypot(partner.x - body.x, partner.y - body.y), contact);

      const dynamical = Math.sqrt(separation ** 3 / (G * (body.mass + partner.mass)));
      const relativeSpeed = Math.hypot(partner.vx - body.vx, partner.vy - body.vy);
      const crossing = relativeSpeed > 0 ? separation / relativeSpeed : Infinity;

      best = Math.min(best, dynamical, crossing);
    }

    return best;
  }

  /** Distance from a point to the node's square, zero if the point is inside. */
  private distanceToBox(node: QuadNode, x: number, y: number): number {
    const dx = Math.max(Math.abs(x - node.cx) - node.half, 0);
    const dy = Math.max(Math.abs(y - node.cy) - node.half, 0);
    return Math.sqrt(dx * dx + dy * dy);
  }

  /** Distance from a point to the farthest corner of the node's square. */
  private farDistanceToBox(node: QuadNode, x: number, y: number): number {
    const dx = Math.abs(x - node.cx) + node.half;
    const dy = Math.abs(y - node.cy) + node.half;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Indices of every body whose surface is within `radius` of the point —
   * the broad phase for contact detection.
   *
   * Each node knows the largest body radius beneath it, so a branch can be
   * discarded when even its widest member could not reach the query.
   */
  withinContact(x: number, y: number, radius: number, out: number[]): void {
    this.collect(this.root, x, y, radius, out);
  }

  private collect(node: QuadNode, x: number, y: number, radius: number, out: number[]): void {
    if (node.mass === 0) return;
    if (this.distanceToBox(node, x, y) > radius + node.maxRadius) return;

    if (node.children) {
      for (const child of node.children) this.collect(child, x, y, radius, out);
      return;
    }

    for (const index of node.bodies) {
      const body = this.bodies[index];
      const dx = body.x - x;
      const dy = body.y - y;
      const reach = radius + body.radius;

      if (dx * dx + dy * dy < reach * reach) out.push(index);
    }
  }
}

/** Build a tree over particles as they currently stand. */
export function treeOf(particles: Particle[]): QuadTree {
  return QuadTree.build(
    particles.map((particle) => ({
      x: particle.position.x,
      y: particle.position.y,
      mass: particle.mass,
      radius: particle.radius,
      vx: particle.velocity.x,
      vy: particle.velocity.y,
    }))
  );
}

/** Build a tree over particles placed at `positions` instead of where they are. */
export function treeAt(particles: Particle[], positions: Vector2D[]): QuadTree {
  return QuadTree.build(
    particles.map((particle, index) => ({
      x: positions[index].x,
      y: positions[index].y,
      mass: particle.mass,
      radius: particle.radius,
      vx: particle.velocity.x,
      vy: particle.velocity.y,
    }))
  );
}

import { PresetBody } from './presets';
import { INTEGRATOR_LABELS, IntegratorName } from './integrators';
import { COLLISION_MODE_LABELS, CollisionMode } from './collisions';
import { FORCE_MODE_LABELS, ForceMode } from './PhysicsEngine';

/**
 * Scenes as text, so a configuration can survive a refresh and travel in a
 * link. Roadmap M4.
 *
 * The format is deliberately plain rather than base64-wrapped JSON: it is
 * shorter, it survives being read by a human, and a link that arrives mangled
 * can be diagnosed by looking at it. Every field is `key=value`, fields are
 * separated by `;`, and all of the characters used are legal in a URL fragment
 * without escaping.
 *
 *   v=1;s=figure-eight
 *   v=1;c=0,0,1;t=50;o=110;p=verlet,merge,auto,1;b=-200,0,100,0,0.25|200,0,100,0,-0.25
 *
 * **Decoding is defensive.** Links come from outside: anything malformed is
 * rejected with a reason rather than half-applied, unknown keys are ignored so
 * a future version can add fields without breaking this one, and the body count
 * is capped so a hostile link cannot ask the browser for a million particles.
 */

/** Bumped only when a change would make an old link decode *wrongly*. */
export const SCENE_FORMAT_VERSION = 1;

/**
 * Upper bound on bodies in a decoded scene.
 *
 * Well above the largest preset (300) and far below what would hang a tab.
 */
/**
 * The largest step a link may ask for.
 *
 * The solar system, the scene this exists for, uses 110. A thousand is far
 * beyond any scene here and still short of the range where a single step
 * carries a body clean through the system.
 */
export const MAX_TIME_STEP = 1000;

export const MAX_DECODED_BODIES = 5000;

/**
 * A scene, as saved.
 *
 * Every field is optional, and an absent field means "leave whatever the app
 * already has". That is what lets `v=1;s=binary` be a complete, valid scene.
 *
 * What is deliberately *not* here: the mass slider, the arrow and body size
 * multipliers, the field range and the grid mode. Those are how the viewer is
 * looking at the simulation rather than what the simulation is, and a link that
 * reset them would be overreaching. What is here is what a preset can set, plus
 * the physics settings, because those change what the scene actually does.
 */
export interface SavedScene {
  preset?: string;
  bodies?: PresetBody[];
  camera?: { x: number; y: number; zoom: number };
  trailLength?: number;
  showVectorField?: boolean;
  showParticleVectors?: boolean;
  showTrails?: boolean;
  integrator?: IntegratorName;
  collisionMode?: CollisionMode;
  forceMode?: ForceMode;
  adaptiveStepping?: boolean;
  restitution?: number;
  /**
   * How much simulated time one frame advances, when the scene is not happy
   * with 1.
   *
   * Carried because it changes what the scene *does* rather than how it is
   * being looked at: the solar system runs at 110 units a frame because one
   * unit is 398 seconds there, and a link that dropped it would open on a
   * picture that appears to be frozen.
   */
  timeStep?: number;
  /** Per body, in the same order as `bodies`. Omitted when nothing is turning. */
  spin?: { angle: number; angularVelocity: number }[];
}

export type DecodeResult = { scene: SavedScene } | { error: string };

/**
 * Six significant digits, with the trailing zeros and exponents that
 * `toPrecision` leaves behind cleaned off.
 *
 * Six is far more than the simulation's own accuracy justifies and still keeps
 * a body inside about 40 characters.
 */
/**
 * How much of each number a link carries.
 *
 * Six, and roadmap M19 tried to make it fewer. A link is as long as the scene
 * is — about 55 characters a body, so a 300-body scene is 12,476 of them, fine
 * in an address bar and too long for most chat clients — and quantising is the
 * obvious economy: a body placed by mouse has three meaningful figures at best.
 *
 * It was measured and declined. Four figures saves 27% and five saves 13%, and
 * *both* break the property `tests/serialization.test.ts` pins in "restores a
 * preset to the same simulation, step for step": a restored scene stops
 * evolving like the one that was saved. At five figures it misses that
 * tolerance by a hair, which is the useful part of the measurement — the margin
 * is not there to be spent.
 *
 * The other economy does not pay either. Five float32s a body, base64-encoded,
 * comes to 8,400 characters against this format's 12,476 — a third off, for a
 * second format that cannot be diagnosed by reading it, and still far past what
 * a chat client will take. Five numbers a body is simply a lot of data, and the
 * app already says so above 2,000 characters rather than pretending otherwise.
 */
const SIGNIFICANT_FIGURES = 6;

function num(value: number): string {
  return String(Number(value.toPrecision(SIGNIFICANT_FIGURES)));
}

const flag = (value: boolean) => (value ? '1' : '0');

/** Encode a scene. The result contains no characters needing URL escaping. */
export function encodeScene(scene: SavedScene): string {
  const fields: string[] = [`v=${SCENE_FORMAT_VERSION}`];

  if (scene.preset !== undefined) fields.push(`s=${scene.preset}`);

  if (scene.camera) {
    fields.push(`c=${num(scene.camera.x)},${num(scene.camera.y)},${num(scene.camera.zoom)}`);
  }

  if (scene.trailLength !== undefined) fields.push(`t=${Math.round(scene.trailLength)}`);

  if (
    scene.showVectorField !== undefined ||
    scene.showParticleVectors !== undefined ||
    scene.showTrails !== undefined
  ) {
    fields.push(
      `o=${flag(scene.showVectorField ?? true)}${flag(scene.showParticleVectors ?? true)}` +
        `${flag(scene.showTrails ?? true)}`
    );
  }

  if (
    scene.integrator !== undefined ||
    scene.collisionMode !== undefined ||
    scene.forceMode !== undefined ||
    scene.adaptiveStepping !== undefined
  ) {
    fields.push(
      `p=${scene.integrator ?? 'verlet'},${scene.collisionMode ?? 'merge'},` +
        `${scene.forceMode ?? 'auto'},${flag(scene.adaptiveStepping ?? true)}`
    );
  }

  // Both of these are their own key rather than extra parts of `p=`, and that
  // is deliberate: a build that predates them ignores a key it does not know,
  // where a fifth comma-separated part would have made it reject the whole
  // link. The version is for changes that would be *misread*, not for
  // additions.
  if (scene.restitution !== undefined) fields.push(`r=${num(scene.restitution)}`);
  if (scene.timeStep !== undefined) fields.push(`d=${num(scene.timeStep)}`);

  if (scene.spin) {
    fields.push(
      `w=${scene.spin.map((s) => `${num(s.angle)},${num(s.angularVelocity)}`).join('|')}`
    );
  }

  // Bodies last: it is the long field, so everything readable stays near the
  // front of the link.
  if (scene.bodies) {
    const bodies = scene.bodies
      .map((b) => `${num(b.x)},${num(b.y)},${num(b.mass)},${num(b.vx)},${num(b.vy)}`)
      .join('|');
    fields.push(`b=${bodies}`);
  }

  return fields.join(';');
}

function parseNumbers(value: string, expected: number): number[] | null {
  const parts = value.split(',');
  if (parts.length !== expected) return null;

  const numbers = parts.map(Number);
  return numbers.every((n) => Number.isFinite(n)) ? numbers : null;
}

function oneOf<T extends string>(
  value: string,
  allowed: ReadonlyArray<{ id: T }>
): T | undefined {
  return allowed.some((entry) => entry.id === value) ? (value as T) : undefined;
}

/**
 * Decode a scene, or say why it could not be read.
 *
 * Leading `#`, surrounding whitespace and a leading `scene=` are all tolerated,
 * because all three turn up when a link is copied by hand.
 */
export function decodeScene(text: string): DecodeResult {
  const trimmed = text.trim().replace(/^#/, '').replace(/^scene=/, '');
  if (trimmed === '') return { error: 'empty' };

  const fields = new Map<string, string>();
  for (const field of trimmed.split(';')) {
    if (field === '') continue;
    const separator = field.indexOf('=');
    if (separator < 1) return { error: `not a key=value field: "${field}"` };
    fields.set(field.slice(0, separator), field.slice(separator + 1));
  }

  const version = Number(fields.get('v'));
  if (!Number.isInteger(version)) return { error: 'no version' };
  if (version > SCENE_FORMAT_VERSION) {
    return { error: `saved by a newer version of the app (v${version})` };
  }

  const scene: SavedScene = {};

  const preset = fields.get('s');
  if (preset !== undefined) {
    if (!/^[a-z0-9-]+$/.test(preset)) return { error: 'bad scene id' };
    scene.preset = preset;
  }

  const camera = fields.get('c');
  if (camera !== undefined) {
    const parsed = parseNumbers(camera, 3);
    if (!parsed) return { error: 'bad camera' };
    scene.camera = { x: parsed[0], y: parsed[1], zoom: parsed[2] };
  }

  const trail = fields.get('t');
  if (trail !== undefined) {
    const parsed = Number(trail);
    if (!Number.isFinite(parsed) || parsed < 0) return { error: 'bad trail length' };
    scene.trailLength = Math.round(parsed);
  }

  const overlays = fields.get('o');
  if (overlays !== undefined) {
    if (!/^[01]{3}$/.test(overlays)) return { error: 'bad overlay flags' };
    scene.showVectorField = overlays[0] === '1';
    scene.showParticleVectors = overlays[1] === '1';
    scene.showTrails = overlays[2] === '1';
  }

  const physics = fields.get('p');
  if (physics !== undefined) {
    const parts = physics.split(',');
    if (parts.length !== 4) return { error: 'bad physics settings' };

    const integrator = oneOf<IntegratorName>(parts[0], INTEGRATOR_LABELS);
    const collisions = oneOf<CollisionMode>(parts[1], COLLISION_MODE_LABELS);
    const forces = oneOf<ForceMode>(parts[2], FORCE_MODE_LABELS);
    if (!integrator || !collisions || !forces || !/^[01]$/.test(parts[3])) {
      return { error: 'bad physics settings' };
    }

    scene.integrator = integrator;
    scene.collisionMode = collisions;
    scene.forceMode = forces;
    scene.adaptiveStepping = parts[3] === '1';
  }

  const restitution = fields.get('r');
  if (restitution !== undefined) {
    const parsed = Number(restitution);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      return { error: 'bad restitution' };
    }
    scene.restitution = parsed;
  }

  const timeStep = fields.get('d');
  if (timeStep !== undefined) {
    const parsed = Number(timeStep);
    // Bounded because it is reachable from outside: a step of zero freezes the
    // simulation with no way back, and a huge one puts every body through the
    // whole scene in a frame.
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_TIME_STEP) {
      return { error: 'bad time step' };
    }
    scene.timeStep = parsed;
  }

  const spin = fields.get('w');
  if (spin !== undefined) {
    scene.spin = [];
    for (const entry of spin.split('|').filter((part) => part !== '')) {
      const parsed = parseNumbers(entry, 2);
      if (!parsed) return { error: `bad spin: "${entry}"` };
      scene.spin.push({ angle: parsed[0], angularVelocity: parsed[1] });
    }
  }

  const bodies = fields.get('b');
  if (bodies !== undefined) {
    const entries = bodies.split('|').filter((entry) => entry !== '');
    if (entries.length > MAX_DECODED_BODIES) {
      return { error: `too many bodies (${entries.length})` };
    }

    scene.bodies = [];
    for (const entry of entries) {
      const parsed = parseNumbers(entry, 5);
      if (!parsed) return { error: `bad body: "${entry}"` };
      if (parsed[2] <= 0) return { error: 'a body needs a positive mass' };

      scene.bodies.push({
        x: parsed[0],
        y: parsed[1],
        mass: parsed[2],
        vx: parsed[3],
        vy: parsed[4],
      });
    }
  }

  if (scene.preset === undefined && scene.bodies === undefined) {
    return { error: 'no bodies and no scene id' };
  }

  return { scene };
}

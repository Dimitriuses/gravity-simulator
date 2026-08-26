import p5 from 'p5';
import { PhysicsEngine } from './PhysicsEngine';
import { Renderer } from './Renderer';
import { Particle } from './Particle';
import { Camera } from './Camera';
import { DEFAULT_PRESET_ID, PRESETS, getPreset, presetParticles } from './presets';
import { INTEGRATOR_LABELS, IntegratorName } from './integrators';
import { COLLISION_MODE_LABELS, CollisionMode } from './collisions';
import { FORCE_MODE_LABELS, ForceMode } from './PhysicsEngine';
import { SavedScene, decodeScene, encodeScene } from './serialization';
import { FIELD_MODE_LABELS, FieldMode } from './VectorField';

/**
 * Sample the field slightly beyond the viewport so arrows do not pop in at the
 * edges while panning.
 */
const FIELD_MARGIN_PX = 60;

/** Drag pixels to world velocity. A full-screen drag is a fast shot. */
const DRAG_TO_VELOCITY = 0.05;

/**
 * How many bodies the list names individually before summarising the rest.
 *
 * The panel is 250px wide and scrolls at 105px tall, so a list of hundreds was
 * never readable; what it was, was expensive to rebuild.
 */
const MAX_LISTED_PARTICLES = 40;

/**
 * How long a shared link can get before it is worth warning about.
 *
 * Browsers handle far more than this, but chat clients, mail clients and issue
 * trackers all have their own opinions and 2,000 characters is the length none
 * of them argue with. A hand-built scene of twenty bodies is about 900.
 */
const COMFORTABLE_LINK_LENGTH = 2000;

/** Typed lookup — every one of these ids exists in index.html. */
function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing UI element #${id}`);
  return found as T;
}

/**
 * Main sketch for the gravity simulator
 */
const sketch = (p: p5) => {
  let engine: PhysicsEngine;
  let renderer: Renderer;
  let camera: Camera;
  /** The canvas element itself — what mouse events are checked against. */
  let canvasElement: HTMLCanvasElement;

  // UI state
  let isPaused = false;
  let isDrawingVelocity = false;
  let velocityStart: { x: number; y: number } | null = null;
  let selectedMass = 200;
  let isPanning = false;
  /**
   * Trail length for bodies the user adds, kept in step with the loaded scene
   * so a body dropped into the figure-eight draws the same length of trail as
   * the three already there.
   */
  let sceneTrailLength = new Particle(0, 0).maxTrailLength;
  /** How many bodies the particle list is currently showing. */
  let listedParticleCount = 0;
  /**
   * The fragment this page last wrote, so its own writes can be told apart from
   * a link someone pasted into the address bar.
   */
  let lastWrittenHash = '';

  // HTML controls
  const massSlider = el<HTMLInputElement>('massSlider');
  const massValue = el('massValue');
  const rangeSlider = el<HTMLInputElement>('rangeSlider');
  const rangeValue = el('rangeValue');
  const objectSizeSlider = el<HTMLInputElement>('objectSizeSlider');
  const objectSizeValue = el('objectSizeValue');
  const arrowSizeSlider = el<HTMLInputElement>('arrowSizeSlider');
  const arrowSizeValue = el('arrowSizeValue');
  const zoomValue = el('zoomValue');
  const resetCameraBtn = el('resetCameraBtn');
  const fieldModeSelect = el<HTMLSelectElement>('fieldModeSelect');
  const presetSelect = el<HTMLSelectElement>('presetSelect');
  const reloadPresetBtn = el('reloadPresetBtn');
  const integratorSelect = el<HTMLSelectElement>('integratorSelect');
  const adaptiveSteppingCheckbox = el<HTMLInputElement>('adaptiveStepping');
  const collisionSelect = el<HTMLSelectElement>('collisionSelect');
  const forceModeSelect = el<HTMLSelectElement>('forceModeSelect');
  const shareBtn = el('shareBtn');
  const shareStatus = el('shareStatus');
  const legendTitle = el('legendTitle');
  const legendMin = el('legendMin');
  const legendMax = el('legendMax');
  const legendScale = el('legendScale');
  const legendRamp = el('legendRamp');
  const subStepCount = el('subStepCount');
  const forceModeLabel = el('forceModeLabel');
  const showVectorsCheckbox = el<HTMLInputElement>('showVectors');
  const showParticleVectorsCheckbox = el<HTMLInputElement>('showParticleVectors');
  const showTrailsCheckbox = el<HTMLInputElement>('showTrails');
  const clearBtn = el('clearBtn');
  const pauseBtn = el('pauseBtn');
  const objectCount = el('objectCount');
  const particleList = el('particleList');

  p.setup = () => {
    const canvas = p.createCanvas(p.windowWidth, p.windowHeight);
    canvas.parent(document.body);
    canvasElement = canvas.elt as HTMLCanvasElement;

    // p5's default RGB colour mode is left in place. The renderer switches to
    // HSB only for the vector-field pass, where hue encodes force strength.

    engine = new PhysicsEngine(30);
    renderer = new Renderer(p, engine);
    camera = new Camera(p);

    // These dropdowns are the controls whose options come from TypeScript, so
    // they have to be filled in before anything reads their values.
    populatePresetOptions();
    populateFieldModeOptions();
    populateIntegratorOptions();
    populateCollisionOptions();
    populateForceModeOptions();

    setupUI();
    // Read the simulation's starting values out of the markup rather than
    // duplicating them here, so the controls and the simulation cannot disagree.
    // That includes the opening scene, which is whichever preset is selected.
    syncStateFromControls();

    // ...unless the page was opened with a scene in its fragment, which is the
    // whole point of the link being shareable.
    loadSceneFromLocation();

    updateObjectCount();
    updateZoomDisplay();
  };

  p.draw = () => {
    const view = camera.getViewBounds(FIELD_MARGIN_PX);

    if (isPaused) {
      // Keep the force arrows truthful while frozen: recompute them, but do
      // not integrate. Adding or deleting a body while paused still updates
      // every arrow.
      engine.computeForces();
    } else {
      engine.step();
    }
    engine.updateField(view);

    updateSubStepDisplay();
    updateLegend();
    // Merging removes bodies without anyone clicking anything, which the
    // particle list had never had to cope with: until collisions existed the
    // only way to lose a body was to press its delete button.
    if (engine.particles.length !== listedParticleCount) {
      updateObjectCount();
    }

    camera.apply();
    renderer.zoom = camera.zoom;
    renderer.draw();

    if (isDrawingVelocity && velocityStart) {
      const worldEnd = camera.screenToWorld(p.mouseX, p.mouseY);
      renderer.drawVelocityPreview(velocityStart.x, velocityStart.y, worldEnd.x, worldEnd.y);
    }

    camera.reset();
  };

  p.mousePressed = (event?: MouseEvent) => {
    if (!isCanvasEvent(event)) {
      return;
    }

    // Middle-drag or Ctrl+drag pans
    if (p.mouseButton === p.CENTER || (p.mouseButton === p.LEFT && p.keyIsDown(p.CONTROL))) {
      camera.startPan(p.mouseX, p.mouseY);
      isPanning = true;
      return;
    }

    // Left-drag places a body and aims its initial velocity
    if (p.mouseButton === p.LEFT) {
      const worldPos = camera.screenToWorld(p.mouseX, p.mouseY);
      velocityStart = { x: worldPos.x, y: worldPos.y };
      isDrawingVelocity = true;
    }
  };

  p.mouseDragged = () => {
    if (isPanning) {
      camera.updatePan(p.mouseX, p.mouseY);
    }
  };

  p.mouseReleased = (event?: MouseEvent) => {
    if (isPanning) {
      camera.endPan();
      isPanning = false;
      return;
    }

    if (!isDrawingVelocity || !velocityStart) return;

    // Releasing anywhere but the canvas cancels, rather than dropping a body
    // underneath a panel or off the edge of the window.
    if (!isCanvasEvent(event)) {
      isDrawingVelocity = false;
      velocityStart = null;
      return;
    }

    const worldEnd = camera.screenToWorld(p.mouseX, p.mouseY);
    const placed = new Particle(
      velocityStart.x,
      velocityStart.y,
      selectedMass,
      (worldEnd.x - velocityStart.x) * DRAG_TO_VELOCITY,
      (worldEnd.y - velocityStart.y) * DRAG_TO_VELOCITY
    );
    placed.maxTrailLength = sceneTrailLength;
    engine.addParticle(placed);

    isDrawingVelocity = false;
    velocityStart = null;

    updateObjectCount();
  };

  p.mouseWheel = (event: WheelEvent) => {
    // Only claim the wheel over the canvas. Preventing the default first meant
    // the control panel could not be scrolled with the wheel at all, which
    // matters because it scrolls internally in a short window.
    if (!isCanvasEvent(event)) return;
    event.preventDefault();

    // Scrolling up (negative deltaY) zooms in.
    camera.zoomAt(p.mouseX, p.mouseY, -event.deltaY);
    updateZoomDisplay();
    return false;
  };

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
  };

  /**
   * Did this mouse event actually happen on the canvas?
   *
   * p5 listens on `window`, so every click in the page reaches these handlers,
   * including clicks on the control panels — and a click that is not on the
   * canvas must never place a body.
   *
   * This used to hit-test the pointer against the panels' bounding rectangles,
   * which is wrong for anything the browser draws *outside* the page: a native
   * `<select>` popup is an OS-level widget that opens over the canvas, so
   * choosing an option from any dropdown reported coordinates beyond every
   * panel's rectangle and dropped a body wherever the option had been. The
   * event's `target` knows what was really clicked; coordinates do not.
   *
   * An event p5 did not give us is treated as not-canvas: refusing to place a
   * body is the safe way to be wrong.
   */
  function isCanvasEvent(event?: Event): boolean {
    return !!event && event.target === canvasElement;
  }

  /**
   * Push every control's current value into the simulation.
   *
   * Called once at startup. Without it the sliders' markup values and the
   * objects' defaults drift apart — the mass slider read 200 while new bodies
   * were created with mass 50, and the range slider read 150 while the field
   * used 300.
   */
  function syncStateFromControls(): void {
    selectedMass = parseInt(massSlider.value, 10);
    massValue.textContent = massSlider.value;

    engine.vectorField.maxInfluenceRadius = parseInt(rangeSlider.value, 10);
    rangeValue.textContent = rangeSlider.value;

    renderer.particleSizeMultiplier = parseFloat(objectSizeSlider.value);
    objectSizeValue.textContent = renderer.particleSizeMultiplier.toFixed(1);

    renderer.arrowSizeMultiplier = parseFloat(arrowSizeSlider.value);
    arrowSizeValue.textContent = renderer.arrowSizeMultiplier.toFixed(1);

    engine.vectorField.fieldMode = fieldModeSelect.value as FieldMode;
    engine.integrator = integratorSelect.value as IntegratorName;
    engine.adaptiveStepping = adaptiveSteppingCheckbox.checked;
    engine.collisionMode = collisionSelect.value as CollisionMode;
    engine.forceMode = forceModeSelect.value as ForceMode;
    loadPreset(presetSelect.value);
    renderer.showVectorField = showVectorsCheckbox.checked;
    renderer.showParticleVectors = showParticleVectorsCheckbox.checked;
    renderer.showTrails = showTrailsCheckbox.checked;
  }

  /**
   * Wire up the controls.
   *
   * Native DOM listeners rather than p5's `select().input()` wrappers: p5's DOM
   * helpers are typed onto the p5 instance rather than onto p5.Element, so the
   * wrapper form does not typecheck, and half these controls were plain
   * elements already.
   */
  function setupUI(): void {
    massSlider.addEventListener('input', () => {
      selectedMass = parseInt(massSlider.value, 10);
      massValue.textContent = selectedMass.toString();
    });

    rangeSlider.addEventListener('input', () => {
      const range = parseInt(rangeSlider.value, 10);
      rangeValue.textContent = range.toString();
      engine.vectorField.maxInfluenceRadius = range;
    });

    objectSizeSlider.addEventListener('input', () => {
      const size = parseFloat(objectSizeSlider.value);
      objectSizeValue.textContent = size.toFixed(1);
      renderer.particleSizeMultiplier = size;
    });

    arrowSizeSlider.addEventListener('input', () => {
      const size = parseFloat(arrowSizeSlider.value);
      arrowSizeValue.textContent = size.toFixed(1);
      renderer.arrowSizeMultiplier = size;
    });

    showVectorsCheckbox.addEventListener('change', () => {
      renderer.showVectorField = showVectorsCheckbox.checked;
    });

    showParticleVectorsCheckbox.addEventListener('change', () => {
      renderer.showParticleVectors = showParticleVectorsCheckbox.checked;
    });

    showTrailsCheckbox.addEventListener('change', () => {
      renderer.showTrails = showTrailsCheckbox.checked;
    });

    fieldModeSelect.addEventListener('change', () => {
      engine.vectorField.fieldMode = fieldModeSelect.value as FieldMode;
    });

    presetSelect.addEventListener('change', () => {
      loadPreset(presetSelect.value);
      // Choosing a scene makes the address bar shareable without pressing
      // anything: the short form is a dozen characters.
      writeLocation(encodeScene({ preset: presetSelect.value }));
      setShareStatus('');
    });

    shareBtn.addEventListener('click', () => {
      void shareCurrentScene();
    });

    // A pasted link on the page you are already looking at changes the fragment
    // without reloading, and so do the back and forward buttons.
    window.addEventListener('hashchange', () => {
      if (window.location.hash.slice(1) === lastWrittenHash) return;
      loadSceneFromLocation();
    });

    integratorSelect.addEventListener('change', () => {
      engine.integrator = integratorSelect.value as IntegratorName;
    });

    adaptiveSteppingCheckbox.addEventListener('change', () => {
      engine.adaptiveStepping = adaptiveSteppingCheckbox.checked;
      updateSubStepDisplay();
    });

    collisionSelect.addEventListener('change', () => {
      engine.collisionMode = collisionSelect.value as CollisionMode;
    });

    forceModeSelect.addEventListener('change', () => {
      engine.forceMode = forceModeSelect.value as ForceMode;
    });

    // `change` does not fire when the same option is picked again, so replaying
    // the current scene after pushing it around needs its own button.
    reloadPresetBtn.addEventListener('click', () => {
      loadPreset(presetSelect.value);
    });

    resetCameraBtn.addEventListener('click', () => {
      camera.resetCamera();
      updateZoomDisplay();
    });

    clearBtn.addEventListener('click', () => {
      engine.clearParticles();
      updateObjectCount();
    });

    pauseBtn.addEventListener('click', () => {
      isPaused = !isPaused;
      pauseBtn.textContent = isPaused ? 'Resume' : 'Pause';
    });
  }

  /**
   * The scene as it stands right now: where every body actually is, not where
   * it started.
   *
   * That is the useful thing to share — "look at what this turned into" — and
   * it is why saving is a button rather than something that happens when a
   * preset loads.
   */
  function currentScene(): SavedScene {
    return {
      bodies: engine.particles.map((particle) => ({
        x: particle.position.x,
        y: particle.position.y,
        mass: particle.mass,
        vx: particle.velocity.x,
        vy: particle.velocity.y,
      })),
      camera: { x: camera.x, y: camera.y, zoom: camera.zoom },
      trailLength: sceneTrailLength,
      showVectorField: showVectorsCheckbox.checked,
      showParticleVectors: showParticleVectorsCheckbox.checked,
      showTrails: showTrailsCheckbox.checked,
      integrator: engine.integrator,
      collisionMode: engine.collisionMode,
      forceMode: engine.forceMode,
      adaptiveStepping: engine.adaptiveStepping,
    };
  }

  /**
   * Put a saved scene into the running simulation.
   *
   * Every field is optional and an absent one is left alone, so a scene that is
   * only `s=binary` loads a preset and a scene with bodies but no camera keeps
   * the camera where it is.
   */
  function applyScene(scene: SavedScene): void {
    if (scene.preset !== undefined) {
      if (!getPreset(scene.preset)) {
        setShareStatus(`No scene called "${scene.preset}"`);
        return;
      }
      presetSelect.value = scene.preset;
      loadPreset(scene.preset);
    }

    if (scene.integrator !== undefined) {
      engine.integrator = scene.integrator;
      integratorSelect.value = scene.integrator;
    }
    if (scene.collisionMode !== undefined) {
      engine.collisionMode = scene.collisionMode;
      collisionSelect.value = scene.collisionMode;
    }
    if (scene.forceMode !== undefined) {
      engine.forceMode = scene.forceMode;
      forceModeSelect.value = scene.forceMode;
    }
    if (scene.adaptiveStepping !== undefined) {
      engine.adaptiveStepping = scene.adaptiveStepping;
      adaptiveSteppingCheckbox.checked = scene.adaptiveStepping;
    }

    if (scene.trailLength !== undefined) sceneTrailLength = scene.trailLength;

    if (scene.showVectorField !== undefined) {
      showVectorsCheckbox.checked = scene.showVectorField;
      renderer.showVectorField = scene.showVectorField;
    }
    if (scene.showParticleVectors !== undefined) {
      showParticleVectorsCheckbox.checked = scene.showParticleVectors;
      renderer.showParticleVectors = scene.showParticleVectors;
    }
    if (scene.showTrails !== undefined) {
      showTrailsCheckbox.checked = scene.showTrails;
      renderer.showTrails = scene.showTrails;
    }

    if (scene.bodies) {
      engine.clearParticles();
      for (const body of scene.bodies) {
        const particle = new Particle(body.x, body.y, body.mass, body.vx, body.vy);
        particle.maxTrailLength = sceneTrailLength;
        engine.addParticle(particle);
      }
      updateObjectCount();
    }

    if (scene.camera) {
      camera.resetCameraTo(scene.camera.zoom);
      camera.x = scene.camera.x;
      camera.y = scene.camera.y;
      updateZoomDisplay();
    }
  }

  /** Load whatever scene the address bar is carrying, if it is carrying one. */
  function loadSceneFromLocation(): void {
    const fragment = window.location.hash.slice(1);
    if (fragment === '') return;

    const result = decodeScene(decodeURIComponent(fragment));
    if ('error' in result) {
      // Say so rather than silently showing the default scene, or the link
      // looks like it worked and quietly did not.
      setShareStatus(`Could not read that link: ${result.error}`);
      return;
    }

    applyScene(result.scene);
    setShareStatus(result.scene.bodies ? 'Loaded the scene from this link' : '');
  }

  /**
   * Write a scene into the address bar without adding a history entry.
   *
   * `replaceState` rather than assigning to `location.hash`: choosing four
   * scenes in a row should not mean pressing Back four times to leave.
   */
  function writeLocation(encoded: string): void {
    lastWrittenHash = encoded;
    window.history.replaceState(null, '', `#${encoded}`);
  }

  async function shareCurrentScene(): Promise<void> {
    const encoded = encodeScene(currentScene());
    writeLocation(encoded);

    const url = window.location.href;
    const size =
      url.length > COMFORTABLE_LINK_LENGTH
        ? ` (${url.length} characters — long for a link, but it is in the address bar)`
        : '';

    try {
      await navigator.clipboard.writeText(url);
      setShareStatus(`Link copied${size}`);
    } catch {
      // Clipboard access needs a secure context and the browser's permission,
      // and neither is guaranteed. The link is in the address bar either way,
      // which is the part that matters.
      setShareStatus(`Link is in the address bar${size}`);
    }
  }

  function setShareStatus(message: string): void {
    shareStatus.textContent = message;
  }

  /**
   * Fill the scheme dropdown from `INTEGRATOR_LABELS`, and select whichever one
   * the engine defaults to — the engine owns that decision, not the markup.
   */
  function populateIntegratorOptions(): void {
    integratorSelect.replaceChildren();

    for (const scheme of INTEGRATOR_LABELS) {
      const option = document.createElement('option');
      option.value = scheme.id;
      option.textContent = scheme.label;
      integratorSelect.append(option);
    }

    integratorSelect.value = engine.integrator;
  }

  /** Fill the field dropdown from `FIELD_MODE_LABELS`. */
  function populateFieldModeOptions(): void {
    fieldModeSelect.replaceChildren();

    for (const mode of FIELD_MODE_LABELS) {
      const option = document.createElement('option');
      option.value = mode.id;
      option.textContent = mode.label;
      fieldModeSelect.append(option);
    }

    fieldModeSelect.value = engine.vectorField.fieldMode;
  }

  /**
   * Fill the force dropdown from `FORCE_MODE_LABELS`, selecting the engine's
   * default.
   */
  function populateForceModeOptions(): void {
    forceModeSelect.replaceChildren();

    for (const mode of FORCE_MODE_LABELS) {
      const option = document.createElement('option');
      option.value = mode.id;
      option.textContent = mode.label;
      forceModeSelect.append(option);
    }

    forceModeSelect.value = engine.forceMode;
  }

  /**
   * Fill the contact dropdown from `COLLISION_MODE_LABELS`, selecting whatever
   * the engine defaults to.
   */
  function populateCollisionOptions(): void {
    collisionSelect.replaceChildren();

    for (const mode of COLLISION_MODE_LABELS) {
      const option = document.createElement('option');
      option.value = mode.id;
      option.textContent = mode.label;
      collisionSelect.append(option);
    }

    collisionSelect.value = engine.collisionMode;
  }

  /**
   * Fill the scene dropdown from `PRESETS` and select the default.
   *
   * Deliberately not written into index.html: unlike a slider's starting value,
   * a scene is initial conditions plus the orbital arithmetic behind them, so
   * duplicating the list in markup would be two sources that can disagree.
   */
  function populatePresetOptions(): void {
    presetSelect.replaceChildren();

    for (const preset of PRESETS) {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.name;
      option.title = preset.summary;
      presetSelect.append(option);
    }

    presetSelect.value = DEFAULT_PRESET_ID;
  }

  /**
   * Replace the scene with a preset and frame the camera on it.
   *
   * Leaves the pause state alone — loading a scene while paused is a reasonable
   * way to inspect its initial forces, and `draw()` keeps the arrows live.
   */
  function loadPreset(id: string): void {
    const preset = getPreset(id);
    if (!preset) return;

    engine.clearParticles();
    for (const particle of presetParticles(preset)) {
      if (preset.trailLength !== undefined) particle.maxTrailLength = preset.trailLength;
      sceneTrailLength = particle.maxTrailLength;
      engine.addParticle(particle);
    }

    camera.resetCameraTo(preset.zoom);

    // Overlays are part of a scene's setup, the same way its zoom and trail
    // length are, and a scene that says nothing wants them on. Applying this on
    // every load rather than only when a preset asks is what stops the galaxy's
    // settings from following you into the next scene: it switches both off,
    // and without this the scene loaded afterwards inherited a blank canvas
    // with no indication why.
    const wantsField = preset.showVectorField ?? true;
    const wantsVectors = preset.showParticleVectors ?? true;

    showVectorsCheckbox.checked = wantsField;
    renderer.showVectorField = wantsField;
    showParticleVectorsCheckbox.checked = wantsVectors;
    renderer.showParticleVectors = wantsVectors;

    updateObjectCount();
    updateZoomDisplay();
  }

  function updateObjectCount(): void {
    listedParticleCount = engine.particles.length;
    objectCount.textContent = listedParticleCount.toString();
    updateParticleList();
  }

  /**
   * Rebuild the per-particle list with its delete buttons.
   *
   * Capped: a scene can now hold hundreds of bodies, and merging rebuilds this
   * every time the count changes. Four hundred rows of DOM, thrown away and
   * rebuilt several times a second, costs more than the simulation does.
   */
  function updateParticleList(): void {
    particleList.replaceChildren();

    const shown = engine.particles.slice(0, MAX_LISTED_PARTICLES);
    const hidden = engine.particles.length - shown.length;

    shown.forEach((particle, index) => {
      const item = document.createElement('div');
      item.className = 'particle-item';

      const info = document.createElement('span');
      info.textContent = `#${index + 1} - Mass: ${Math.round(particle.mass)}`;

      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = '✕';
      deleteBtn.title = 'Delete this particle';
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        engine.removeParticle(particle);
        updateObjectCount();
      });

      item.append(info, deleteBtn);
      particleList.append(item);
    });

    if (hidden > 0) {
      const note = document.createElement('div');
      note.style.cssText = 'font-size: 11px; color: #666; padding: 4px;';
      note.textContent = `...and ${hidden} more`;
      particleList.append(note);
    }
  }

  /**
   * Show how finely the last frame had to be sliced.
   *
   * Worth surfacing rather than hiding: it is the difference between "this
   * close pass is being resolved" and "the frame rate just dropped and you
   * cannot see why", and at the cap it is the honest signal that the encounter
   * is beyond what a frame can resolve.
   */
  /**
   * Say what the colours are worth, in the units the simulation actually uses.
   *
   * The field's arrows are normalized against the range present in the current
   * frame — that is what keeps them legible across the ~10^6 span the sliders
   * can produce — so the same red means something different from one frame to
   * the next. Printing the two ends of the range is what turns a relative
   * picture into a readable one.
   */
  function updateLegend(): void {
    const mode = engine.vectorField.fieldMode;
    const scale = renderer.fieldScale;

    // Contours and the heightmap draw the same scalar — the potential — one as
    // level sets and one as shading, so they report the same units.
    const showsPotential = mode === 'contours' || mode === 'heightmap';
    const title = showsPotential
      ? mode === 'contours'
        ? 'Equipotentials:'
        : 'Potential:'
      : mode === 'streamlines'
        ? 'Streamlines:'
        : 'Vector Field:';
    if (legendTitle.textContent !== title) legendTitle.textContent = title;

    if (mode === 'streamlines') {
      // A streamline has a direction but no magnitude, so the colour ramp is
      // not describing anything and is hidden rather than left to mislead.
      legendRamp.style.display = 'none';
      // Cleared as well as hidden: a hidden element still holding last mode's
      // numbers is a stale reading waiting to be believed.
      setLegendText(legendMin, '');
      setLegendText(legendMax, '');
      setLegendText(legendScale, 'direction of the field; strength not shown');
      return;
    }

    legendRamp.style.display = '';

    if (!scale) {
      setLegendText(legendMin, '—');
      setLegendText(legendMax, '—');
      return;
    }

    setLegendText(legendMax, format(scale.max));
    setLegendText(legendMin, format(scale.min));
    setLegendText(
      legendScale,
      showsPotential ? 'log scale, potential per unit mass' : 'log scale, force per unit mass'
    );
  }

  function setLegendText(element: HTMLElement, text: string): void {
    if (element.textContent !== text) element.textContent = text;
  }

  /** Two significant figures, which is all a legend has room to mean. */
  function format(value: number): string {
    if (!Number.isFinite(value) || value === 0) return '0';

    const [mantissa, exponent] = value.toExponential(1).split('e');
    const power = Number(exponent);
    return power === 0 ? mantissa : `${mantissa}e${power}`;
  }

  function updateSubStepDisplay(): void {
    const label = isPaused ? '—' : engine.lastSubSteps.toString();
    if (subStepCount.textContent !== label) subStepCount.textContent = label;

    // Whether the approximation is in play is worth saying out loud, since on
    // `auto` it switches itself on as a scene grows.
    const forces = engine.usingBarnesHut() ? 'tree' : 'exact';
    if (forceModeLabel.textContent !== forces) forceModeLabel.textContent = forces;
  }

  function updateZoomDisplay(): void {
    zoomValue.textContent = camera.getZoomPercent().toString();
  }
};

// Create and run the sketch
new p5(sketch);

import p5 from 'p5';
import { PhysicsEngine } from './PhysicsEngine';
import { Renderer } from './Renderer';
import { Particle } from './Particle';
import { Camera } from './Camera';

/**
 * Sample the field slightly beyond the viewport so arrows do not pop in at the
 * edges while panning.
 */
const FIELD_MARGIN_PX = 60;

/** Drag pixels to world velocity. A full-screen drag is a fast shot. */
const DRAG_TO_VELOCITY = 0.05;

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

  // UI state
  let isPaused = false;
  let isDrawingVelocity = false;
  let velocityStart: { x: number; y: number } | null = null;
  let selectedMass = 200;
  let isPanning = false;

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
  const gridModeSelect = el<HTMLSelectElement>('gridModeSelect');
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

    // p5's default RGB colour mode is left in place. The renderer switches to
    // HSB only for the vector-field pass, where hue encodes force strength.

    engine = new PhysicsEngine(30);
    renderer = new Renderer(p, engine);
    camera = new Camera(p);

    setupUI();
    // Read the simulation's starting values out of the markup rather than
    // duplicating them here, so the controls and the simulation cannot disagree.
    syncStateFromControls();

    // Two equal bodies in a mutual orbit, straddling the world origin.
    engine.addParticle(new Particle(-200, 0, 100, 0, 0.5));
    engine.addParticle(new Particle(200, 0, 100, 0, -0.5));

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

    camera.apply();
    renderer.draw();

    if (isDrawingVelocity && velocityStart) {
      const worldEnd = camera.screenToWorld(p.mouseX, p.mouseY);
      renderer.drawVelocityPreview(velocityStart.x, velocityStart.y, worldEnd.x, worldEnd.y);
    }

    camera.reset();
  };

  p.mousePressed = () => {
    if (p.mouseX < 0 || p.mouseX > p.width || p.mouseY < 0 || p.mouseY > p.height) {
      return;
    }
    if (isMouseOverUI()) {
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

  p.mouseReleased = () => {
    if (isPanning) {
      camera.endPan();
      isPanning = false;
      return;
    }

    if (!isDrawingVelocity || !velocityStart) return;

    // Dragging onto a panel cancels rather than dropping a body underneath it
    if (isMouseOverUI()) {
      isDrawingVelocity = false;
      velocityStart = null;
      return;
    }

    const worldEnd = camera.screenToWorld(p.mouseX, p.mouseY);
    engine.addParticle(
      new Particle(
        velocityStart.x,
        velocityStart.y,
        selectedMass,
        (worldEnd.x - velocityStart.x) * DRAG_TO_VELOCITY,
        (worldEnd.y - velocityStart.y) * DRAG_TO_VELOCITY
      )
    );

    isDrawingVelocity = false;
    velocityStart = null;

    updateObjectCount();
  };

  p.mouseWheel = (event: WheelEvent) => {
    event.preventDefault();
    if (isMouseOverUI()) return;

    // Scrolling up (negative deltaY) zooms in.
    camera.zoomAt(p.mouseX, p.mouseY, -event.deltaY);
    updateZoomDisplay();
    return false;
  };

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
  };

  /**
   * Is the pointer over one of the floating panels? Those swallow the click so
   * it does not also place a particle on the canvas beneath.
   */
  function isMouseOverUI(): boolean {
    return ['controls', 'info', 'legend'].some((id) => {
      const element = document.getElementById(id);
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      return (
        p.mouseX >= rect.left &&
        p.mouseX <= rect.right &&
        p.mouseY >= rect.top &&
        p.mouseY <= rect.bottom
      );
    });
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

    engine.vectorField.gridMode = gridModeSelect.value as 'uniform' | 'adaptive';
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

    gridModeSelect.addEventListener('change', () => {
      engine.vectorField.gridMode = gridModeSelect.value as 'uniform' | 'adaptive';
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

  function updateObjectCount(): void {
    objectCount.textContent = engine.particles.length.toString();
    updateParticleList();
  }

  /**
   * Rebuild the per-particle list with its delete buttons.
   */
  function updateParticleList(): void {
    particleList.replaceChildren();

    engine.particles.forEach((particle, index) => {
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
  }

  function updateZoomDisplay(): void {
    zoomValue.textContent = camera.getZoomPercent().toString();
  }
};

// Create and run the sketch
new p5(sketch);

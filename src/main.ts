import p5 from 'p5';
import { PhysicsEngine } from './PhysicsEngine';
import { Renderer } from './Renderer';
import { Particle } from './Particle';
import { Camera } from './Camera';

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
  let selectedMass = 50;
  let isPanningWithMiddleMouse = false;

  // HTML elements
  let massSlider: p5.Element;
  let massValue: HTMLElement;
  let rangeSlider: p5.Element;
  let rangeValue: HTMLElement;
  let objectSizeSlider: p5.Element;
  let objectSizeValue: HTMLElement;
  let arrowSizeSlider: p5.Element;
  let arrowSizeValue: HTMLElement;
  let zoomValue: HTMLElement;
  let resetCameraBtn: HTMLElement;
  let gridModeSelect: p5.Element;
  let showVectorsCheckbox: p5.Element;
  let showParticleVectorsCheckbox: p5.Element;
  let showTrailsCheckbox: p5.Element;
  let clearBtn: HTMLElement;
  let pauseBtn: HTMLElement;
  let objectCount: HTMLElement;
  let particleList: HTMLElement;

  p.setup = () => {
    const canvas = p.createCanvas(p.windowWidth, p.windowHeight);
    canvas.parent(document.body);
    
    p.colorMode(p.HSB, 360, 100, 100, 100);

    // Initialize physics engine, renderer, and camera
    engine = new PhysicsEngine(p.width, p.height);
    renderer = new Renderer(p, engine);
    camera = new Camera(p);
    
    // Camera starts at (0,0) which puts world origin at screen center
    // This is the default, just being explicit

    // Setup UI controls
    setupUI();

    // Add initial particles at world center (0, 0) with some offset
    engine.addParticle(new Particle(-200, 0, 100, 0, 0.5));
    engine.addParticle(new Particle(200, 0, 100, 0, -0.5));
    
    updateObjectCount();
    updateZoomDisplay();
  };

  p.draw = () => {
    if (!isPaused) {
      engine.update();
    }

    // Apply camera transformation for world objects
    camera.apply();
    renderer.draw();

    // Draw velocity preview arrow in world space
    if (isDrawingVelocity && velocityStart) {
      const worldEnd = camera.screenToWorld(p.mouseX, p.mouseY);
      renderer.drawVelocityPreview(
        velocityStart.x,
        velocityStart.y,
        worldEnd.x,
        worldEnd.y
      );
    }
    
    camera.reset();
  };

  p.mousePressed = () => {
    // Check if click is outside canvas or on UI elements
    if (p.mouseX < 0 || p.mouseX > p.width || p.mouseY < 0 || p.mouseY > p.height) {
      return;
    }

    // Check if mouse is over any UI element
    if (isMouseOverUI()) {
      return;
    }

    // Middle mouse button (button 1) or Ctrl+Click for panning
    if (p.mouseButton === p.CENTER || (p.mouseButton === p.LEFT && p.keyIsDown(p.CONTROL))) {
      camera.startPan(p.mouseX, p.mouseY);
      isPanningWithMiddleMouse = true;
      return;
    }

    // Left mouse button for adding particles
    if (p.mouseButton === p.LEFT) {
      // Convert screen coordinates to world coordinates
      const worldPos = camera.screenToWorld(p.mouseX, p.mouseY);
      velocityStart = { x: worldPos.x, y: worldPos.y };
      isDrawingVelocity = true;
    }
  };

  p.mouseDragged = () => {
    // Update panning if middle mouse is down
    if (isPanningWithMiddleMouse) {
      camera.updatePan(p.mouseX, p.mouseY);
      return;
    }
  };

  p.mouseReleased = () => {
    // End panning
    if (isPanningWithMiddleMouse) {
      camera.endPan();
      isPanningWithMiddleMouse = false;
      return;
    }

    if (!isDrawingVelocity || !velocityStart) return;

    // Check if mouse is over UI (don't create particle if dragging over UI)
    if (isMouseOverUI()) {
      isDrawingVelocity = false;
      velocityStart = null;
      return;
    }

    // Convert screen coordinates to world coordinates
    const worldEnd = camera.screenToWorld(p.mouseX, p.mouseY);
    
    // Calculate velocity from drag
    const vx = (worldEnd.x - velocityStart.x) * 0.05;
    const vy = (worldEnd.y - velocityStart.y) * 0.05;

    // Add particle with velocity
    const particle = new Particle(
      velocityStart.x,
      velocityStart.y,
      selectedMass,
      vx,
      vy
    );
    engine.addParticle(particle);

    // Reset drawing state
    isDrawingVelocity = false;
    velocityStart = null;
    
    updateObjectCount();
  };

  p.mouseWheel = (event: WheelEvent) => {
    // Prevent default scrolling
    event.preventDefault();
    
    // Don't zoom if mouse is over UI
    if (isMouseOverUI()) {
      return;
    }
    
    // Zoom at mouse position
    camera.zoomAt(p.mouseX, p.mouseY, -event.delta);
    updateZoomDisplay();
    
    return false;
  };

  p.windowResized = () => {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
    engine.resize(p.width, p.height);
  };

  /**
   * Check if mouse is over any UI element
   */
  function isMouseOverUI(): boolean {
    // Get all UI container elements
    const controls = document.getElementById('controls');
    const info = document.getElementById('info');
    const legend = document.getElementById('legend');

    return isMouseOverElement(controls) || 
           isMouseOverElement(info) || 
           isMouseOverElement(legend);
  }

  /**
   * Check if mouse is over a specific element
   */
  function isMouseOverElement(element: HTMLElement | null): boolean {
    if (!element) return false;

    const rect = element.getBoundingClientRect();
    return p.mouseX >= rect.left && 
           p.mouseX <= rect.right && 
           p.mouseY >= rect.top && 
           p.mouseY <= rect.bottom;
  }

  /**
   * Setup UI controls and event handlers
   */
  function setupUI() {
    // Mass slider
    massSlider = p.select('#massSlider') as p5.Element;
    massValue = document.getElementById('massValue')!;
    massSlider.input(() => {
      selectedMass = parseInt((massSlider.elt as HTMLInputElement).value);
      massValue.textContent = selectedMass.toString();
    });

    // Vector range slider
    rangeSlider = p.select('#rangeSlider') as p5.Element;
    rangeValue = document.getElementById('rangeValue')!;
    rangeSlider.input(() => {
      const range = parseInt((rangeSlider.elt as HTMLInputElement).value);
      rangeValue.textContent = range.toString();
      engine.vectorField.maxInfluenceRadius = range;
    });

    // Object size slider
    objectSizeSlider = p.select('#objectSizeSlider') as p5.Element;
    objectSizeValue = document.getElementById('objectSizeValue')!;
    objectSizeSlider.input(() => {
      const size = parseFloat((objectSizeSlider.elt as HTMLInputElement).value);
      objectSizeValue.textContent = size.toFixed(1);
      renderer.particleSizeMultiplier = size;
    });

    // Arrow size slider
    arrowSizeSlider = p.select('#arrowSizeSlider') as p5.Element;
    arrowSizeValue = document.getElementById('arrowSizeValue')!;
    arrowSizeSlider.input(() => {
      const size = parseFloat((arrowSizeSlider.elt as HTMLInputElement).value);
      arrowSizeValue.textContent = size.toFixed(1);
      renderer.arrowSizeMultiplier = size;
    });

    // Show vectors checkbox
    showVectorsCheckbox = p.select('#showVectors') as p5.Element;
    showVectorsCheckbox.changed(() => {
      renderer.showVectorField = (showVectorsCheckbox.elt as HTMLInputElement).checked;
    });

    // Grid mode select
    gridModeSelect = p.select('#gridModeSelect') as p5.Element;
    gridModeSelect.changed(() => {
      const mode = (gridModeSelect.elt as HTMLSelectElement).value as 'uniform' | 'adaptive';
      engine.vectorField.gridMode = mode;
    });
    
    // Prevent mouse events on select from creating particles
    (gridModeSelect.elt as HTMLSelectElement).addEventListener('mousedown', (e) => {
      e.stopPropagation();
    });
    (gridModeSelect.elt as HTMLSelectElement).addEventListener('click', (e) => {
      e.stopPropagation();
    });

    // Show particle vectors checkbox
    showParticleVectorsCheckbox = p.select('#showParticleVectors') as p5.Element;
    showParticleVectorsCheckbox.changed(() => {
      renderer.showParticleVectors = (showParticleVectorsCheckbox.elt as HTMLInputElement).checked;
    });

    // Show trails checkbox
    showTrailsCheckbox = p.select('#showTrails') as p5.Element;
    showTrailsCheckbox.changed(() => {
      renderer.showTrails = (showTrailsCheckbox.elt as HTMLInputElement).checked;
    });

    // Camera reset button
    zoomValue = document.getElementById('zoomValue')!;
    resetCameraBtn = document.getElementById('resetCameraBtn')!;
    resetCameraBtn.addEventListener('click', () => {
      camera.x = 0;
      camera.y = 0;
      camera.zoom = 1.0;
      updateZoomDisplay();
    });

    // Clear button
    clearBtn = document.getElementById('clearBtn')!;
    clearBtn.addEventListener('click', () => {
      engine.clearParticles();
      updateObjectCount();
    });

    // Pause button
    pauseBtn = document.getElementById('pauseBtn')!;
    pauseBtn.addEventListener('click', () => {
      isPaused = !isPaused;
      pauseBtn.textContent = isPaused ? 'Resume' : 'Pause';
    });

    // Object count
    objectCount = document.getElementById('objectCount')!;
    
    // Particle list
    particleList = document.getElementById('particleList')!;
  }

  /**
   * Update the object count display
   */
  function updateObjectCount() {
    objectCount.textContent = engine.particles.length.toString();
    updateParticleList();
  }

  /**
   * Update the particle list with delete buttons
   */
  function updateParticleList() {
    particleList.innerHTML = '';
    
    if (engine.particles.length === 0) {
      return;
    }

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
      
      item.appendChild(info);
      item.appendChild(deleteBtn);
      particleList.appendChild(item);
    });
  }

  /**
   * Update the zoom display
   */
  function updateZoomDisplay() {
    zoomValue.textContent = camera.getZoomPercent().toString();
  }
};

// Create and run the sketch
new p5(sketch);

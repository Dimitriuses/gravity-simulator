import { describe, it, expect } from 'vitest';
import type p5 from 'p5';
import { Camera } from '../src/Camera';

/**
 * The camera only reads `width` and `height` off the p5 instance; the drawing
 * calls it makes (translate/scale/resetMatrix) are exercised in the browser
 * smoke test instead. A stub keeps the coordinate maths testable under Node.
 */
function makeCamera(width = 1280, height = 800): Camera {
  const stub = {
    width,
    height,
    translate: () => {},
    scale: () => {},
    resetMatrix: () => {},
  };
  return new Camera(stub as unknown as p5);
}

describe('Camera', () => {
  it('puts the world origin at the centre of the canvas by default', () => {
    const camera = makeCamera();
    expect(camera.worldToScreen(0, 0)).toMatchObject({ x: 640, y: 400 });
    expect(camera.screenToWorld(640, 400)).toMatchObject({ x: 0, y: 0 });
  });

  it('round-trips screen and world coordinates at any zoom and pan', () => {
    const camera = makeCamera();
    camera.zoom = 2.35;
    camera.x = -412;
    camera.y = 77;

    const world = camera.screenToWorld(913, 122);
    const screen = camera.worldToScreen(world.x, world.y);

    expect(screen.x).toBeCloseTo(913, 9);
    expect(screen.y).toBeCloseTo(122, 9);
  });

  describe('zoomAt', () => {
    /**
     * The invariant that makes wheel-zoom feel right: whatever world point is
     * under the cursor before the zoom is still under it afterwards.
     */
    it('keeps the world point under the cursor fixed', () => {
      const camera = makeCamera();
      const cursor = { x: 900, y: 250 };
      const before = camera.screenToWorld(cursor.x, cursor.y);

      camera.zoomAt(cursor.x, cursor.y, 100);

      const after = camera.screenToWorld(cursor.x, cursor.y);
      expect(after.x).toBeCloseTo(before.x, 9);
      expect(after.y).toBeCloseTo(before.y, 9);
    });

    it('holds the invariant over a sequence of zooms at different points', () => {
      const camera = makeCamera();
      const probe = { x: 300, y: 700 };
      const anchor = camera.screenToWorld(probe.x, probe.y);

      camera.zoomAt(probe.x, probe.y, 100);
      camera.zoomAt(probe.x, probe.y, 100);
      camera.zoomAt(probe.x, probe.y, -100);
      camera.zoomAt(probe.x, probe.y, 250);

      const after = camera.screenToWorld(probe.x, probe.y);
      expect(after.x).toBeCloseTo(anchor.x, 6);
      expect(after.y).toBeCloseTo(anchor.y, 6);
    });

    it('treats one wheel notch as 10%', () => {
      const camera = makeCamera();
      camera.zoomAt(640, 400, 100); // scroll up = zoom in
      expect(camera.zoom).toBeCloseTo(1.1, 6);

      const zoomedIn = makeCamera();
      zoomedIn.zoomAt(640, 400, -100);
      expect(zoomedIn.zoom).toBeCloseTo(1 / 1.1, 6);
    });

    it('is proportional to the wheel delta, not a fixed step', () => {
      const small = makeCamera();
      const large = makeCamera();

      small.zoomAt(640, 400, 50);
      large.zoomAt(640, 400, 200);

      expect(large.zoom).toBeGreaterThan(small.zoom);
      // Two 50-unit deltas must equal one 100-unit delta.
      const twice = makeCamera();
      twice.zoomAt(640, 400, 50);
      twice.zoomAt(640, 400, 50);
      expect(twice.zoom).toBeCloseTo(1.1, 6);
    });

    it('clamps an absurd delta instead of crossing the whole range', () => {
      const camera = makeCamera();
      camera.zoomAt(640, 400, 100_000);
      // One event must not slam into the maximum.
      expect(camera.zoom).toBeLessThan(camera.maxZoom);
      expect(camera.zoom).toBeGreaterThan(1);
    });

    it('clamps to the zoom limits', () => {
      const zoomedOut = makeCamera();
      for (let i = 0; i < 200; i++) zoomedOut.zoomAt(640, 400, -100);
      expect(zoomedOut.zoom).toBeCloseTo(zoomedOut.minZoom, 9);

      const zoomedIn = makeCamera();
      for (let i = 0; i < 200; i++) zoomedIn.zoomAt(640, 400, 100);
      expect(zoomedIn.zoom).toBeCloseTo(zoomedIn.maxZoom, 9);
    });
  });

  describe('panning', () => {
    it('moves the camera opposite the drag, scaled by zoom', () => {
      const camera = makeCamera();
      camera.startPan(500, 500);
      camera.updatePan(600, 450);

      // Dragging right moves the camera left, so content follows the cursor.
      expect(camera.x).toBeCloseTo(-100, 9);
      expect(camera.y).toBeCloseTo(50, 9);
    });

    it('pans by fewer world units when zoomed in', () => {
      const camera = makeCamera();
      camera.zoom = 4;
      camera.startPan(500, 500);
      camera.updatePan(600, 500);

      expect(camera.x).toBeCloseTo(-25, 9);
    });

    it('ignores updates when no pan is in progress', () => {
      const camera = makeCamera();
      camera.updatePan(999, 999);
      expect(camera.x).toBe(0);
      expect(camera.y).toBe(0);

      camera.startPan(0, 0);
      expect(camera.isCurrentlyPanning()).toBe(true);
      camera.endPan();
      expect(camera.isCurrentlyPanning()).toBe(false);

      camera.updatePan(500, 500);
      expect(camera.x).toBe(0);
    });
  });

  describe('centerOn', () => {
    it('puts the given world point in the middle of the screen', () => {
      const camera = makeCamera(800, 600);
      camera.zoom = 2.5;

      camera.centerOn(140, -60);

      const screen = camera.worldToScreen(140, -60);
      expect(screen.x).toBeCloseTo(400, 9);
      expect(screen.y).toBeCloseTo(300, 9);
    });

    it('holds a moving body still on screen, wherever it goes', () => {
      // What following a body is, once the camera transform is taken out of it.
      const camera = makeCamera(800, 600);
      camera.zoom = 0.4;

      for (const [x, y] of [
        [0, 0],
        [3000, -1200],
        [-25000, 40000],
      ]) {
        camera.centerOn(x, y);
        const screen = camera.worldToScreen(x, y);

        expect(screen.x, `x at ${x},${y}`).toBeCloseTo(400, 9);
        expect(screen.y, `y at ${x},${y}`).toBeCloseTo(300, 9);
      }
    });

    it('stops a pan in progress rather than fighting it', () => {
      // A drag and a followed body both want to set the camera. Letting the
      // follow win silently leaves the pointer dragging a view that does not
      // move, which reads as the app having frozen.
      const camera = makeCamera(800, 600);
      camera.startPan(100, 100);
      expect(camera.isCurrentlyPanning()).toBe(true);

      camera.centerOn(500, 500);

      expect(camera.isCurrentlyPanning()).toBe(false);

      // ...and a drag that carries on after that does not move the camera.
      camera.updatePan(300, 220);
      expect(camera.x).toBe(500);
      expect(camera.y).toBe(500);
    });
  });

  describe('getViewBounds', () => {
    it('covers exactly the canvas at 100% zoom', () => {
      const bounds = makeCamera().getViewBounds();
      expect(bounds).toMatchObject({ minX: -640, minY: -400, maxX: 640, maxY: 400 });
    });

    it('grows as the camera zooms out', () => {
      const camera = makeCamera();
      camera.zoom = 0.5;
      const bounds = camera.getViewBounds();

      expect(bounds.maxX - bounds.minX).toBeCloseTo(2560, 9);
      expect(bounds.maxY - bounds.minY).toBeCloseTo(1600, 9);
    });

    it('follows the camera when panned', () => {
      const camera = makeCamera();
      camera.x = 10_000;
      camera.y = -5_000;
      const bounds = camera.getViewBounds();

      expect(bounds.minX).toBeCloseTo(9_360, 9);
      expect(bounds.maxX).toBeCloseTo(10_640, 9);
      expect(bounds.minY).toBeCloseTo(-5_400, 9);
      expect(bounds.maxY).toBeCloseTo(-4_600, 9);
    });

    it('adds the requested margin in screen pixels', () => {
      const camera = makeCamera();
      const plain = camera.getViewBounds();
      const padded = camera.getViewBounds(60);

      expect(padded.minX).toBeCloseTo(plain.minX - 60, 9);
      expect(padded.maxX).toBeCloseTo(plain.maxX + 60, 9);
    });
  });

  it('resets position and zoom together', () => {
    const camera = makeCamera();
    camera.x = 500;
    camera.y = -200;
    camera.zoom = 3.7;

    camera.resetCamera();

    expect(camera).toMatchObject({ x: 0, y: 0, zoom: 1 });
    expect(camera.getZoomPercent()).toBe(100);
  });

  describe('resetCameraTo', () => {
    it('recentres at the requested zoom', () => {
      const camera = makeCamera();
      camera.x = 500;
      camera.y = -200;

      camera.resetCameraTo(0.5);

      expect(camera).toMatchObject({ x: 0, y: 0, zoom: 0.5 });
      expect(camera.getZoomPercent()).toBe(50);
    });

    it('clamps to the zoom range, so a preset cannot ask for the impossible', () => {
      const camera = makeCamera();

      camera.resetCameraTo(50);
      expect(camera.zoom).toBe(camera.maxZoom);

      camera.resetCameraTo(0.0001);
      expect(camera.zoom).toBe(camera.minZoom);
    });
  });
});

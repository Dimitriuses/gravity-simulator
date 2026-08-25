import p5 from 'p5';
import { ViewBounds } from './VectorField';

/**
 * One mouse-wheel notch is |deltaY| ≈ 100 and should zoom by 10%, so the rate
 * is ln(1.1) / 100 per unit of wheel delta.
 */
const ZOOM_PER_WHEEL_UNIT = Math.log(1.1) / 100;

/** Some devices report deltas in the thousands; one event should not cross the whole range. */
const MAX_WHEEL_DELTA = 240;

/**
 * Camera class for handling zoom and pan transformations
 */
export class Camera {
  private p: p5;
  
  // Camera position (in world coordinates)
  x: number = 0;
  y: number = 0;
  
  // Zoom level (1.0 = normal, 2.0 = 2x zoom, 0.5 = zoomed out)
  zoom: number = 1.0;
  
  // Min and max zoom levels
  minZoom: number = 0.1;
  maxZoom: number = 5.0;
  
  // Panning state
  private isPanning: boolean = false;
  private panStartX: number = 0;
  private panStartY: number = 0;
  private cameraStartX: number = 0;
  private cameraStartY: number = 0;

  constructor(p: p5) {
    this.p = p;
  }

  /**
   * Apply camera transformation
   * Call this before drawing anything that should be affected by camera
   */
  apply(): void {
    this.p.translate(this.p.width / 2, this.p.height / 2);
    this.p.scale(this.zoom);
    this.p.translate(-this.x, -this.y);
  }

  /**
   * Reset camera transformation
   * Call this after drawing world objects, before drawing UI
   */
  reset(): void {
    this.p.resetMatrix();
  }

  /**
   * Convert screen coordinates to world coordinates
   */
  screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    const worldX = (screenX - this.p.width / 2) / this.zoom + this.x;
    const worldY = (screenY - this.p.height / 2) / this.zoom + this.y;
    return { x: worldX, y: worldY };
  }

  /**
   * Convert world coordinates to screen coordinates
   */
  worldToScreen(worldX: number, worldY: number): { x: number; y: number } {
    const screenX = (worldX - this.x) * this.zoom + this.p.width / 2;
    const screenY = (worldY - this.y) * this.zoom + this.p.height / 2;
    return { x: screenX, y: screenY };
  }

  /**
   * The rectangle of world space currently on screen.
   *
   * The vector field is built from this, so panning and zooming change what
   * gets sampled — without it the field stays pinned to a fixed box around the
   * world origin and visibly runs out as soon as the camera moves.
   *
   * `margin` extends the rectangle in screen pixels so arrows just off the edge
   * are still sampled and do not pop in at the border.
   */
  getViewBounds(margin: number = 0): ViewBounds {
    const topLeft = this.screenToWorld(-margin, -margin);
    const bottomRight = this.screenToWorld(this.p.width + margin, this.p.height + margin);
    return {
      minX: topLeft.x,
      minY: topLeft.y,
      maxX: bottomRight.x,
      maxY: bottomRight.y,
    };
  }

  /**
   * Start panning
   */
  startPan(mouseX: number, mouseY: number): void {
    this.isPanning = true;
    this.panStartX = mouseX;
    this.panStartY = mouseY;
    this.cameraStartX = this.x;
    this.cameraStartY = this.y;
  }

  /**
   * Update pan based on mouse movement
   */
  updatePan(mouseX: number, mouseY: number): void {
    if (!this.isPanning) return;
    
    const dx = (mouseX - this.panStartX) / this.zoom;
    const dy = (mouseY - this.panStartY) / this.zoom;
    
    this.x = this.cameraStartX - dx;
    this.y = this.cameraStartY - dy;
  }

  /**
   * End panning
   */
  endPan(): void {
    this.isPanning = false;
  }

  /**
   * Check if currently panning
   */
  isCurrentlyPanning(): boolean {
    return this.isPanning;
  }

  /**
   * Zoom in or out about a screen point, usually the mouse.
   *
   * The step is exponential in `delta` rather than a fixed ±10%, so one notch
   * of a mouse wheel (|deltaY| ≈ 100) gives the familiar 10% while a trackpad's
   * stream of small deltas scrolls smoothly instead of stepping. `delta` is
   * clamped first: some devices emit deltas in the thousands, which would
   * otherwise cross the whole zoom range in a single event.
   */
  zoomAt(screenX: number, screenY: number, delta: number): void {
    const worldBefore = this.screenToWorld(screenX, screenY);

    const clamped = Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, delta));
    this.zoom *= Math.exp(clamped * ZOOM_PER_WHEEL_UNIT);
    this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom));

    // Shift the camera so the world point under the cursor stays under it.
    const worldAfter = this.screenToWorld(screenX, screenY);
    this.x -= worldAfter.x - worldBefore.x;
    this.y -= worldAfter.y - worldBefore.y;
  }

  /**
   * Reset camera to default position and zoom
   */
  resetCamera(): void {
    this.resetCameraTo(1.0);
  }

  /**
   * Recentre on the world origin at a given zoom, clamped to the zoom range.
   *
   * Loading a preset uses this: a scene 2,400 world units across needs to be
   * framed on arrival rather than leaving the user to zoom out and find it.
   */
  resetCameraTo(zoom: number): void {
    this.x = 0;
    this.y = 0;
    this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, zoom));
  }

  /**
   * Get current zoom level as percentage
   */
  getZoomPercent(): number {
    return Math.round(this.zoom * 100);
  }
}

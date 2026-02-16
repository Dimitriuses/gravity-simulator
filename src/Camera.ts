import p5 from 'p5';

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
   * Zoom in or out centered on a point (usually mouse position)
   */
  zoomAt(screenX: number, screenY: number, delta: number): void {
    // Get world position before zoom
    const worldBefore = this.screenToWorld(screenX, screenY);
    
    // Apply zoom
    const zoomFactor = delta > 0 ? 1.1 : 0.9;
    this.zoom *= zoomFactor;
    
    // Clamp zoom
    this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom));
    
    // Get world position after zoom (if we don't adjust camera)
    const worldAfter = this.screenToWorld(screenX, screenY);
    
    // Adjust camera position to keep the same world point under the cursor
    // We want worldAfter to equal worldBefore, so we need to shift camera
    this.x -= worldAfter.x - worldBefore.x;
    this.y -= worldAfter.y - worldBefore.y;
  }

  /**
   * Reset camera to default position and zoom
   */
  resetCamera(): void {
    this.x = 0;
    this.y = 0;
    this.zoom = 1.0;
  }

  /**
   * Get current zoom level as percentage
   */
  getZoomPercent(): number {
    return Math.round(this.zoom * 100);
  }
}

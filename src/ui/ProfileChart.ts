// ============================================================
// GeoWear — ProfileChart
// 2D profile visualization of geodesic sections
// Shows radial distance vs arc length with irregularity coloring
// ============================================================

import type { DoubleGeodesic, GeodesicPoint } from '../types';

interface ViewTransform {
  offsetX: number;
  offsetY: number;
  scaleX: number;
  scaleY: number;
}

interface DataBounds {
  minArc: number;
  maxArc: number;
  minRadius: number;
  maxRadius: number;
}

export class ProfileChart {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private data: DoubleGeodesic | null = null;
  private sphereRadius: number = 0;
  private showSphere: boolean = true;
  
  // View state for pan/zoom
  private view: ViewTransform = { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 };
  private bounds: DataBounds = { minArc: 0, maxArc: 1, minRadius: 0, maxRadius: 1 };
  
  // Interaction state
  private isDragging = false;
  private lastMouseX = 0;
  private lastMouseY = 0;
  
  // Tooltip state
  private hoveredPoint: GeodesicPoint | null = null;
  
  // Layout constants
  private readonly MARGIN = { top: 20, right: 20, bottom: 40, left: 60 };
  private readonly COLORS = {
    regular: '#1a8f3e',
    irregular: '#d32f2f',
    sphere: '#0077cc',
    grid: '#e0e0e0',
    gridMajor: '#c0c0c0',
    text: '#333333',
    background: '#fafafa',
    pole: '#0077cc',
  };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    
    this.setupEvents();
    this.render();
  }

  private setupEvents(): void {
    // Mouse wheel for zoom
    this.canvas.addEventListener('wheel', (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      
      // Zoom centered on mouse position
      const rect = this.canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      
      // Convert mouse to data coordinates before zoom
      const dataX = this.screenToDataX(mouseX);
      const dataY = this.screenToDataY(mouseY);
      
      // Apply zoom
      this.view.scaleX *= factor;
      this.view.scaleY *= factor;
      
      // Clamp scale
      this.view.scaleX = Math.max(0.5, Math.min(10, this.view.scaleX));
      this.view.scaleY = Math.max(0.5, Math.min(10, this.view.scaleY));
      
      // Adjust offset to keep mouse point fixed
      const newScreenX = this.dataToScreenX(dataX);
      const newScreenY = this.dataToScreenY(dataY);
      this.view.offsetX += mouseX - newScreenX;
      this.view.offsetY += mouseY - newScreenY;
      
      this.render();
    });

    // Mouse drag for pan
    this.canvas.addEventListener('mousedown', (e: MouseEvent) => {
      this.isDragging = true;
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
      this.canvas.style.cursor = 'grabbing';
    });

    this.canvas.addEventListener('mousemove', (e: MouseEvent) => {
      const rect = this.canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      
      if (this.isDragging) {
        const dx = e.clientX - this.lastMouseX;
        const dy = e.clientY - this.lastMouseY;
        this.view.offsetX += dx;
        this.view.offsetY += dy;
        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;
        this.render();
      } else {
        // Hover to show tooltip
        this.updateHoveredPoint(mouseX, mouseY);
        this.render();
      }
    });

    this.canvas.addEventListener('mouseup', () => {
      this.isDragging = false;
      this.canvas.style.cursor = 'crosshair';
    });

    this.canvas.addEventListener('mouseleave', () => {
      this.isDragging = false;
      this.hoveredPoint = null;
      this.canvas.style.cursor = 'crosshair';
      this.render();
    });
  }

  /**
   * Set sphere radius for ideal sphere line.
   */
  setSphereRadius(radius: number): void {
    this.sphereRadius = radius;
    this.render();
  }

  /**
   * Toggle showing the ideal sphere line.
   */
  setShowSphere(show: boolean): void {
    this.showSphere = show;
    this.render();
  }

  /**
   * Set data to display.
   */
  setData(data: DoubleGeodesic): void {
    this.data = data;
    this.computeBounds();
    this.resetView();
  }

  private computeBounds(): void {
    if (!this.data || this.data.points.length === 0) {
      this.bounds = { minArc: 0, maxArc: 1, minRadius: 0, maxRadius: 1 };
      return;
    }

    const points = this.data.points;
    let minArc = Infinity, maxArc = -Infinity;
    let minRadius = Infinity, maxRadius = -Infinity;

    for (const pt of points) {
      const radius = this.getRadius(pt);
      minArc = Math.min(minArc, pt.arcLength);
      maxArc = Math.max(maxArc, pt.arcLength);
      minRadius = Math.min(minRadius, radius);
      maxRadius = Math.max(maxRadius, radius);
    }

    // Add some padding
    const arcPad = (maxArc - minArc) * 0.05;
    const radPad = (maxRadius - minRadius) * 0.1;
    
    this.bounds = {
      minArc: minArc - arcPad,
      maxArc: maxArc + arcPad,
      minRadius: minRadius - radPad,
      maxRadius: maxRadius + radPad,
    };
  }

  /**
   * Get radius (distance from sphere center) for a point.
   */
  private getRadius(pt: GeodesicPoint): number {
    // deviation is in μm, convert to mm and add to sphere radius
    return this.sphereRadius + pt.deviation / 1000;
  }

  /**
   * Reset view to show all data.
   */
  resetView(): void {
    this.view = { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 };
    this.render();
  }

  // Coordinate transforms
  private getPlotWidth(): number {
    return this.canvas.width - this.MARGIN.left - this.MARGIN.right;
  }

  private getPlotHeight(): number {
    return this.canvas.height - this.MARGIN.top - this.MARGIN.bottom;
  }

  private dataToScreenX(dataX: number): number {
    const normalized = (dataX - this.bounds.minArc) / (this.bounds.maxArc - this.bounds.minArc);
    return this.MARGIN.left + normalized * this.getPlotWidth() * this.view.scaleX + this.view.offsetX;
  }

  private dataToScreenY(dataY: number): number {
    // Y is inverted (higher values = lower on screen)
    const normalized = (dataY - this.bounds.minRadius) / (this.bounds.maxRadius - this.bounds.minRadius);
    return this.MARGIN.top + (1 - normalized) * this.getPlotHeight() * this.view.scaleY + this.view.offsetY;
  }

  private screenToDataX(screenX: number): number {
    const normalized = (screenX - this.MARGIN.left - this.view.offsetX) / (this.getPlotWidth() * this.view.scaleX);
    return this.bounds.minArc + normalized * (this.bounds.maxArc - this.bounds.minArc);
  }

  private screenToDataY(screenY: number): number {
    const normalized = 1 - (screenY - this.MARGIN.top - this.view.offsetY) / (this.getPlotHeight() * this.view.scaleY);
    return this.bounds.minRadius + normalized * (this.bounds.maxRadius - this.bounds.minRadius);
  }

  private updateHoveredPoint(mouseX: number, mouseY: number): void {
    if (!this.data) {
      this.hoveredPoint = null;
      return;
    }

    const dataX = this.screenToDataX(mouseX);
    const threshold = (this.bounds.maxArc - this.bounds.minArc) * 0.02 / this.view.scaleX;
    
    let closest: GeodesicPoint | null = null;
    let closestDist = Infinity;

    for (const pt of this.data.points) {
      const dist = Math.abs(pt.arcLength - dataX);
      if (dist < threshold && dist < closestDist) {
        closest = pt;
        closestDist = dist;
      }
    }

    this.hoveredPoint = closest;
  }

  /**
   * Main render function.
   */
  render(): void {
    const ctx = this.ctx;
    const width = this.canvas.width;
    const height = this.canvas.height;

    // Clear
    ctx.fillStyle = this.COLORS.background;
    ctx.fillRect(0, 0, width, height);

    // Draw grid
    this.drawGrid();

    // Draw ideal sphere line
    if (this.showSphere && this.sphereRadius > 0) {
      this.drawSphereLine();
    }

    // Draw profile
    if (this.data) {
      this.drawProfile();
    }

    // Draw axes
    this.drawAxes();

    // Draw pole marker
    if (this.data) {
      this.drawPoleMarker();
    }

    // Draw tooltip
    if (this.hoveredPoint) {
      this.drawTooltip();
    }
  }

  private drawGrid(): void {
    const ctx = this.ctx;
    
    // Calculate nice grid intervals
    const arcRange = this.bounds.maxArc - this.bounds.minArc;
    const radRange = this.bounds.maxRadius - this.bounds.minRadius;
    const arcStep = this.niceInterval(arcRange / 8);
    const radStep = this.niceInterval(radRange / 6);

    ctx.strokeStyle = this.COLORS.grid;
    ctx.lineWidth = 0.5;
    ctx.setLineDash([2, 2]);

    // Vertical grid lines (arc length)
    const arcStart = Math.ceil(this.bounds.minArc / arcStep) * arcStep;
    for (let arc = arcStart; arc <= this.bounds.maxArc; arc += arcStep) {
      const x = this.dataToScreenX(arc);
      if (x >= this.MARGIN.left && x <= this.canvas.width - this.MARGIN.right) {
        ctx.beginPath();
        ctx.moveTo(x, this.MARGIN.top);
        ctx.lineTo(x, this.canvas.height - this.MARGIN.bottom);
        ctx.stroke();
      }
    }

    // Horizontal grid lines (radius)
    const radStart = Math.ceil(this.bounds.minRadius / radStep) * radStep;
    for (let rad = radStart; rad <= this.bounds.maxRadius; rad += radStep) {
      const y = this.dataToScreenY(rad);
      if (y >= this.MARGIN.top && y <= this.canvas.height - this.MARGIN.bottom) {
        ctx.beginPath();
        ctx.moveTo(this.MARGIN.left, y);
        ctx.lineTo(this.canvas.width - this.MARGIN.right, y);
        ctx.stroke();
      }
    }

    ctx.setLineDash([]);
  }

  private niceInterval(roughInterval: number): number {
    const magnitude = Math.pow(10, Math.floor(Math.log10(roughInterval)));
    const normalized = roughInterval / magnitude;
    
    if (normalized <= 1) return magnitude;
    if (normalized <= 2) return 2 * magnitude;
    if (normalized <= 5) return 5 * magnitude;
    return 10 * magnitude;
  }

  private drawSphereLine(): void {
    const ctx = this.ctx;
    const y = this.dataToScreenY(this.sphereRadius);

    ctx.strokeStyle = this.COLORS.sphere;
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 4]);

    ctx.beginPath();
    ctx.moveTo(this.MARGIN.left, y);
    ctx.lineTo(this.canvas.width - this.MARGIN.right, y);
    ctx.stroke();

    ctx.setLineDash([]);

    // Label
    ctx.fillStyle = this.COLORS.sphere;
    ctx.font = '10px sans-serif';
    ctx.fillText('Ideal sphere', this.canvas.width - this.MARGIN.right - 60, y - 5);
  }

  private drawProfile(): void {
    if (!this.data || this.data.points.length < 2) return;

    const ctx = this.ctx;
    const points = this.data.points;
    const curvatureThreshold = 0.01; // threshold for irregularity (based on second derivative)

    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Draw segments with color based on irregularity
    for (let i = 0; i < points.length - 1; i++) {
      const pt1 = points[i];
      const pt2 = points[i + 1];
      
      const x1 = this.dataToScreenX(pt1.arcLength);
      const y1 = this.dataToScreenY(this.getRadius(pt1));
      const x2 = this.dataToScreenX(pt2.arcLength);
      const y2 = this.dataToScreenY(this.getRadius(pt2));

      // Check if segment is within visible area
      if (x2 < this.MARGIN.left || x1 > this.canvas.width - this.MARGIN.right) continue;

      // Determine color based on irregularity
      const isIrregular = Math.abs(pt1.secondDerivative) > curvatureThreshold || 
                          Math.abs(pt2.secondDerivative) > curvatureThreshold;
      
      ctx.strokeStyle = isIrregular ? this.COLORS.irregular : this.COLORS.regular;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    // Draw irregular points as dots
    ctx.fillStyle = this.COLORS.irregular;
    for (const pt of points) {
      if (Math.abs(pt.secondDerivative) > curvatureThreshold) {
        const x = this.dataToScreenX(pt.arcLength);
        const y = this.dataToScreenY(this.getRadius(pt));
        
        if (x >= this.MARGIN.left && x <= this.canvas.width - this.MARGIN.right) {
          ctx.beginPath();
          ctx.arc(x, y, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  private drawPoleMarker(): void {
    if (!this.data) return;

    const ctx = this.ctx;
    const polePoint = this.data.points[this.data.poleIndex];
    const x = this.dataToScreenX(polePoint.arcLength);
    const y = this.dataToScreenY(this.getRadius(polePoint));

    // Vertical line at pole
    ctx.strokeStyle = this.COLORS.pole;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, this.MARGIN.top);
    ctx.lineTo(x, this.canvas.height - this.MARGIN.bottom);
    ctx.stroke();
    ctx.setLineDash([]);

    // Pole point marker
    ctx.fillStyle = this.COLORS.pole;
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();

    // Label
    ctx.fillStyle = this.COLORS.pole;
    ctx.font = 'bold 10px sans-serif';
    ctx.fillText('Pole', x + 8, this.MARGIN.top + 15);
  }

  private drawAxes(): void {
    const ctx = this.ctx;
    
    // Calculate nice intervals
    const arcRange = this.bounds.maxArc - this.bounds.minArc;
    const radRange = this.bounds.maxRadius - this.bounds.minRadius;
    const arcStep = this.niceInterval(arcRange / 8);
    const radStep = this.niceInterval(radRange / 6);

    ctx.fillStyle = this.COLORS.text;
    ctx.strokeStyle = this.COLORS.text;
    ctx.lineWidth = 1;

    // X-axis
    ctx.beginPath();
    ctx.moveTo(this.MARGIN.left, this.canvas.height - this.MARGIN.bottom);
    ctx.lineTo(this.canvas.width - this.MARGIN.right, this.canvas.height - this.MARGIN.bottom);
    ctx.stroke();

    // Y-axis
    ctx.beginPath();
    ctx.moveTo(this.MARGIN.left, this.MARGIN.top);
    ctx.lineTo(this.MARGIN.left, this.canvas.height - this.MARGIN.bottom);
    ctx.stroke();

    // X-axis labels
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    const arcStart = Math.ceil(this.bounds.minArc / arcStep) * arcStep;
    for (let arc = arcStart; arc <= this.bounds.maxArc; arc += arcStep) {
      const x = this.dataToScreenX(arc);
      if (x >= this.MARGIN.left && x <= this.canvas.width - this.MARGIN.right) {
        ctx.fillText(arc.toFixed(1), x, this.canvas.height - this.MARGIN.bottom + 15);
        // Tick mark
        ctx.beginPath();
        ctx.moveTo(x, this.canvas.height - this.MARGIN.bottom);
        ctx.lineTo(x, this.canvas.height - this.MARGIN.bottom + 4);
        ctx.stroke();
      }
    }

    // Y-axis labels
    ctx.textAlign = 'right';
    const radStart = Math.ceil(this.bounds.minRadius / radStep) * radStep;
    for (let rad = radStart; rad <= this.bounds.maxRadius; rad += radStep) {
      const y = this.dataToScreenY(rad);
      if (y >= this.MARGIN.top && y <= this.canvas.height - this.MARGIN.bottom) {
        ctx.fillText(rad.toFixed(2), this.MARGIN.left - 5, y + 3);
        // Tick mark
        ctx.beginPath();
        ctx.moveTo(this.MARGIN.left - 4, y);
        ctx.lineTo(this.MARGIN.left, y);
        ctx.stroke();
      }
    }

    // Axis labels
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Arc Length (mm)', this.canvas.width / 2, this.canvas.height - 5);
    
    ctx.save();
    ctx.translate(12, this.canvas.height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('Radius (mm)', 0, 0);
    ctx.restore();
  }

  private drawTooltip(): void {
    if (!this.hoveredPoint) return;

    const ctx = this.ctx;
    const pt = this.hoveredPoint;
    const x = this.dataToScreenX(pt.arcLength);
    const y = this.dataToScreenY(this.getRadius(pt));

    // Highlight point
    ctx.fillStyle = '#ffcc00';
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Tooltip box
    const text = [
      `Arc: ${pt.arcLength.toFixed(2)} mm`,
      `Radius: ${this.getRadius(pt).toFixed(3)} mm`,
      `Deviation: ${pt.deviation.toFixed(1)} μm`,
    ];

    ctx.font = '11px sans-serif';
    const maxWidth = Math.max(...text.map(t => ctx.measureText(t).width));
    const boxWidth = maxWidth + 16;
    const boxHeight = text.length * 16 + 12;
    
    let boxX = x + 10;
    let boxY = y - boxHeight - 10;
    
    // Keep tooltip in bounds
    if (boxX + boxWidth > this.canvas.width - 5) {
      boxX = x - boxWidth - 10;
    }
    if (boxY < 5) {
      boxY = y + 10;
    }

    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.strokeStyle = '#ccc';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxWidth, boxHeight, 4);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#333';
    ctx.textAlign = 'left';
    for (let i = 0; i < text.length; i++) {
      ctx.fillText(text[i], boxX + 8, boxY + 18 + i * 16);
    }
  }

  /**
   * Dispose resources.
   */
  dispose(): void {
    // Remove event listeners (canvas will be removed by parent)
  }
}

// ============================================================
// GeoWear — ProfileChart
// 2D profile visualization of geodesic sections
// Shows the actual geometric cross-section profile
// ============================================================

import type { DoubleGeodesic, GeodesicPoint, MeshData } from '../types';

interface ViewTransform {
  offsetX: number;
  offsetY: number;
  scale: number;
}

interface DataBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

interface ProfilePoint {
  x: number;           // horizontal position in profile plane
  y: number;           // vertical position in profile plane  
  original: GeodesicPoint;
  isIrregular: boolean;
}

interface OuterProfilePoint {
  x: number;
  y: number;
}

export class ProfileChart {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private data: DoubleGeodesic | null = null;
  private sphereRadius: number = 0;
  private sphereCenter: [number, number, number] = [0, 0, 0];
  private wallThickness: number = 6; // Fallback if no outer mesh
  private showSphere: boolean = true;
  private showOuterLayer: boolean = true;
  
  // Projected profile points
  private profilePoints: ProfilePoint[] = [];
  
  // Outer mesh section points (real geometry)
  private outerMesh: MeshData | null = null;
  private outerProfilePoints: OuterProfilePoint[] = [];
  
  // Projection axes (stored for sphere projection)
  private uAxis = { x: 1, y: 0, z: 0 };
  private vAxis = { x: 0, y: 1, z: 0 };
  private planeNormal = { x: 0, y: 0, z: 1 };
  private centroid = { x: 0, y: 0, z: 0 };
  
  // View state for pan/zoom
  private view: ViewTransform = { offsetX: 0, offsetY: 0, scale: 1 };
  private bounds: DataBounds = { minX: 0, maxX: 1, minY: 0, maxY: 1 };
  
  // Interaction state
  private isDragging = false;
  private lastMouseX = 0;
  private lastMouseY = 0;
  
  // Tooltip state
  private hoveredPoint: ProfilePoint | null = null;
  
  // Layout constants
  private readonly MARGIN = { top: 30, right: 30, bottom: 50, left: 60 };
  private readonly COLORS = {
    regular: '#1a8f3e',
    irregular: '#d32f2f',
    sphere: '#0077cc',
    sphereFill: 'rgba(0, 119, 204, 0.1)',
    outer: '#00b4ff',
    outerFill: 'rgba(0, 180, 255, 0.12)',
    outerStroke: 'rgba(0, 180, 255, 0.5)',
    grid: '#e0e0e0',
    gridMajor: '#c0c0c0',
    text: '#333333',
    background: '#fafafa',
    pole: '#0077cc',
    profile: '#2d5016',
    profileFill: 'rgba(45, 80, 22, 0.15)',
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
      const factor = e.deltaY < 0 ? 1.15 : 0.87;
      
      // Zoom centered on mouse position
      const rect = this.canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      
      // Convert mouse to data coordinates before zoom
      const dataX = this.screenToDataX(mouseX);
      const dataY = this.screenToDataY(mouseY);
      
      // Apply zoom
      this.view.scale *= factor;
      
      // Clamp scale
      this.view.scale = Math.max(0.3, Math.min(15, this.view.scale));
      
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
   * Set sphere center and radius for ideal sphere visualization.
   */
  setSphereRadius(radius: number): void {
    this.sphereRadius = radius;
    this.render();
  }

  setSphereCenter(center: [number, number, number]): void {
    this.sphereCenter = center;
    this.render();
  }

  /**
   * Set wall thickness for outer layer visualization.
   */
  setWallThickness(thickness: number): void {
    this.wallThickness = thickness;
    this.render();
  }

  /**
   * Toggle showing outer layer.
   */
  setShowOuterLayer(show: boolean): void {
    this.showOuterLayer = show;
    this.render();
  }

  /**
   * Toggle showing the ideal sphere arc.
   */
  setShowSphere(show: boolean): void {
    this.showSphere = show;
    this.render();
  }

  /**
   * Set the outer mesh for real outer surface visualization.
   */
  setOuterMesh(mesh: MeshData): void {
    this.outerMesh = mesh;
    // If we already have profile data, recompute outer section
    if (this.profilePoints.length > 0) {
      this.computeOuterSection();
      this.render();
    }
  }

  /**
   * Set data to display and compute the 2D profile projection.
   */
  setData(data: DoubleGeodesic): void {
    this.data = data;
    this.computeProfileProjection();
    this.computeOuterSection();
    this.computeBounds();
    this.resetView();
  }

  /**
   * Project 3D geodesic points onto a 2D profile plane.
   * The profile plane is the plane containing the geodesic.
   */
  private computeProfileProjection(): void {
    this.profilePoints = [];
    if (!this.data || this.data.points.length < 3) return;

    const points = this.data.points;
    
    // Get 3D positions
    const positions = points.map(pt => ({
      x: pt.position[0],
      y: pt.position[1],
      z: pt.position[2],
    }));

    // Compute the plane of the geodesic using first, middle, and last points
    const p1 = positions[0];
    const p2 = positions[Math.floor(positions.length / 2)];
    const p3 = positions[positions.length - 1];

    // Vectors in the plane
    const v1 = { x: p2.x - p1.x, y: p2.y - p1.y, z: p2.z - p1.z };
    const v2 = { x: p3.x - p1.x, y: p3.y - p1.y, z: p3.z - p1.z };

    // Normal to the plane (cross product)
    const normal = {
      x: v1.y * v2.z - v1.z * v2.y,
      y: v1.z * v2.x - v1.x * v2.z,
      z: v1.x * v2.y - v1.y * v2.x,
    };
    const normalLen = Math.sqrt(normal.x ** 2 + normal.y ** 2 + normal.z ** 2);
    if (normalLen < 1e-10) return;
    normal.x /= normalLen;
    normal.y /= normalLen;
    normal.z /= normalLen;
    
    // Store plane normal for outer section computation
    this.planeNormal = { x: normal.x, y: normal.y, z: normal.z };

    // Define local coordinate system in the plane
    // U axis: from first point to last point (horizontal in profile)
    this.uAxis = { x: p3.x - p1.x, y: p3.y - p1.y, z: p3.z - p1.z };
    const uLen = Math.sqrt(this.uAxis.x ** 2 + this.uAxis.y ** 2 + this.uAxis.z ** 2);
    this.uAxis.x /= uLen;
    this.uAxis.y /= uLen;
    this.uAxis.z /= uLen;

    // V axis: perpendicular to U in the plane (up in profile)
    // V = normal × U
    this.vAxis = {
      x: normal.y * this.uAxis.z - normal.z * this.uAxis.y,
      y: normal.z * this.uAxis.x - normal.x * this.uAxis.z,
      z: normal.x * this.uAxis.y - normal.y * this.uAxis.x,
    };

    // Origin for projection (centroid of the geodesic)
    this.centroid = positions.reduce(
      (acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y, z: acc.z + p.z }),
      { x: 0, y: 0, z: 0 }
    );
    this.centroid.x /= positions.length;
    this.centroid.y /= positions.length;
    this.centroid.z /= positions.length;

    // Curvature threshold for irregularity detection
    const curvatureThreshold = 0.01;

    // Project each point
    for (let i = 0; i < points.length; i++) {
      const pt = points[i];
      const pos = positions[i];
      
      // Vector from centroid to point
      const dx = pos.x - this.centroid.x;
      const dy = pos.y - this.centroid.y;
      const dz = pos.z - this.centroid.z;

      // Project onto local axes
      const u = dx * this.uAxis.x + dy * this.uAxis.y + dz * this.uAxis.z;
      const v = dx * this.vAxis.x + dy * this.vAxis.y + dz * this.vAxis.z;

      const isIrregular = Math.abs(pt.secondDerivative) > curvatureThreshold;

      this.profilePoints.push({
        x: u,
        y: v,
        original: pt,
        isIrregular,
      });
    }
  }

  /**
   * Compute the intersection of the outer mesh with the geodesic plane.
   * This gives the real outer surface cross-section profile.
   */
  private computeOuterSection(): void {
    this.outerProfilePoints = [];
    
    if (!this.outerMesh || this.profilePoints.length < 3) return;
    
    const { positions, indices, faceCount } = this.outerMesh;
    const nx = this.planeNormal.x;
    const ny = this.planeNormal.y;
    const nz = this.planeNormal.z;
    const cx = this.centroid.x;
    const cy = this.centroid.y;
    const cz = this.centroid.z;
    
    // Collect all intersection points
    const intersectionPoints: { x: number; y: number; lat: number }[] = [];
    
    for (let f = 0; f < faceCount; f++) {
      const i0 = indices[f * 3];
      const i1 = indices[f * 3 + 1];
      const i2 = indices[f * 3 + 2];
      
      // Signed distances to the geodesic plane
      const sd0 = (positions[i0 * 3] - cx) * nx + (positions[i0 * 3 + 1] - cy) * ny + (positions[i0 * 3 + 2] - cz) * nz;
      const sd1 = (positions[i1 * 3] - cx) * nx + (positions[i1 * 3 + 1] - cy) * ny + (positions[i1 * 3 + 2] - cz) * nz;
      const sd2 = (positions[i2 * 3] - cx) * nx + (positions[i2 * 3 + 1] - cy) * ny + (positions[i2 * 3 + 2] - cz) * nz;
      
      // Find edges that cross the plane
      const edges: [number, number, number, number][] = [
        [i0, i1, sd0, sd1],
        [i1, i2, sd1, sd2],
        [i2, i0, sd2, sd0],
      ];
      
      for (const [ia, ib, sda, sdb] of edges) {
        if (sda * sdb < 0) {
          // Edge crosses the plane
          const t = sda / (sda - sdb);
          const px = positions[ia * 3] + t * (positions[ib * 3] - positions[ia * 3]);
          const py = positions[ia * 3 + 1] + t * (positions[ib * 3 + 1] - positions[ia * 3 + 1]);
          const pz = positions[ia * 3 + 2] + t * (positions[ib * 3 + 2] - positions[ia * 3 + 2]);
          
          // Project to 2D profile plane
          const dx = px - cx;
          const dy = py - cy;
          const dz = pz - cz;
          const u = dx * this.uAxis.x + dy * this.uAxis.y + dz * this.uAxis.z;
          const v = dx * this.vAxis.x + dy * this.vAxis.y + dz * this.vAxis.z;
          
          intersectionPoints.push({ x: u, y: v, lat: v }); // Use v as latitude for sorting
        }
      }
    }
    
    if (intersectionPoints.length < 3) return;
    
    // Sort by latitude (vertical position) descending to get ordered contour
    intersectionPoints.sort((a, b) => b.lat - a.lat);
    
    // Remove duplicates
    const eps = 0.01;
    const uniquePoints: OuterProfilePoint[] = [{ x: intersectionPoints[0].x, y: intersectionPoints[0].y }];
    for (let i = 1; i < intersectionPoints.length; i++) {
      const prev = uniquePoints[uniquePoints.length - 1];
      const curr = intersectionPoints[i];
      if (Math.abs(curr.x - prev.x) > eps || Math.abs(curr.y - prev.y) > eps) {
        uniquePoints.push({ x: curr.x, y: curr.y });
      }
    }
    
    this.outerProfilePoints = uniquePoints;
  }

  private computeBounds(): void {
    if (this.profilePoints.length === 0) {
      this.bounds = { minX: -1, maxX: 1, minY: -1, maxY: 1 };
      return;
    }

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    for (const pt of this.profilePoints) {
      minX = Math.min(minX, pt.x);
      maxX = Math.max(maxX, pt.x);
      minY = Math.min(minY, pt.y);
      maxY = Math.max(maxY, pt.y);
    }

    // Add padding and ensure aspect ratio
    const rangeX = maxX - minX;
    const rangeY = maxY - minY;
    const padding = Math.max(rangeX, rangeY) * 0.1;
    
    this.bounds = {
      minX: minX - padding,
      maxX: maxX + padding,
      minY: minY - padding,
      maxY: maxY + padding,
    };
  }

  /**
   * Reset view to show all data.
   */
  resetView(): void {
    this.view = { offsetX: 0, offsetY: 0, scale: 1 };
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
    const rangeX = this.bounds.maxX - this.bounds.minX;
    const rangeY = this.bounds.maxY - this.bounds.minY;
    const range = Math.max(rangeX, rangeY);
    const normalized = (dataX - this.bounds.minX) / range;
    const plotSize = Math.min(this.getPlotWidth(), this.getPlotHeight());
    return this.MARGIN.left + (this.getPlotWidth() - plotSize) / 2 + normalized * plotSize * this.view.scale + this.view.offsetX;
  }

  private dataToScreenY(dataY: number): number {
    const rangeX = this.bounds.maxX - this.bounds.minX;
    const rangeY = this.bounds.maxY - this.bounds.minY;
    const range = Math.max(rangeX, rangeY);
    // Y is inverted and offset to center
    const normalized = (dataY - this.bounds.minY) / range;
    const plotSize = Math.min(this.getPlotWidth(), this.getPlotHeight());
    return this.MARGIN.top + (this.getPlotHeight() - plotSize) / 2 + (1 - normalized) * plotSize * this.view.scale + this.view.offsetY;
  }

  private screenToDataX(screenX: number): number {
    const rangeX = this.bounds.maxX - this.bounds.minX;
    const rangeY = this.bounds.maxY - this.bounds.minY;
    const range = Math.max(rangeX, rangeY);
    const plotSize = Math.min(this.getPlotWidth(), this.getPlotHeight());
    const normalized = (screenX - this.MARGIN.left - (this.getPlotWidth() - plotSize) / 2 - this.view.offsetX) / (plotSize * this.view.scale);
    return this.bounds.minX + normalized * range;
  }

  private screenToDataY(screenY: number): number {
    const rangeX = this.bounds.maxX - this.bounds.minX;
    const rangeY = this.bounds.maxY - this.bounds.minY;
    const range = Math.max(rangeX, rangeY);
    const plotSize = Math.min(this.getPlotWidth(), this.getPlotHeight());
    const normalized = 1 - (screenY - this.MARGIN.top - (this.getPlotHeight() - plotSize) / 2 - this.view.offsetY) / (plotSize * this.view.scale);
    return this.bounds.minY + normalized * range;
  }

  private updateHoveredPoint(mouseX: number, mouseY: number): void {
    if (this.profilePoints.length === 0) {
      this.hoveredPoint = null;
      return;
    }

    const threshold = 15; // pixels
    let closest: ProfilePoint | null = null;
    let closestDist = Infinity;

    for (const pt of this.profilePoints) {
      const sx = this.dataToScreenX(pt.x);
      const sy = this.dataToScreenY(pt.y);
      const dist = Math.sqrt((sx - mouseX) ** 2 + (sy - mouseY) ** 2);
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

    // Draw outer layer (external cup surface) - semi-transparent for context
    if (this.showOuterLayer && this.sphereRadius > 0) {
      this.drawOuterLayer();
    }

    // Draw ideal sphere arc
    if (this.showSphere && this.sphereRadius > 0) {
      this.drawSphereArc();
    }

    // Draw profile
    if (this.profilePoints.length > 0) {
      this.drawProfile();
    }

    // Draw axes
    this.drawAxes();

    // Draw pole marker
    if (this.data && this.profilePoints.length > 0) {
      this.drawPoleMarker();
    }

    // Draw tooltip
    if (this.hoveredPoint) {
      this.drawTooltip();
    }

    // Draw title
    this.drawTitle();
  }

  private drawTitle(): void {
    if (!this.data) return;
    const ctx = this.ctx;
    ctx.fillStyle = this.COLORS.text;
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(
      `Cross-Section Profile: ${this.data.angleA}° — ${this.data.angleB}°`,
      this.canvas.width / 2,
      15
    );
  }

  private drawGrid(): void {
    const ctx = this.ctx;
    const rangeX = this.bounds.maxX - this.bounds.minX;
    const rangeY = this.bounds.maxY - this.bounds.minY;
    const range = Math.max(rangeX, rangeY);
    const step = this.niceInterval(range / 6 / this.view.scale);

    ctx.strokeStyle = this.COLORS.grid;
    ctx.lineWidth = 0.5;
    ctx.setLineDash([3, 3]);

    // Vertical grid lines
    const xStart = Math.ceil(this.bounds.minX / step) * step;
    for (let x = xStart; x <= this.bounds.maxX; x += step) {
      const sx = this.dataToScreenX(x);
      if (sx >= this.MARGIN.left && sx <= this.canvas.width - this.MARGIN.right) {
        ctx.beginPath();
        ctx.moveTo(sx, this.MARGIN.top);
        ctx.lineTo(sx, this.canvas.height - this.MARGIN.bottom);
        ctx.stroke();
      }
    }

    // Horizontal grid lines
    const yStart = Math.ceil(this.bounds.minY / step) * step;
    for (let y = yStart; y <= this.bounds.maxY; y += step) {
      const sy = this.dataToScreenY(y);
      if (sy >= this.MARGIN.top && sy <= this.canvas.height - this.MARGIN.bottom) {
        ctx.beginPath();
        ctx.moveTo(this.MARGIN.left, sy);
        ctx.lineTo(this.canvas.width - this.MARGIN.right, sy);
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

  private drawSphereArc(): void {
    if (this.sphereRadius <= 0) return;

    const ctx = this.ctx;
    
    // Project sphere center to profile plane
    const scx = this.sphereCenter[0] - this.centroid.x;
    const scy = this.sphereCenter[1] - this.centroid.y;
    const scz = this.sphereCenter[2] - this.centroid.z;
    const cx = scx * this.uAxis.x + scy * this.uAxis.y + scz * this.uAxis.z;
    const cy = scx * this.vAxis.x + scy * this.vAxis.y + scz * this.vAxis.z;
    const r = this.sphereRadius;

    // Draw arc of ideal sphere (full circle intersected with the geodesic plane)
    ctx.strokeStyle = this.COLORS.sphere;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);

    ctx.beginPath();
    // Sample points along the arc
    const numPoints = 120;
    for (let i = 0; i <= numPoints; i++) {
      const angle = (i / numPoints) * Math.PI * 2;
      const px = cx + r * Math.cos(angle);
      const py = cy + r * Math.sin(angle);
      const sx = this.dataToScreenX(px);
      const sy = this.dataToScreenY(py);
      
      if (i === 0) {
        ctx.moveTo(sx, sy);
      } else {
        ctx.lineTo(sx, sy);
      }
    }
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);

    // Label
    ctx.fillStyle = this.COLORS.sphere;
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    const labelX = this.dataToScreenX(cx + r * 0.7);
    const labelY = this.dataToScreenY(cy + r * 0.7);
    ctx.fillText('Ideal sphere', labelX + 5, labelY);
  }

  /**
   * Draw the outer layer (external cup surface) as transparent context.
   * This shows the real outer profile from mesh-plane intersection,
   * or falls back to radial displacement if no outer mesh is available.
   */
  private drawOuterLayer(): void {
    if (!this.data) return;

    const ctx = this.ctx;
    
    // Use real outer mesh intersection if available
    let outerPoints: { x: number; y: number }[];
    
    if (this.outerProfilePoints.length >= 3) {
      // Use real outer mesh section
      outerPoints = this.outerProfilePoints;
    } else {
      // No outer mesh available
      return;
    }
    
    if (outerPoints.length < 3) return;

    // Draw only the outer surface line (gray)
    ctx.strokeStyle = 'rgba(80, 80, 80, 0.8)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < outerPoints.length; i++) {
      const pt = outerPoints[i];
      const sx = this.dataToScreenX(pt.x);
      const sy = this.dataToScreenY(pt.y);
      
      if (i === 0) {
        ctx.moveTo(sx, sy);
      } else {
        ctx.lineTo(sx, sy);
      }
    }
    ctx.stroke();
  }

  private drawProfile(): void {
    if (this.profilePoints.length < 2) return;

    const ctx = this.ctx;

    // Draw filled area under profile
    ctx.fillStyle = this.COLORS.profileFill;
    ctx.beginPath();
    for (let i = 0; i < this.profilePoints.length; i++) {
      const pt = this.profilePoints[i];
      const sx = this.dataToScreenX(pt.x);
      const sy = this.dataToScreenY(pt.y);
      if (i === 0) {
        ctx.moveTo(sx, sy);
      } else {
        ctx.lineTo(sx, sy);
      }
    }
    ctx.closePath();
    ctx.fill();

    // Draw profile line with color coding
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (let i = 0; i < this.profilePoints.length - 1; i++) {
      const pt1 = this.profilePoints[i];
      const pt2 = this.profilePoints[i + 1];
      
      const sx1 = this.dataToScreenX(pt1.x);
      const sy1 = this.dataToScreenY(pt1.y);
      const sx2 = this.dataToScreenX(pt2.x);
      const sy2 = this.dataToScreenY(pt2.y);

      // Color based on irregularity
      const isIrregular = pt1.isIrregular || pt2.isIrregular;
      ctx.strokeStyle = isIrregular ? this.COLORS.irregular : this.COLORS.regular;
      
      ctx.beginPath();
      ctx.moveTo(sx1, sy1);
      ctx.lineTo(sx2, sy2);
      ctx.stroke();
    }

    // Draw irregularity markers
    ctx.fillStyle = this.COLORS.irregular;
    for (const pt of this.profilePoints) {
      if (pt.isIrregular) {
        const sx = this.dataToScreenX(pt.x);
        const sy = this.dataToScreenY(pt.y);
        ctx.beginPath();
        ctx.arc(sx, sy, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private drawPoleMarker(): void {
    if (!this.data || this.profilePoints.length === 0) return;

    const poleIdx = this.data.poleIndex;
    if (poleIdx < 0 || poleIdx >= this.profilePoints.length) return;

    const ctx = this.ctx;
    const polePt = this.profilePoints[poleIdx];
    const sx = this.dataToScreenX(polePt.x);
    const sy = this.dataToScreenY(polePt.y);

    // Pole point marker
    ctx.fillStyle = this.COLORS.pole;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(sx, sy, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Label
    ctx.fillStyle = this.COLORS.pole;
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Pole', sx, sy - 12);
  }

  private drawAxes(): void {
    const ctx = this.ctx;
    const rangeX = this.bounds.maxX - this.bounds.minX;
    const rangeY = this.bounds.maxY - this.bounds.minY;
    const range = Math.max(rangeX, rangeY);
    const step = this.niceInterval(range / 6 / this.view.scale);

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
    const xStart = Math.ceil(this.bounds.minX / step) * step;
    for (let x = xStart; x <= this.bounds.maxX; x += step) {
      const sx = this.dataToScreenX(x);
      if (sx >= this.MARGIN.left + 20 && sx <= this.canvas.width - this.MARGIN.right - 20) {
        ctx.fillText(x.toFixed(1), sx, this.canvas.height - this.MARGIN.bottom + 15);
        ctx.beginPath();
        ctx.moveTo(sx, this.canvas.height - this.MARGIN.bottom);
        ctx.lineTo(sx, this.canvas.height - this.MARGIN.bottom + 4);
        ctx.stroke();
      }
    }

    // Y-axis labels
    ctx.textAlign = 'right';
    const yStart = Math.ceil(this.bounds.minY / step) * step;
    for (let y = yStart; y <= this.bounds.maxY; y += step) {
      const sy = this.dataToScreenY(y);
      if (sy >= this.MARGIN.top + 10 && sy <= this.canvas.height - this.MARGIN.bottom - 10) {
        ctx.fillText(y.toFixed(1), this.MARGIN.left - 8, sy + 3);
        ctx.beginPath();
        ctx.moveTo(this.MARGIN.left - 4, sy);
        ctx.lineTo(this.MARGIN.left, sy);
        ctx.stroke();
      }
    }

    // Axis labels
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Horizontal Position (mm)', this.canvas.width / 2, this.canvas.height - 8);
    
    ctx.save();
    ctx.translate(15, this.canvas.height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('Vertical Position (mm)', 0, 0);
    ctx.restore();
  }

  private drawTooltip(): void {
    if (!this.hoveredPoint) return;

    const ctx = this.ctx;
    const pt = this.hoveredPoint;
    const sx = this.dataToScreenX(pt.x);
    const sy = this.dataToScreenY(pt.y);

    // Highlight point
    ctx.fillStyle = '#ffcc00';
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(sx, sy, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Tooltip box
    const text = [
      `Arc Length: ${pt.original.arcLength.toFixed(2)} mm`,
      `Deviation: ${pt.original.deviation.toFixed(1)} μm`,
      pt.isIrregular ? '⚠ Irregular zone' : '✓ Regular',
    ];

    ctx.font = '11px sans-serif';
    const maxWidth = Math.max(...text.map(t => ctx.measureText(t).width));
    const boxWidth = maxWidth + 20;
    const boxHeight = text.length * 17 + 14;
    
    let boxX = sx + 12;
    let boxY = sy - boxHeight - 8;
    
    // Keep tooltip in bounds
    if (boxX + boxWidth > this.canvas.width - 5) {
      boxX = sx - boxWidth - 12;
    }
    if (boxY < 5) {
      boxY = sy + 12;
    }

    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.strokeStyle = '#ccc';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxWidth, boxHeight, 5);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#333';
    ctx.textAlign = 'left';
    for (let i = 0; i < text.length; i++) {
      const color = i === 2 ? (pt.isIrregular ? this.COLORS.irregular : this.COLORS.regular) : '#333';
      ctx.fillStyle = color;
      ctx.fillText(text[i], boxX + 10, boxY + 20 + i * 17);
    }
  }

  /**
   * Dispose resources.
   */
  dispose(): void {
    // Canvas will be removed by parent
  }
}

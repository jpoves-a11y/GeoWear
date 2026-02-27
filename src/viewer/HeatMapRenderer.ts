// ============================================================
// GeoWear — HeatMapRenderer
// Vertex coloring for deviation heat map visualization
// ============================================================

import * as THREE from 'three';
import { Lut } from 'three/addons/math/Lut.js';

export class HeatMapRenderer {
  private lut: Lut;
  private legendCanvas: HTMLCanvasElement | null;
  private legendContainer: HTMLElement | null;
  private currentColorMap: string = 'rainbow';

  constructor() {
    this.lut = new Lut('rainbow', 512);
    this.legendCanvas = document.getElementById('legend-canvas') as HTMLCanvasElement;
    this.legendContainer = document.getElementById('color-legend');
  }

  /**
   * Generate vertex colors from per-vertex deviation values.
   * @param deviations Float32Array of deviations in μm
   * @param minValue Minimum value for color scale (μm)
   * @param maxValue Maximum value for color scale (μm)
   * @param colorMapName Color map name: 'rainbow' | 'cooltowarm' | 'blackbody'
   * @returns Float32Array of RGB colors (3 values per vertex)
   */
  generateColors(
    deviations: Float32Array,
    minValue: number,
    maxValue: number,
    colorMapName: string = 'rainbow'
  ): Float32Array {
    if (colorMapName !== this.currentColorMap) {
      this.lut = new Lut(colorMapName, 512);
      this.currentColorMap = colorMapName;
    }

    this.lut.setMin(minValue);
    this.lut.setMax(maxValue);

    const n = deviations.length;
    const colors = new Float32Array(n * 3);
    const clr = new THREE.Color();

    for (let i = 0; i < n; i++) {
      const val = Math.max(minValue, Math.min(maxValue, deviations[i]));
      const c = this.lut.getColor(val);
      if (c) {
        colors[i * 3] = c.r;
        colors[i * 3 + 1] = c.g;
        colors[i * 3 + 2] = c.b;
      } else {
        // Fallback: gray
        colors[i * 3] = 0.5;
        colors[i * 3 + 1] = 0.5;
        colors[i * 3 + 2] = 0.5;
      }
    }

    return colors;
  }

  /**
   * Generate a custom diverging color map (blue-white-red for dip-nominal-bump).
   */
  generateDivergingColors(
    deviations: Float32Array,
    minValue: number,
    maxValue: number
  ): Float32Array {
    const n = deviations.length;
    const colors = new Float32Array(n * 3);

    const absMax = Math.max(Math.abs(minValue), Math.abs(maxValue));

    for (let i = 0; i < n; i++) {
      const val = deviations[i];
      const t = val / absMax; // [-1, 1]

      let r: number, g: number, b: number;

      if (t < -0.01) {
        // Negative (dip/wear): blue → purple
        const s = Math.min(1, Math.abs(t));
        r = 0.2 * s + 0.15 * (1 - s);
        g = 0.1 * (1 - s);
        b = 0.5 + 0.5 * s;
      } else if (t > 0.01) {
        // Positive (bump): yellow → red
        const s = Math.min(1, t);
        r = 0.8 + 0.2 * s;
        g = 0.6 * (1 - s);
        b = 0.1 * (1 - s);
      } else {
        // Nominal: soft green
        r = 0.3;
        g = 0.7;
        b = 0.3;
      }

      colors[i * 3] = r;
      colors[i * 3 + 1] = g;
      colors[i * 3 + 2] = b;
    }

    return colors;
  }

  /**
   * Update the color scale legend in the UI.
   */
  updateLegend(minValue: number, maxValue: number, colorMapName: string = 'rainbow'): void {
    if (!this.legendCanvas || !this.legendContainer) return;

    // Show legend
    this.legendContainer.classList.remove('hidden');

    const ctx = this.legendCanvas.getContext('2d')!;
    const w = this.legendCanvas.width;
    const h = this.legendCanvas.height;

    // Draw gradient
    const lut = new Lut(colorMapName, 256);
    lut.setMin(0);
    lut.setMax(1);

    for (let y = 0; y < h; y++) {
      const t = 1 - y / h; // top = max, bottom = min
      const val = t;
      const c = lut.getColor(val);
      if (c) {
        ctx.fillStyle = `rgb(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)})`;
      } else {
        ctx.fillStyle = '#888';
      }
      ctx.fillRect(0, y, w, 1);
    }

    // Update labels
    const maxLabel = document.getElementById('legend-max');
    const midLabel = document.getElementById('legend-mid');
    const minLabel = document.getElementById('legend-min');

    if (maxLabel) maxLabel.textContent = `+${maxValue.toFixed(1)}`;
    if (midLabel) midLabel.textContent = `${((minValue + maxValue) / 2).toFixed(1)}`;
    if (minLabel) minLabel.textContent = `${minValue.toFixed(1)}`;
  }

  /**
   * Hide the legend.
   */
  hideLegend(): void {
    if (this.legendContainer) {
      this.legendContainer.classList.add('hidden');
    }
  }
}

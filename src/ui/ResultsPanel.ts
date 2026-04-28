// ============================================================
// GeoWear — ResultsPanel
// Analysis results display and interactive table
// ============================================================

import type { AnalysisResults, AnalysisRunResult, Geodesic, MultiModeComparisonResults } from '../types';

export class ResultsPanel {
  private container: HTMLElement;
  private sidebar: HTMLElement;
  private closeBtn: HTMLElement;
  private onGeodesicSelect?: (angle: number) => void;
  private yearsInVivo: number = 0;

  /** Update the implantation duration used for wear rate computation. */
  setYearsInVivo(years: number): void {
    this.yearsInVivo = years;
  }

  constructor() {
    this.container = document.getElementById('results-container')!;
    this.sidebar = document.getElementById('sidebar-right')!;
    this.closeBtn = document.getElementById('btn-close-results')!;

    this.closeBtn.addEventListener('click', () => this.hide());
  }

  /**
   * Set callback for geodesic selection in the table.
   */
  setGeodesicSelectHandler(handler: (angle: number) => void): void {
    this.onGeodesicSelect = handler;
  }

  /**
   * Show results panel with full analysis data.
   */
  show(results: AnalysisRunResult): void {
    this.sidebar.classList.remove('hidden');
    this.container.innerHTML = '';

    if (results.analysisMode === 'compare-all-modes') {
      this.addCompareSummarySection(results);
      this.renderSingleResult(results.pureGeodesic, 'Pure Geodesic');
      this.renderSingleResult(results.sphereBestfit, 'Sphere BestFit');
      this.renderSingleResult(results.doubleSphereMetrics, 'Double Sphere Metrics');
      window.dispatchEvent(new Event('resize'));
      return;
    }

    this.renderSingleResult(results);

    // Trigger layout resize
    window.dispatchEvent(new Event('resize'));
  }

  private renderSingleResult(results: AnalysisResults, titlePrefix?: string): void {
    if (titlePrefix) {
      const header = this.createSection(`Mode Detail: ${titlePrefix}`);
      this.container.appendChild(header);
    }

    // Summary section
    this.addSummarySection(results);

    // Sphere fit section
    this.addSphereFitSection(results);

    if (results.analysisMode === 'sphere-bestfit') {
      // --- Sphere BestFit mode sections ---
      if (results.commercialSphere) {
        this.addCommercialSphereSection(results);
      }
      if (results.wearClassification) {
        this.addWearClassificationSection(results);
      }
      if (results.zoneSpheres) {
        this.addZoneSpheresSection(results);
      }
      if (results.wearVolumeResult) {
        this.addWearVolumeSection(results);
      }
      if (results.wearPlane) {
        this.addWearPlaneSection(results);
      }
    } else if (results.analysisMode === 'double-sphere-metrics') {
      this.addDoubleSphereSection(results);
      if (results.wearVolumeResult) {
        this.addWearVolumeSection(results);
      }
    } else {
      // --- Pure Geodesic mode sections ---
      if (results.ellipsoidFit) {
        this.addShapeSection(results);
      }
      this.addWearSection(results);
      this.addVolumeSection(results);
      if (results.wearVector) {
        this.addWearVectorSection(results);
      }
    }

    // Geodesic table section
    this.addGeodesicTable(results.geodesics);
  }

  hide(): void {
    this.sidebar.classList.add('hidden');
    window.dispatchEvent(new Event('resize'));
  }

  private addSummarySection(results: AnalysisResults): void {
    const section = this.createSection('Summary');

    const modeLabel =
      results.analysisMode === 'sphere-bestfit'
        ? 'Sphere BestFit'
        : results.analysisMode === 'double-sphere-metrics'
          ? 'Double Sphere Metrics'
          : 'Pure Geodesic';
    this.addMetric(section, 'Mode', modeLabel);
    this.addMetric(section, 'Vertices', results.vertexCount.toLocaleString());
    this.addMetric(section, 'Faces', results.faceCount.toLocaleString());
    this.addMetric(section, 'Geodesics', results.geodesicCount.toString());
    if (results.analysisMode === 'sphere-bestfit' && results.wearClassification) {
      this.addMetric(section, 'Worn Vertices', results.wearClassification.wornCount.toLocaleString(),
        undefined, results.wearClassification.wornCount > 0 ? 'danger' : 'success');
      this.addMetric(section, 'Worn %', `${results.wearClassification.wornPercent.toFixed(1)}`, '%',
        results.wearClassification.wornPercent > 5 ? 'danger' : 'success');
      if (results.wearVolumeResult) {
        this.addMetric(section, 'Wear Volume', results.wearVolumeResult.wearVolume.toFixed(4), 'mm³',
          results.wearVolumeResult.wearVolume > 0.1 ? 'danger' : 'success', true);
        if (this.yearsInVivo > 0) {
          const volRate = results.wearVolumeResult.wearVolume / this.yearsInVivo;
          this.addRateMetric(section, 'Vol. Wear Rate', volRate.toFixed(4), 'mm³/year',
            volRate > 0.01 ? 'danger' : 'success');
        }
      }
      if (results.zoneSpheres) {
        const linearWear = results.zoneSpheres.wornSphere.center.distanceTo(results.zoneSpheres.unwornSphere.center);
        const unreliable = results.zoneSpheres.linearWearUnreliable;
        const label = unreliable ? 'Linear Wear ⚠' : 'Linear Wear';
        this.addMetric(section, label, (linearWear * 1000).toFixed(1), 'μm',
          unreliable ? 'warning' : (linearWear > 0.01 ? 'danger' : 'success'), true);
        if (this.yearsInVivo > 0) {
          const linearRate = linearWear / this.yearsInVivo; // mm/year
          this.addRateMetric(section, 'Linear Wear Rate', linearRate.toFixed(4), 'mm/year',
            linearRate > 0.01 ? 'danger' : 'success');
        }
        if (unreliable && results.zoneSpheres.unreliableReason) {
          this.addMetric(section, 'Warning', results.zoneSpheres.unreliableReason, undefined, 'warning');
        }
      }
    } else if (results.analysisMode === 'double-sphere-metrics') {
      const best = results.doubleSphereMetrics?.bestCell;
      this.addMetric(section, 'Sweep Cells', (results.doubleSphereMetrics?.cells.length ?? 0).toString());
      if (best) {
        this.addMetric(section, 'Best Linear Wear', (best.centerDistanceMean * 1000).toFixed(1), 'μm', 'warning');
        this.addMetric(section, 'Best Distance Std', (best.centerDistanceStd * 1000).toFixed(1), 'μm');
        this.addMetric(section, 'Best Thresh1', best.thresh1.toFixed(3));
        this.addMetric(section, 'Best Thresh2', best.thresh2.toFixed(3));
      }
      if (results.wearVolumeResult) {
        this.addMetric(section, 'Wear Volume', results.wearVolumeResult.wearVolume.toFixed(4), 'mm³',
          results.wearVolumeResult.wearVolume > 0.1 ? 'danger' : 'success', true);
        if (this.yearsInVivo > 0) {
          const volRate = results.wearVolumeResult.wearVolume / this.yearsInVivo;
          this.addRateMetric(section, 'Vol. Wear Rate', volRate.toFixed(4), 'mm³/year',
            volRate > 0.01 ? 'danger' : 'success');
        }
      }
    } else {
      this.addMetric(section, 'Anomaly Points', results.totalAnomalyPoints.toLocaleString(),
        undefined, results.totalAnomalyPoints > 0 ? 'warning' : 'success');
      this.addMetric(section, 'Wear Clusters', results.bumpClusters.length.toString(),
        undefined, results.bumpClusters.length > 0 ? 'danger' : 'success');
    }
    this.addMetric(section, 'Processing Time',
      `${(results.processingTimeMs / 1000).toFixed(1)}`, 's');

    this.container.appendChild(section);
  }

  private addCompareSummarySection(results: MultiModeComparisonResults): void {
    const section = this.createSection('Comparison Summary');
    this.addMetric(section, 'Mode', 'Compare All Modes');
    this.addMetric(section, 'Pure Geodesic Wear Vol', results.summary.pureGeodesicWearVolumeMm3.toFixed(4), 'mm³');
    this.addMetric(section, 'Sphere BestFit Wear Vol', results.summary.sphereBestfitWearVolumeMm3.toFixed(4), 'mm³');
    this.addMetric(section, 'Double Sphere Linear Wear', (results.summary.doubleSphereLinearWearMm * 1000).toFixed(1), 'μm');
    this.addMetric(section, 'Processing Time', `${(results.processingTimeMs / 1000).toFixed(1)}`, 's');
    this.container.appendChild(section);
  }

  private addDoubleSphereSection(results: AnalysisResults): void {
    const section = this.createSection('Double Sphere Metrics');
    const ds = results.doubleSphereMetrics;
    if (!ds) {
      this.addMetric(section, 'Status', 'No sweep results available', undefined, 'warning');
      this.container.appendChild(section);
      return;
    }

    this.addMetric(section, 'Factor', ds.factor.toFixed(3));
    this.addMetric(section, 'Iterations', ds.iterations.toString());
    this.addMetric(section, 'Thresh1 Values', ds.thresh1Values.length.toString());
    this.addMetric(section, 'Thresh2 Values', ds.thresh2Values.length.toString());
    this.addMetric(section, 'Computed Cells', ds.cells.length.toString());
    if (ds.bestCell) {
      this.addMetric(section, 'Best Thresh1', ds.bestCell.thresh1.toFixed(3));
      this.addMetric(section, 'Best Thresh2', ds.bestCell.thresh2.toFixed(3));
      this.addMetric(section, 'Best Center Dist Mean', ds.bestCell.centerDistanceMean.toFixed(4), 'mm', 'warning');
      this.addMetric(section, 'Best Center Dist Std', ds.bestCell.centerDistanceStd.toFixed(4), 'mm');
      this.addMetric(section, 'Best Radius1 Mean', ds.bestCell.radius1Mean.toFixed(4), 'mm');
      this.addMetric(section, 'Best Radius2 Mean', ds.bestCell.radius2Mean.toFixed(4), 'mm');
    }

    this.container.appendChild(section);

    const table = this.createSection('Double Sphere Sweep Table');
    for (const cell of ds.cells) {
      this.addMetric(
        table,
        `t1=${cell.thresh1.toFixed(3)} | t2=${cell.thresh2.toFixed(3)}`,
        `${(cell.centerDistanceMean * 1000).toFixed(1)} ± ${(cell.centerDistanceStd * 1000).toFixed(1)} μm`
      );
    }
    this.container.appendChild(table);
  }

  private addSphereFitSection(results: AnalysisResults): void {
    const section = this.createSection('Sphere Fit');
    const sf = results.sphereFit;

    this.addMetric(section, 'Radius', sf.radius.toFixed(4), 'mm');
    this.addMetric(section, 'Center X', sf.center.x.toFixed(4), 'mm');
    this.addMetric(section, 'Center Y', sf.center.y.toFixed(4), 'mm');
    this.addMetric(section, 'Center Z', sf.center.z.toFixed(4), 'mm');
    this.addMetric(section, 'RMS Error', (sf.rmsError * 1000).toFixed(2), 'μm');
    this.addMetric(section, 'Max Error', (sf.maxError * 1000).toFixed(2), 'μm');

    this.container.appendChild(section);
  }

  private addShapeSection(results: AnalysisResults): void {
    const section = this.createSection('Shape Classification');
    const ef = results.ellipsoidFit;
    if (!ef) {
      this.addMetric(section, 'Sphericity', 'N/A');
      this.addMetric(section, 'Classification', 'N/A');
      this.addMetric(section, 'Semi-axis A', 'N/A');
      this.addMetric(section, 'Semi-axis B', 'N/A');
      this.addMetric(section, 'Semi-axis C', 'N/A');
      this.addMetric(section, 'Axis ratio (B/A)', 'N/A');
      this.addMetric(section, 'Axis ratio (C/A)', 'N/A');
    } else {
      this.addMetric(section, 'Sphericity', `${ef.sphericityPercent.toFixed(2)}`, '%',
        ef.sphericityPercent >= 98 ? 'success' : ef.sphericityPercent >= 90 ? 'warning' : 'danger');
      this.addMetric(section, 'Classification', ef.shapeClass.replace(/-/g, ' '));
      this.addMetric(section, 'Semi-axis A', ef.semiAxes[0].toFixed(4), 'mm');
      this.addMetric(section, 'Semi-axis B', ef.semiAxes[1].toFixed(4), 'mm');
      this.addMetric(section, 'Semi-axis C', ef.semiAxes[2].toFixed(4), 'mm');
      this.addMetric(section, 'Axis ratio (B/A)', (ef.semiAxes[1] / ef.semiAxes[0]).toFixed(4));
      this.addMetric(section, 'Axis ratio (C/A)', (ef.semiAxes[2] / ef.semiAxes[0]).toFixed(4));
    }
    this.container.appendChild(section);
  }

  private addWearSection(results: AnalysisResults): void {
    const section = this.createSection('Wear Analysis');

    // Find max bump and max dip across all clusters
    let maxBump = 0, maxDip = 0;
    for (const c of results.bumpClusters) {
      if (c.maxDeviation > maxBump) maxBump = c.maxDeviation;
    }
    for (const c of results.dipClusters) {
      if (c.minDeviation < maxDip) maxDip = c.minDeviation;
    }

    this.addMetric(section, 'Max Wear', `+${maxBump.toFixed(2)}`, 'μm',
      maxBump > 10 ? 'danger' : maxBump > 5 ? 'warning' : 'success');

    if (results.primaryWearZone) {
      const pwz = results.primaryWearZone;
      this.addMetric(section, 'Primary Wear Depth', `+${pwz.maxDeviation.toFixed(2)}`, 'μm', 'danger');
      this.addMetric(section, 'Primary Wear Area', pwz.area.toFixed(2), 'mm²');
    }

    this.container.appendChild(section);
  }

  private addVolumeSection(results: AnalysisResults): void {
    const section = this.createSection('Volume Analysis');

    this.addMetric(section, 'Wear Volume',
      results.totalBumpVolume.toFixed(4), 'mm³',
      results.totalBumpVolume > 0.1 ? 'danger' : 'success');

    // Mass estimates
    const density = 0.935; // g/cm³ = mg/mm³
    this.addMetric(section, 'Wear Mass',
      (results.totalBumpVolume * density).toFixed(4), 'mg', 'danger');

    this.container.appendChild(section);
  }

  private addWearVectorSection(results: AnalysisResults): void {
    const section = this.createSection('Wear Vector');
    const wv = results.wearVector!;

    this.addMetric(section, 'Max Depth', wv.maxDepth.toFixed(2), 'μm', 'danger');
    this.addMetric(section, 'Distance to Pole', wv.distance.toFixed(3), 'mm');
    this.addMetric(section, 'Angle from Axis', wv.angle.toFixed(1), '°');
    this.addMetric(section, 'Deepest Pt X', wv.deepestPoint.x.toFixed(3), 'mm');
    this.addMetric(section, 'Deepest Pt Y', wv.deepestPoint.y.toFixed(3), 'mm');
    this.addMetric(section, 'Deepest Pt Z', wv.deepestPoint.z.toFixed(3), 'mm');

    this.container.appendChild(section);
  }

  private addCommercialSphereSection(results: AnalysisResults): void {
    const section = this.createSection('Commercial Sphere');
    const cs = results.commercialSphere!;

    this.addMetric(section, 'Geodesic Radius', cs.geodesicRadius.toFixed(4), 'mm');
    this.addMetric(section, 'Commercial Radius', cs.commercialRadius.toFixed(1), 'mm');
    this.addMetric(section, 'Detection',
      cs.autoDetected
        ? (cs.commercialRadius > cs.geodesicRadius ? 'Auto (snap up)' : 'Auto (round down)')
        : 'Manual');
    this.addMetric(section, 'Center X', cs.center.x.toFixed(4), 'mm');
    this.addMetric(section, 'Center Y', cs.center.y.toFixed(4), 'mm');
    this.addMetric(section, 'Center Z', cs.center.z.toFixed(4), 'mm');

    this.container.appendChild(section);
  }

  private addWearClassificationSection(results: AnalysisResults): void {
    const section = this.createSection('Wear Classification');
    const wc = results.wearClassification!;

    this.addMetric(section, 'Threshold', wc.threshold.toFixed(3), 'mm');
    this.addMetric(section, 'Worn Vertices', wc.wornCount.toLocaleString(), undefined,
      wc.wornCount > 0 ? 'danger' : 'success');
    this.addMetric(section, 'Unworn Vertices', wc.unwornCount.toLocaleString(), undefined, 'success');
    this.addMetric(section, 'Worn %', wc.wornPercent.toFixed(2), '%',
      wc.wornPercent > 10 ? 'danger' : wc.wornPercent > 2 ? 'warning' : 'success');

    this.container.appendChild(section);
  }

  private addZoneSpheresSection(results: AnalysisResults): void {
    const section = this.createSection('Zone Spheres');
    const zs = results.zoneSpheres!;

    const linearWear = zs.wornSphere.center.distanceTo(zs.unwornSphere.center);
    const unreliable = zs.linearWearUnreliable;
    this.addMetric(section, unreliable ? 'Linear Wear ⚠' : 'Linear Wear',
      (linearWear * 1000).toFixed(1), 'μm', unreliable ? 'warning' : 'danger');

    if (unreliable && zs.unreliableReason) {
      this.addMetric(section, 'Warning', zs.unreliableReason, undefined, 'warning');
    }

    if (zs.filterUsed) {
      const filterNames: Record<string, string> = {
        'none': 'None',
        'robust-irls': 'Robust IRLS',
        'dbscan-spatial': 'Spatial DBSCAN',
        'combined': 'Combined',
      };
      this.addMetric(section, 'Filter', filterNames[zs.filterUsed] || zs.filterUsed);
    }
    if (zs.rawWornVertexCount !== undefined && zs.filteredWornVertexCount !== undefined) {
      this.addMetric(section, 'Worn Vertices (raw)', zs.rawWornVertexCount.toLocaleString());
      this.addMetric(section, 'Worn Vertices (filtered)', zs.filteredWornVertexCount.toLocaleString(),
        undefined, zs.filteredWornVertexCount < zs.rawWornVertexCount ? 'warning' : 'success');
    }
    if (zs.discardedClusters !== undefined && zs.discardedClusters > 0) {
      this.addMetric(section, 'Discarded Clusters', zs.discardedClusters.toString(), undefined, 'warning');
    }

    this.addMetric(section, 'Worn Sphere RMS', (zs.wornSphere.rmsError * 1000).toFixed(2), 'μm', 'danger');
    this.addMetric(section, 'Unworn Sphere RMS', (zs.unwornSphere.rmsError * 1000).toFixed(2), 'μm', 'success');

    this.container.appendChild(section);
  }

  private addWearVolumeSection(results: AnalysisResults): void {
    const section = this.createSection('Wear Volume');
    const wv = results.wearVolumeResult!;
    const density = 0.935; // UHMWPE density g/cm³ = mg/mm³

    this.addMetric(section, 'Mesh Enclosed Vol', wv.meshEnclosedVolume.toFixed(4), 'mm³');
    this.addMetric(section, 'Sphere Cap Vol', wv.sphereCapVolume.toFixed(4), 'mm³');
    this.addMetric(section, 'Wear Volume', wv.wearVolume.toFixed(4), 'mm³',
      wv.wearVolume > 0.1 ? 'danger' : 'success');
    this.addMetric(section, 'Wear Mass', (wv.wearVolume * density).toFixed(4), 'mg',
      wv.wearVolume > 0.1 ? 'danger' : 'success');

    if (this.yearsInVivo > 0) {
      const volRate = wv.wearVolume / this.yearsInVivo;
      this.addRateMetric(section, 'Volumetric Wear Rate', volRate.toFixed(4), 'mm³/year',
        volRate > 0.01 ? 'danger' : 'success');
      this.addRateMetric(section, 'Mass Wear Rate', (volRate * density).toFixed(4), 'mg/year');
    }

    this.container.appendChild(section);
  }

  private addWearPlaneSection(results: AnalysisResults): void {
    const section = this.createSection('Maximum Wear Point');
    const wp = results.wearPlane!;

    this.addMetric(section, 'Max Wear Depth', wp.maxWearDepth.toFixed(1), 'μm',
      wp.maxWearDepth > 10 ? 'danger' : wp.maxWearDepth > 5 ? 'warning' : 'success');
    this.addMetric(section, 'Point X', wp.maxWearPoint.x.toFixed(4), 'mm');
    this.addMetric(section, 'Point Y', wp.maxWearPoint.y.toFixed(4), 'mm');
    this.addMetric(section, 'Point Z', wp.maxWearPoint.z.toFixed(4), 'mm');

    this.container.appendChild(section);
  }

  private addGeodesicTable(geodesics: Geodesic[]): void {
    const section = this.createSection('Geodesic Details');

    const tableWrapper = document.createElement('div');
    tableWrapper.style.maxHeight = '300px';
    tableWrapper.style.overflowY = 'auto';

    const table = document.createElement('table');
    table.className = 'geodesic-table';

    // Header
    const thead = document.createElement('thead');
    thead.innerHTML = `
      <tr>
        <th>Angle</th>
        <th>Max</th>
        <th>Min</th>
        <th>Anom.</th>
      </tr>`;
    table.appendChild(thead);

    // Body
    const tbody = document.createElement('tbody');
    for (const geo of geodesics) {
      const tr = document.createElement('tr');
      if (geo.anomalyCount > 0) tr.className = 'anomaly';

      tr.innerHTML = `
        <td>${geo.angle.toFixed(0)}°</td>
        <td style="color: ${geo.maxDeviation > 1 ? '#f85149' : 'inherit'}">${geo.maxDeviation.toFixed(1)}</td>
        <td style="color: ${geo.minDeviation < -1 ? '#6644ff' : 'inherit'}">${geo.minDeviation.toFixed(1)}</td>
        <td>${geo.anomalyCount}</td>
      `;

      tr.addEventListener('click', () => {
        if (this.onGeodesicSelect) {
          this.onGeodesicSelect(geo.angle);
        }
      });

      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    tableWrapper.appendChild(table);
    section.appendChild(tableWrapper);

    this.container.appendChild(section);
  }

  private createSection(title: string): HTMLElement {
    const section = document.createElement('div');
    section.className = 'results-section fade-in';

    const h3 = document.createElement('h3');
    h3.textContent = title;
    section.appendChild(h3);

    return section;
  }

  private addMetric(
    section: HTMLElement,
    label: string,
    value: string,
    unit?: string,
    colorClass?: string,
    highlight?: boolean
  ): void {
    const row = document.createElement('div');
    row.className = highlight ? 'metric-row highlight' : 'metric-row';

    const labelSpan = document.createElement('span');
    labelSpan.className = 'metric-label';
    labelSpan.textContent = label;

    const valueSpan = document.createElement('span');
    valueSpan.className = `metric-value ${colorClass || ''}`;
    valueSpan.textContent = value;
    if (unit) {
      const unitSpan = document.createElement('span');
      unitSpan.className = 'metric-unit';
      unitSpan.textContent = unit;
      valueSpan.appendChild(unitSpan);
    }

    row.appendChild(labelSpan);
    row.appendChild(valueSpan);
    section.appendChild(row);
  }

  /** Like addMetric but styled with blue accent for wear-rate rows. */
  private addRateMetric(
    section: HTMLElement,
    label: string,
    value: string,
    unit?: string,
    colorClass?: string
  ): void {
    const row = document.createElement('div');
    row.className = 'metric-row rate-highlight';

    const labelSpan = document.createElement('span');
    labelSpan.className = 'metric-label';
    labelSpan.textContent = label;

    const valueSpan = document.createElement('span');
    valueSpan.className = `metric-value ${colorClass || ''}`;
    valueSpan.textContent = value;
    if (unit) {
      const unitSpan = document.createElement('span');
      unitSpan.className = 'metric-unit';
      unitSpan.textContent = unit;
      valueSpan.appendChild(unitSpan);
    }

    row.appendChild(labelSpan);
    row.appendChild(valueSpan);
    section.appendChild(row);
  }
}
